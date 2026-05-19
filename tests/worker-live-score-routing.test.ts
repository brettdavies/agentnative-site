// Worker entry routing for /live-score/* paths.
//
// Plan U8: live-score URL pattern matches the rest of the site —
// `/live-score/<binary>` is the canonical no-extension form. `.md` is the
// markdown twin. `.html` redirects to the canonical form (mirrors the
// CF Static Assets html_handling=auto-trailing-slash behavior for the
// curated /score/<tool> static pages).
//
// Also verifies the homepage's {{TURNSTILE_SITEKEY}} placeholder is
// substituted at request time so production cuts ship empty (fail-loud)
// while staging gets the always-passes test sitekey.

import { beforeEach, describe, expect, test } from 'bun:test';
import worker, { type Env } from '../src/worker/index';
import { _resetShellTemplateCache } from '../src/worker/score/summary-render';

const SHELL_TEMPLATE = `<!doctype html>
<html><head><title>{{TITLE}}</title></head>
<body>{{BODY}}</body></html>`;

const HOMEPAGE_HTML = `<!doctype html>
<html><head>
<title>anc.dev</title>
<meta name="turnstile-sitekey" content="{{TURNSTILE_SITEKEY}}" />
</head><body><form data-live-score-form></form></body></html>`;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: {
      async fetch(req: Request | string) {
        const url = typeof req === 'string' ? req : req.url;
        const path = new URL(url).pathname;
        if (path === '/' || path === '/index.html') {
          return new Response(HOMEPAGE_HTML, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        if (path === '/index.md') {
          return new Response('# anc.dev\n\nThe agent-native CLI standard.\n', {
            status: 200,
            headers: { 'content-type': 'text/markdown; charset=utf-8' },
          });
        }
        if (path === '/_internal/live-score-shell.html') {
          return new Response(SHELL_TEMPLATE, { status: 200 });
        }
        return new Response('not found', { status: 404 });
      },
    } as Fetcher,
    SCORE_KV: {
      async get() {
        return null;
      },
    } as unknown as KVNamespace,
    ...overrides,
  };
}

beforeEach(() => {
  _resetShellTemplateCache();
});

describe('/live-score URL canonicalization', () => {
  test('/live-score/<binary>.html → 301 redirect to /live-score/<binary>', async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request('https://anc.dev/live-score/ripgrep.html'), env);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/live-score/ripgrep');
  });

  test('/live-score/<binary>.html redirects regardless of cache state', async () => {
    // Redirect is at the routing layer, so it fires before the R2 lookup
    // — a missing cache entry doesn't change the redirect behavior.
    const env = makeEnv();
    const res = await worker.fetch(new Request('https://anc.dev/live-score/unknown-tool.html'), env);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/live-score/unknown-tool');
  });

  test('/live-score/<bad-slug>.html does NOT redirect — falls to ASSETS 404', async () => {
    // Path-traversal guards: shape regex rejects uppercase, dots, slashes.
    const env = makeEnv();
    for (const path of [
      '/live-score/RipGrep.html',
      '/live-score/../etc.html',
      '/live-score/-bad.html',
      '/live-score/foo/bar.html',
    ]) {
      const res = await worker.fetch(new Request(`https://anc.dev${path}`), env);
      // Either a 404 from ASSETS or a 301 — the must-NOT is that the
      // redirect path matches a malformed slug and serves it as canonical.
      expect(res.headers.get('location')).not.toBe(path.replace('.html', ''));
    }
  });

  test('/live-score/<binary>.md → markdown twin (no redirect)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request('https://anc.dev/live-score/ripgrep.md'), env);
    // No cache prefilled → 404, but with markdown content-type (the
    // /live-score handler is what serves it, NOT a static asset).
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/markdown');
  });

  test('/live-score/<binary> (no extension) → handled by handleLiveScorePage', async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request('https://anc.dev/live-score/ripgrep'), env);
    // No cache prefilled → 404 HTML (the canonical route, not a redirect).
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

describe('Homepage TURNSTILE_SITEKEY substitution', () => {
  test('homepage HTML substitutes {{TURNSTILE_SITEKEY}} from env var', async () => {
    const env = makeEnv({ TURNSTILE_SITEKEY: '1x00000000000000000000AA' });
    const res = await worker.fetch(new Request('https://anc.dev/'), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('content="1x00000000000000000000AA"');
    expect(html).not.toContain('{{TURNSTILE_SITEKEY}}');
  });

  test('production (no sitekey set) substitutes empty string', async () => {
    const env = makeEnv(); // TURNSTILE_SITEKEY absent
    const res = await worker.fetch(new Request('https://anc.dev/'), env);
    const html = await res.text();
    // Placeholder must NOT leak through to the response.
    expect(html).not.toContain('{{TURNSTILE_SITEKEY}}');
    // Meta tag still present but with empty content (form JS disables itself).
    expect(html).toContain('content=""');
  });

  test('homepage Accept: text/markdown bypasses substitution (serves index.md)', async () => {
    const env = makeEnv({ TURNSTILE_SITEKEY: 'test-key' });
    const res = await worker.fetch(new Request('https://anc.dev/', { headers: { accept: 'text/markdown' } }), env);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const md = await res.text();
    // The markdown twin must not carry the meta-tag placeholder OR the
    // substituted value. Markdown-twin silence (U8.8) is the build-time
    // invariant; this is the runtime mirror.
    expect(md).not.toContain('{{TURNSTILE_SITEKEY}}');
    expect(md).not.toContain('test-key');
    expect(md).not.toContain('turnstile-sitekey');
  });

  test('non-homepage HTML pages are NOT touched by the substitution', async () => {
    const env = makeEnv({ TURNSTILE_SITEKEY: 'should-not-leak' });
    // A non-homepage asset that doesn't carry the placeholder shouldn't
    // be rewritten — the substitution path is scoped to / and /index.html.
    const res = await worker.fetch(new Request('https://anc.dev/check'), env);
    // ASSETS returns 404 in this stub (no /check.html fixture), so just
    // confirm the path didn't blow up.
    expect(res.status).toBeLessThan(500);
  });
});

describe('/_internal/* interceptor', () => {
  test('direct GET /_internal/live-score-shell.html → 404', async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request('https://anc.dev/_internal/live-score-shell.html'), env);
    expect(res.status).toBe(404);
  });

  test('arbitrary /_internal/anything → 404', async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request('https://anc.dev/_internal/something-else'), env);
    expect(res.status).toBe(404);
  });
});
