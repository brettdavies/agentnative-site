// MCP server factory — SDK v2 dual-stack via agents/mcp/server.
//
// Module-scoped handler singleton (KTD3): createMcpHandler instances are cached
// by { responseMode, legacy }. The SDK factory creates a fresh McpServer per
// request; catalog is warmed synchronously via getWarmCatalog() after
// loadCatalog(env) in the dispatch shell.

import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { type Catalog, getWarmCatalog } from './catalog';
import { getMcpEnv } from './env-context';
import { buildInstructions, SPEC_REVISION } from './instructions';
import { registerResources } from './resources';
import { type RegisterToolsEnv, registerTools } from './tools';

const SERVER_NAME = 'anc';
const SERVER_VERSION = '0.1.0';

const CACHE_HINTS = {
  'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' as const },
  'resources/list': { ttlMs: 3_600_000, cacheScope: 'public' as const },
  'resources/templates/list': { ttlMs: 3_600_000, cacheScope: 'public' as const },
  'resources/read': { ttlMs: 3_600_000, cacheScope: 'public' as const },
};

export type McpLegacyMode = 'stateless' | 'reject';

export interface GetMcpHandlerOptions {
  jsonResponse: boolean;
  legacy: McpLegacyMode;
}

export interface McpEnv {
  ASSETS: Fetcher;
  SCORE?: DurableObjectNamespace;
  SCORE_KV?: KVNamespace;
  SCORE_CACHE?: R2Bucket;
  SCORE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  SCORE_LIMITER_IP?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  MCP_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  MCP_AUDIT_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  MCP_ENABLED?: string;
  MCP_LIVE_SCORING_ENABLED?: string;
  MCP_LEGACY_ENABLED?: string;
  MCP_CACHE_BYPASS_ALLOWED?: string;
  WEB_AUDIT_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  WEB_AUDIT_LIMITER_IP?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  WEB_AUDIT_ENABLED?: string;
}

type McpHandler = {
  (request: Request, env: McpEnv, ctx: ExecutionContext): Promise<Response>;
  fetch: (request: Request, requestOptions?: { parsedBody?: unknown; authInfo?: unknown }) => Promise<Response>;
};

const handlerCache = new Map<string, McpHandler>();

function handlerCacheKey(opts: GetMcpHandlerOptions): string {
  return `${opts.jsonResponse ? 'json' : 'auto'}:${opts.legacy}`;
}

function createAncServer(catalog: Catalog): McpServer {
  const env = getMcpEnv();
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: buildInstructions(env),
      cacheHints: CACHE_HINTS,
    },
  );

  registerTools(server, catalog, env as RegisterToolsEnv);
  registerResources(server, catalog);
  return server;
}

export function getMcpHandler(opts: GetMcpHandlerOptions): McpHandler {
  const key = handlerCacheKey(opts);
  let handler = handlerCache.get(key);
  if (!handler) {
    const sdkHandler = createMcpHandler(() => createAncServer(getWarmCatalog()), {
      legacy: opts.legacy,
      responseMode: opts.jsonResponse ? 'json' : 'auto',
    });
    handler = sdkHandler as unknown as McpHandler;
    handlerCache.set(key, handler);
  }
  return handler;
}

/** Test hook — handler graph is keyed only by { responseMode, legacy }. */
export function resetMcpHandlerCacheForTests(): void {
  handlerCache.clear();
}

export function resolveLegacyMode(env: Pick<McpEnv, 'MCP_LEGACY_ENABLED'>): McpLegacyMode {
  return env.MCP_LEGACY_ENABLED === 'false' ? 'reject' : 'stateless';
}

export { SPEC_REVISION };

/** @deprecated Use getMcpHandler after loadCatalog. Kept for incremental test migration. */
export async function buildMcpHandler(
  env: McpEnv,
  opts: { jsonResponse: boolean } = { jsonResponse: true },
): Promise<McpHandler> {
  const { loadCatalog } = await import('./catalog');
  await loadCatalog(env);
  return getMcpHandler({ jsonResponse: opts.jsonResponse, legacy: resolveLegacyMode(env) });
}
