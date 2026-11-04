/**
 * Checks probed as soon as discovery settles, whatever their own antecedent
 * says, because their results feed antecedent tokens or retained bodies other
 * checks read. Their own antecedents apply once those signals are in: the
 * openapi probe result is itself one input to its api-surface gate, and the
 * accept-markdown probe result is one of the markdown-twin gate's markdown
 * signals.
 */
export const SOURCE_CHECK_IDS = [
  'robots',
  'llms-txt',
  'llms-full-txt',
  'openapi',
  'oauth-discovery',
  'mcp-initialize',
  'mcp-server-discover',
  'sitemap',
  'accept-markdown',
] as const;

export type SourceCheckId = (typeof SOURCE_CHECK_IDS)[number];

export const SOURCE_CHECKS: ReadonlySet<string> = new Set(SOURCE_CHECK_IDS);

/**
 * The step after both MCP wire probes answer: sign-in settled, their rows read
 * again if it is required, and the session and lane facts taken.
 */
export const MCP_SETTLED = 'mcp-settled';

/**
 * The session notified, after MCP_SETTLED. The protocol has a client send
 * nothing else on a session until the server has that notification, so every
 * later request to the endpoint comes after it.
 */
export const MCP_NOTIFIED = 'mcp-notified';

/** What must have settled before a check can gate or probe: a source check's probe, or an MCP step. */
export type Prerequisite = SourceCheckId | typeof MCP_SETTLED | typeof MCP_NOTIFIED;
