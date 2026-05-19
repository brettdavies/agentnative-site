// agentnative-site Worker — routes every request to Cloudflare's Static
// Assets fetcher, with one branch: if the request wants markdown (by URL
// suffix or Accept header) and we're serving an HTML path, rewrite the
// asset lookup to the `.md` twin before fetching.
//
// Contract (docs/DESIGN.md §3.4 + eng review A3, A8, A12):
//   - Assets served via env.ASSETS (Workers Static Assets product). Not KV,
//     not R2, not kv-asset-handler.
//   - CN branch: path ends with `.md` OR `Accepts(req).type(['text/html',
//     'text/markdown']) === 'text/markdown'` → serve the markdown twin.
//   - Response headers applied in src/worker/headers.ts (Link rel=alternate,
//     X-Llms-Txt, Cache-Control, staging X-Robots-Tag guard).

import { detectPreference } from './accept';
import { applyHeaders } from './headers';
import { isScorePath } from './score/content-negotiation';
import { handleScore, type ScoreEnv } from './score/handler';
import { handleLiveScorePage, parseLiveScorePath } from './score/summary-render';

// The CF Sandbox/Containers SDK looks up `ctx.exports.ContainerProxy` at
// outbound-handler dispatch time and throws "ctx.exports.ContainerProxy
// is undefined, export ContainerProxy from the containers package in
// your worker entrypoint" if it's missing. Surfaces only at runtime on
// the first DO fetch; wrangler dry-run, deploy, and the bun-test
// `cloudflare:workers` shim all pass. Same class of failure as PR #94
// (Sandbox `fetch()` missing) — documented in
// docs/solutions/integration-issues/cloudflare-workers-do-mock-must-mirror-binding-shape-2026-05-15.md.
export { ContainerProxy } from '@cloudflare/sandbox';
// Live-scoring DO class. Re-exported so wrangler's binding resolver can
// find `class_name: "Sandbox"` from wrangler.jsonc's containers +
// durable_objects sections.
export { Sandbox } from './score/do';

// At runtime wrangler injects every binding declared in wrangler.jsonc
// (ASSETS plus the SCORE_* set used by /api/score). The Env interface is
// kept narrow so tests that exercise only the asset-first path can stub
// a minimal env. The /api/score branch casts to ScoreEnv at dispatch
// time, which is sound because wrangler always populates the full set.
export interface Env {
  ASSETS: Fetcher;
  SCORE?: DurableObjectNamespace;
  SCORE_KV?: KVNamespace;
  SCORE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  SCORE_LIMITER_IP?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  // TURNSTILE_SECRET is a secret (wrangler secret put). TURNSTILE_SITEKEY
  // is a public var the homepage form bakes into the widget render — set
  // in env.staging only until U10 promotes production. Absent on
  // production means the homepage form refuses to render Turnstile,
  // which is the deliberate fail-loud posture pre-promotion.
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITEKEY?: string;
  SESSION_HMAC_SECRET?: string;
}

function rewriteToMarkdown(url: URL): URL {
  const rewritten = new URL(url.toString());
  if (rewritten.pathname === '/') {
    rewritten.pathname = '/index.md';
  } else {
    rewritten.pathname = `${rewritten.pathname.replace(/\/$/, '')}.md`;
  }
  return rewritten;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Live-scoring routes (plan U5). Sits ABOVE the asset call so the
    // asset-first invariant for everything else (every other path proxies
    // to env.ASSETS) is preserved by exclusion, not by overlap.
    if (isScorePath(pathname)) {
      return handleScore(request, env as ScoreEnv);
    }

    // /score/live/<binary>.html → 301 to /score/live/<binary>. Mirrors
    // the rest of the site (static `/score/<tool>.html` is canonicalized
    // away from the .html extension by CF Static Assets'
    // html_handling=auto-trailing-slash); the /score/live/ route is
    // Worker-served so the same redirect is explicit here.
    const liveScoreHtmlMatch = pathname.match(/^\/score\/live\/([a-z0-9][a-z0-9-]{0,63})\.html$/);
    if (liveScoreHtmlMatch) {
      const canonical = `/score/live/${liveScoreHtmlMatch[1]}`;
      return new Response(null, {
        status: 301,
        headers: { Location: canonical, 'Cache-Control': 'public, max-age=300' },
      });
    }

    // Shareable live-score result page (plan U8). Reads the cached
    // scorecard from R2 by binary slug, renders an HTML summary view.
    // Strict regex enforced by parseLiveScorePath — slugs must match
    // /^[a-z0-9][a-z0-9-]{0,63}$/, so an attacker can't pivot this
    // route into an arbitrary R2 key read. Accepts both /score/live/<binary>
    // and /score/live/<binary>.md (markdown twin) per the site-wide
    // twin invariant. The "live" segment is reserved as a registry name
    // (scorecards.mjs) so no curated tool can collide with this route.
    if (parseLiveScorePath(pathname)) {
      return handleLiveScorePage(request, env as ScoreEnv);
    }

    // /_internal/* paths are build-only assets (shell templates the
    // Worker fetches via env.ASSETS internally). Return 404 here so
    // direct user navigation never sees the raw template with `{{...}}`
    // placeholders. The Worker's internal fetch goes straight to
    // env.ASSETS.fetch and bypasses this interceptor.
    if (pathname.startsWith('/_internal/')) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }

    const pathIsMarkdown = pathname.endsWith('.md');
    const pathIsJson = pathname.endsWith('.json');
    // CN rewrite is markdown-only. Skip for `.json` paths so `Accept:
    // text/markdown` against `/skill.json` returns the JSON unchanged
    // instead of rewriting to a non-existent `/skill.json.md` twin.
    const preferMarkdown = !pathIsMarkdown && !pathIsJson && detectPreference(request) === 'markdown';
    const servedMarkdown = pathIsMarkdown || preferMarkdown;

    let assetRequest = request;
    if (preferMarkdown) {
      // Rewrite the asset lookup to the .md twin; the client-visible URL is
      // unchanged (no redirect) — content negotiation MUST stay invisible
      // to crawlers + link shorteners.
      assetRequest = new Request(rewriteToMarkdown(url), request);
    }

    const upstream = await env.ASSETS.fetch(assetRequest);

    // Homepage HTML: substitute {{TURNSTILE_SITEKEY}} placeholder. Runs
    // AFTER the markdown-CN rewrite above so /index.md content (no
    // placeholder) flows through untouched. Production with no
    // TURNSTILE_SITEKEY set substitutes with the empty string, which the
    // homepage JS treats as "form disabled, install anc locally" per
    // the deliberate fail-loud-pre-promotion posture.
    if ((pathname === '/' || pathname === '/index.html') && !servedMarkdown && upstream.ok) {
      const contentType = upstream.headers.get('content-type') ?? '';
      if (contentType.toLowerCase().includes('text/html')) {
        const html = await upstream.text();
        const sitekey = env.TURNSTILE_SITEKEY ?? '';
        const substituted = html.replaceAll('{{TURNSTILE_SITEKEY}}', sitekey);
        const rewritten = new Response(substituted, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        });
        return applyHeaders(rewritten, { request, servedMarkdown, pathname });
      }
    }

    return applyHeaders(upstream, { request, servedMarkdown, pathname });
  },
} satisfies ExportedHandler<Env>;
