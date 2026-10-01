// The endpoint the MCP rows are scored at, chosen once discovery's POSTs
// and the follow slice have both finished: the audited site's own
// endpoint, else the first declared endpoint the slice admitted. Beside
// it, the declared-hosts trail in declaration order, and the reason the
// rows that need an endpoint were not evaluated when a declared host is
// why there is none.

import type { NaReason } from '../../shared/web-audit-findings';
import type { DiscoveryDocuments, DiscoveryResult } from './discovery';
import type { McpDeclaration } from './discovery-documents';
import { type FollowInput, type FollowResult, followDeclarations } from './follow';
import { declarationKey, declaresHost, hostOf, type TrailEntry, type TrailOutcome, trailEntry } from './follow-trail';

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
  trail: TrailEntry[];
  unmet: DeclaredHostReason | null;
}

const ROW_REASONS: Partial<Record<TrailOutcome, NaReason>> = {
  'reciprocity-refused': 'reciprocity-refused',
  // The guard refused it: from the auditor's vantage the host cannot be reached.
  blocked: 'declared-host-unreachable',
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
    if (reason !== undefined && host !== null) return { reason, host, url };
  }
  return null;
}

export function endpointOfRecord(
  base: string,
  discovery: { endpoint: string | null; declarations: readonly McpDeclaration[] },
  follow: Pick<FollowResult, 'endpoint' | 'entries'>,
): EndpointOfRecord {
  const own = discovery.endpoint;
  const trail: TrailEntry[] = [];
  const keys = new Set<string>();
  for (const declaration of discovery.declarations) {
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
    trail,
    unmet: endpoint === null ? unmetReason(trail) : null,
  };
}

const NOTHING_FOLLOWED: FollowResult = { endpoint: null, entries: new Map(), evidence: [], requests: 0 };

/**
 * Discovery's POSTs and the follow slice, side by side, then the endpoint
 * of record. A site that answered nothing gets no request sent to the
 * hosts it declares.
 */
export async function settleEndpointOfRecord(
  documents: DiscoveryDocuments,
  opts: Omit<FollowInput, 'declarations' | 'entryEndpointDeclared'> & { siteAnswered: boolean },
): Promise<{ discovery: DiscoveryResult; declared: EndpointOfRecord }> {
  const { siteAnswered, ...follow } = opts;
  const [discovery, followed] = await Promise.all([
    documents.probeEndpoint(),
    siteAnswered
      ? followDeclarations({
          ...follow,
          declarations: documents.declarations,
          entryEndpointDeclared: documents.cardEndpoint !== null,
        })
      : NOTHING_FOLLOWED,
  ]);
  return { discovery, declared: endpointOfRecord(follow.base, discovery, followed) };
}
