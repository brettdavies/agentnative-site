// Black-box test skeleton for an agent-facing web surface, distilled from
// agentnative-site tests/worker.test.ts
// @ 6c120df73e3b63659c586b537e3e3c90dad0907e.
// The live file at that repo's HEAD is the authoritative robust version;
// this is a starting skeleton to adapt.
//
// Adapt: replace the declare block with imports from your own handler,
// swap every YOUR_* placeholder, and run the suite red before wiring
// behavior. The declares keep this file parseable offline without
// shipping any implementation.

import { describe, expect, test } from 'bun:test';

// Replace with your real imports, e.g.:
// import { detectPreference } from '../src/worker/accept';
// import { applyHeaders } from '../src/worker/headers';
declare function detectPreference(request: Request): 'html' | 'markdown';
declare function applyHeaders(
  response: Response,
  ctx: { request: Request; servedMarkdown: boolean; pathname: string },
): Response;

const PAGE = '/YOUR_PAGE_ROUTE';
const JSON_ROUTE = '/YOUR_ENDPOINT.json';
const ORIGIN = 'https://YOUR_HOST';

// Real production User-Agent shapes so allowlist regressions catch real
// UA drift; add the fetchers your surface routes on.
const UA = {
  cli: 'curl/8.7.1',
  browser:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
} as const;

function req(url: string, accept?: string, ua?: string): Request {
  const headers: Record<string, string> = {};
  if (accept !== undefined) headers.accept = accept;
  if (ua !== undefined) headers['user-agent'] = ua;
  return new Request(url, { headers });
}

// P2 analog: content negotiation is the structured-output contract of a
// web surface. Explicit Accept wins; q-values are honored; malformed
// input falls back safely.
describe('content negotiation decision table', () => {
  test('no Accept header falls back to the default branch', () => {
    expect(detectPreference(req(`${ORIGIN}${PAGE}`))).toBe('html');
  });

  test('explicit machine-readable Accept selects the machine branch', () => {
    expect(detectPreference(req(`${ORIGIN}${PAGE}`, 'text/markdown'))).toBe('markdown');
  });

  test('higher q-value wins', () => {
    expect(detectPreference(req(`${ORIGIN}${PAGE}`, 'text/markdown,text/html;q=0.9'))).toBe('markdown');
  });

  test('implicit q=1 beats a lower explicit q', () => {
    expect(detectPreference(req(`${ORIGIN}${PAGE}`, 'text/markdown;q=0.9,text/html'))).toBe('html');
  });

  test('malformed Accept falls back gracefully', () => {
    expect(detectPreference(req(`${ORIGIN}${PAGE}`, 'garbage,,,;;;'))).toBe('html');
  });
});

// P2 analog: User-Agent routing fires only when Accept expresses no
// preference; explicit Accept always wins over the UA path.
describe('User-Agent allowlist', () => {
  test('*/* plus an allowlisted CLI UA selects the machine branch', () => {
    expect(detectPreference(req(`${ORIGIN}${PAGE}`, '*/*', UA.cli))).toBe('markdown');
  });

  test('explicit Accept wins over an allowlisted UA', () => {
    expect(detectPreference(req(`${ORIGIN}${PAGE}`, 'text/html', UA.cli))).toBe('html');
  });

  test('*/* plus a browser UA stays on the default branch', () => {
    expect(detectPreference(req(`${ORIGIN}${PAGE}`, '*/*', UA.browser))).toBe('html');
  });
});

// P3 analog: response headers are the discovery surface. Assert the
// policy per branch: content type, CORS, caching, robots directives.
describe('header policy per branch', () => {
  test('machine branch sets its Content-Type and robots directive', () => {
    const res = applyHeaders(new Response('md'), {
      request: req(`${ORIGIN}${PAGE}.md`),
      servedMarkdown: true,
      pathname: `${PAGE}.md`,
    });
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  test('default branch advertises its machine twin', () => {
    const res = applyHeaders(new Response('html'), {
      request: req(`${ORIGIN}${PAGE}`),
      servedMarkdown: false,
      pathname: PAGE,
    });
    expect(res.headers.get('Link')).toContain('rel="alternate"');
    expect(res.headers.get('Vary')).toBe('Accept, User-Agent');
  });

  test('JSON branch sets its content type and CORS policy', () => {
    const res = applyHeaders(new Response('{}'), {
      request: req(`${ORIGIN}${JSON_ROUTE}`),
      servedMarkdown: false,
      pathname: JSON_ROUTE,
    });
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
