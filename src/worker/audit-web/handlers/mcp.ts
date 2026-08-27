// `mcp` probe handler. Builds the JSON-RPC payload per op (legacy
// initialize / tools-list / resources-list / error with the registry's
// pinned protocol version; modern-era modern-tools-list / server-discover
// header-routed per SEP-2243; the per-era error-code conformance family),
// POSTs through the SSRF guard, parses JSON or SSE via parseJsonRpc, and
// evaluates serverInfo / capabilities / tools / resources / discovery /
// error-code. Returns n_a when no endpoint was discovered. CORS
// classification lives in the cors-preflight posture handler.

import { parseJsonRpc } from '../assert';
import type { WebCheck } from '../registry';
import { type GuardedFetchOptions, guardedFetch } from '../ssrf';
import { timeoutMsFor } from './shared';
import type { EvidenceItem, HandlerContext, ProbeOutcome } from './types';

type ConformanceOp =
  | 'malformed-body'
  | 'batch-reject'
  | 'unknown-tool'
  | 'modern-unknown-method'
  | 'modern-clientcaps'
  | 'modern-header-mismatch'
  | 'modern-version-reject'
  | 'modern-resources-miss';

type McpWith = {
  op:
    | 'initialize'
    | 'tools-list'
    | 'resources-list'
    | 'error'
    | 'modern-tools-list'
    | 'server-discover'
    | ConformanceOp;
  assert?: 'capabilities';
  method?: string;
  expect_code?: number;
  timeout?: number;
};

// The modern era is a handler concern, not registry config: the
// registry's mcp_discovery.protocol_version stays the legacy pin and
// keeps legacy discovery byte-stable.
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

// Codes that signal the probed era lane is not offered (-32601 method
// not found, -32022 UnsupportedProtocolVersion). Any other well-formed
// error envelope keeps the broken-surface penalty.
const LANE_UNAVAILABLE_CODES = new Set([-32601, -32022]);

const MODERN_OPS = new Set<McpWith['op']>(['modern-tools-list', 'server-discover']);

const CLIENT_INFO = { name: 'agent-web-audit', version: '1.0' };

function legacyProbeHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
}

/** Modern request headers (SEP-2243): header-routed, sessionless, no initialize. */
export function modernProbeHeaders(method: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
    'Mcp-Method': method,
  };
}

function modernMeta(protocolVersion: string): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

/** Modern request body; clientCapabilities is mandatory on every modern request (omitting it draws -32602). */
export function modernProbeBody(method: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method,
    params: { _meta: modernMeta(MODERN_PROTOCOL_VERSION) },
  });
}

// A protocol revision that predates the modern lane, so every conforming
// 2026-07-28 server must refuse it with -32022 + data.supported.
const UNSUPPORTED_VERSION_CLAIM = '2025-03-26';
const UNKNOWN_TOOL_NAME = 'not_a_real_tool';
const UNKNOWN_METHOD = 'nonexistent/method';
const RESOURCE_MISS_URI = 'resource://agent-web-audit/nonexistent';

type ConformanceProbe = {
  headers: () => Record<string, string>;
  body: () => string;
  /** JSON-RPC error codes that satisfy the row. */
  accept: readonly number[];
  /** Bare HTTP statuses that satisfy the row when no envelope came back (typed refusal arm). */
  httpAccept?: readonly number[];
  /** The accepted envelope must carry error.data.supported (version reject). */
  requireSupported?: boolean;
};

