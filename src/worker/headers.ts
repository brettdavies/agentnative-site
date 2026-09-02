import { homeTag, webDomainTag, webTag } from './audit-web/hit-min-tags';

// Response-header policy for the agentnative-site Worker.
//
// Contract (docs/DESIGN.md §3.4):
//
//   HTML responses         Link: </p<n>.md>; rel="alternate"; type="text/markdown"
//                          X-Llms-Txt: /llms.txt
//                          Vary: Accept, User-Agent  (extensionless URLs only)
//
//   Markdown responses     Content-Type: text/markdown; charset=utf-8
//                          X-Robots-Tag: noindex
//                          Vary: Accept, User-Agent  (extensionless URLs only)
//                          Explicit `.md` is one representation: no Vary.
//
//   Cache classes (P4). applyHeaders is the only writer of Cache-Tag and
//   class TTL. Upstream Cache-Tag is discarded.
//
//   HIT-1d (bake-at-build HTML/markdown)  Cache-Control: public, max-age=300,
//                                         stale-while-revalidate=60
//                                         (no s-maxage — that re-arms the
//                                         custom-domain zone HIT that stripped
//                                         Vary)
//                                         Cloudflare-CDN-Cache-Control:
//                                         public, max-age=86400
//
//   HIT-min (live boards)                 Cache-Control: public, max-age=0,
//                                         must-revalidate
//                                         Cloudflare-CDN-Cache-Control:
//                                         public, max-age=300
//                                         Cache-Tag: home | web | web:{domain}
//
//   MISS                                  Cache-Control: no-store
//                                         Cloudflare-CDN-Cache-Control: no-store
//                                         (status >= 400; /web/scoring*; scoring
//                                         overlay also strips Cache-Tag)
//
//   Path-keyed files (.json, .svg, .txt,  Cache-Control: public, max-age=300,
//   .xml, …)                              s-maxage=86400, stale-while-revalidate=60
//                                         No Vary. No Cloudflare-CDN-Cache-Control.
//
//   Hashed assets                         Cache-Control: public, max-age=31536000,
//   (/fonts/*, /og-image.png)             immutable
//
//   JSON responses (.json) Content-Type: application/json; charset=utf-8
//                          Access-Control-Allow-Origin: *
//                          X-Robots-Tag: noindex
//                          (No Link rel=alternate, no X-Llms-Txt — JSON has
//                          no markdown twin. Detected by URL extension so any
//                          /<slug>.json endpoint reuses the branch.)
//
//   SVG responses (.svg)   Content-Type: image/svg+xml; charset=utf-8
//                          Access-Control-Allow-Origin: *
//                          CORS is the functional requirement: the badge
//                          surface (/badge/<tool>.svg) is meant to be
//                          embedded in third-party READMEs cross-origin.
//
//   Staging guard          X-Robots-Tag: noindex on every response whose
//                          Host ends with `.workers.dev`. Added LAST so it
//                          composes with the markdown branch (both set
//                          noindex; last write wins, same value either way).

// HIT-1d negotiated: browser TTL without s-maxage. s-maxage on Cache-Control
// re-arms the custom-domain zone HIT that stored the Worker response and
// dropped Vary. Edge freshness is Cloudflare-CDN-Cache-Control only.
const HIT_1D_BROWSER = 'public, max-age=300, stale-while-revalidate=60';
const HIT_1D_CDN = 'public, max-age=86400';
// HIT-min: browsers revalidate so a tag purge is visible on the next
// navigation. Edge stores for 300s. Do not use Cache-Control: no-store
// here — Workers Caching fills from a cacheable Cache-Control.
const HIT_MIN_BROWSER = 'public, max-age=0, must-revalidate';
const HIT_MIN_CDN = 'public, max-age=300';
const MISS_CACHE = 'no-store';
const SHORT_CACHE = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=60';
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

// Machine-surface discovery advertised on the site root via the Link header
// (RFC 8288), so an agent reading only response headers finds these without
// parsing HTML or probing /.well-known: service-desc/doc/meta are the RFC 8631
// trio (machine description, human doc, service context), api-catalog is the
// RFC 9727 index. Targets mirror the served /.well-known/api-catalog linkset.
const ROOT_DISCOVERY_LINKS = [
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</.well-known/mcp/server-card.json>; rel="service-desc"',
  '</mcp-skill>; rel="service-doc"',
  '</.well-known/ai.txt>; rel="service-meta"',
].join(', ');

