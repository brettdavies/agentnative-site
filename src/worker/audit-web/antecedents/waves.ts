/**
 * Checks probed in wave 1 because their results feed antecedent tokens or
 * retained bodies consumed by wave-2 checks. Probed unconditionally; their
 * own antecedents are applied afterwards from wave-1 data (the openapi probe
 * result is itself one input to its api-surface gate).
 */
export const WAVE1_CHECK_IDS: ReadonlySet<string> = new Set([
  'robots',
  'llms-txt',
  'llms-full-txt',
  'openapi',
  'oauth-discovery',
  'mcp-initialize',
  'sitemap',
]);
