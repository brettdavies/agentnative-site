// anc.dev is the one canonical host. www.anc.dev stays bound to the Worker
// only so it can send every request there: same path and query, always https.
// A GET or HEAD gets 301; any other method gets 308, so an MCP POST keeps its
// method and body when its client follows the redirect.

import { CANONICAL_SITE_URL } from '../shared/site-url';

const WWW_HOST = `www.${new URL(CANONICAL_SITE_URL).hostname}`;

/** The redirect to the canonical host, or null when the request is already there. */
export function canonicalHostRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.hostname !== WWW_HOST) return null;
  const location = `${CANONICAL_SITE_URL}${url.pathname}${url.search}`;
  const status = request.method === 'GET' || request.method === 'HEAD' ? 301 : 308;
  return new Response(null, { status, headers: { location, 'cache-control': 'public, max-age=86400' } });
}
