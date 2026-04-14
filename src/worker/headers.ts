// Response-header policy for the agentnative-site Worker.
//
// Contract (DESIGN.md §3.4 + eng review A8, A10, A12, P4):
//
//   HTML responses         Link: </p<n>.md>; rel="alternate"; type="text/markdown"
//                          X-Llms-Txt: /llms.txt
//                          Cache-Control: public, max-age=300, s-maxage=86400,
//                                         stale-while-revalidate=60
//
//   Markdown responses     Content-Type: text/markdown; charset=utf-8
//                          X-Robots-Tag: noindex
//                          Cache-Control: public, max-age=300, s-maxage=86400,
//                                         stale-while-revalidate=60
//
//   Hashed assets          Cache-Control: public, max-age=31536000, immutable
//   (/fonts/*, /og-image.png)
//
//   Staging guard (P4 +    X-Robots-Tag: noindex on every response whose
//    locked decision #4)   Host ends with `.workers.dev`. Added LAST so it
//                          composes with the markdown branch (both set
//                          noindex; last write wins, same value either way).

const SHORT_CACHE = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=60';
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

export interface ApplyHeadersOptions {
  request: Request;
  servedMarkdown: boolean;
  pathname: string;
}

/** `true` when the Host header ends with `.workers.dev` — the staging origin. */
export function isStagingHost(host: string): boolean {
  return host.endsWith('.workers.dev');
}

function markdownTwinFor(pathname: string): string {
  if (pathname === '/') return '/index.md';
  // Strip trailing slash and optional `.html` before appending `.md`.
  const normalized = pathname.replace(/\/$/, '').replace(/\.html$/, '');
  return `${normalized}.md`;
}

function isHashedAsset(pathname: string): boolean {
  return pathname.startsWith('/fonts/') || pathname === '/og-image.png';
}

/**
 * Clone the response and replace its header set with the project's policy.
 * We clone so upstream 304 / redirect status codes flow through unchanged.
 */
export function applyHeaders(response: Response, opts: ApplyHeadersOptions): Response {
  const headers = new Headers(response.headers);
  const url = new URL(opts.request.url);

  if (opts.servedMarkdown) {
    headers.set('Content-Type', 'text/markdown; charset=utf-8');
    headers.set('X-Robots-Tag', 'noindex');
    headers.set('Cache-Control', SHORT_CACHE);
  } else if (isHashedAsset(opts.pathname)) {
    headers.set('Cache-Control', IMMUTABLE_CACHE);
  } else {
    headers.set('Link', `<${markdownTwinFor(opts.pathname)}>; rel="alternate"; type="text/markdown"`);
    headers.set('X-Llms-Txt', '/llms.txt');
    headers.set('Cache-Control', SHORT_CACHE);
  }

  // Staging guard — three-line check per locked decision #4. Applied LAST so
  // a dev who overrides upstream headers still gets noindex on *.workers.dev.
  if (isStagingHost(url.host)) {
    headers.set('X-Robots-Tag', 'noindex');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
