// MCP server-card path constants. Lives outside the Worker entrypoint so
// wrangler dev does not treat string/Set exports as export-map handlers.

export const MCP_DESCRIPTOR_CANONICAL_PATH = '/.well-known/mcp/server-card.json';

export const MCP_DESCRIPTOR_ALIAS_PATHS = new Set([
  MCP_DESCRIPTOR_CANONICAL_PATH,
  '/.well-known/mcp',
  '/mcp.json',
  '/.well-known/mcp.json',
]);
