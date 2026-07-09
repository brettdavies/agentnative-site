// `mcp` probe handler (plan U4). Builds the JSON-RPC payload per op
// (initialize / tools-list / error) with `Accept: application/json,
// text/event-stream` and the pinned protocol version, POSTs through the
// SSRF guard, parses JSON or SSE via parseJsonRpc, and evaluates
// serverInfo / capabilities / tools / error-code / CORS. Returns n_a
// when no endpoint was discovered. Port of handler_mcp.

import { parseJsonRpc } from '../assert';
import type { WebCheck } from '../registry';
import { guardedFetch } from '../ssrf';
import { timeoutMsFor } from './shared';
import type { EvidenceItem, HandlerContext, ProbeOutcome } from './types';

type McpWith = {
  op: 'initialize' | 'tools-list' | 'error';
  assert?: 'capabilities' | 'cors';
  method?: string;
  expect_code?: number;
  origin?: string;
  timeout?: number;
};

function buildBody(op: McpWith['op'], method: string, protocolVersion: string): string {
  if (op === 'initialize') {
    return JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'agent-web-audit', version: '1.0' },
      },
    });
  }
  if (op === 'tools-list') {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  }
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} });
}

export async function runMcp(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const endpoint = ctx.mcpEndpoint;
  if (!endpoint) {
    return { status: 'na', evidence: [{ why: ['no MCP endpoint discovered'] }] };
  }
  const w = check.with as McpWith;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (w.origin) headers.Origin = w.origin;

  const resp = await guardedFetch(
    endpoint,
    { method: 'POST', headers, body: buildBody(w.op, w.method ?? '', ctx.protocolVersion) },
    { ...ctx.fetchOptions, timeoutMs: timeoutMsFor(w.timeout, ctx.defaultTimeoutMs) },
  );
  const rpc = parseJsonRpc(resp);
  const ev: EvidenceItem = { url: endpoint, status: resp.status, error: resp.error };
  const wwwAuthenticate = resp.headers['www-authenticate'];
  if (wwwAuthenticate !== undefined) ev.www_authenticate = wwwAuthenticate;

  if (resp.error) {
    ev.why = ['request failed'];
    return { status: 'error', evidence: [ev] };
  }
  // The endpoint exists (discovery found it), so a response that carries
  // no parseable JSON-RPC is a broken surface, not an absent one.
  if (rpc === null) {
    ev.why = ['no parseable JSON-RPC response'];
    return { status: 'broken', evidence: [ev] };
  }

  const result = (rpc.result ?? {}) as Record<string, unknown>;
  let ok: boolean;
  if (w.op === 'initialize') {
    const serverInfo = result.serverInfo as { name?: string } | undefined;
    const capabilities = (result.capabilities ?? null) as Record<string, unknown> | null;
    ev.serverInfo = serverInfo ?? null;
    ev.protocolVersion = result.protocolVersion ?? null;
    ev.capabilities = capabilities ? Object.keys(capabilities) : [];
    ok = w.assert === 'capabilities' ? !!capabilities && Object.keys(capabilities).length > 0 : !!serverInfo?.name;
  } else if (w.op === 'tools-list') {
    if (w.assert === 'cors') {
      const acao = resp.headers['access-control-allow-origin'] ?? null;
      ev.allow_origin = acao;
      ok = acao !== null;
    } else {
      const tools = result.tools as Array<{ name?: string; inputSchema?: unknown }> | undefined;
      ev.tools = Array.isArray(tools) ? tools.map((t) => t.name ?? null) : null;
      ev.with_input_schema = Array.isArray(tools) ? tools.filter((t) => t.inputSchema).length : 0;
      ok = Array.isArray(tools);
    }
  } else {
    const code = (rpc.error as { code?: number } | undefined)?.code ?? null;
    ev.error_code = code;
    ok = code === (w.expect_code ?? -32601);
  }
  return { status: ok ? 'pass' : 'broken', evidence: [ev] };
}
