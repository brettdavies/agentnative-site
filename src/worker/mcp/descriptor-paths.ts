// MCP server-card path constants. Lives outside the Worker entrypoint so
// wrangler dev does not treat string/Set exports as export-map handlers.

// SEP-1649 canonical path. Legacy pointer aliases 301 to it (R9): one
// canonical body, no ambiguous duplicates.
export const MCP_DESCRIPTOR_CANONICAL_PATH = '/.well-known/mcp/server-card.json';

export const MCP_DESCRIPTOR_ALIAS_PATHS = new Set(['/.well-known/mcp', '/mcp.json', '/.well-known/mcp.json']);
