// Worker route: GET /score/live/<binary>
//
// The shareable result URL renders the cached scorecard as HTML. Cache-
// key share-URL design: the same key the DO writes to
// (scores/<binary>/<spec>.json) is the key this route reads from. No
// session minting; the URL is meaningful.

import { describe, expect, test } from 'bun:test';
import { keyFor } from '../src/worker/score/cache';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import {
  _resetShellTemplateCache,
  handleLiveScorePage,
  parseLiveScorePath,
  parseLiveScorePathMatch,
} from '../src/worker/score/summary-render';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';

const SHELL_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<title>{{TITLE}}</title>
<meta name="description" content="{{DESCRIPTION}}" />
<link rel="canonical" href="https://anc.dev{{CANONICAL_PATH}}" />
</head>
<body>{{BODY}}</body>
</html>
`;

const SAMPLE_SCORECARD = {
  schema_version: '0.5',
  tool: { name: 'ripgrep', binary: 'rg', version: '14.1.0' },
  target: { kind: 'command', command: 'rg' },
  badge: { score_pct: 92, eligible: true },
  audience: 'agent-optimized',
  audit_profile: null,
  results: [
    { status: 'pass', label: 'has --help', group: 'P3', evidence: 'OK' },
    {
      status: 'fail',
      label: 'exits 0 on missing flag',
      group: 'P4',
      evidence: 'expected non-zero exit, got 0',
    },
    { status: 'warn', label: 'subcommands listed', group: 'P6', evidence: 'missing groups' },
    { status: 'pass', label: 'streams stdout', group: 'P1', evidence: 'OK' },
  ],
};

const CACHED_RIPGREP_KEY = keyFor('ripgrep', SPEC_VERSION);
const CACHED_RIPGREP_PAYLOAD = {
  spec_version: SPEC_VERSION,
  anc_version: ANC_VERSION,
  tool_version: '14.1.0',
  scorecard: SAMPLE_SCORECARD,
};

// Registry-index fixture for redirect tests. Empty `by_slug` by default so
// the curated-tool short-circuit doesn't fire; tests that exercise the
// redirect override `opts.registry` with curated entries.
const EMPTY_REGISTRY_INDEX = { by_slug: {}, by_owner_repo: {} };

type MakeEnvOpts = { registry?: { by_slug: Record<string, unknown>; by_owner_repo: Record<string, unknown> } };

function makeEnv(content: Record<string, unknown> = {}, opts: MakeEnvOpts = {}) {
  const store = new Map<string, string>();
  for (const [k, v] of Object.entries(content)) {
    store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const registryIndex = opts.registry ?? EMPTY_REGISTRY_INDEX;
  const env = {
    ASSETS: {
      async fetch(req: Request | string) {
        const url = typeof req === 'string' ? req : req.url;
        const path = new URL(url).pathname;
        if (path === '/_internal/score-live-shell.html') {
          return new Response(SHELL_TEMPLATE, { status: 200 });
        }
        if (path === '/registry-index.json') {
          return new Response(JSON.stringify(registryIndex), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      },
    },
    SCORE_CACHE: {
      async get(key: string) {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return {
          async json() {
            return JSON.parse(raw);
          },
          async text() {
            return raw;
          },
        };
      },
      async put(key: string, value: unknown) {
        store.set(key, typeof value === 'string' ? value : String(value));
      },
      async delete(key: string) {
        store.delete(key);
      },
    },
  };
  // Reset module-level caches so each test re-fetches fixtures fresh.
  _resetShellTemplateCache();
  _resetRegistryIndexCache();
  return env as unknown as { ASSETS: Fetcher; SCORE_CACHE: R2Bucket };
}

function get(path: string): Request {
  return new Request(`https://anc.dev${path}`, { method: 'GET' });
}

