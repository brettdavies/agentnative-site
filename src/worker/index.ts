// agentnative-site Worker — routes every request to Cloudflare's Static
// Assets fetcher, with one branch: if the request wants markdown (by URL
// suffix or Accept header) and we're serving an HTML path, rewrite the
// asset lookup to the `.md` twin before fetching.
//
// Contract (docs/DESIGN.md §3.4):
//   - Assets served via env.ASSETS (Workers Static Assets product). Not KV,
//     not R2, not kv-asset-handler.
//   - CN branch: path ends with `.md` OR `Accepts(req).type(['text/html',
//     'text/markdown']) === 'text/markdown'` → serve the markdown twin.
//   - Response headers applied in src/worker/headers.ts (Link rel=alternate,
//     X-Llms-Txt, Cache-Control, staging X-Robots-Tag guard).

import { detectMcpFormat, detectMcpGetFormat, detectPreference } from './accept';
import {
  handleWebAudit,
  handleWebResultPage,
  isWebAuditPath,
  parseWebResultPath,
  type WebAuditRouteEnv,
} from './audit-web/route';
import { applyHeaders } from './headers';
import { MCP_DESCRIPTOR_ALIAS_PATHS } from './mcp/descriptor-paths';
import { buildMcpHandler, type McpEnv } from './mcp/server';
import { logVisitor } from './mcp/visitor-log';
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
  // in env.staging only while production stays gated. Absent on
  // production means the homepage form refuses to render Turnstile,
  // which is the deliberate fail-loud posture pre-promotion.
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITEKEY?: string;
  SESSION_HMAC_SECRET?: string;
  // MCP endpoint bindings (added in U4 of docs/plans/2026-06-05-001-
  // feat-mcp-endpoint-plan.md). MCP_LIMITER gates every POST /mcp;
  // MCP_AUDIT_LIMITER gates only score_cli cache-miss audits (used
  // inside src/worker/mcp/tools/scorecard-audit.ts in U5). Both are
  // optional on the Env interface so tests that don't exercise the
  // /mcp branch can stub a minimal env. MCP_ENABLED and
  // MCP_LIVE_SCORING_ENABLED are env-var kill switches read as strings;
  // a literal `"true"` comparison gates the surface (per KTD-11 the
  // truthy-check on the bare string would treat `"false"` as truthy).
  MCP_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  MCP_AUDIT_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  MCP_ENABLED?: string;
  MCP_LIVE_SCORING_ENABLED?: string;
  // Web-audit bindings (docs/plans/2026-07-09-001 U7). WEB_AUDIT_LIMITER
  // gates fresh /api/audit-web + audit_website audits; WEB_AUDIT_ENABLED
  // is the secret-backed kill switch covering both the webapp route and
  // the MCP fresh path. Optional so tests that don't exercise the web
  // audit can stub a minimal env.
  WEB_AUDIT_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  WEB_AUDIT_ENABLED?: string;
}

/**
 * Build a JSON-RPC error envelope at HTTP 200 — the MCP transport
 * surface for rate-limit breach. The MCP client parses JSON-RPC, not
 * HTTP status codes; returning 429 would mis-route the error past the
 * client's JSON-RPC dispatcher. Used at the MCP_LIMITER gate (here) and
 * by score_cli's MCP_AUDIT_LIMITER gate (which lands in U5).
 */
