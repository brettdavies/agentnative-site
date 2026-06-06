// Visitor inventory log — one INFO-level structured line per POST /mcp.
//
// The MCP server is intentionally public (catalog has no auth) and the
// proposal targets server-to-agent callers. Visitor inventory is the
// first-order question for that posture: who is calling, and were they
// rate-limited? Per R8 of the plan the log fires AFTER the rate-limit
// gate decision so Workers Logs volume stays bounded under attack while
// still recording the denial. The `gate_result` field carries
// `passed | rate_limited` to surface that in queries.
//
// Payload uses null-emit-explicit (the key is always present, the value
// is null when the header is absent) so downstream queries see a stable
// shape. snake_case matches the /.well-known/mcp field convention. The
// structured object — not a pre-stringified string — lets Workers Logs
// auto-extract fields for filtering (see docs/solutions/tooling-decisions
// /workers-logs-console-log-object-auto-extraction.md).

export type McpGateResult = 'passed' | 'rate_limited';

export interface VisitorLogOptions {
  format: 'json' | 'sse';
  gate_result: McpGateResult;
}

export function logVisitor(request: Request, opts: VisitorLogOptions): void {
  const headers = request.headers;
  const payload = {
    origin: headers.get('origin'),
    user_agent: headers.get('user-agent'),
    ip: headers.get('cf-connecting-ip'),
    country: headers.get('cf-ipcountry'),
    format: opts.format,
    gate_result: opts.gate_result,
  };
  console.log('[mcp-call]', payload);
}