describe('parseLiveScorePath', () => {
  test('accepts /score/live/<binary> with lowercase alphanumeric + hyphen', () => {
    expect(parseLiveScorePath('/score/live/ripgrep')).toBe('ripgrep');
    expect(parseLiveScorePath('/score/live/ast-grep')).toBe('ast-grep');
    expect(parseLiveScorePath('/score/live/btm')).toBe('btm');
    expect(parseLiveScorePath('/score/live/aider2')).toBe('aider2');
  });

  test('rejects uppercase, dots (non-.md), slashes (path traversal guard)', () => {
    expect(parseLiveScorePath('/score/live/RipGrep')).toBeNull();
    expect(parseLiveScorePath('/score/live/ripgrep.json')).toBeNull();
    expect(parseLiveScorePath('/score/live/ripgrep.html')).toBeNull();
    expect(parseLiveScorePath('/score/live/../etc/passwd')).toBeNull();
    expect(parseLiveScorePath('/score/live/foo/bar')).toBeNull();
    expect(parseLiveScorePath('/score/live/foo bar')).toBeNull();
  });

  test('accepts .md suffix and reports isMarkdown', () => {
    expect(parseLiveScorePathMatch('/score/live/ripgrep')).toEqual({ binary: 'ripgrep', isMarkdown: false });
    expect(parseLiveScorePathMatch('/score/live/ripgrep.md')).toEqual({ binary: 'ripgrep', isMarkdown: true });
    expect(parseLiveScorePathMatch('/score/live/ast-grep.md')).toEqual({ binary: 'ast-grep', isMarkdown: true });
  });

  test('rejects malformed .md paths', () => {
    expect(parseLiveScorePathMatch('/score/live/.md')).toBeNull();
    expect(parseLiveScorePathMatch('/score/live/ripgrep.md.md')).toBeNull();
    expect(parseLiveScorePathMatch('/score/live/ripgrep.MD')).toBeNull();
    expect(parseLiveScorePathMatch('/score/live/../etc.md')).toBeNull();
  });

  test('rejects leading hyphen + over-long slugs', () => {
    expect(parseLiveScorePath('/score/live/-ripgrep')).toBeNull();
    expect(parseLiveScorePath(`/score/live/${'a'.repeat(65)}`)).toBeNull();
  });

  test('rejects empty + bare prefix paths', () => {
    expect(parseLiveScorePath('/score/live/')).toBeNull();
    expect(parseLiveScorePath('/live-score')).toBeNull();
    expect(parseLiveScorePath('/livescore/ripgrep')).toBeNull();
  });

  test('rejects /api/score and /score (curated) namespaces', () => {
    expect(parseLiveScorePath('/api/score/ripgrep')).toBeNull();
    expect(parseLiveScorePath('/score/ripgrep')).toBeNull();
  });
});

