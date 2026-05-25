// Brew discovery-fallback tests for resolveSpec() in resolve-spec.ts.
//
// When a user pastes `brew install <pkg>`, resolveSpec fetches the
// formula metadata from formulae.brew.sh, parses the homepage as a
// github.com URL, and runs the same discoverBinary chain used for
// github-url inputs. The brew-only bounce is intentionally
// indistinguishable from a missing formula or a non-github homepage so
// the user-facing CTA stays simple.
//
// 2026-05-20 move: pre-move this lived in do.ts and was invoked at the
// DO boundary. Resolution now happens at the Worker tier; the function
// signature is unchanged, only the file location moved.

import { describe, expect, test } from 'bun:test';
import { parseGithubOwnerRepo, resolveBrewFallback } from '../src/worker/score/resolve-spec';

type FetchHandler = (url: string) => Response | Promise<Response>;

function fakeFetcher(handler: FetchHandler): typeof fetch {
  return (async (input: Request | string | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return await handler(url);
  }) as unknown as typeof fetch;
}

const EMPTY_HINTS = { by_owner_repo: {} };

function ok<T>(body: T): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function notFound(): Response {
  return new Response('', { status: 404 });
}

describe('resolveBrewFallback — happy paths', () => {
  test('formula with crates.io distribution → resolves to pm=cargo-binstall', async () => {
    const fetcher = fakeFetcher((url) => {
      if (url.includes('formulae.brew.sh/api/formula/ripgrep.json')) {
        return ok({ homepage: 'https://github.com/BurntSushi/ripgrep' });
      }
      if (url.includes('api.github.com/repos/BurntSushi/ripgrep/releases/latest')) {
        // Force discovery past Step 2 so Step 3 distributions decide.
        return notFound();
      }
      if (url === 'https://crates.io/api/v1/crates/ripgrep') {
        return ok({ crate: { repository: 'https://github.com/BurntSushi/ripgrep', max_stable_version: '14.0.0' } });
      }
      if (url === 'https://crates.io/api/v1/crates/ripgrep/14.0.0') {
        return ok({ version: { bin_names: ['rg'] } });
      }
      // npm / pypi / go misses — return 404 so they don't compete.
      return notFound();
    });
    const result = await resolveBrewFallback('ripgrep', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pm).toBe('cargo-binstall');
  });

  test('formula with GitHub release asset → resolves to pm=direct via Step 2', async () => {
    const fetcher = fakeFetcher((url) => {
      if (url.includes('formulae.brew.sh/api/formula/csvlens.json')) {
        return ok({ homepage: 'https://github.com/YS-L/csvlens' });
      }
      if (url.includes('api.github.com/repos/YS-L/csvlens/releases/latest')) {
        return ok({
          assets: [
            {
              name: 'csvlens-x86_64-unknown-linux-musl.tar.xz',
              browser_download_url: 'https://example.com/csvlens-x86_64-unknown-linux-musl.tar.xz',
            },
          ],
        });
      }
      return notFound();
    });
    const result = await resolveBrewFallback('csvlens', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pm).toBe('direct');
    if (result.value.pm !== 'direct') return;
    expect(result.value.url).toContain('.tar.xz');
  });
});

describe('resolveBrewFallback — bounce paths', () => {
  test('formula 404 on formulae.brew.sh → install_unsupported pm=brew_only', async () => {
    const fetcher = fakeFetcher(() => notFound());
    const result = await resolveBrewFallback('definitely-not-a-formula', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('install_unsupported');
    expect(result.details).toBe('pm=brew_only');
  });

  test('formula homepage is non-github → install_unsupported pm=brew_only', async () => {
    const fetcher = fakeFetcher((url) => {
      if (url.includes('formulae.brew.sh/api/formula/exotic.json')) {
        return ok({ homepage: 'https://exotic.example/tool' });
      }
      return notFound();
    });
    const result = await resolveBrewFallback('exotic', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('install_unsupported');
    expect(result.details).toBe('pm=brew_only');
  });

  test('formula with GitHub homepage but no other-PM distribution → install_unsupported pm=brew_only', async () => {
    const fetcher = fakeFetcher((url) => {
      if (url.includes('formulae.brew.sh/api/formula/brew-only-tool.json')) {
        return ok({
          homepage: 'https://github.com/owner/brew-only-tool',
          urls: { stable: { url: 'https://github.com/owner/brew-only-tool/releases/v1.tar.gz' } },
        });
      }
      // Every other registry misses. Note: the discoverBinary chain
      // still queries formulae.brew.sh as part of Step 3, so we have to
      // serve a brew-tight match here too — and the resolveBrewFallback
      // wrapper rejects pm=brew explicitly, which is what produces the
      // brew_only bounce.
      return notFound();
    });
    const result = await resolveBrewFallback('brew-only-tool', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('install_unsupported');
    expect(result.details).toBe('pm=brew_only');
  });

  test('formula missing homepage field → install_unsupported pm=brew_only', async () => {
    const fetcher = fakeFetcher((url) => {
      if (url.includes('formulae.brew.sh/api/formula/no-homepage.json')) {
        return ok({});
      }
      return notFound();
    });
    const result = await resolveBrewFallback('no-homepage', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('install_unsupported');
    expect(result.details).toBe('pm=brew_only');
  });

  test('formula API throws → install_unsupported pm=brew_only', async () => {
    const fetcher = (async () => {
      throw new Error('network refused');
    }) as unknown as typeof fetch;
    const result = await resolveBrewFallback('anything', EMPTY_HINTS, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('install_unsupported');
    expect(result.details).toBe('pm=brew_only');
  });
});

describe('parseGithubOwnerRepo', () => {
  test('repo-root URL → {owner, repo}', () => {
    expect(parseGithubOwnerRepo('https://github.com/BurntSushi/ripgrep')).toEqual({
      owner: 'BurntSushi',
      repo: 'ripgrep',
    });
  });

  test('repo URL with .git suffix → strips suffix', () => {
    expect(parseGithubOwnerRepo('https://github.com/BurntSushi/ripgrep.git')).toEqual({
      owner: 'BurntSushi',
      repo: 'ripgrep',
    });
  });

  test('repo URL with subpath → still returns repo root', () => {
    // A brew formula's homepage SHOULD be the repo root, but some
    // formulae point at a docs subpath or a /releases page. The parser
    // takes the first two segments — best-effort recovery rather than
    // a strict reject — because the downstream discoverBinary call
    // does its own owner/repo validation.
    expect(parseGithubOwnerRepo('https://github.com/owner/repo/tree/main')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  test('non-github host → null', () => {
    expect(parseGithubOwnerRepo('https://gitlab.com/owner/repo')).toBeNull();
  });

  test('unparseable URL → null', () => {
    expect(parseGithubOwnerRepo('not a url')).toBeNull();
  });

  test('undefined → null', () => {
    expect(parseGithubOwnerRepo(undefined)).toBeNull();
  });

  test('github.com with only owner segment → null', () => {
    expect(parseGithubOwnerRepo('https://github.com/owner')).toBeNull();
  });
});
