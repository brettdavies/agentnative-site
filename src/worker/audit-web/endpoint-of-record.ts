// The endpoint the MCP rows are scored at, chosen once discovery's POSTs
// and the follow slice have both finished: the audited site's own
// endpoint, else the first declared endpoint the slice admitted. Beside
// it, the declared-hosts trail in declaration order, the API catalog's
// share of what the slice settled, and the reason the rows that need an
// endpoint were not evaluated when a declared host is why there is none.

import type { NaReason } from '../../shared/web-audit-findings';
import { apiDeclarations } from './api-catalog';
import type { DiscoveryDocuments, DiscoveryResult } from './discovery';
import type { McpDeclaration } from './discovery-documents';
import { type FollowInput, type FollowResult, openFollow } from './follow';
import type { ApiFollowResult } from './follow-api';
import { declarationKey, declaresHost, type TrailEntry, type TrailOutcome, trailEntry } from './follow-trail';
import type { SignInChallenge } from './mcp-auth';
import { hostOf } from './provenance';
import type { MetadataMatch } from './reciprocity';

/** A declared host the rows that need an endpoint could not be evaluated at, and why. */
export interface DeclaredHostReason {
  reason: NaReason;
  host: string;
  url: string;
}

export interface EndpointOfRecord {
  endpoint: string | null;
  /** The endpoint came from a declared host, whose URL was pinned when reciprocity admitted it. */
  followed: boolean;
  /** RFC 9728 metadata naming the endpoint that finding or admitting it already read. */
  metadata: MetadataMatch | null;
  /** The 401 discovery drew from the audited site's own endpoint while finding it; null when it found it another way. */
  challenge: SignInChallenge | null;
  trail: TrailEntry[];
  unmet: DeclaredHostReason | null;
  /** What the slice settled for the API catalog's anchors and descriptions. */
  api: ApiFollowResult;
}

const ROW_REASONS: Partial<Record<TrailOutcome, NaReason>> = {
  'reciprocity-refused': 'reciprocity-refused',
  blocked: 'declared-host-blocked',
  unreachable: 'declared-host-unreachable',
  'budget-exceeded': 'declared-host-budget-exceeded',
};

/** An endpoint admitted while the audited site's own endpoint was found: never probed. */
function superseded(entry: TrailEntry): TrailEntry {
  const { admitted_by: _admittedBy, outcome: _outcome, ...kept } = entry;
  return { ...kept, outcome: 'not-followed', reason: 'beyond-endpoint-of-record' };
}

/** Why a row could not be evaluated at an entry's host, or null when the entry names no such reason. */
export function declaredHostReason(entry: TrailEntry): DeclaredHostReason | null {
  const reason =
    entry.outcome === 'not-followed' && entry.reason === 'follow-disabled'
      ? 'follow-disabled'
      : ROW_REASONS[entry.outcome];
  const url = entry.final_url ?? entry.url;
  const host = hostOf(url);
  return reason !== undefined && host !== null && host.length > 0 ? { reason, host, url } : null;
}

function unmetReason(trail: readonly TrailEntry[]): DeclaredHostReason | null {
  for (const entry of trail) {
    if (entry.kind !== 'mcp-endpoint' && entry.kind !== 'card-document') continue;
    const reason = declaredHostReason(entry);
    if (reason !== null) return reason;
  }
  return null;
}

export function endpointOfRecord(
  base: string,
  discovery: Pick<
    DiscoveryResult,
    'endpoint' | 'endpointMetadata' | 'endpointChallenge' | 'declarations' | 'redirected'
  >,
  follow: Pick<FollowResult, 'endpoint' | 'endpointMetadata' | 'entries' | 'api'>,
): EndpointOfRecord {
  const own = discovery.endpoint;
  const trail: TrailEntry[] = [];
  const keys = new Set<string>();
  const record = (entry: TrailEntry): void => {
    const key = declarationKey(entry);
    if (keys.has(key)) return;
    keys.add(key);
    trail.push(
      own !== null && entry.outcome === 'followed' && entry.kind === 'mcp-endpoint' ? superseded(entry) : entry,
    );
  };
  const recordMcp = (declarations: readonly McpDeclaration[]): void => {
    for (const declaration of declarations) {
      if (!declaresHost(declaration, base)) continue;
      // Only a card read after the POSTs (one at the audited site's own
      // endpoint) declares what the slice never saw.
      const group = follow.entries.get(declarationKey(declaration)) ?? [
        trailEntry(declaration, { outcome: 'not-followed', reason: 'beyond-endpoint-of-record' }),
      ];
      for (const entry of group) record(entry);
    }
  };
  recordMcp(discovery.declarations);
  for (const entry of follow.api.entries) record(entry);
  recordMcp(discovery.redirected);
  const endpoint = own ?? follow.endpoint;
  return {
    endpoint,
    followed: own === null && follow.endpoint !== null,
    metadata: own !== null ? discovery.endpointMetadata : follow.endpointMetadata,
    challenge: own !== null ? discovery.endpointChallenge : null,
    trail,
    unmet: endpoint === null ? unmetReason(trail) : null,
    api: follow.api,
  };
}

/**
 * Discovery's POSTs and the follow slice, side by side, then where the
 * POSTs were redirected off the audited origin, on what is left of the
 * slice, then the endpoint of record. The hosts the documents declare are
 * followed only when the site answered the root or a document read; a
 * redirected POST is an answer of its own.
 */
export async function settleEndpointOfRecord(
  documents: DiscoveryDocuments,
  opts: Omit<FollowInput, 'entryEndpointDeclared'> & { siteAnswered: boolean },
): Promise<{ discovery: DiscoveryResult; declared: EndpointOfRecord }> {
  const { siteAnswered, ...follow } = opts;
  const session = openFollow({ ...follow, entryEndpointDeclared: documents.cardEndpoint !== null });
  const [discovery] = await Promise.all([
    documents.probeEndpoint(),
    session.settle(siteAnswered ? documents.declarations : []),
    session.settleApi(siteAnswered ? apiDeclarations(documents.apiAnchors) : []),
  ]);
  await session.settle(discovery.redirected);
  return { discovery, declared: endpointOfRecord(follow.base, discovery, session.result()) };
}
