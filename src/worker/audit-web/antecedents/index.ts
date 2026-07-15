// Antecedent resolution for the web audit.
//
// A check is scored only when its antecedent holds; otherwise it is n_a
// (excluded from both scores). Antecedents resolve from the declared site
// type, from MCP discovery, from the single canonical root fetch, or from
// another check's wave-1 probe result, never from a fresh fetch, which is
// what keeps the subrequest budget bounded. Each token's logic lives in a
// per-group module; this file composes them into the dispatch tables.

import type { AntecedentToken } from '../registry';
import { apiEvidence, apiResolvers } from './api';
import { authEvidence, authResolvers } from './auth';
import { contentEvidence, contentResolvers } from './content';
import type { AntecedentContext, AntecedentResolution, AntecedentResolver } from './context';
import { discoverabilityEvidence, discoverabilityResolvers } from './discoverability';
import { mcpEvidence, mcpResolvers } from './mcp';
import { rootEvidence, rootResolvers } from './root';

export { siteTypeApplies } from './site-type';
export { WAVE1_CHECK_IDS } from './waves';
export type { AntecedentContext, AntecedentResolution };

const RESOLVERS: Record<AntecedentToken, AntecedentResolver> = {
  ...rootResolvers,
  ...mcpResolvers,
  ...apiResolvers,
  ...contentResolvers,
  ...discoverabilityResolvers,
  ...authResolvers,
};

const UNMET_EVIDENCE: Record<AntecedentToken, string> = {
  ...rootEvidence,
  ...mcpEvidence,
  ...apiEvidence,
  ...contentEvidence,
  ...discoverabilityEvidence,
  ...authEvidence,
};

export function resolveAntecedent(token: AntecedentToken, ctx: AntecedentContext): AntecedentResolution {
  return RESOLVERS[token](ctx);
}

/** Human evidence line for a check gated to n_a by its antecedent. */
export function antecedentUnmetEvidence(token: AntecedentToken): string {
  return UNMET_EVIDENCE[token];
}
