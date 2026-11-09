// Antecedent resolution for the web audit.
//
// A check is scored only when its antecedent holds; otherwise it is n_a
// (excluded from the relative score). Antecedents resolve from the declared site
// type, from MCP discovery, from the single canonical root fetch, or from
// a source check's probe result, never from a fresh fetch, which is what keeps
// the subrequest budget bounded. Each token's logic lives in a per-group
// module, beside the prerequisites naming what that logic reads; this file
// composes them into the dispatch tables.

import type { AntecedentToken } from '../registry';
import { apiEvidence, apiPrerequisites, apiResolvers } from './api';
import { authEvidence, authPrerequisites, authResolvers } from './auth';
import { contentEvidence, contentPrerequisites, contentResolvers } from './content';
import type { AntecedentContext, AntecedentResolution, AntecedentResolver } from './context';
import { discoverabilityEvidence, discoverabilityPrerequisites, discoverabilityResolvers } from './discoverability';
import { mcpEvidence, mcpPrerequisites, mcpResolvers } from './mcp';
import { rootEvidence, rootPrerequisites, rootResolvers } from './root';
import type { Prerequisite } from './sources';

export { siteTypeApplies } from './site-type';
export { MCP_NOTIFIED, MCP_SETTLED, type Prerequisite, SOURCE_CHECKS } from './sources';
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

const PREREQUISITES: Record<AntecedentToken, readonly Prerequisite[]> = {
  ...rootPrerequisites,
  ...mcpPrerequisites,
  ...apiPrerequisites,
  ...contentPrerequisites,
  ...discoverabilityPrerequisites,
  ...authPrerequisites,
};

/** What must have settled before `token` can resolve. */
export function antecedentPrerequisites(token: AntecedentToken): readonly Prerequisite[] {
  return PREREQUISITES[token];
}

export function resolveAntecedent(token: AntecedentToken, ctx: AntecedentContext): AntecedentResolution {
  return RESOLVERS[token](ctx);
}

/** Human evidence line for a check gated to n_a by its antecedent. */
export function antecedentUnmetEvidence(token: AntecedentToken): string {
  return UNMET_EVIDENCE[token];
}
