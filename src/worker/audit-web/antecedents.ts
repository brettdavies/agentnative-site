// Antecedent resolution for the web audit (plan-003 U3, KTD-2/KTD-4).
//
// A check is scored only when its antecedent holds; otherwise it is n_a
// (excluded from both scores). Antecedents resolve from the declared
// site type, from MCP discovery, from the single canonical root fetch,
// or from another check's wave-1 probe result — never from a fresh
// fetch, which is what keeps the subrequest budget bounded.

import type { ProbeResponse } from './assert';
import type { EvidenceItem, ProbeOutcome } from './handlers/types';
import type { AntecedentToken, WebCheckSiteType, WebSiteType } from './registry';

/**
 * Checks probed in wave 1 because their results feed antecedent tokens
 * or retained bodies consumed by wave-2 checks. Probed unconditionally;
 * their own antecedents are applied afterwards from wave-1 data (the
 * openapi probe result is itself one input to its api-surface gate).
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

/** True when the declared-type filter lets the check run. */
export function siteTypeApplies(siteTypes: WebCheckSiteType[], ctx: AntecedentContext): boolean {
  if (siteTypes.includes('all')) return true;
  if (siteTypes.includes('mcp') && ctx.mcpEndpoint !== null) return true;
  if (ctx.siteType === null || ctx.siteType === undefined) return true;
  return siteTypes.includes(ctx.siteType);
}

function rootContentType(ctx: AntecedentContext): string {
  return ctx.root?.headers['content-type'] ?? '';
}

function sourcePassed(ctx: AntecedentContext, checkId: string): boolean {
  return ctx.sources.get(checkId)?.status === 'pass';
}

function sourceEvidence(ctx: AntecedentContext, checkId: string): EvidenceItem[] {
  return ctx.sources.get(checkId)?.evidence ?? [];
}

function retainedBody(ctx: AntecedentContext, checkId: string): string {
  for (const item of sourceEvidence(ctx, checkId)) {
    if (typeof item.body === 'string') return item.body;
  }
  return '';
}

function anyEvidenceStatus(items: EvidenceItem[], status: number): boolean {
  return items.some((item) => item.status === status);
}

const API_ROOT_RE = /openapi|swagger|rel=["']?(service-desc|service-doc)["']?/i;
const API_LLMS_RE = /openapi|swagger|\/api\//i;
const SCHEMAS_RE = /application\/schema\+json|json-?schema|\/schema\.json/i;

/** KTD-4 union: any one signal makes the api-surface antecedent hold. */
function apiSurfaceHolds(ctx: AntecedentContext): boolean {
  if (ctx.siteType === 'api') return true;
  const root = ctx.root;
  if (root && (API_ROOT_RE.test(root.body) || API_ROOT_RE.test(root.headers.link ?? ''))) return true;
  if (anyEvidenceStatus(sourceEvidence(ctx, 'openapi'), 200)) return true;
  if (API_LLMS_RE.test(retainedBody(ctx, 'llms-txt'))) return true;
  return false;
}

/** A 401 challenge observed anywhere in wave 1, or discovery card auth. */
function authSignalObserved(ctx: AntecedentContext): boolean {
  if (ctx.root?.status === 401) return true;
  for (const id of ['openapi', 'mcp-initialize'] as const) {
    const items = sourceEvidence(ctx, id);
    if (anyEvidenceStatus(items, 401)) return true;
    if (items.some((item) => typeof item.www_authenticate === 'string')) return true;
  }
  return ctx.discoveryEvidence.some((item) => item.authentication === true);
}

function mcpAuthHolds(ctx: AntecedentContext): boolean {
  if (ctx.mcpEndpoint === null) return false;
  const init = sourceEvidence(ctx, 'mcp-initialize');
  if (anyEvidenceStatus(init, 401) || init.some((item) => typeof item.www_authenticate === 'string')) return true;
  return ctx.discoveryEvidence.some((item) => item.authentication === true);
}

export function resolveAntecedent(token: AntecedentToken, ctx: AntecedentContext): AntecedentResolution {
  switch (token) {
    case 'none':
      return 'apply';
    case 'http-root':
      // A network error on the root makes dependents error/skip, not n_a.
      return ctx.root !== null && ctx.root.status !== null ? 'apply' : 'error';
    case 'html-root': {
      if (ctx.root === null || ctx.root.status === null) return 'error';
      return rootContentType(ctx).includes('text/html') ? 'apply' : 'n_a';
    }
    case 'mcp-present':
      return ctx.mcpEndpoint !== null ? 'apply' : 'n_a';
    case 'mcp-auth':
      return mcpAuthHolds(ctx) ? 'apply' : 'n_a';
    case 'api-surface':
      return apiSurfaceHolds(ctx) ? 'apply' : 'n_a';
    case 'schemas-ref': {
      if (sourcePassed(ctx, 'openapi')) return 'apply';
      const root = ctx.root;
      if (root && SCHEMAS_RE.test(root.body)) return 'apply';
      return 'n_a';
    }
    case 'docs-site':
      return ctx.siteType === 'content' || sourcePassed(ctx, 'llms-txt') ? 'apply' : 'n_a';
    case 'root-llms-txt':
      return sourcePassed(ctx, 'llms-txt') ? 'apply' : 'n_a';
    case 'root-llms-full-txt':
      return sourcePassed(ctx, 'llms-full-txt') ? 'apply' : 'n_a';
    case 'robots-present':
      return sourcePassed(ctx, 'robots') ? 'apply' : 'n_a';
    case 'auth-present':
      return sourcePassed(ctx, 'oauth-discovery') || authSignalObserved(ctx) ? 'apply' : 'n_a';
  }
}

/** Human evidence line for a check gated to n_a by its antecedent. */
export function antecedentUnmetEvidence(token: AntecedentToken): string {
  const lines: Record<AntecedentToken, string> = {
    none: 'not applicable',
    'http-root': 'root did not answer',
    'html-root': 'root is not an HTML document',
    'mcp-present': 'no MCP endpoint discovered',
    'mcp-auth': 'MCP endpoint does not challenge for auth',
    'api-surface': 'no API surface detected',
    'schemas-ref': 'no JSON Schema references detected',
    'docs-site': 'not a docs/content site',
    'root-llms-txt': 'root llms.txt not present',
    'root-llms-full-txt': 'root llms-full.txt not present',
    'robots-present': 'robots.txt not present',
    'auth-present': 'no auth surface detected',
  };
  return lines[token];
}
