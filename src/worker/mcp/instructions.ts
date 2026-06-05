// Session-time MCP usage summary returned in InitializeResult.instructions.
//
// The McpServer constructor accepts free-form usage guidance via
// ServerOptions.instructions. It fires once per session, so the cost of
// the prose amortizes across every subsequent tool call. Absent
// instructions would force every agent to fetch /.well-known/mcp out of
// band or guess the contract.
//
// The numeric facts authored below (9 tools, 5 resources total, both
// rate limits, the spec revision pin, the docs URL) are the same facts
// that appear in content/mcp.md and the AGENTS.md disclosure (U8). The
// tests in tests/worker-mcp.test.ts assert each literal digit and
// pinned URL so a change in one source forces a change in all three.
// Drift gate per KTD-8 of the plan.

const SITE_URL = 'https://anc.dev';
const SPEC_REVISION = '2025-06-18';
const DOCS_URL = `${SITE_URL}/mcp-docs.md`;
const TOOL_COUNT = 9;
const RESOURCE_TOTAL = 5;
const READ_LIMIT_REQUESTS = 60;
const READ_LIMIT_WINDOW_SECONDS = 60;
const AUDIT_LIMIT_REQUESTS = 5;
const AUDIT_LIMIT_WINDOW_MINUTES = 60;

export interface InstructionsEnv {
  ASSETS: Fetcher;
}

export function buildInstructions(_env: InstructionsEnv): string {
  return [
    `anc.dev exposes the agent-native CLI standard catalog over a streamable HTTP MCP server, per spec revision ${SPEC_REVISION}. ` +
      'Every scored CLI, every principle of the spec, and the vendored spec sections are queryable without authentication.',
    'Response format is driven by the Accept header. The server accepts application/json alone, text/event-stream ' +
      'alone, both together (any order, any q-values), */*, and absent Accept. JSON wins ties; q-values resolve ' +
      'unequal preferences. A request that accepts neither MIME type receives 406 Not Acceptable with a text/plain ' +
      'body, no JSON-RPC envelope, since the rejection is pre-JSON-RPC.',
    `Surface: ${TOOL_COUNT} tools (list_tools, get_tool, search_tools, list_principles, get_principle, ` +
      'list_spec_sections, get_spec_section, get_scorecard, score_cli) plus ' +
      `${RESOURCE_TOTAL} resources total (1 concrete anc://registry plus 4 templates anc://tool/{slug}, ` +
      'anc://principle/{n}, anc://spec/{section}, anc://scorecard/{binary}). ' +
      'Per-item records live behind the templates; full schemas are on tools/list and resources/templates/list.',
    'The two scorecard tools compose the shared /api/score orchestration so cache semantics never drift. ' +
      'get_scorecard always returns isError: false for cache-state outcomes (hit returns the inline scorecard; miss ' +
      'returns next_tool: score_cli). score_cli is the cache-miss-only fresh-audit path; on hit it returns ' +
      'next_tool: get_scorecard. isError: true is reserved for genuine tool-execution failures (validator rejection, ' +
      'rate-limit breach, infrastructure error).',
    'Errors carry on two layers. Tool-level failures return CallToolResult with isError: true plus a textual ' +
      'message; the JSON-RPC envelope itself is successful. Transport-level failures return JSON-RPC error envelopes ' +
      'at HTTP 200: -32700 parse error for malformed JSON, -32099 for rate-limit breach (either limiter). The 406 ' +
      'Accept-header rejection is the one transport error that bypasses the JSON-RPC envelope.',
    `Rate limits are split. ${READ_LIMIT_REQUESTS} requests per ${READ_LIMIT_WINDOW_SECONDS} seconds per IP gate ` +
      `every call (MCP_LIMITER). ${AUDIT_LIMIT_REQUESTS} fresh audits per ${AUDIT_LIMIT_WINDOW_MINUTES} minutes per ` +
      'IP gate score_cli cache-miss audits only (MCP_AUDIT_LIMITER). Both keyed on cf-connecting-ip; the read tier ' +
      'falls back to a shared anon bucket, the audit tier rejects on missing IP rather than consuming a shared ' +
      'bucket. Two env-var kill switches let the operator disable the whole surface (MCP_ENABLED) or only the ' +
      'cost-bearing audit tool (MCP_LIVE_SCORING_ENABLED) without a deploy.',
    `Spec revision is pinned to ${SPEC_REVISION}; the /.well-known/mcp pointer advertises the same value, and the ` +
      'two are bumped in lockstep when the SDK is upgraded.',
    `Full contract at ${DOCS_URL}`,
  ].join(' ');
}