// Content-Security-Policy for HTML responses. CSP is required to allow
// Cloudflare Turnstile's invisible widget script + iframe + siteverify
// XHR on the homepage form, while keeping the rest of the site locked
// down. Three directives MUST include `challenges.cloudflare.com` or
// Turnstile breaks silently:
//   - script-src  (lazy-loaded api.js)
//   - frame-src   (invisible widget iframe)
//   - connect-src (token exchange XHR)
//
// CF Web Analytics adds `static.cloudflareinsights.com` to script-src
// (the beacon script is auto-injected by the CF edge into HTML responses
// when Web Analytics is enabled at the zone level) and
// `cloudflareinsights.com` to connect-src (the beacon POSTs real-user
// metrics back to a CF endpoint). Both must be present or the beacon
// silently drops field Core Web Vitals.
//
// `'unsafe-inline'` is required for:
//   - script-src: shell.mjs inlines the theme-init bootstrap (`<script>${themeInit}</script>`)
//                 so dark/light mode is set BEFORE first paint, no FOUC.
//   - style-src:  Shiki emits inline `style="color: #..."` on every code-block
//                 token (the dual-theme bridge in DESIGN.md §4.6 depends on it).
//
// img-src includes `data:` for inline SVG icons; font-src `'self'` because
// the woff2 files self-host from /fonts/. base-uri + form-action + object-src
// lock down classic exfil/click-jack vectors that no part of this site needs.
//
// Applied to every HTML response (not just /), so a CSP regression test
// hitting any page surfaces drift on every directive.
// style-src + font-src include the Google Fonts origins because the
// Turnstile widget bootstrap injects `<link rel=stylesheet
// href="https://fonts.googleapis.com/css?family=Lato...">` into the
// host document even when the sitekey is configured as Invisible mode
// in the CF dashboard (defensive UI prep in case the challenge elevates).
// The CSS file in turn loads font files from fonts.gstatic.com.
const CSP_HTML =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://static.cloudflareinsights.com; " +
  'frame-src https://challenges.cloudflare.com; ' +
  "connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com; " +
  "img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "object-src 'none'; " +
  "frame-ancestors 'self'";

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

function isJson(pathname: string): boolean {
  return pathname.endsWith('.json');
}

function isSvg(pathname: string): boolean {
  return pathname.endsWith('.svg');
}

// Source files with no HTML twin. A curl/agent UA would otherwise rewrite
// `/llms.txt` to `/llms.txt.md` (same `.json` pitfall DESIGN.md §3.4 called
// out for `/skill.json`). Keep this list extension-only: `/web/anc.dev` is
// a result page, not a file, and is dispatched before asset CN.
function isUntwinnedSource(pathname: string): boolean {
  return /\.(txt|xml|css|js|mjs|map|png|ico|woff2|webmanifest)$/i.test(pathname);
}

/** True when the path is one representation: never rewritten to a `.md` twin. */
export function isSingleRepresentation(pathname: string): boolean {
  return isJson(pathname) || isSvg(pathname) || isHashedAsset(pathname) || isUntwinnedSource(pathname);
}

/**
 * True when the path is pinned to one representation and never negotiates:
 * explicit `.md` twins plus every single-representation file class. Every
 * layer that selects a representation or stamps Vary (the CN rewrite, this
 * module's Vary branches, the live-score headers, the /api/score suffix
 * dispatch) consumes this predicate so the negotiable path set cannot
 * drift between layers.
 */
export function isRepresentationPinned(pathname: string): boolean {
  return pathname.endsWith('.md') || isSingleRepresentation(pathname);
}

function isAlwaysMissPath(pathname: string): boolean {
  return pathname === '/web/scoring' || pathname === '/web/scoring.md' || pathname.startsWith('/web/scoring/');
}

/**
 * HIT-min Cache-Tag for a request pathname, or null when the URL is not
 * HIT-min. Same tag on every HTML/markdown variant of a URL. Classify from
 * the request URL, not from `opts.pathname` (that stays HTML-canonical for
 * Link/twin generation so `/web.md` is not treated as extensionless).
 */
export function hitMinCacheTag(pathname: string): string | null {
  if (pathname === '/' || pathname === '/index.md') return homeTag();
  if (pathname === '/web' || pathname === '/web.md') return webTag();
  const match = pathname.match(/^\/web\/([^/]+?)(\.md)?$/);
  if (!match) return null;
  const domain = match[1];
  if (domain === 'scoring') return null;
  return webDomainTag(domain);
}