function jsonRpcError(code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
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

const MCP_DESCRIPTOR_CACHE = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=60';

// Must match the seed file written by emitDiscovery() in src/build/11a-discovery-emit.mjs
// (separate bundle, so the path cannot be a shared import).
const MCP_DESCRIPTOR_SEED_ASSET = '/_internal/mcp-server-card.json';

function rewriteMcpDescriptorUrls(data: Record<string, unknown>, origin: string): void {
  const mcp = `${origin}/mcp`;
  const docs = `${origin}/mcp-skill.md`;
  data.mcp_endpoint = mcp;
  data.url = mcp;
  data.documentation = docs;
  const transport = data.transport;
  if (transport && typeof transport === 'object' && transport !== null) {
    (transport as Record<string, unknown>).endpoint = mcp;
  }
  const authentication = data.authentication;
  if (authentication && typeof authentication === 'object' && authentication !== null) {
    (authentication as Record<string, unknown>).documentation = `${origin}/auth.md`;
  }
}

/**
 * Build the MCP server-card JSON body, rewriting URL fields to the inbound
 * request's origin. Seed: dist/_internal/mcp-server-card.json.
 *
 * Canonical (SEP-1649): GET /.well-known/mcp/server-card.json
 * Aliases (same body):  /.well-known/mcp, /mcp.json, /.well-known/mcp.json
 * Also:                GET /mcp with Accept: application/json
 */
async function buildMcpDescriptorJsonBody(request: Request, env: Env): Promise<string | null> {
  const seedUrl = new URL(request.url);
  seedUrl.pathname = MCP_DESCRIPTOR_SEED_ASSET;
  const asset = await env.ASSETS.fetch(new Request(seedUrl.toString(), { method: 'GET' }));
  if (!asset.ok) return null;
  const body = await asset.text();
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    rewriteMcpDescriptorUrls(data, new URL(request.url).origin);
    return `${JSON.stringify(data, null, 2)}\n`;
  } catch {
    return null;
  }
}

/**
 * Rewrite absolute URLs in agent-readiness JSON metadata so staging and
 * local previews see their own origin instead of the build-time default.
 */
async function buildOriginAwareJsonBody(
  request: Request,
  env: Env,
  assetPath: string,
  rewrite: (data: Record<string, unknown>, origin: string) => void,
): Promise<string | null> {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = assetPath;
  const asset = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET' }));
  if (!asset.ok) return null;
  const body = await asset.text();
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    rewrite(data, new URL(request.url).origin);
    return `${JSON.stringify(data, null, 2)}\n`;
  } catch {
    return null;
  }
}

function rewriteOAuthProtectedResource(data: Record<string, unknown>, origin: string): void {
  data.resource = `${origin}/mcp`;
  data.resource_documentation = `${origin}/auth.md`;
  if (Array.isArray(data.authorization_servers)) {
    data.authorization_servers = [origin];
  }
}

function rewriteOAuthAuthorizationServer(data: Record<string, unknown>, origin: string): void {
  data.issuer = origin;
  data.token_endpoint = `${origin}/oauth2/token`;
  data.jwks_uri = `${origin}/.well-known/jwks.json`;
  data.service_documentation = `${origin}/auth.md`;
  const agentAuth = data.agent_auth;
  if (agentAuth && typeof agentAuth === 'object') {
    const block = agentAuth as Record<string, unknown>;
    block.skill = `${origin}/auth.md`;
    block.register_uri = `${origin}/auth.md`;
    const anonymous = block.anonymous;
    if (anonymous && typeof anonymous === 'object') {
      (anonymous as Record<string, unknown>).claim_uri = `${origin}/auth.md`;
    }
  }
}

function rewriteApiCatalogHrefs(value: unknown, href: string): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (entry && typeof entry === 'object') {
      (entry as Record<string, unknown>).href = href;
    }
  }
}

function rewriteApiCatalog(data: Record<string, unknown>, origin: string): void {
  const linkset = data.linkset;
  if (!Array.isArray(linkset)) return;
  const serverCard = `${origin}/.well-known/mcp/server-card.json`;
  for (const entry of linkset) {
    if (!entry || typeof entry !== 'object') continue;
    const link = entry as Record<string, unknown>;
    if (typeof link.anchor === 'string') link.anchor = `${origin}/mcp`;
    rewriteApiCatalogHrefs(link['service-desc'], serverCard);
    rewriteApiCatalogHrefs(link['service-doc'], `${origin}/mcp-skill`);
    rewriteApiCatalogHrefs(link.status, serverCard);
  }
}

function mcpDescriptorJsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': MCP_DESCRIPTOR_CACHE,
      ...DISCOVERY_CORS_HEADERS,
    },
  });
}

