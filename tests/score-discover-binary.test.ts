import { describe, expect, test } from 'bun:test';
import { discoverBinary } from '../src/worker/score/discover-binary';
import type { DiscoveryHintsIndex } from '../src/worker/score/registry-lookup';

const EMPTY_HINTS: DiscoveryHintsIndex = { by_owner_repo: {} };

// Build a fetcher that returns canned responses keyed by exact URL match.
// URLs not in the table fall back to 404 — keeps each test focused on the
// path being exercised. Exact (not prefix) match avoids overlap between
// `/api/v1/crates/foo` and `/api/v1/crates/foo/1.0.0`.
function mockFetcher(table: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const response = table[url];
    if (response) {
      const body = response.body;
      const status = response.status ?? 200;
      const ok = status >= 200 && status < 300;
      return {
        ok,
        status,
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as Response;
  }) as unknown as typeof fetch;
}

describe('discoverBinary — step 0.5 (hints)', () => {
  test('hint hit short-circuits the chain (never queries any HTTP endpoint)', async () => {
    const fetcher = mockFetcher({}); // empty — any HTTP call would 404
    const hints: DiscoveryHintsIndex = {
      by_owner_repo: { 'Aider-AI/aider': { pm: 'pip', package: 'aider-chat', binary: 'aider' } },
    };
    const r = await discoverBinary({ owner: 'Aider-AI', repo: 'aider', hintsIndex: hints, fetcher });
    expect(r).toEqual({
      ok: true,
      spec: { pm: 'pip', package: 'aider-chat', binary: 'aider' },
      resolved_step: '0.5-hints',
    });
  });

  test('hint hit is case-insensitive on owner/repo', async () => {
    const fetcher = mockFetcher({});
    const hints: DiscoveryHintsIndex = {
      by_owner_repo: { 'Aider-AI/aider': { pm: 'pip', package: 'aider-chat', binary: 'aider' } },
    };
    const r = await discoverBinary({ owner: 'aider-ai', repo: 'AIDER', hintsIndex: hints, fetcher });
    expect(r.ok).toBe(true);
  });
});

describe('discoverBinary — step 2 (releases asset)', () => {
  test('linux-musl asset wins', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': {
        body: {
          assets: [
            { name: 'foo-darwin.tar.gz', browser_download_url: 'https://x/foo-darwin.tar.gz' },
            {
              name: 'foo-x86_64-unknown-linux-musl.tar.gz',
              browser_download_url: 'https://x/foo-x86_64-unknown-linux-musl.tar.gz',
            },
          ],
        },
      },
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved_step).toBe('2-releases-asset');
      expect(r.spec).toEqual({
        pm: 'direct',
        url: 'https://x/foo-x86_64-unknown-linux-musl.tar.gz',
        binary: 'bar',
      });
    }
  });

  test('linux-amd64 alias also matches', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': {
        body: {
          assets: [{ name: 'foo-linux-amd64.tar.gz', browser_download_url: 'https://x/foo-linux-amd64.tar.gz' }],
        },
      },
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved_step).toBe('2-releases-asset');
  });

  test('release with no linux assets falls through to step 3', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': {
        body: { assets: [{ name: 'foo-darwin.zip', browser_download_url: 'https://x/d.zip' }] },
      },
      'https://crates.io/api/v1/crates/bar': {
        body: { crate: { repository: 'https://github.com/foo/bar', max_stable_version: '1.0.0' } },
      },
      'https://crates.io/api/v1/crates/bar/1.0.0': { body: { version: { bin_names: ['bar'] } } },
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved_step).toBe('3-crates');
  });
});

