// Shared context type and evidence accessors for the antecedent resolvers.
// Each per-group module (root, mcp, api, content, discoverability, auth)
// resolves a subset of the tokens against this context; index.ts composes
// them into the dispatch tables.

import type { ProbeResponse } from '../assert';
import type { EvidenceItem, ProbeOutcome } from '../handlers/types';
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
}

export type AntecedentResolution = 'apply' | 'n_a' | 'error';

/** Resolves one antecedent token against the wave-1 context. */
export type AntecedentResolver = (ctx: AntecedentContext) => AntecedentResolution;

export function rootContentType(ctx: AntecedentContext): string {
  return ctx.root?.headers['content-type'] ?? '';
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

/** The discovery card declares authentication. */
export function cardDeclaresAuth(ctx: AntecedentContext): boolean {
  return ctx.discoveryEvidence.some((item) => item.authentication === true);
}
