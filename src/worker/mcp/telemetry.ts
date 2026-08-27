// Structured MCP request telemetry — one PII-free `mcp.request` line per POST.
// Replaces visitor-log.ts `[mcp-call]`. See docs/plans/2026-08-25-001-feat-mcp-
// 2026-dual-protocol-plan.md appendix.

export type McpEra = 'legacy' | 'modern';

export type McpResponseFormat = 'json' | 'sse';

export type McpRequestOutcome =
  | 'ok'
  | 'error'
  | 'legacy_rejected'
  | 'rate_limited'
  | 'disabled'
  | 'accept_rejected'
  | 'live_scoring_disabled'
  | 'web_audit_disabled';

export interface McpRequestLogInput {
  era: McpEra;
  method: string | null;
  name: string | null;
  client_name: string | null;
  protocol_version: string | null;
  host: string;
  response_format: McpResponseFormat;
  outcome: McpRequestOutcome;
  error_code: number | null;
  duration_ms: number;
}

const MAX_ERROR_BODY_BYTES = 4096;

/**
 * The format actually served, read off the response the client receives.
 *
 * The modern lane is built with `responseMode: 'auto'`, which the SDK defines
 * as a single JSON body unless the handler emits a related message before its
 * result. Tools that report nothing mid-call therefore answer JSON even when
 * the client asked for a stream, so an Accept-derived value logs `'sse'` while
 * JSON goes on the wire and an operator filtering `response_format = 'sse'`
 * over-counts. Because `auto` is dynamic, no intent-derived value stays correct
 * once any tool starts reporting progress; only the served content-type does.
 *
 * Exits that carry no MCP body (the kill switch and the Accept rejection) serve
 * `text/plain` and land on `'json'`: under the served reading the field answers
 * "was this a stream", and those responses are not streams.
 */
export function servedResponseFormat(response: Response): McpResponseFormat {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  return contentType.includes('text/event-stream') ? 'sse' : 'json';
}

export function msBucket(ms: number): '<50' | '50-200' | '200-1000' | '>1000' {
  if (ms < 50) return '<50';
  if (ms < 200) return '50-200';
  if (ms < 1000) return '200-1000';
  return '>1000';
}

export function truncateClientName(name: string | null | undefined, max = 64): string | null {
  if (name == null || name === '') return null;
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

/** Extract JSON-RPC transport error code from a response body (≤4 KB). */
export async function extractTransportErrorCode(response: Response): Promise<number | null> {
  if (!response.ok && response.status !== 200) return null;
  try {
    const clone = response.clone();
    const buf = await clone.arrayBuffer();
    if (buf.byteLength > MAX_ERROR_BODY_BYTES) return null;
    const text = new TextDecoder().decode(buf);
    const parsed = JSON.parse(text) as { error?: { code?: unknown } };
    const code = parsed.error?.code;
    return typeof code === 'number' ? code : null;
  } catch {
    return null;
  }
}

export function extractClientNameFromBody(parsedBody: unknown): string | null {
  if (typeof parsedBody !== 'object' || parsedBody === null) return null;
  const params = (parsedBody as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return null;

  const p = params as Record<string, unknown>;

  const initClient = p.clientInfo;
  if (typeof initClient === 'object' && initClient !== null && 'name' in initClient) {
    const n = (initClient as { name?: unknown }).name;
    if (typeof n === 'string') return truncateClientName(n);
  }

  const meta = p._meta;
  if (typeof meta === 'object' && meta !== null) {
    const clientInfo = (meta as Record<string, unknown>)['io.modelcontextprotocol/clientInfo'];
    if (typeof clientInfo === 'object' && clientInfo !== null && 'name' in clientInfo) {
      const n = (clientInfo as { name?: unknown }).name;
      if (typeof n === 'string') return truncateClientName(n);
    }
  }

  return null;
}

export function extractProtocolVersion(parsedBody: unknown, request: Request): string | null {
  const header = request.headers.get('MCP-Protocol-Version') ?? request.headers.get('mcp-protocol-version');
  if (header) return header;

  if (typeof parsedBody !== 'object' || parsedBody === null) return null;
  const params = (parsedBody as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return null;

  const p = params as Record<string, unknown>;
  if (typeof p.protocolVersion === 'string') return p.protocolVersion;

  const meta = p._meta;
  if (typeof meta === 'object' && meta !== null) {
    const pv = (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'];
    if (typeof pv === 'string') return pv;
  }

  return null;
}

export function logMcpRequest(input: McpRequestLogInput): void {
  // method and name can carry client-supplied strings on paths that
  // fire before the rate limiter; cap them like client_name so a
  // flood cannot amplify log volume with unbounded values.
  const payload = {
    event: 'mcp.request',
    era: input.era,
    method: truncateClientName(input.method),
    name: truncateClientName(input.name),
    client_name: input.client_name,
    protocol_version: input.protocol_version,
    host: input.host,
    response_format: input.response_format,
    outcome: input.outcome,
    error_code: input.error_code,
    ms_bucket: msBucket(input.duration_ms),
  };
  console.log(JSON.stringify(payload));
}
