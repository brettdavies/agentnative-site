// Content-negotiation + header-policy tests for the Worker.
//
// Covers every row of the decision table in docs/DESIGN.md §3.4 / eng review §3
// diagram, plus the Link/X-Llms-Txt/X-Robots-Tag/Cache-Control assertions
// from A8 and P4, plus the staging-host guard (locked decision #4).
//
// We exercise the handler end-to-end against a stubbed env.ASSETS fetcher —
// no wrangler dev needed.

import { describe, expect, test } from 'bun:test';
import { detectPreference } from '../src/worker/accept';
import { applyHeaders, isStagingHost } from '../src/worker/headers';
import worker from '../src/worker/index';

function req(url: string, accept?: string): Request {
  const headers: Record<string, string> = {};
  if (accept !== undefined) headers.accept = accept;
  return new Request(url, { headers });
}

/**
 * Return a stub env.ASSETS whose fetch echoes the requested URL back in
 * both body text and a custom header. The handler under test sees this as
 * an opaque upstream response and layers its own headers on top.
 */
function makeEnv(bodyByPath: Record<string, string> = {}) {
  return {
    ASSETS: {
      async fetch(request: Request | string): Promise<Response> {
        const url = typeof request === 'string' ? request : request.url;
        const path = new URL(url).pathname;
        const body = bodyByPath[path] ?? `asset:${path}`;
        return new Response(body, {
          status: 200,
          headers: { 'X-Echo-Path': path },
        });
      },
    } as unknown as Fetcher,
  };
}

// ---------------------------------------------------------------------------
// detectPreference — the q-value parsing matrix (eng review §3 diagram).
// ---------------------------------------------------------------------------

describe('detectPreference — content-negotiation decision table', () => {
  test('no Accept header → html (markdown is opt-in)', () => {
    expect(detectPreference(req('https://x/p3'))).toBe('html');
  });

  test('Accept: */* → html (first in our preference list)', () => {
    expect(detectPreference(req('https://x/p3', '*/*'))).toBe('html');
  });

  test('Accept: text/html → html', () => {
    expect(detectPreference(req('https://x/p3', 'text/html'))).toBe('html');
  });

  test('Accept: text/markdown → markdown', () => {
    expect(detectPreference(req('https://x/p3', 'text/markdown'))).toBe('markdown');
  });

  test('Accept: text/html,text/markdown;q=0.9 → html (higher q)', () => {
    expect(detectPreference(req('https://x/p3', 'text/html,text/markdown;q=0.9'))).toBe('html');
  });

  test('Accept: text/markdown,text/html;q=0.9 → markdown (higher q)', () => {
    expect(detectPreference(req('https://x/p3', 'text/markdown,text/html;q=0.9'))).toBe('markdown');
  });

  test('Accept: text/markdown;q=0.9,text/html → html (html implicit q=1 wins)', () => {
    expect(detectPreference(req('https://x/p3', 'text/markdown;q=0.9,text/html'))).toBe('html');
  });

  test('Accept: application/json → html (neither accepted type matches; fallback to html)', () => {
    expect(detectPreference(req('https://x/p3', 'application/json'))).toBe('html');
  });

  test('malformed Accept → html (graceful fallback)', () => {
    expect(detectPreference(req('https://x/p3', 'garbage,,,;;;'))).toBe('html');
  });
});

// ---------------------------------------------------------------------------
// isStagingHost — the three-line guard.
// ---------------------------------------------------------------------------

