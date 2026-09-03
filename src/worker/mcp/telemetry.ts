// Structured MCP request telemetry: one PII-free `mcp.request` record per
// POST, emitted through the central emitter, which caps the client-supplied
// method, name, and client name and buckets the duration.

import { msBucket, truncateClientName } from '../telemetry/caps';
import { emitLog } from '../telemetry/log';

export { msBucket, truncateClientName };

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

/**
 * Extract a JSON-RPC transport error code from a response body (≤4 KB).
 *
 * Status is not a filter. The SDK answers its Host and Origin rejections with
 * HTTP 403 carrying a JSON-RPC envelope, so reading 200s alone would log those
 * rejections as `error_code: null` and leave the rebinding gate invisible to
 * the operator filter that has to catch a wrong allowlist. Any body that does
 * not parse as JSON with a numeric `error.code` still yields null.
 */
export async function extractTransportErrorCode(response: Response): Promise<number | null> {
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
  emitLog(
    { event: 'mcp.request' },
    {
      era: input.era,
      method: input.method,
      name: input.name,
      client_name: input.client_name,
      protocol_version: input.protocol_version,
      host: input.host,
      response_format: input.response_format,
      outcome: input.outcome,
      error_code: input.error_code,
      duration_ms: input.duration_ms,
    },
  );
}