describe('handleLiveScorePage — happy path', () => {
  test('returns 200 HTML with rendered scorecard summary', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    const html = await res.text();
    expect(html).toContain('<title>ripgrep');
    expect(html).toContain('92%');
    expect(html).toContain('14.1.0');
    expect(html).toContain(ANC_VERSION); // anc version
    expect(html).toContain('exits 0 on missing flag'); // top issue
    expect(html).toContain('subcommands listed'); // top issue
    expect(html).toContain('href="/install"'); // canonical install link (dedup with content/install.md)
    expect(html).toContain('https://anc.dev/score/live/ripgrep'); // canonical
  });

  test('top-issues block surfaces FAIL before WARN', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    const html = await res.text();
    const failIdx = html.indexOf('exits 0 on missing flag');
    const warnIdx = html.indexOf('subcommands listed');
    expect(failIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(-1);
    expect(failIdx).toBeLessThan(warnIdx);
  });

  test('renders full audit groups and details block at parity with static /score/<tool>', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    const html = await res.text();
    expect(html).toContain('scorecard-audits');
    expect(html).toContain('All Audits');
    expect(html).toContain('audit-group');
    expect(html).toContain('audit-table');
    expect(html).toContain('scorecard-meta');
    expect(html).toContain('Version scored');
    // Every check from results appears in the full audit table.
    expect(html).toContain('has --help');
    expect(html).toContain('streams stdout');
  });

  test('renders principle-met badge alongside score badge', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    const html = await res.text();
    expect(html).toContain('scorecard-principle-badge');
    expect(html).toContain('principles met');
    // SAMPLE_SCORECARD: P1 + P3 pass; P4 fail, P6 warn — 2/8 met.
    expect(html).toContain('2/8');
  });

  test('renders eligible embed snippet when scorecard clears the badge floor', async () => {
    const eligiblePayload = {
      ...CACHED_RIPGREP_PAYLOAD,
      scorecard: {
        ...SAMPLE_SCORECARD,
        badge: {
          score_pct: 92,
          eligible: true,
          embed_markdown: '[![agent-native](https://anc.dev/badge/ripgrep.svg)](https://anc.dev/score/ripgrep)',
        },
      },
    };
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: eligiblePayload });
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    const html = await res.text();
    expect(html).toContain('scorecard-embed--eligible');
    expect(html).toContain('Embed the badge');
    // Embed markdown is HTML-escaped inside a <pre><code>.
    expect(html).toContain('https://anc.dev/badge/ripgrep.svg');
  });

  test('renders below-floor hint instead of embed when scorecard is below the floor', async () => {
    const belowFloorPayload = {
      ...CACHED_RIPGREP_PAYLOAD,
      scorecard: {
        ...SAMPLE_SCORECARD,
        badge: { score_pct: 42, eligible: false },
      },
    };
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: belowFloorPayload });
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    const html = await res.text();
    expect(html).toContain('scorecard-embed--below');
    expect(html).toContain('badge floor');
    expect(html).not.toContain('scorecard-embed--eligible');
  });

  test('renders reproduce CTA with target.kind=command invocation verbatim', async () => {
    const invocationPayload = {
      ...CACHED_RIPGREP_PAYLOAD,
      scorecard: {
        ...SAMPLE_SCORECARD,
        target: { kind: 'command', command: 'rg' },
        run: { invocation: 'anc audit --command rg', started_at: '2026-05-01T12:00:00Z' },
      },
    };
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: invocationPayload });
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    const html = await res.text();
    expect(html).toContain('scorecard-cta');
    expect(html).toContain('anc audit --command rg');
  });

  test('renders cached freshness marker', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    const html = await res.text();
    expect(html).toContain('cached');
  });

  test('clean scorecard shows all-principles-met message', async () => {
    const cleanPayload = {
      ...CACHED_RIPGREP_PAYLOAD,
      scorecard: {
        ...SAMPLE_SCORECARD,
        results: [{ status: 'pass', label: 'all good', group: 'P1', evidence: 'OK' }],
      },
    };
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: cleanPayload });
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    const html = await res.text();
    expect(html).toContain('no issues found');
  });
});

describe('handleLiveScorePage — 404 + edge cases', () => {
  test('returns 404 HTML for missing cache entry', async () => {
    const env = makeEnv();
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('No live score for');
    expect(html).toContain('ripgrep');
    expect(html).toContain('Score it now');
  });

  test('returns 404 for slug shape violation (path traversal)', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    const res = await handleLiveScorePage(get('/score/live/../etc'), env);
    expect(res.status).toBe(404);
  });

  test('405 for non-GET/HEAD methods', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      const res = await handleLiveScorePage(new Request('https://anc.dev/score/live/ripgrep', { method }), env);
      expect(res.status).toBe(405);
    }
  });

  test('HEAD returns 200 + body (cheap; matches GET semantics)', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    const res = await handleLiveScorePage(new Request('https://anc.dev/score/live/ripgrep', { method: 'HEAD' }), env);
    expect(res.status).toBe(200);
  });

  test('500 + plain-text when shell template asset missing (defense in depth)', async () => {
    const store = new Map<string, string>();
    store.set(CACHED_RIPGREP_KEY, JSON.stringify(CACHED_RIPGREP_PAYLOAD));
    const env = {
      ASSETS: {
        async fetch() {
          return new Response('not found', { status: 404 });
        },
      },
      SCORE_CACHE: {
        async get(key: string) {
          const raw = store.get(key);
          if (raw === undefined) return null;
          return {
            async json() {
              return JSON.parse(raw);
            },
            async text() {
              return raw;
            },
          };
        },
        async put() {},
        async delete() {},
      },
    } as unknown as { ASSETS: Fetcher; SCORE_CACHE: R2Bucket };
    _resetShellTemplateCache();
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  test('returns 404 + does not expose raw user input as HTML in error page', async () => {
    // Red-team: send a slug that bypasses parseLiveScorePath (it shouldn't),
    // but if it did, ensure the 404 page escapes the binary name. Since
    // parseLiveScorePath rejects anything outside [a-z0-9-], a clean slug
    // is still escaped by the renderer. Cover that path explicitly.
    const env = makeEnv();
    const res = await handleLiveScorePage(get('/score/live/foo-bar'), env);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('No live score for');
    // The 404 path uses esc() — confirm by sending a slug with a hyphen.
    expect(html).toContain('foo-bar');
  });
});