// Per-era conformance probes: one request each, era-shaped headers, raw
// body override where the probe is the body itself (malformed / batch).
// Codes -32603 (an internal error cannot be forced from outside) and
// -32099 (triggering rate limits against third-party servers is abusive)
// are deliberately not probed.
const CONFORMANCE_PROBES: Record<ConformanceOp, ConformanceProbe> = {
  'malformed-body': {
    headers: legacyProbeHeaders,
    body: () => 'not-json{{',
    accept: [-32700],
    httpAccept: [400, 415],
  },
  'batch-reject': {
    // A valid all-legacy batch is served on the pinned SDK line; the
    // reliably rejected shape is a batch carrying a modern-envelope element.
    headers: legacyProbeHeaders,
    body: () => `[${modernProbeBody('tools/list')}]`,
    accept: [-32600],
  },
  'unknown-tool': {
    headers: legacyProbeHeaders,
    body: () =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: UNKNOWN_TOOL_NAME, arguments: {} },
      }),
    accept: [-32602],
  },
  'modern-unknown-method': {
    headers: () => modernProbeHeaders(UNKNOWN_METHOD),
    body: () => modernProbeBody(UNKNOWN_METHOD),
    accept: [-32601],
  },
  'modern-clientcaps': {
    headers: () => modernProbeHeaders('tools/list'),
    body: () => {
      const { 'io.modelcontextprotocol/clientCapabilities': _dropped, ...meta } = modernMeta(MODERN_PROTOCOL_VERSION);
      return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } });
    },
    accept: [-32602, -32600],
  },
  'modern-header-mismatch': {
    headers: () => modernProbeHeaders('resources/list'),
    body: () => modernProbeBody('tools/list'),
    accept: [-32020],
  },
  'modern-version-reject': {
    headers: () => ({ ...modernProbeHeaders('tools/list'), 'MCP-Protocol-Version': UNSUPPORTED_VERSION_CLAIM }),
    body: () =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: modernMeta(UNSUPPORTED_VERSION_CLAIM) },
      }),
    accept: [-32022],
    requireSupported: true,
  },
  'modern-resources-miss': {
    headers: () => ({ ...modernProbeHeaders('resources/read'), 'Mcp-Name': RESOURCE_MISS_URI }),
    body: () =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: RESOURCE_MISS_URI, _meta: modernMeta(MODERN_PROTOCOL_VERSION) },
      }),
    // -32602 is the miss code at the SDK encode seam; -32002 is
    // receive-tolerated legacy compat from non-SDK servers.
    accept: [-32602, -32002],
  },
};

function conformanceFor(op: McpWith['op']): ConformanceProbe | undefined {
  return op in CONFORMANCE_PROBES ? CONFORMANCE_PROBES[op as ConformanceOp] : undefined;
}

function buildBody(op: McpWith['op'], method: string, protocolVersion: string): string {
  if (op === 'initialize') {
    return JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    });
  }
  if (op === 'tools-list') {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  }
  if (op === 'resources-list') {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} });
  }
  if (op === 'modern-tools-list') {
    return modernProbeBody('tools/list');
  }
  if (op === 'server-discover') {
    return modernProbeBody('server/discover');
  }
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} });
}

export function mcpSessionIdFrom(outcome: ProbeOutcome | undefined): string | null {
  const raw = outcome?.evidence[0]?.session_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

const INITIALIZED_BODY = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

/** Best-effort session handshake after initialize; failures do not fail the audit. */
export async function notifyMcpInitialized(
  endpoint: string,
  sessionId: string,
  opts: {
    timeoutMs: number;
    fetchOptions?: Pick<GuardedFetchOptions, 'fetchImpl' | 'maxRedirects'>;
  },
): Promise<void> {
  await guardedFetch(
    endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': sessionId,
      },
      body: INITIALIZED_BODY,
    },
    { ...opts.fetchOptions, timeoutMs: opts.timeoutMs },
  );
}

