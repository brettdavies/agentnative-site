// Shared in-process MCP RPC helpers for worker unit tests.

import { loadCatalog, resetCatalogCacheForTests } from '../../src/worker/mcp/catalog';
import { runWithMcpEnv } from '../../src/worker/mcp/env-context';
import { runWithMcpRequest } from '../../src/worker/mcp/request-context';
import {
  getMcpHandler,
  type McpEnv,
  resetMcpHandlerCacheForTests,
  resolveLegacyMode,
} from '../../src/worker/mcp/server';
import { _resetHintsIndexCache } from '../../src/worker/score/orchestrate';
import { _resetRegistryIndexCache } from '../../src/worker/score/registry-lookup';

export type JsonRpcBody = {
  jsonrpc: '2.0';
  id: number | string | null;
  method?: string;
  params?: unknown;
  result?: {
    serverInfo?: { name?: string; version?: string };
    protocolVersion?: string;
    capabilities?: { tools?: unknown; resources?: { subscribe?: boolean } };
    instructions?: string;
    tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    resources?: Array<{ uri: string; name?: string }>;
    resourceTemplates?: Array<{ uriTemplate: string; name?: string }>;
    content?: Array<{ type: string; text: string }>;
    contents?: Array<{ uri: string; mimeType: string; text: string }>;
    isError?: boolean;
    ttlMs?: number;
    cacheScope?: string;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
};

export function parseMcpHttpBody(raw: string, contentType?: string | null): JsonRpcBody {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('text/event-stream') || raw.trimStart().startsWith('event:')) {
    for (const line of raw.split('\n')) {
      if (line.startsWith('data: ')) {
        return JSON.parse(line.slice(6)) as JsonRpcBody;
      }
    }
    throw new Error(`no data: line in SSE MCP response: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(raw) as JsonRpcBody;
}

export async function mcpRpc(
  env: McpEnv,
  body: JsonRpcBody,
  headers: Record<string, string> = {},
  /** Origin the request arrives on; links in tool results are built from it. */
  origin = 'https://anc.dev',
): Promise<{
  status: number;
  body: JsonRpcBody;
  raw: string;
  contentType: string | null;
}> {
  await loadCatalog(env);
  const handler = getMcpHandler({ jsonResponse: true, legacy: resolveLegacyMode(env) });
  const res = await runWithMcpRequest(
    new Request(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: new URL(origin).host,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    () =>
      runWithMcpEnv(env, () =>
        handler.fetch(
          new Request('https://anc.dev/mcp', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              host: 'anc.dev',
              ...headers,
            },
            body: JSON.stringify(body),
          }),
        ),
      ),
  );
  const raw = await res.text();
  let parsed: JsonRpcBody = { jsonrpc: '2.0', id: null };
  try {
    parsed = parseMcpHttpBody(raw, res.headers.get('content-type'));
  } catch {
    // non-JSON (406/503 paths)
  }
  return { status: res.status, body: parsed, raw, contentType: res.headers.get('content-type') };
}

export async function mcpRpcExpect200(
  env: McpEnv,
  body: JsonRpcBody,
  headers?: Record<string, string>,
): Promise<JsonRpcBody> {
  const { status, body: parsed, raw } = await mcpRpc(env, body, headers);
  if (status !== 200) {
    throw new Error(`expected HTTP 200, got ${status}: ${raw}`);
  }
  return parsed;
}

export async function mcpInitialize(env: McpEnv): Promise<JsonRpcBody> {
  return mcpRpcExpect200(env, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    },
  });
}

export function resetMcpTestState(): void {
  resetCatalogCacheForTests();
  resetMcpHandlerCacheForTests();
  // Score-path indexes are isolate-scoped promises. Earlier suites can
  // cache a fixture without ripgrep (or an empty index); without a reset,
  // get_scorecard validates against the stale map and returns
  // unrecognized_input for curated slugs.
  _resetRegistryIndexCache();
  _resetHintsIndexCache();
}

export function getJsonToolContent(body: JsonRpcBody): unknown {
  const result = body.result as { content?: Array<{ type: string; text: string }> } | undefined;
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('expected text content block');
  return JSON.parse(text);
}