describe('handleLiveScorePage — curated-tool redirect', () => {
  // /score/live/<binary> is for non-registry binaries. Anything matching a
  // curated tool (by name OR alias binary) MUST 301 to /score/<slug>.
  const RIPGREP_ENTRY = { name: 'ripgrep', binary: 'rg', install: 'brew install ripgrep' };
  const ANC_ENTRY = { name: 'anc', binary: 'anc', install: 'brew install brettdavies/tap/anc' };
  const CURATED_REGISTRY = {
    by_slug: { ripgrep: RIPGREP_ENTRY, anc: ANC_ENTRY },
    by_owner_repo: {},
  };

  test('redirects /score/live/<curated-name> to /score/<name>', async () => {
    const env = makeEnv({}, { registry: CURATED_REGISTRY });
    const res = await handleLiveScorePage(get('/score/live/anc'), env);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/score/anc');
  });

  test('redirects /score/live/<curated-binary-alias> to /score/<name>', async () => {
    // ripgrep is registered as name=ripgrep, binary=rg. A user (or stale
    // cache entry) landing at /score/live/rg should bounce to /score/ripgrep,
    // not render at the live path.
    const env = makeEnv({}, { registry: CURATED_REGISTRY });
    const res = await handleLiveScorePage(get('/score/live/rg'), env);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/score/ripgrep');
  });

  test('preserves .md suffix through the redirect', async () => {
    const env = makeEnv({}, { registry: CURATED_REGISTRY });
    const res = await handleLiveScorePage(get('/score/live/anc.md'), env);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/score/anc.md');
  });

  test('Accept: text/markdown on the no-suffix path also redirects to .md', async () => {
    const env = makeEnv({}, { registry: CURATED_REGISTRY });
    const req = new Request('https://anc.dev/score/live/anc', {
      method: 'GET',
      headers: { accept: 'text/markdown' },
    });
    const res = await handleLiveScorePage(req, env);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/score/anc.md');
  });

  test('redirect fires even when an R2 cache entry exists for the curated binary', async () => {
    // Defense-in-depth: the cache may carry a stale write for a binary that
    // has since been added to the registry. The redirect MUST win.
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD }, { registry: CURATED_REGISTRY });
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/score/ripgrep');
  });

  test('non-registry binary still renders normally (no false-positive redirect)', async () => {
    const env = makeEnv(
      { [keyFor('cowsay', SPEC_VERSION)]: { ...CACHED_RIPGREP_PAYLOAD } },
      { registry: CURATED_REGISTRY },
    );
    const res = await handleLiveScorePage(get('/score/live/cowsay'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  test('registry-index asset fetch failure falls through (does not 5xx the live path)', async () => {
    // If the registry-index asset is unavailable, the live path proceeds
    // without the curated check rather than failing closed.
    const store = new Map<string, string>();
    store.set(CACHED_RIPGREP_KEY, JSON.stringify(CACHED_RIPGREP_PAYLOAD));
    const env = {
      ASSETS: {
        async fetch(req: Request | string) {
          const url = typeof req === 'string' ? req : req.url;
          const path = new URL(url).pathname;
          if (path === '/_internal/score-live-shell.html') {
            return new Response(SHELL_TEMPLATE, { status: 200 });
          }
          return new Response('not found', { status: 404 });
        },
      },
      SCORE_CACHE: {
        async get(key: string) {
          const raw = store.get(key);
          if (raw === undefined) return null;
          return {
            async json() {
              return JSON.parse(raw);
            },
            async text() {
              return raw;
            },
          };
        },
        async put() {},
        async delete() {},
      },
    } as unknown as { ASSETS: Fetcher; SCORE_CACHE: R2Bucket };
    _resetShellTemplateCache();
    _resetRegistryIndexCache();
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    expect(res.status).toBe(200);
  });
});

describe('handleLiveScorePage — markdown twin', () => {
  test('GET /score/live/<binary>.md returns text/markdown with full scorecard', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    const res = await handleLiveScorePage(get('/score/live/ripgrep.md'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const md = await res.text();
    expect(md).toContain('# ripgrep');
    expect(md).toContain('**Score:** 92% pass rate');
    expect(md).toContain('**Principles:**');
    expect(md).toContain('## Embed the badge');
    expect(md).toContain('## Reproduce locally');
    // Full audit table inlined under the embed section, same shape as the
    // static /score/<slug>.md twin (single source of truth).
    expect(md).toContain('| FAIL | exits 0 on missing flag |');
    expect(md).toContain('| PASS | has --help |');
    expect(md).toContain('https://anc.dev/p4'); // absolute principle link
    expect(md).not.toContain('<'); // no HTML tags in markdown twin
  });

  test('Accept: text/markdown on /score/live/<binary> returns markdown', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    const req = new Request('https://anc.dev/score/live/ripgrep', {
      method: 'GET',
      headers: { accept: 'text/markdown' },
    });
    const res = await handleLiveScorePage(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const md = await res.text();
    expect(md).toContain('# ripgrep');
  });

  test('Accept: text/html on /score/live/<binary> returns HTML (default)', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    const req = new Request('https://anc.dev/score/live/ripgrep', {
      method: 'GET',
      headers: { accept: 'text/html' },
    });
    const res = await handleLiveScorePage(req, env);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  test('404 markdown response for missing cache entry', async () => {
    const env = makeEnv();
    const res = await handleLiveScorePage(get('/score/live/ripgrep.md'), env);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const md = await res.text();
    expect(md).toContain('# No live score for `ripgrep` yet');
    expect(md).toContain('homepage');
  });

  test('markdown escapes pipe characters in evidence to preserve table shape', async () => {
    const pipeXssPayload = {
      ...CACHED_RIPGREP_PAYLOAD,
      scorecard: {
        ...SAMPLE_SCORECARD,
        results: [
          {
            status: 'fail',
            label: 'pipeline check',
            group: 'P3',
            evidence: 'cmd | grep foo | head -1',
          },
        ],
      },
    };
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: pipeXssPayload });
    const res = await handleLiveScorePage(get('/score/live/ripgrep.md'), env);
    const md = await res.text();
    expect(md).toContain('cmd \\| grep foo \\| head -1');
  });

  test('Accept q-weighted header picks markdown when text/markdown wins', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    const req = new Request('https://anc.dev/score/live/ripgrep', {
      method: 'GET',
      headers: { accept: 'text/html;q=0.1, text/markdown;q=0.9' },
    });
    const res = await handleLiveScorePage(req, env);
    expect(res.headers.get('content-type')).toContain('text/markdown');
  });
});

describe('handleLiveScorePage — HTML escape sanity', () => {
  test('escapes scorecard.results.evidence to prevent HTML injection', async () => {
    const xssPayload = {
      ...CACHED_RIPGREP_PAYLOAD,
      scorecard: {
        ...SAMPLE_SCORECARD,
        results: [
          {
            status: 'fail',
            label: '<script>alert(1)</script>',
            group: 'P1',
            evidence: '<img src=x onerror=alert(2)>',
          },
        ],
      },
    };
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: xssPayload });
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    const html = await res.text();
    // Neither <script> nor <img onerror> should appear raw — they must
    // be entity-escaped before reaching the response body.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
  });

  test('escapes tool.name and binary fields', async () => {
    const xssPayload = {
      ...CACHED_RIPGREP_PAYLOAD,
      scorecard: { ...SAMPLE_SCORECARD, tool: { name: '<svg/onload=alert(3)>', binary: 'rg' } },
    };
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: xssPayload });
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    const html = await res.text();
    expect(html).not.toContain('<svg/onload=alert(3)>');
    expect(html).toContain('&lt;svg');
  });
});
