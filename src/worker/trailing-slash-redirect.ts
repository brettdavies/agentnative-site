// The asset binding canonicalizes a trailing slash with a 307 (`/p1/` to
// `/p1`, per `html_handling: auto-trailing-slash`), and a search engine reads
// a 307 as temporary, so the slash form and the bare form stay split. No
// asset setting changes the status, so the Worker upgrades that one redirect.
//
// The binding's own Location is returned untouched: it is never rebuilt from
// the request path. The upgrade applies only when that Location stays on the
// request's origin, keeps its query, and differs from the request path by
// nothing but the trailing slash, so a redirect that leaves the origin is
// never made permanent and a browser cannot cache one.

function toggledSlash(pathname: string): string {
  return pathname.endsWith('/') ? pathname.slice(0, -1) : `${pathname}/`;
}

export function permanentSlashRedirect(upstream: Response, assetUrl: URL, method: string): Response {
  if (upstream.status !== 307) return upstream;
  const location = upstream.headers.get('location');
  if (location === null) return upstream;
  let target: URL;
  try {
    target = new URL(location, assetUrl);
  } catch {
    return upstream;
  }
  if (target.origin !== assetUrl.origin || target.search !== assetUrl.search) return upstream;
  if (target.pathname !== toggledSlash(assetUrl.pathname)) return upstream;
  // 308 keeps a POST and its body; GET and HEAD take the 301 crawlers know best.
  const read = method === 'GET' || method === 'HEAD';
  return new Response(null, { status: read ? 301 : 308, headers: upstream.headers });
}
