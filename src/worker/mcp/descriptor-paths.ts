// MCP server-card path constants. Lives outside the Worker entrypoint so
// wrangler dev does not treat string/Set exports as export-map handlers.

import { SEP_1649_CARD_PATH } from '../../shared/mcp-discovery';

// SEP-1649 canonical path. Legacy pointer aliases 301 to it: one
// canonical body, no ambiguous duplicates.
export const MCP_DESCRIPTOR_CANONICAL_PATH = SEP_1649_CARD_PATH;

export const MCP_DESCRIPTOR_ALIAS_PATHS = new Set(['/.well-known/mcp', '/mcp.json', '/.well-known/mcp.json']);