describe('discoverBinary — step 3 F1 tightening (repository-field match)', () => {
  test('crates.io 200 with mismatched repository → step 3 rejects, chain continues', async () => {
    // The classic "cobra" collision: crates.io has SOME crate, but its
    // repository field points elsewhere. Loose check would fire; tight
    // check rejects.
    const fetcher = mockFetcher({
      'https://api.github.com/repos/spf13/cobra/releases/latest': { body: { assets: [] } },
      'https://crates.io/api/v1/crates/cobra': {
        body: { crate: { repository: null, max_stable_version: '1.0.0' } },
      },
      // README has no install block matching the repo name → step 4 misses too
      'https://raw.githubusercontent.com/spf13/cobra/HEAD/README.md': {
        body: 'no install block here\n```\necho hello\n```',
      },
    });
    const r = await discoverBinary({ owner: 'spf13', repo: 'cobra', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('chain_no_resolve');
      expect(r.exhausted.distributions.per_registry.crates.loose).toBe(true);
      expect(r.exhausted.distributions.per_registry.crates.tight).toBe(false);
    }
  });

  test('crates.io match repo + non-empty bin_names → tight hit', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/burntsushi/ripgrep/releases/latest': { body: { assets: [] } },
      'https://crates.io/api/v1/crates/ripgrep': {
        body: { crate: { repository: 'https://github.com/BurntSushi/ripgrep', max_stable_version: '15.1.0' } },
      },
      'https://crates.io/api/v1/crates/ripgrep/15.1.0': { body: { version: { bin_names: ['rg'] } } },
    });
    const r = await discoverBinary({ owner: 'burntsushi', repo: 'ripgrep', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved_step).toBe('3-crates');
  });

  test('crates.io match repo + EMPTY bin_names (library-only) → tight rejects', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/ratatui/ratatui/releases/latest': { body: { assets: [] } },
      'https://crates.io/api/v1/crates/ratatui': {
        body: { crate: { repository: 'https://github.com/ratatui/ratatui', max_stable_version: '0.30.0' } },
      },
      'https://crates.io/api/v1/crates/ratatui/0.30.0': { body: { version: { bin_names: [] } } },
      'https://raw.githubusercontent.com/ratatui/ratatui/HEAD/README.md': { body: 'no install block' },
    });
    const r = await discoverBinary({ owner: 'ratatui', repo: 'ratatui', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exhausted.distributions.per_registry.crates.tight).toBe(false);
      expect(r.exhausted.distributions.per_registry.crates.reason).toBe('crate_is_library_only');
    }
  });

  test('npm match repo + bin field → tight hit', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/google/zx/releases/latest': { body: { assets: [] } },
      'https://registry.npmjs.org/zx/latest': {
        body: { bin: { zx: 'build/cli.js' }, repository: { url: 'git+https://github.com/google/zx.git' } },
      },
    });
    const r = await discoverBinary({ owner: 'google', repo: 'zx', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved_step).toBe('3-npm');
  });

  test('npm bin present but repository does NOT match → tight rejects', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': { body: { assets: [] } },
      'https://registry.npmjs.org/bar/latest': {
        body: { bin: { bar: 'cli.js' }, repository: { url: 'git+https://github.com/somebody-else/bar.git' } },
      },
      'https://raw.githubusercontent.com/foo/bar/HEAD/README.md': { body: 'no install' },
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.exhausted.distributions.per_registry.npm.tight).toBe(false);
  });

  test('pypi wheel + project_urls match → tight hit', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/pallets/click/releases/latest': { body: { assets: [] } },
      'https://pypi.org/pypi/click/json': {
        body: {
          info: { home_page: null, project_urls: { Source: 'https://github.com/pallets/click/' } },
          urls: [{ packagetype: 'bdist_wheel' }, { packagetype: 'sdist' }],
        },
      },
    });
    const r = await discoverBinary({ owner: 'pallets', repo: 'click', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved_step).toBe('3-pypi');
  });

  test('go proxy 200 → tight hit (path is owner/repo-keyed by construction)', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': { body: { assets: [] } },
      'https://proxy.golang.org/foo/bar/@latest': { body: { Version: 'v1.2.3' } },
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved_step).toBe('3-go');
  });

  test('priority order: crates → npm → pypi → go → brew (U6-supported PMs first, Bug J fix)', async () => {
    // Original plan said brew → crates → npm → pypi → go, but the U6
    // install table bounces brew (Linuxbrew non-viable on musl). If a
    // tool has both a brew formula AND a working alternative (e.g.
    // csvlens on brew AND on crates.io), picking brew sends the user
    // to a guaranteed bounce when scoring was possible. Brew is now
    // last so brew-only tools still resolve to brew (and bounce
    // honestly with the brew formula name in the error), but tools
    // with any other supported PM score successfully.
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': { body: { assets: [] } },
      'https://formulae.brew.sh/api/formula/bar.json': {
        body: {
          homepage: 'https://github.com/foo/bar',
          urls: { stable: { url: 'https://github.com/foo/bar/archive/v1.tar.gz' } },
        },
      },
      'https://crates.io/api/v1/crates/bar': {
        body: { crate: { repository: 'https://github.com/foo/bar', max_stable_version: '1.0.0' } },
      },
      'https://crates.io/api/v1/crates/bar/1.0.0': { body: { version: { bin_names: ['bar'] } } },
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved_step).toBe('3-crates');
  });

  test('brew wins only when no other distribution matches (last-resort priority)', async () => {
    // No crates, npm, pypi, or go match — brew formula is the only
    // hit. Discovery picks brew; U6 bounces it as install_unsupported
    // with the formula name in the error.
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/baz/releases/latest': { body: { assets: [] } },
      'https://formulae.brew.sh/api/formula/baz.json': {
        body: {
          homepage: 'https://github.com/foo/baz',
          urls: { stable: { url: 'https://github.com/foo/baz/archive/v1.tar.gz' } },
        },
      },
      // No crates / npm / pypi / go responses — fetcher returns 404
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'baz', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved_step).toBe('3-brew');
  });
});