describe('isStagingHost', () => {
  test('matches *.workers.dev', () => {
    expect(isStagingHost('agentnative-site.brett.workers.dev')).toBe(true);
    expect(isStagingHost('something.workers.dev')).toBe(true);
  });

  test('does not match production domain', () => {
    expect(isStagingHost('agentnative.dev')).toBe(false);
    expect(isStagingHost('localhost:8787')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Header policy (A8 + P4).
// ---------------------------------------------------------------------------

describe('applyHeaders — HTML branch', () => {
  test('/p3 HTML: Link rel=alternate + X-Llms-Txt + short cache', () => {
    const res = applyHeaders(new Response('html'), {
      request: req('https://agentnative.dev/p3'),
      servedMarkdown: false,
      pathname: '/p3',
    });
    expect(res.headers.get('Link')).toBe('</p3.md>; rel="alternate"; type="text/markdown"');
    expect(res.headers.get('X-Llms-Txt')).toBe('/llms.txt');
    expect(res.headers.get('Cache-Control')).toContain('stale-while-revalidate=60');
    expect(res.headers.get('X-Robots-Tag')).toBeNull();
  });

  test('/ HTML: Link points to /index.md', () => {
    const res = applyHeaders(new Response('html'), {
      request: req('https://agentnative.dev/'),
      servedMarkdown: false,
      pathname: '/',
    });
    expect(res.headers.get('Link')).toBe('</index.md>; rel="alternate"; type="text/markdown"');
  });
});

describe('applyHeaders — markdown branch', () => {
  test('/p3.md: Content-Type + X-Robots-Tag noindex + short cache', () => {
    const res = applyHeaders(new Response('md'), {
      request: req('https://agentnative.dev/p3.md'),
      servedMarkdown: true,
      pathname: '/p3.md',
    });
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Link')).toBeNull();
  });
});

describe('applyHeaders — hashed assets', () => {
  test('/fonts/* gets immutable cache', () => {
    const res = applyHeaders(new Response('woff2'), {
      request: req('https://agentnative.dev/fonts/uncut-sans-variable.woff2'),
      servedMarkdown: false,
      pathname: '/fonts/uncut-sans-variable.woff2',
    });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  test('/og-image.png gets immutable cache', () => {
    const res = applyHeaders(new Response('png'), {
      request: req('https://agentnative.dev/og-image.png'),
      servedMarkdown: false,
      pathname: '/og-image.png',
    });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });
});

describe('applyHeaders — staging-host guard (locked decision #4)', () => {
  test('HTML on .workers.dev gets X-Robots-Tag: noindex', () => {
    const res = applyHeaders(new Response('html'), {
      request: req('https://agentnative-site.brett.workers.dev/p3'),
      servedMarkdown: false,
      pathname: '/p3',
    });
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    // Link + X-Llms-Txt still present on HTML.
    expect(res.headers.get('Link')).toContain('rel="alternate"');
  });

  test('fonts on .workers.dev still immutable-cached AND noindex', () => {
    const res = applyHeaders(new Response('woff2'), {
      request: req('https://agentnative-site.brett.workers.dev/fonts/uncut-sans-variable.woff2'),
      servedMarkdown: false,
      pathname: '/fonts/uncut-sans-variable.woff2',
    });
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  test('production host does NOT get noindex on HTML', () => {
    const res = applyHeaders(new Response('html'), {
      request: req('https://agentnative.dev/p3'),
      servedMarkdown: false,
      pathname: '/p3',
    });
    expect(res.headers.get('X-Robots-Tag')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end handler: asset-lookup rewrite for the markdown branch.
// ---------------------------------------------------------------------------

describe('worker.fetch — CN rewrite + asset lookup', () => {
  test('/p3 no Accept → fetches /p3 (HTML, auto-trailing-slash resolves to p3.html)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://agentnative.dev/p3'), env);
    expect(res.headers.get('X-Echo-Path')).toBe('/p3');
    expect(res.headers.get('Link')).toContain('</p3.md>');
  });

  test('/p3 with Accept: text/markdown → fetches /p3.md (rewritten)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://agentnative.dev/p3', 'text/markdown'), env);
    expect(res.headers.get('X-Echo-Path')).toBe('/p3.md');
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  test('/p3.md any Accept → fetches /p3.md (suffix wins)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://agentnative.dev/p3.md', 'text/html'), env);
    expect(res.headers.get('X-Echo-Path')).toBe('/p3.md');
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
  });

  test('/ with Accept: text/markdown → fetches /index.md', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://agentnative.dev/', 'text/markdown'), env);
    expect(res.headers.get('X-Echo-Path')).toBe('/index.md');
  });

  test('/p3 with Accept: text/html,text/markdown;q=0.9 → HTML branch', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://agentnative.dev/p3', 'text/html,text/markdown;q=0.9'), env);
    expect(res.headers.get('X-Echo-Path')).toBe('/p3');
  });

  test('/p3 with */* → HTML branch', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://agentnative.dev/p3', '*/*'), env);
    expect(res.headers.get('X-Echo-Path')).toBe('/p3');
  });

  test('/p3 with malformed Accept → HTML branch', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://agentnative.dev/p3', 'garbage,,,;;;'), env);
    expect(res.headers.get('X-Echo-Path')).toBe('/p3');
  });

  test('staging .workers.dev: HTML branch still adds noindex', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://agentnative-site.brett.workers.dev/p3'), env);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Link')).toContain('</p3.md>');
  });
});
