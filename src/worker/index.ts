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
  TURNSTILE_SECRET?: string;
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
    return applyHeaders(upstream, { request, servedMarkdown, pathname });
  },
} satisfies ExportedHandler<Env>;