describe('discoverBinary — step 4 (README parse)', () => {
  test('first fenced block matching install-command shape with repo name → hit', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': { body: { assets: [] } },
      'https://raw.githubusercontent.com/foo/bar/HEAD/README.md': {
        body: '# bar\n\n## Install\n\n```\npip install bar\n```\n',
      },
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved_step).toBe('4-readme-parse');
      expect(r.spec).toEqual({ pm: 'pip', package: 'bar', binary: 'bar' });
    }
  });

  test('install-command in README pointing to a different package name → reject (name-mismatch guard)', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': { body: { assets: [] } },
      'https://raw.githubusercontent.com/foo/bar/HEAD/README.md': {
        body: '```\npip install some-other-package\n```',
      },
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(false);
  });

  test('README with leading $ shell prompt parses correctly', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': { body: { assets: [] } },
      'https://raw.githubusercontent.com/foo/bar/HEAD/README.md': { body: '```\n$ pip install bar\n```' },
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
  });

  test('README first-line is a comment → skip the comment, scan to the next fence', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': { body: { assets: [] } },
      'https://raw.githubusercontent.com/foo/bar/HEAD/README.md': {
        body: '```\n# example\n```\n```\npip install bar\n```',
      },
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
  });
});

describe('discoverBinary — chain miss', () => {
  test('all steps miss → chain_no_resolve with full exhausted breadcrumb', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': { body: { assets: [] } },
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('chain_no_resolve');
      expect(r.exhausted.releases.hit).toBe(false);
      expect(r.exhausted.distributions.hit).toBe(false);
      expect(r.exhausted.readme.hit).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — parallel fan-out + priority pick + agreement diagnostics
// ---------------------------------------------------------------------------

describe('discoverBinary — parallel fan-out (Fix 2)', () => {
  // Build a fetcher whose responses each take a known delay. The
  // parallel fan-out asserts: total wall-clock for a chain miss is the
  // MAX of the per-step delays, not the SUM. If a future refactor
  // re-serializes the steps this test fails LOUDLY.
  function delayedFetcher(table: Record<string, { delayMs: number; status?: number; body: unknown }>): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const response = table[url];
      if (response) {
        await new Promise((r) => setTimeout(r, response.delayMs));
        const body = response.body;
        const status = response.status ?? 200;
        const ok = status >= 200 && status < 300;
        return {
          ok,
          status,
          json: async () => body,
          text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as Response;
    }) as unknown as typeof fetch;
  }

  test('steps 2/3/4 fire concurrently (total time ≈ max(step times), not sum)', async () => {
    // Each step takes 200 ms. Serial fan-out would be 200 ms (releases)
    // + 200 ms (5x parallel registries) + 200 ms (readme) = 600 ms.
    // Parallel fan-out finishes in ~200 ms once all three steps settle.
    // 400 ms threshold gives generous slack for test-runner jitter.
    const delay = 200;
    const fetcher = delayedFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': { delayMs: delay, body: { assets: [] } },
      'https://formulae.brew.sh/api/formula/bar.json': { delayMs: delay, status: 404, body: {} },
      'https://crates.io/api/v1/crates/bar': { delayMs: delay, status: 404, body: {} },
      'https://registry.npmjs.org/bar/latest': { delayMs: delay, status: 404, body: {} },
      'https://pypi.org/pypi/bar/json': { delayMs: delay, status: 404, body: {} },
      'https://proxy.golang.org/foo/bar/@latest': { delayMs: delay, status: 404, body: {} },
      'https://raw.githubusercontent.com/foo/bar/HEAD/README.md': { delayMs: delay, status: 404, body: '' },
      'https://raw.githubusercontent.com/foo/bar/main/README.md': { delayMs: delay, status: 404, body: '' },
      'https://raw.githubusercontent.com/foo/bar/master/README.md': { delayMs: delay, status: 404, body: '' },
    });
    const start = Date.now();
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    // Each step internally parallelizes (step 3 uses Promise.all over 5
    // registries; step 4 walks the README candidate list sequentially
    // — 3 x 200 ms = 600 ms worst-case for step 4 alone). The fan-out
    // assertion is: the OUTER chain ran the three steps concurrently,
    // so the total stays under sum-of-outer-steps. Without the
    // parallelization the README step's serial walk would stack on
    // top of release + distributions for >= 1000 ms total.
    expect(elapsed).toBeLessThan(900);
  });

  test('release-asset wins over registry on agreement (priority pick)', async () => {
    // Both step 2 AND step 3 (crates) hit. Priority: release > registry.
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': {
        body: {
          assets: [{ name: 'bar-x86_64-unknown-linux-musl.tar.gz', browser_download_url: 'https://x/bar.tar.gz' }],
        },
      },
      'https://crates.io/api/v1/crates/bar': {
        body: { crate: { repository: 'https://github.com/foo/bar', max_stable_version: '1.0.0' } },
      },
      'https://crates.io/api/v1/crates/bar/1.0.0': { body: { version: { bin_names: ['bar'] } } },
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved_step).toBe('2-releases-asset');
    expect(r.diagnostics?.winner).toBe('2-releases-asset');
    // Loser list captures the OTHER source that also hit.
    expect(r.diagnostics?.losers).toContain('3-crates');
    // Agreement: both sources resolve to the same binary name (the
    // repo name in this fixture). agreed_binary stays true.
    expect(r.diagnostics?.agreed_binary).toBe(true);
  });

  test('registry wins over README (priority pick when no release hit)', async () => {
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': { body: { assets: [] } },
      'https://crates.io/api/v1/crates/bar': {
        body: { crate: { repository: 'https://github.com/foo/bar', max_stable_version: '1.0.0' } },
      },
      'https://crates.io/api/v1/crates/bar/1.0.0': { body: { version: { bin_names: ['bar'] } } },
      'https://raw.githubusercontent.com/foo/bar/HEAD/README.md': {
        body: '```\npip install bar\n```',
      },
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved_step).toBe('3-crates');
    expect(r.diagnostics?.losers).toContain('4-readme-parse');
  });

  test('hint hit short-circuits parallel fan-out (no network calls)', async () => {
    // The hint lookup is in-memory and runs BEFORE the parallel
    // fan-out. A hit must return before any HTTP call fires — this
    // keeps the zero-cost lookup zero-cost.
    let fetchCalls = 0;
    const fetcher = (async () => {
      fetchCalls++;
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as Response;
    }) as unknown as typeof fetch;
    const hints: DiscoveryHintsIndex = {
      by_owner_repo: { 'foo/bar': { pm: 'pip', package: 'bar', binary: 'bar' } },
    };
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: hints, fetcher });
    expect(r.ok).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  test('disagreement on binary name surfaces in diagnostics.agreed_binary=false', async () => {
    // Release picks 'bar' (repo-name default). README parse for a
    // build script that names a DIFFERENT package (in this case
    // `bar-tools`) gets normalized via the substring guard, but the
    // resolved spec.binary differs. agreed_binary fires false so logs
    // can spot the cross-source mismatch.
    const fetcher = mockFetcher({
      'https://api.github.com/repos/foo/bar/releases/latest': {
        body: {
          assets: [{ name: 'bar-x86_64-unknown-linux-musl.tar.gz', browser_download_url: 'https://x/bar.tar.gz' }],
        },
      },
      // README install says `pip install bar-tools` — the substring
      // guard (bar ⊂ bar-tools) passes, so step 4 hits with a
      // different binary name.
      'https://raw.githubusercontent.com/foo/bar/HEAD/README.md': {
        body: '```\npip install bar-tools\n```',
      },
    });
    const r = await discoverBinary({ owner: 'foo', repo: 'bar', hintsIndex: EMPTY_HINTS, fetcher });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Release wins on priority.
    expect(r.resolved_step).toBe('2-releases-asset');
    expect(r.diagnostics?.losers).toContain('4-readme-parse');
    expect(r.diagnostics?.agreed_binary).toBe(false);
  });
});
