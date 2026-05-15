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

// Live-scoring DO class. Re-exported so wrangler's binding resolver can
// find `class_name: "Sandbox"` from wrangler.jsonc's containers +
// durable_objects sections. Stub until U6 lands the install + score
// implementation.
export { Sandbox } from './score/do';

// Build-time env identifier. Wrangler substitutes `__BUILD_ENV__` at
// deploy via the `define` block in each Worker's config:
//   wrangler.jsonc         → "production"
//   wrangler.staging.jsonc → "staging"
//
// Why this constant exists: forcing the two compiled Worker scripts to
// have distinct bytes (and therefore distinct script etags) is the
// workaround for the Workers Assets cross-env asset-sharing bug filed
// at https://github.com/cloudflare/workers-sdk/issues/13925. Without
// some bytes-level divergence, an asset upload from staging silently
// overrides what production serves at the same URL path.
//
// The `typeof` guard keeps tests working: `bun test` does not run
// through wrangler's bundler, so `__BUILD_ENV__` is undeclared at
// test time and the fallback to 'development' kicks in.
declare const __BUILD_ENV__: 'production' | 'staging';
const BUILD_ENV: 'production' | 'staging' | 'development' =
  typeof __BUILD_ENV__ !== 'undefined' ? __BUILD_ENV__ : 'development';

export interface Env {
  ASSETS: Fetcher;
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
    return applyHeaders(upstream, { request, servedMarkdown, pathname, buildEnv: BUILD_ENV });
  },
} satisfies ExportedHandler<Env>;
