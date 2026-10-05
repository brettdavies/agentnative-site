// What anc.dev's MCP server calls itself and where its discovery documents
// live. The build writes the SEP-2127 server card and the AI catalog from
// these, the Worker serves and origin-rewrites them, the MCP server reports
// the same identity at runtime, the web audit reads cards by the same media
// type, and every surface that advertises the documents renders
// MCP_DISCOVERY_DOCUMENTS. Plain data with no imports, so the Worker, the
// browser client, and the Bun build all accept the module.

/** The `serverInfo` the MCP server reports, which its card must not contradict. */
export const MCP_SERVER_NAME = 'anc';
export const MCP_SERVER_VERSION = '0.1.0';

/** The SEP-1649 card's canonical path; its pointer aliases 301 here. */
export const SEP_1649_CARD_PATH = '/.well-known/mcp/server-card.json';
/** SEP-2127 reserves `<streamable-http-url>/server-card` as an endpoint's card location. */
export const MCP_SERVER_CARD_PATH = '/mcp/server-card';
export const AI_CATALOG_PATH = '/.well-known/ai-catalog.json';

// Build seeds the Worker rewrites to the request's origin and serves at the
// card paths; the Worker 404s every /_internal/ path, so a seed is never served as itself.
export const MCP_SERVER_CARD_SEED_PATH = '/_internal/mcp-server-card-sep2127.json';
export const SEP_1649_CARD_SEED_PATH = '/_internal/mcp-server-card.json';

export const MCP_SERVER_CARD_TYPE = 'application/mcp-server-card+json';
export const AI_CATALOG_TYPE = 'application/ai-catalog+json';

/** A machine-readable document that describes or lists the MCP server. */
export interface McpDiscoveryDocument {
  path: string;
  type: string;
  label: string;
  /** The link relation naming the document in a Link header, a `<link>`, or a linkset. */
  rel: string;
}

/**
 * The discovery documents every advertising surface lists, in this order.
 * Neither server card spec defines a link relation, so both cards use RFC
 * 8631 `service-desc`; `ai-catalog` is the relation the AI Catalog spec
 * defines for its document.
 */
export const MCP_DISCOVERY_DOCUMENTS: readonly McpDiscoveryDocument[] = [
  { path: SEP_1649_CARD_PATH, type: 'application/json', label: 'MCP server card (SEP-1649)', rel: 'service-desc' },
  { path: MCP_SERVER_CARD_PATH, type: MCP_SERVER_CARD_TYPE, label: 'MCP server card (SEP-2127)', rel: 'service-desc' },
  { path: AI_CATALOG_PATH, type: AI_CATALOG_TYPE, label: 'AI catalog', rel: 'ai-catalog' },
];

/**
 * The `$schema` the extension schema requires of every card. It answers 404
 * until the extension graduates; the spec-drift poll watches it, and cards
 * validate against the vendored schema meanwhile.
 */
export const MCP_SERVER_CARD_SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
