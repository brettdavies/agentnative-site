// The one test-side expectation for the MCP tool surface, shared by the
// bun unit layer (tests/worker-mcp.test.ts) and the live staging specs
// (tests/e2e/mcp.e2e.ts, tests/e2e/discoverability.e2e.ts). Deliberately
// NOT derived from src/worker/mcp — the registrations are the system
// under test, and an expectation computed from them would pass no matter
// what they register. Changing the tool surface means updating this list,
// which drags the prose surfaces (instructions.ts, content/mcp-skill.md,
// AGENTS.md) through their literal-digit drift gates per KTD-8.

// Names in registration order — tools/list order is the registration
// order in src/worker/mcp/tools/index.ts.
export const EXPECTED_TOOL_NAMES = [
  'list_tools',
  'get_tool',
  'search_tools',
  'list_principles',
  'get_principle',
  'list_spec_sections',
  'get_spec_section',
  'get_scorecard',
  'score_cli',
  'get_website_audit',
  'audit_website',
  'list_website_audits',
  'get_web_remediation',
] as const;

export const EXPECTED_TOOL_COUNT = EXPECTED_TOOL_NAMES.length;

export const EXPECTED_TOOL_TITLES: Record<string, string> = {
  list_tools: 'List scored CLI registry entries',
  get_tool: 'Get a registry entry',
  search_tools: 'Search the CLI registry',
  list_principles: 'List agent-native principles',
  get_principle: 'Get an agent-native principle',
  list_spec_sections: 'List spec sections',
  get_spec_section: 'Get a spec section',
  get_scorecard: 'Get a cached CLI scorecard',
  score_cli: 'Run a live CLI audit',
  get_website_audit: 'Get a cached website audit',
  audit_website: 'Run a live website audit',
  list_website_audits: 'List cached website audits',
  get_web_remediation: 'Get web-audit remediation guidance',
};

// score_cli and audit_website reach external systems and write cache /
// leaderboard state, so readOnlyHint is false and openWorldHint true.
export const NON_READ_TOOL_NAMES = new Set(['score_cli', 'audit_website']);
