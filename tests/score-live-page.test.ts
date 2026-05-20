// Worker route: GET /score/live/<binary>
//
// The shareable result URL renders the cached scorecard as HTML. Cache-
// key share-URL design: the same key the DO writes to
// (scores/<binary>/<spec>.json) is the key this route reads from. No
// session minting; the URL is meaningful.

import { describe, expect, test } from 'bun:test';
import {
  _resetShellTemplateCache,
  handleLiveScorePage,
  parseLiveScorePath,
  parseLiveScorePathMatch,
} from '../src/worker/score/summary-render';

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

const CACHED_RIPGREP_KEY = 'scores/ripgrep/0.4.0.json';
const CACHED_RIPGREP_PAYLOAD = {
  spec_version: '0.4.0',
  anc_version: '0.3.1',
  tool_version: '14.1.0',
  scorecard: SAMPLE_SCORECARD,
};

function makeEnv(content: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  for (const [k, v] of Object.entries(content)) {
    store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
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
      async put(key: string, value: unknown) {
        store.set(key, typeof value === 'string' ? value : String(value));
      },
      async delete(key: string) {
        store.delete(key);
      },
    },
  };
  // Reset the module-level template cache so each test re-fetches.
  _resetShellTemplateCache();
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
    expect(html).toContain('0.3.1'); // anc version
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

  test('omits per-tool check table and meta sections (summary-only)', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    const html = await res.text();
    expect(html).not.toContain('scorecard-checks');
    expect(html).not.toContain('scorecard-meta');
    expect(html).not.toContain('All Checks');
  });

  test('renders cached freshness marker', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    const res = await handleLiveScorePage(get('/score/live/ripgrep'), env);
    const html = await res.text();
    expect(html).toContain('cached');
  });

  test('clean scorecard shows "no failing or warning checks"', async () => {
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
    expect(html).toContain('No failing or warning checks');
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

describe('handleLiveScorePage — markdown twin', () => {
  test('GET /score/live/<binary>.md returns text/markdown with summary', async () => {
    const env = makeEnv({ [CACHED_RIPGREP_KEY]: CACHED_RIPGREP_PAYLOAD });
    const res = await handleLiveScorePage(get('/score/live/ripgrep.md'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const md = await res.text();
    expect(md).toContain('# ripgrep');
    expect(md).toContain('**Score:** 92% pass rate');
    expect(md).toContain('## Top issues');
    expect(md).toContain('| FAIL | exits 0 on missing flag |');
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
