// Response-header policy for the agentnative-site Worker.
//
// Contract (docs/DESIGN.md §3.4):
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
//   JSON responses (.json) Content-Type: application/json; charset=utf-8
//                          Access-Control-Allow-Origin: *
//                          X-Robots-Tag: noindex
//                          Cache-Control: public, max-age=300, s-maxage=86400,
//                                         stale-while-revalidate=60
//                          (No Link rel=alternate, no X-Llms-Txt — JSON has
//                          no markdown twin. Detected by URL extension so any
//                          /<slug>.json endpoint reuses the branch.)
//
//   SVG responses (.svg)   Content-Type: image/svg+xml; charset=utf-8
//                          Access-Control-Allow-Origin: *
//                          Cache-Control: public, max-age=300, s-maxage=86400,
//                                         stale-while-revalidate=60
//                          CORS is the functional requirement: the badge
//                          surface (/badge/<tool>.svg) is meant to be
//                          embedded in third-party READMEs cross-origin.
//                          Short cache so a re-scored tool's badge color
//                          flips within a TTL of the next site build,
//                          rather than serving a stale year-old SVG from
//                          edge caches.
//
//   Hashed assets          Cache-Control: public, max-age=31536000, immutable
//   (/fonts/*, /og-image.png)
//
//   Staging guard          X-Robots-Tag: noindex on every response whose
//                          Host ends with `.workers.dev`. Added LAST so it
//                          composes with the markdown branch (both set
//                          noindex; last write wins, same value either way).

const SHORT_CACHE = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=60';
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

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
  } else if (isJson(opts.pathname)) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('X-Robots-Tag', 'noindex');
    headers.set('Cache-Control', SHORT_CACHE);
  } else if (isSvg(opts.pathname)) {
    headers.set('Content-Type', 'image/svg+xml; charset=utf-8');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', SHORT_CACHE);
  } else if (isHashedAsset(opts.pathname)) {
    headers.set('Cache-Control', IMMUTABLE_CACHE);
  } else {
    headers.set('Link', `<${markdownTwinFor(opts.pathname)}>; rel="alternate"; type="text/markdown"`);
    headers.set('X-Llms-Txt', '/llms.txt');
    headers.set('Cache-Control', SHORT_CACHE);
    // CSP applies to HTML responses only — the markdown / JSON / SVG
    // branches above MUST stay free of HTML-only directives like
    // frame-ancestors (Cloudflare WAF flags inconsistent enforcement).
    headers.set('Content-Security-Policy', CSP_HTML);
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
