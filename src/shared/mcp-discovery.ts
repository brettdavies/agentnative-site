// What anc.dev's MCP server calls itself and where its SEP-2127 discovery
// documents live. The build writes the server card and the AI catalog from
// these, the Worker serves and origin-rewrites them, the MCP server reports
// the same identity at runtime, and the web audit reads cards by the same
// media type. Bare-string constants only, so the Worker, the browser
// client, and the Bun build all accept the module.

/** The `serverInfo` the MCP server reports, which its card must not contradict. */
export const MCP_SERVER_NAME = 'anc';
export const MCP_SERVER_VERSION = '0.1.0';

/** SEP-2127 reserves `<streamable-http-url>/server-card` as an endpoint's card location. */
export const MCP_SERVER_CARD_PATH = '/mcp/server-card';
export const AI_CATALOG_PATH = '/.well-known/ai-catalog.json';

// Build seeds the Worker rewrites to the request's origin and serves at the
// card paths; the Worker 404s every /_internal/ path, so a seed is never served as itself.
export const MCP_SERVER_CARD_SEED_PATH = '/_internal/mcp-server-card-sep2127.json';
export const SEP_1649_CARD_SEED_PATH = '/_internal/mcp-server-card.json';

export const MCP_SERVER_CARD_TYPE = 'application/mcp-server-card+json';
export const AI_CATALOG_TYPE = 'application/ai-catalog+json';

/**
 * The `$schema` the extension schema requires of every card. It answers 404
 * until the extension graduates; the spec-drift poll watches it, and cards
 * validate against the vendored schema meanwhile.
 */
export const MCP_SERVER_CARD_SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