export async function runMcp(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const endpoint = ctx.mcpEndpoint;
  if (!endpoint) {
    return { status: 'na', evidence: [{ why: ['no MCP endpoint discovered'] }] };
  }
  const w = check.with as McpWith;
  const conformance = conformanceFor(w.op);
  const modernOp = MODERN_OPS.has(w.op);
  // Modern probes stay sessionless (no Mcp-Session-Id) and carry no
  // Mcp-Name: neither op is a tools/call or resources/read. Conformance
  // probes are single self-contained requests: fully table-shaped
  // headers, never a session attach.
  const headers: Record<string, string> = conformance
    ? conformance.headers()
    : modernOp
      ? modernProbeHeaders(w.op === 'server-discover' ? 'server/discover' : 'tools/list')
      : legacyProbeHeaders();
  if (!conformance && !modernOp && w.op !== 'initialize' && ctx.mcpSessionId) {
    headers['Mcp-Session-Id'] = ctx.mcpSessionId;
  }

  const resp = await guardedFetch(
    endpoint,
    {
      method: 'POST',
      headers,
      body: conformance ? conformance.body() : buildBody(w.op, w.method ?? '', ctx.protocolVersion),
    },
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
  // no parseable JSON-RPC is a broken surface, not an absent one. A
  // conformance row with a typed-HTTP arm accepts a bare refusal in the
  // listed statuses; 404 stays out of every arm so a dead endpoint earns
  // nothing.
  if (rpc === null) {
    if (conformance && resp.status !== null && (conformance.httpAccept ?? []).includes(resp.status)) {
      ev.why = ['typed HTTP refusal with no JSON-RPC envelope'];
      return { status: 'pass', evidence: [ev] };
    }
    ev.why = ['no parseable JSON-RPC response'];
    return { status: 'broken', evidence: [ev] };
  }

  // Conformance classification: the expected refusal code passes, an
  // unavailability-coded refusal that is not the expected code means the
  // era machinery is not offered (absent), anything else well-formed
  // stays broken.
  if (conformance) {
    const err = rpc.error as { code?: number; data?: { supported?: unknown } } | undefined;
    const code = typeof err?.code === 'number' ? err.code : null;
    ev.error_code = code;
    if (code === null) {
      ev.why = ['expected a JSON-RPC error envelope, got a result'];
      return { status: 'broken', evidence: [ev] };
    }
    if (conformance.accept.includes(code)) {
      if (conformance.requireSupported) {
        if (!Array.isArray(err?.data?.supported)) {
          ev.why = ['error.data.supported missing from the version-reject envelope'];
          return { status: 'broken', evidence: [ev] };
        }
        ev.supported_versions = err.data.supported;
      }
      return { status: 'pass', evidence: [ev] };
    }
    return { status: LANE_UNAVAILABLE_CODES.has(code) ? 'absent' : 'broken', evidence: [ev] };
  }

  // Era-mismatch classification for the result-expecting ops on both
  // lanes: an unavailability-coded refusal means the probed era is not
  // offered (absent), any other error envelope stays broken. The error
  // op keeps its own expect_code semantics.
  if (rpc.error !== undefined && w.op !== 'error') {
    const code = (rpc.error as { code?: number } | undefined)?.code;
    ev.error_code = typeof code === 'number' ? code : null;
    return {
      status: typeof code === 'number' && LANE_UNAVAILABLE_CODES.has(code) ? 'absent' : 'broken',
      evidence: [ev],
    };
  }

  const result = (rpc.result ?? {}) as Record<string, unknown>;
  let ok: boolean;
  if (w.op === 'initialize') {
    const serverInfo = result.serverInfo as { name?: string } | undefined;
    const capabilities = (result.capabilities ?? null) as Record<string, unknown> | null;
    ev.serverInfo = serverInfo ?? null;
    ev.protocolVersion = result.protocolVersion ?? null;
    ev.capabilities = capabilities ? Object.keys(capabilities) : [];
    ev.session_id = resp.headers['mcp-session-id'] ?? null;
    ok = w.assert === 'capabilities' ? !!capabilities && Object.keys(capabilities).length > 0 : !!serverInfo?.name;
  } else if (w.op === 'tools-list' || w.op === 'modern-tools-list') {
    const tools = result.tools as Array<{ name?: string; inputSchema?: unknown }> | undefined;
    ev.tools = Array.isArray(tools) ? tools.map((t) => t.name ?? null) : null;
    ev.with_input_schema = Array.isArray(tools) ? tools.filter((t) => t.inputSchema).length : 0;
    ok = Array.isArray(tools);
  } else if (w.op === 'server-discover') {
    const supported = result.supportedVersions;
    const meta = result._meta as Record<string, unknown> | undefined;
    const serverInfo = meta?.[SERVER_INFO_META_KEY] as { name?: string } | undefined;
    const capabilities = (result.capabilities ?? null) as Record<string, unknown> | null;
    ev.supported_versions = Array.isArray(supported) ? supported : null;
    ev.serverInfo = serverInfo ?? null;
    // The modern lane's capability advertisement; the mcp-resources
    // antecedent reads it alongside the legacy initialize evidence.
    ev.capabilities = capabilities ? Object.keys(capabilities) : [];
    ok = Array.isArray(supported) && !!serverInfo?.name;
  } else if (w.op === 'resources-list') {
    const resources = result.resources as Array<{ uri?: string; name?: string }> | undefined;
    ev.resources = Array.isArray(resources) ? resources.map((r) => r.uri ?? r.name ?? null) : null;
    ok = Array.isArray(resources) && resources.length > 0;
  } else {
    const code = (rpc.error as { code?: number } | undefined)?.code ?? null;
    ev.error_code = code;
    ok = code === (w.expect_code ?? -32601);
  }
  return { status: ok ? 'pass' : 'broken', evidence: [ev] };
}
