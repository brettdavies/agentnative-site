// Shared context type and evidence accessors for the antecedent resolvers.
// Each per-group module (root, mcp, api, content, discoverability, auth)
// resolves a subset of the tokens against this context; index.ts composes
// them into the dispatch tables.

import type { NaReason } from '../../../shared/web-audit-findings';
import type { ProbeResponse } from '../assert';
import type { DeclaredHostReason } from '../endpoint-of-record';
import type { EvidenceItem, McpAuthRequired, ProbeOutcome } from '../handlers/types';
import type { WebSiteType } from '../registry';

export interface AntecedentContext {
  /** Declared site type from the entry point; null/undefined = run everything. */
  siteType?: WebSiteType | null;
  mcpEndpoint: string | null;
  discoveryEvidence: EvidenceItem[];
  /** The canonical plain GET `/` response; null when it failed at the network level. */
  root: ProbeResponse | null;
  /** Wave-1 probe outcomes keyed by check id. */
  sources: ReadonlyMap<string, ProbeOutcome>;
  /** What following the declared hosts settled; absent when the audit followed none. */
  follow?: { unmet: DeclaredHostReason | null };
  /** Set when the endpoint of record requires sign-in; absent or null when it does not. */
  mcpAuth?: McpAuthRequired | null;
}

/** Whether a check applies, does not, or cannot be decided because the root never answered. */
export type AntecedentOutcome = 'apply' | 'n_a' | 'error';

/**
 * A resolver's result: a bare outcome, or an `n_a` that names its reason,
 * which the gate stamps on the row in place of `antecedent-unmet`. A reason
 * about a declared host names that host, so the row reads as the host it
 * could not be evaluated at rather than the audited one, with the declared
 * URL as its evidence.
 */
export type AntecedentResolution =
  | AntecedentOutcome
  | { outcome: 'n_a'; reason: NaReason; host?: string; evidence?: string };

/** Resolves one antecedent token against the wave-1 context. */
export type AntecedentResolver = (ctx: AntecedentContext) => AntecedentResolution;

export function rootContentType(ctx: AntecedentContext): string {
  return ctx.root?.headers['content-type'] ?? '';
}

/**
 * Gate for antecedents scoped to an HTML root document: `'error'` when the
 * root never answered, `'n_a'` when it answered as non-HTML, and `null`
 * when it is HTML and the caller should keep resolving.
 */
export function htmlRootGate(ctx: AntecedentContext): Exclude<AntecedentOutcome, 'apply'> | null {
  if (ctx.root === null || ctx.root.status === null) return 'error';
  if (!rootContentType(ctx).includes('text/html')) return 'n_a';
  return null;
}

export function sourcePassed(ctx: AntecedentContext, checkId: string): boolean {
  return ctx.sources.get(checkId)?.status === 'pass';
}

export function sourceEvidence(ctx: AntecedentContext, checkId: string): EvidenceItem[] {
  return ctx.sources.get(checkId)?.evidence ?? [];
}

export function retainedBody(ctx: AntecedentContext, checkId: string): string {
  for (const item of sourceEvidence(ctx, checkId)) {
    if (typeof item.body === 'string') return item.body;
  }
  return '';
}

export function anyEvidenceStatus(items: EvidenceItem[], status: number): boolean {
  return items.some((item) => item.status === status);
}

/** A 401 or WWW-Authenticate challenge in a probe's evidence. */
export function evidenceShowsAuthChallenge(items: EvidenceItem[]): boolean {
  return anyEvidenceStatus(items, 401) || items.some((item) => typeof item.www_authenticate === 'string');
}

/** `n_a` for a check that needs the MCP endpoint there is none of, naming the declared host behind that when one is. */
export function noMcpEndpoint(ctx: AntecedentContext): AntecedentResolution {
  const unmet = ctx.follow?.unmet;
  if (unmet === null || unmet === undefined) return 'n_a';
  return { outcome: 'n_a', reason: unmet.reason, host: unmet.host, evidence: unmet.url };
}

/** The discovery card declares authentication. */
export function cardDeclaresAuth(ctx: AntecedentContext): boolean {
  return ctx.discoveryEvidence.some((item) => item.authentication === true);
}
