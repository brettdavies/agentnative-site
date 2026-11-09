// Plain-text answers the card and clip routes share: never edge-cached, and
// kept out of the index like every response on those paths.

import { applyHeaders } from '../headers';

export function ogMethodNotAllowed(): Response {
  return new Response('method not allowed\n', {
    status: 405,
    headers: { Allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function ogText(request: Request, status: number, body: string, extra?: Record<string, string>): Response {
  const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex', ...extra });
  return applyHeaders(new Response(body, { status, headers }), {
    request,
    pathname: new URL(request.url).pathname,
    servedMarkdown: false,
    cache: { klass: 'miss' },
  });
}

/** The 503 a client retries in 30 seconds, when a record or object cannot be read. */
export function ogUnavailable(request: Request, body: string): Response {
  return ogText(request, 503, body, { 'retry-after': '30' });
}