type CacheClass = 'hit-1d' | 'hit-min' | 'miss' | 'short' | 'immutable';

function applyCacheClass(headers: Headers, klass: CacheClass, tag?: string): void {
  headers.delete('Cache-Tag');
  switch (klass) {
    case 'miss':
      headers.set('Cache-Control', MISS_CACHE);
      headers.set('Cloudflare-CDN-Cache-Control', MISS_CACHE);
      break;
    case 'hit-min':
      headers.set('Cache-Control', HIT_MIN_BROWSER);
      headers.set('Cloudflare-CDN-Cache-Control', HIT_MIN_CDN);
      if (tag) headers.set('Cache-Tag', tag);
      break;
    case 'hit-1d':
      headers.set('Cache-Control', HIT_1D_BROWSER);
      headers.set('Cloudflare-CDN-Cache-Control', HIT_1D_CDN);
      break;
    case 'short':
      headers.delete('Cloudflare-CDN-Cache-Control');
      headers.set('Cache-Control', SHORT_CACHE);
      break;
    case 'immutable':
      headers.delete('Cloudflare-CDN-Cache-Control');
      headers.set('Cache-Control', IMMUTABLE_CACHE);
      break;
  }
}

function classifyCacheClass(
  requestPathname: string,
  linkPathname: string,
  status: number,
): { klass: CacheClass; tag?: string } {
  if (status >= 400 || isAlwaysMissPath(requestPathname)) {
    return { klass: 'miss' };
  }
  if (isHashedAsset(linkPathname) || isHashedAsset(requestPathname)) {
    return { klass: 'immutable' };
  }
  if (
    isJson(linkPathname) ||
    isSvg(linkPathname) ||
    isUntwinnedSource(linkPathname) ||
    isJson(requestPathname) ||
    isSvg(requestPathname) ||
    isUntwinnedSource(requestPathname)
  ) {
    return { klass: 'short' };
  }
  const tag = hitMinCacheTag(requestPathname);
  if (tag) return { klass: 'hit-min', tag };
  return { klass: 'hit-1d' };
}

/**
 * Clone the response and replace its header set with the project's policy.
 * We clone so upstream 304 / redirect status codes flow through unchanged.
 *
 * `opts.pathname` is the HTML-canonical path for Link/twin generation.
 * Cache class, Cache-Tag, and Vary vs path-keyed markdown are classified
 * from the request URL so `/web.md` stays HIT-min with no Vary even when
 * the caller passes `pathname: '/web'`.
 */
export function applyHeaders(response: Response, opts: ApplyHeadersOptions): Response {
  const headers = new Headers(response.headers);
  const url = new URL(opts.request.url);
  const requestPathname = url.pathname;

  headers.delete('Cache-Tag');

  if (opts.servedMarkdown) {
    headers.set('Content-Type', 'text/markdown; charset=utf-8');
    headers.set('X-Robots-Tag', 'noindex');
    if (isRepresentationPinned(requestPathname)) {
      headers.delete('Vary');
    } else {
      headers.set('Vary', 'Accept, User-Agent');
    }
  } else if (isJson(opts.pathname)) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('X-Robots-Tag', 'noindex');
    headers.delete('Vary');
  } else if (isSvg(opts.pathname)) {
    headers.set('Content-Type', 'image/svg+xml; charset=utf-8');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.delete('Vary');
  } else if (isHashedAsset(opts.pathname)) {
    headers.delete('Vary');
  } else if (isUntwinnedSource(opts.pathname)) {
    headers.delete('Vary');
  } else {
    const twinLink = `<${markdownTwinFor(opts.pathname)}>; rel="alternate"; type="text/markdown"`;
    headers.set('Link', opts.pathname === '/' ? `${twinLink}, ${ROOT_DISCOVERY_LINKS}` : twinLink);
    headers.set('X-Llms-Txt', '/llms.txt');
    headers.set('Vary', 'Accept, User-Agent');
    // CSP applies to HTML responses only — the markdown / JSON / SVG
    // branches above MUST stay free of HTML-only directives like
    // frame-ancestors (Cloudflare WAF flags inconsistent enforcement).
    headers.set('Content-Security-Policy', CSP_HTML);
  }

  const { klass, tag } = classifyCacheClass(requestPathname, opts.pathname, response.status);
  applyCacheClass(headers, klass, tag);

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
