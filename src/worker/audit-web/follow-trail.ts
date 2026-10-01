// The declared-hosts trail: one entry per URL the audited site declares
// off its origin, the closed vocabulary of how the audit treated it, and
// the refusals settled before any request, which no response can change.

import { CANONICAL_SITE_URL } from '../../shared/site-url';
import { isTemplatedUrl, type McpDeclaration, sameOrigin } from './discovery-documents';
import { hostOf } from './provenance';
import { type AdmittedBy, normalizeEndpointUrl } from './reciprocity';
import { parseIpv4Literal, validatePublicUrl } from './ssrf';

const SELF_ZONE = new URL(CANONICAL_SITE_URL).hostname;
const CANONICAL_SELF_ENDPOINT = normalizeEndpointUrl(`${CANONICAL_SITE_URL}/mcp`);

export type TrailOutcome =
  | 'followed'
  | 'reciprocity-refused'
  | 'not-followed'
  | 'blocked'
  | 'unreachable'
  | 'budget-exceeded';
export type BudgetCause = 'per-audit-cap' | 'slice' | 'domain-budget';
export type NotFollowedReason = 'templated-url' | 'self-path' | 'beyond-endpoint-of-record' | 'follow-disabled';

/** One declared URL and how the audit treated it. */
export type TrailEntry = {
  surface: string;
  kind: McpDeclaration['kind'];
  url: string;
  host?: string;
  final_url?: string;
  outcome: TrailOutcome;
  admitted_by?: AdmittedBy;
  cause?: BudgetCause;
  reason?: NotFollowedReason;
};

export type Settled = Pick<TrailEntry, 'final_url' | 'outcome' | 'admitted_by' | 'cause' | 'reason'>;

/** One trail entry per declared URL: the key a declaration and its entry share. */
export function declarationKey(declaration: Pick<McpDeclaration, 'kind' | 'url'>): string {
  return `${declaration.kind} ${normalizeEndpointUrl(declaration.url) ?? declaration.url}`;
}

/** A declaration names a host other than the audited one: off its origin, or a template it cannot be placed on. */
export function declaresHost(declaration: McpDeclaration, base: string): boolean {
  return !sameOrigin(declaration.url, base);
}

export function trailEntry(declaration: McpDeclaration, settled: Settled): TrailEntry {
  const host = hostOf(declaration.url);
  return {
    surface: declaration.source,
    kind: declaration.kind,
    url: declaration.url,
    ...(host !== null ? { host } : {}),
    ...(settled.final_url !== undefined ? { final_url: settled.final_url } : {}),
    outcome: settled.outcome,
    ...(settled.admitted_by !== undefined ? { admitted_by: settled.admitted_by } : {}),
    ...(settled.cause !== undefined ? { cause: settled.cause } : {}),
    ...(settled.reason !== undefined ? { reason: settled.reason } : {}),
  };
}

function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith('[') || parseIpv4Literal(hostname) !== null;
}

function inSelfZone(hostname: string): boolean {
  return hostname === SELF_ZONE || hostname.endsWith(`.${SELF_ZONE}`);
}

/**
 * Where the URL may not be requested at all, or null when it may. The
 * auditor's own zone admits only its canonical MCP endpoint.
 */
export function refusal(url: string, kind: McpDeclaration['kind']): Settled | null {
  const validated = validatePublicUrl(url);
  if (!validated.ok || isIpLiteral(validated.url.hostname)) return { outcome: 'blocked' };
  if (
    inSelfZone(validated.url.hostname) &&
    (kind !== 'mcp-endpoint' || normalizeEndpointUrl(url) !== CANONICAL_SELF_ENDPOINT)
  ) {
    return { outcome: 'not-followed', reason: 'self-path' };
  }
  return null;
}

/** What a declaration settles to before the slice runs, or null when the slice must request it. */
export function settledUpfront(
  declaration: McpDeclaration,
  input: { enabled: boolean; entryEndpointDeclared: boolean },
): Settled | null {
  if (declaration.not_followed !== undefined) return { outcome: 'not-followed', reason: declaration.not_followed };
  if (isTemplatedUrl(declaration.url)) return { outcome: 'not-followed', reason: 'templated-url' };
  if (!input.enabled) return { outcome: 'not-followed', reason: 'follow-disabled' };
  if (input.entryEndpointDeclared) return { outcome: 'not-followed', reason: 'beyond-endpoint-of-record' };
  return refusal(declaration.url, declaration.kind);
}

/** The declarations in order, each URL kept at its first place. */
export function unique(declarations: readonly McpDeclaration[]): McpDeclaration[] {
  const keys = new Set<string>();
  return declarations.filter((declaration) => {
    const key = declarationKey(declaration);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}
