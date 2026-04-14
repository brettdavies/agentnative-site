// agentnative-site Worker — routes every request to Cloudflare's Static
// Assets fetcher, with one branch: if the request wants markdown (by URL
// suffix or Accept header) and we're serving an HTML path, rewrite the
// asset lookup to the `.md` twin before fetching.
//
// Contract (DESIGN.md §3.4 + eng review A3, A8, A12):
//   - Assets served via env.ASSETS (Workers Static Assets product). Not KV,
//     not R2, not kv-asset-handler.
//   - CN branch: path ends with `.md` OR `Accepts(req).type(['text/html',
//     'text/markdown']) === 'text/markdown'` → serve the markdown twin.
//   - Response headers applied in src/worker/headers.ts (Link rel=alternate,
//     X-Llms-Txt, Cache-Control, staging X-Robots-Tag guard).

import { detectPreference } from './accept';
import { applyHeaders } from './headers';

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
    const preferMarkdown = !pathIsMarkdown && detectPreference(request) === 'markdown';
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