function discoveryMetadataUnavailable(): Response {
  return new Response('discovery metadata unavailable\n', {
    status: 503,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function discoveryGetOnly405(): Response {
  return new Response('method not allowed\n', {
    status: 405,
    headers: {
      Allow: 'GET',
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

const DISCOVERY_GET_ONLY_PATHS = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
  '/.well-known/api-catalog',
]);

/** Read-only discovery JSON may be fetched cross-origin by agent tools and scanners. */
const DISCOVERY_CORS_HEADERS = {
  'access-control-allow-origin': '*',
} as const;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Live-scoring routes. Sits ABOVE the asset call so the asset-first
    // invariant for everything else (every other path proxies to
    // env.ASSETS) is preserved by exclusion, not by overlap.
    if (isScorePath(pathname)) {
      return handleScore(request, env as ScoreEnv);
    }

    // Web-audit streaming dispatch. Threads ctx so the engine's R2 write
    // survives a mid-stream client disconnect via ctx.waitUntil (KTD-13).
    if (isWebAuditPath(pathname)) {
      return handleWebAudit(request, env as WebAuditRouteEnv, ctx);
    }

    // MCP server card (SEP-1649) + legacy pointer aliases — one JSON document
    // from dist/_internal/mcp-server-card.json, origin-rewritten at serve time.
    if (MCP_DESCRIPTOR_ALIAS_PATHS.has(pathname) && request.method !== 'OPTIONS') {
      if (request.method !== 'GET') return discoveryGetOnly405();
      const body = await buildMcpDescriptorJsonBody(request, env);
      if (body === null) return discoveryMetadataUnavailable();
      return mcpDescriptorJsonResponse(body);
    }

    if (DISCOVERY_GET_ONLY_PATHS.has(pathname) && request.method !== 'GET' && request.method !== 'OPTIONS') {
      return discoveryGetOnly405();
    }

    // /.well-known/oauth-protected-resource + oauth-authorization-server —
    // agent-readiness discovery metadata. Origin-aware rewrite keeps staging
    // and local previews self-consistent.
    if (pathname === '/.well-known/oauth-protected-resource' && request.method === 'GET') {
      const body = await buildOriginAwareJsonBody(
        request,
        env,
        '/.well-known/oauth-protected-resource',
        rewriteOAuthProtectedResource,
      );
      if (body === null) return discoveryMetadataUnavailable();
      return mcpDescriptorJsonResponse(body);
    }
    if (pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') {
      const body = await buildOriginAwareJsonBody(
        request,
        env,
        '/.well-known/oauth-authorization-server',
        rewriteOAuthAuthorizationServer,
      );
      if (body === null) return discoveryMetadataUnavailable();
      return mcpDescriptorJsonResponse(body);
    }

    // Public-catalog token endpoint. The MCP surface requires no credentials;
    // POSTs receive a typed JSON body explaining the no-auth posture rather
    // than a misleading 404. No CORS: browser-origin probes are not a
    // supported client; posture is documented in auth.md and OAuth metadata.
    if (pathname === '/oauth2/token' && request.method === 'POST') {
      const origin = new URL(request.url).origin;
      return new Response(
        JSON.stringify({
          error: 'public_catalog',
          error_description:
            'anc.dev publishes a public catalog. No OAuth tokens are issued; call the MCP endpoint directly.',
          documentation: `${origin}/auth.md`,
          mcp_endpoint: `${origin}/mcp`,
        }),
        {
          status: 400,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        },
      );
    }

    // /.well-known/api-catalog — RFC 9727 link set. The static asset is
    // emitted extensionless (11b-agent-readiness), so CF Static Assets can't
    // infer the content-type. Origin-rewrite the linkset URLs so staging and
    // local previews stay self-consistent with the other discovery surfaces,
    // stamp `application/linkset+json`, open CORS (public discovery surface),
    // and mark the response noindex.
    if (pathname === '/.well-known/api-catalog' && request.method === 'GET') {
      const body = await buildOriginAwareJsonBody(request, env, '/.well-known/api-catalog', rewriteApiCatalog);
      if (body === null) return discoveryMetadataUnavailable();
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/linkset+json; charset=utf-8',
          'cache-control': MCP_DESCRIPTOR_CACHE,
          'x-robots-tag': 'noindex',
          ...DISCOVERY_CORS_HEADERS,
        },
      });
    }

    // /mcp — streamable HTTP MCP server (POST) plus a content-negotiated
    // GET surface. Sits above /_internal/ interception and the asset
    // fetch so the entry-point ordering keeps the /mcp branch in front
    // of the asset-first dispatch (KTD-10 of the MCP endpoint plan).
    //
    // GET dispatch:
    //   - Accept: application/json → MCP server card (canonical + aliases above;
    //     kill switch; the URL identity documents itself even when the
    //     JSON-RPC handler is offline).
    //   - Accept: text/html or text/markdown → no early return; control
    //     flows past this branch into the asset-first dispatch, which
    //     serves dist/mcp.html (and the .md twin via the standard
    //     detectPreference content negotiation).
    //
    // POST dispatch enforces, in order:
    //
    //   1. MCP_ENABLED kill switch — 503 Retry-After when disabled.
    //   2. Method check — non-POST returns 405 Allow: GET, POST.
    //   3. Accept-header check — neither MIME acceptable returns 406
    //      text/plain (no JSON-RPC envelope at the pre-JSON-RPC layer).
    //   4. MCP_LIMITER gate — breach returns the -32099 JSON-RPC error
    //      envelope at HTTP 200. The visitor-inventory log fires AFTER
    //      this gate with `gate_result` so Workers Logs volume stays
    //      bounded under attack while still recording the denial (R8).
    //   5. SDK Accept-rewrite shim — the agents SDK's WorkerTransport
    //      strictly requires `Accept: application/json, text/event-
    //      stream`; we rewrite the outgoing Accept to that exact value
    //      and build the handler in the matching jsonResponse mode
    //      derived from the client's actual preference.
    //   6. Handler response returned directly — NOT through applyHeaders
    //      (which would strip the no-store directive and risk mis-
    //      applying static-asset Cache-Control). No Access-Control-
    //      Allow-Origin header is set: the endpoint is server-to-agent
    //      JSON-RPC, not browser-to-server (KTD-10 / R15).
    if (pathname === '/mcp' && request.method !== 'OPTIONS') {
      // OPTIONS deliberately falls through to the asset-first dispatch
      // below — CF Static Assets returns 404, which is the deliberate
      // browser-blocked posture for cross-origin preflights (KTD-10 /
      // R15). MCP clients are agent runtimes that never issue OPTIONS,
      // so this is the right shape.

      if (request.method === 'GET') {
        const getFormat = detectMcpGetFormat(request);
        if (getFormat === 'json') {
          const body = await buildMcpDescriptorJsonBody(request, env);
          if (body === null) return discoveryMetadataUnavailable();
          return mcpDescriptorJsonResponse(body);
        }
        // 'html' or 'markdown' — control flows past this branch into
        // the asset-first dispatch below. dist/mcp.html ships from
        // emitSubPages with the full site shell (header, theme toggle,
        // footer); detectPreference rewrites to dist/mcp.md when the
        // caller prefers text/markdown.
      } else {
        // Step 1: MCP_ENABLED kill switch.
        if (env.MCP_ENABLED !== 'true') {
          return new Response('mcp is currently disabled by the operator\n', {
            status: 503,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              'retry-after': '3600',
              'cache-control': 'no-store',
            },
          });
        }

        // Step 2: method check. GET handled above; POST falls through
        // to the JSON-RPC pipeline; PUT/DELETE/PATCH lands here with
        // Allow advertising the two serviceable methods.
        if (request.method !== 'POST') {
          return new Response('method not allowed\n', {
            status: 405,
            headers: {
              Allow: 'GET, POST',
              'content-type': 'text/plain; charset=utf-8',
              'cache-control': 'no-store',
            },
          });
        }

        // Step 3: Accept-header check.
        const format = detectMcpFormat(request);
        if (format === false) {
          // The 406 rejection happens before any JSON-RPC parsing so the
          // body is plain text without a `jsonrpc`/`id`/`error` envelope.
          return new Response(
            'POST /mcp serves application/json or text/event-stream; the request Accept header allowed neither.\n',
            {
              status: 406,
              headers: {
                'content-type': 'text/plain; charset=utf-8',
                'cache-control': 'no-store',
              },
            },
          );
        }

        // Step 4: MCP_LIMITER gate, then visitor log with gate_result.
        let gateResult: 'passed' | 'rate_limited' = 'passed';
        if (env.MCP_LIMITER) {
          const key = request.headers.get('cf-connecting-ip') ?? 'anon';
          const { success } = await env.MCP_LIMITER.limit({ key });
          if (!success) gateResult = 'rate_limited';
        }
        logVisitor(request, { format, gate_result: gateResult });
        if (gateResult === 'rate_limited') {
          return jsonRpcError(-32099, 'rate limit exceeded');
        }

        // Step 5: SDK Accept-rewrite shim.
        const sdkHeaders = new Headers(request.headers);
        sdkHeaders.set('accept', 'application/json, text/event-stream');
        const sdkRequest = new Request(request, { headers: sdkHeaders });

        // Step 6: build per-request handler and return its response
        // directly. The handler sets its own content-type for both JSON
        // and SSE; we always set Cache-Control: no-store and strip any
        // Access-Control-Allow-Origin the SDK added because the endpoint
        // is server-to-agent JSON-RPC, not browser-to-server (KTD-10).
        // Browser-origin POSTs fail the browser's same-origin check;
        // returning ACAO would defeat the deliberate posture.
        const handler = await buildMcpHandler(env as McpEnv, { jsonResponse: format === 'json' });
        const response = await handler(sdkRequest, env as McpEnv, ctx);
        const headers = new Headers(response.headers);
        headers.delete('access-control-allow-origin');
        headers.set('cache-control', 'no-store');
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
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

    // Renamed page: `/check` -> `/audit` (the CLI subcommand rename).
    // 301 the old path (and its markdown twin) so existing inbound links
    // and any cached references resolve to the canonical page.
    if (pathname === '/check' || pathname === '/check.md') {
      const canonical = pathname.endsWith('.md') ? '/audit.md' : '/audit';
      return new Response(null, {
        status: 301,
        headers: { Location: canonical, 'Cache-Control': 'public, max-age=300' },
      });
    }

    // Shareable live-score result page. Reads the cached scorecard from
    // R2 by binary slug, renders an HTML summary view.
    // Strict regex enforced by parseLiveScorePath — slugs must match
    // /^[a-z0-9][a-z0-9-]{0,63}$/, so an attacker can't pivot this
    // route into an arbitrary R2 key read. Accepts both /score/live/<binary>
    // and /score/live/<binary>.md (markdown twin) per the site-wide
    // twin invariant. The "live" segment is reserved as a registry name
    // (scorecards.mjs) so no curated tool can collide with this route.
    if (parseLiveScorePath(pathname)) {
      return handleLiveScorePage(request, env as ScoreEnv);
    }

    // /web/<domain>.html → 301 to /web/<domain>. Mirrors the live-score
    // .html canonicalization; the /web route is Worker-served so the
    // extension redirect is explicit here.
    const webHtmlMatch = pathname.match(/^\/web\/([^/]+)\.html$/);
    if (webHtmlMatch) {
      return new Response(null, {
        status: 301,
        headers: { Location: `/web/${webHtmlMatch[1]}`, 'Cache-Control': 'public, max-age=300' },
      });
    }

    // Shareable web-audit result page + markdown twin. Reads the cached
    // web scorecard from R2 by domain slug (strict regex in
    // parseWebResultPath bounds the R2 lookup). Sits above the asset-first
    // dispatch like the live-score page.
    if (parseWebResultPath(pathname)) {
      return handleWebResultPage(request, env as WebAuditRouteEnv);
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
