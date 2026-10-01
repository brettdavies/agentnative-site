// The endpoint the MCP rows are scored at, chosen once discovery's POSTs
// and the follow slice have both finished: the audited site's own
// endpoint, else the first declared endpoint the slice admitted. Beside
// it, the declared-hosts trail in declaration order, and the reason the
// rows that need an endpoint were not evaluated when a declared host is
// why there is none.

import type { NaReason } from '../../shared/web-audit-findings';
import type { DiscoveryDocuments, DiscoveryResult } from './discovery';
import { type FollowInput, type FollowResult, openFollow } from './follow';
import { declarationKey, declaresHost, type TrailEntry, type TrailOutcome, trailEntry } from './follow-trail';
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
  trail: TrailEntry[];
  unmet: DeclaredHostReason | null;
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

function unmetReason(trail: readonly TrailEntry[]): DeclaredHostReason | null {
  for (const entry of trail) {
    const reason =
      entry.outcome === 'not-followed' && entry.reason === 'follow-disabled'
        ? 'follow-disabled'
        : ROW_REASONS[entry.outcome];
    const url = entry.final_url ?? entry.url;
    const host = hostOf(url);
    if (reason !== undefined && host !== null && host.length > 0) return { reason, host, url };
  }
  return null;
}

export function endpointOfRecord(
  base: string,
  discovery: Pick<DiscoveryResult, 'endpoint' | 'endpointMetadata' | 'declarations' | 'redirected'>,
  follow: Pick<FollowResult, 'endpoint' | 'endpointMetadata' | 'entries'>,
): EndpointOfRecord {
  const own = discovery.endpoint;
  const trail: TrailEntry[] = [];
  const keys = new Set<string>();
  for (const declaration of [...discovery.declarations, ...discovery.redirected]) {
    if (!declaresHost(declaration, base)) continue;
    // Only a card read after the POSTs (one at the audited site's own
    // endpoint) declares what the slice never saw.
    const group = follow.entries.get(declarationKey(declaration)) ?? [
      trailEntry(declaration, { outcome: 'not-followed', reason: 'beyond-endpoint-of-record' }),
    ];
    for (const entry of group) {
      const key = declarationKey(entry);
      if (keys.has(key)) continue;
      keys.add(key);
      trail.push(
        own !== null && entry.outcome === 'followed' && entry.kind === 'mcp-endpoint' ? superseded(entry) : entry,
      );
    }
  }
  const endpoint = own ?? follow.endpoint;
  return {
    endpoint,
    followed: own === null && follow.endpoint !== null,
    metadata: own !== null ? discovery.endpointMetadata : follow.endpointMetadata,
    trail,
    unmet: endpoint === null ? unmetReason(trail) : null,
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
  ]);
  await session.settle(discovery.redirected);
  return { discovery, declared: endpointOfRecord(follow.base, discovery, session.result()) };
}
