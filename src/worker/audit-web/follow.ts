// The follow slice: one hop from the audited site to the off-origin hosts
// it declares, under its own share of the deadline.
//
// A card-document declaration is fetched to learn the endpoint it names.
// An endpoint declaration gets one GET of its own URL, which may take one
// redirect hop the slice validates and charges itself, then reciprocity on
// the final host (reciprocity.ts). Endpoints are tried in declaration order
// and the first one admitted is the slice's endpoint, so the requests a
// declaration list can cause stop at the endpoint the audit will use.
//
// The card documents declared ahead of every endpoint the slice could admit
// are read side by side, each GET capped so a host that hangs leaves the
// slice to the endpoints after it. Host slots, domain reservations, and the
// request cap admit those GETs and their redirect hops in declaration order,
// never in the order hosts answer (follow-requests.ts). A card document
// declared after such an endpoint is read at its place, and only while no
// endpoint is admitted.
//
// Declarations arrive in batches: what discovery's documents declare, then
// where its POSTs were redirected off the audited origin, which is known
// only once they finish. A later batch settles after the earlier ones, on
// the same slice clock, caps, and budgets, as if declared after them.
//
// Every failure of an endpoint's reciprocity, from a dead host to a card
// naming another URL, records one outcome, so the trail cannot be read as
// an oracle for what a third-party host serves. A card document is the
// site's own declaration, read rather than confirmed, so a card host that
// gives no response at all, or one the edge answers for, records
// unreachable; any answer that yields no endpoint records
// reciprocity-refused. Caps, budgets, and guard refusals are decided
// before any request and record their own outcomes.
// The trail follows declaration order, never completion order.

import type { ProbeResponse } from './assert';
import {
  cardEndpoint,
  isTemplatedUrl,
  MCP_SERVER_CARD_TYPE,
  type McpDeclaration,
  otherRemotes,
  parseJsonObject,
} from './discovery-documents';
import {
  budgetExceeded,
  type DomainBudget,
  type Fetched,
  type Landing,
  land,
  type ReadOptions,
  sliceRequests,
  stopped,
} from './follow-requests';
import {
  declarationKey,
  declaresHost,
  type Settled,
  settledUpfront,
  type TrailEntry,
  trailEntry,
  unique,
} from './follow-trail';
import { phaseBudget, resolveUrl } from './handlers/shared';
import type { EvidenceItem } from './handlers/types';
import { admittingArtifact, type MetadataMatch, normalizeEndpointUrl } from './reciprocity';
import type { WebAuditDiscoveryConfig } from './registry';
import { DOCUMENT_MAX_BODY_BYTES, type GuardedFetchOptions, isEdgeErrorStatus, STATUS_ONLY_BODY_BYTES } from './ssrf';

const FOLLOW_SLICE_MS = 6_000;
// A streamable-HTTP endpoint may hold a GET open as an event stream; the
// GET only looks for a redirect and a challenge, so a hang must not spend
// the slice reciprocity needs.
const ENDPOINT_GET_TIMEOUT_MS = 3_000;
const CARD_DOCUMENT_TIMEOUT_MS = 3_000;

export interface FollowInput {
  /** The audited origin, scheme + host + trailing slash. */
  base: string;
  enabled: boolean;
  /** A card already named an endpoint on the audited origin, which no declared host can displace. */
  entryEndpointDeclared: boolean;
  discovery: Pick<WebAuditDiscoveryConfig, 'ai_catalog' | 'card_suffix'>;
  budget: DomainBudget;
  timeoutMs: number;
  deadlineAt: number;
  now: () => number;
  fetchOptions?: Pick<GuardedFetchOptions, 'fetchImpl'>;
}

export interface FollowResult {
  /** The first declared endpoint reciprocity admitted, pinned to its final URL. */
  endpoint: string | null;
  /** The RFC 9728 metadata that admitted that endpoint, when metadata is what did. */
  endpointMetadata: MetadataMatch | null;
  /** Per declaration key: its entry, then the entries of what a followed card document declared. */
  entries: ReadonlyMap<string, TrailEntry[]>;
  evidence: EvidenceItem[];
  requests: number;
}

/** The follow slice, opened once per audit; its clock starts when it opens. */
export interface FollowSession {
  /**
   * Settles a batch of declarations in order, after every earlier batch. A
   * URL an earlier batch settled keeps its first entry.
   */
  settle(declarations: readonly McpDeclaration[]): Promise<void>;
  result(): FollowResult;
}

const CARD_DOCUMENT_READ: ReadOptions = {
  maxBodyBytes: DOCUMENT_MAX_BODY_BYTES,
  accept: MCP_SERVER_CARD_TYPE,
  timeoutCapMs: CARD_DOCUMENT_TIMEOUT_MS,
};

const BEYOND_ENDPOINT: Settled = { outcome: 'not-followed', reason: 'beyond-endpoint-of-record' };

type CardDocumentRead = { entry: TrailEntry; named: McpDeclaration[] };

export function openFollow(input: FollowInput): FollowSession {
  const requests = sliceRequests({
    budget: input.budget,
    phase: phaseBudget(FOLLOW_SLICE_MS, input.timeoutMs, input),
    fetchOptions: input.fetchOptions,
  });
  const entries = new Map<string, TrailEntry[]>();
  const walked = new Set<string>();
  let endpoint: string | null = null;
  let endpointMetadata: MetadataMatch | null = null;

  /** A card document's trail entry, and the endpoints it names, which settle later in declaration order. */
  const cardDocumentRead = (declaration: McpDeclaration, fetched: Fetched | Settled): CardDocumentRead => {
    if (!('response' in fetched)) return { entry: trailEntry(declaration, fetched), named: [] };
    const finalUrl = fetched.url === declaration.url ? undefined : fetched.url;
    if (fetched.response.status === null || isEdgeErrorStatus(fetched.response.status)) {
      return { entry: trailEntry(declaration, { final_url: finalUrl, outcome: 'unreachable' }), named: [] };
    }
    const card = fetched.response.status === 200 ? parseJsonObject(fetched.response) : null;
    const named = card === null ? null : cardEndpoint(card);
    if (card === null || named === null) {
      return { entry: trailEntry(declaration, { final_url: finalUrl, outcome: 'reciprocity-refused' }), named: [] };
    }
    const primary: McpDeclaration = isTemplatedUrl(named)
      ? { kind: 'mcp-endpoint', url: named, source: declaration.url, not_followed: 'templated-url' }
      : { kind: 'mcp-endpoint', url: resolveUrl(fetched.url, named), source: declaration.url };
    return {
      entry: trailEntry(declaration, { final_url: finalUrl, outcome: 'followed' }),
      named: [primary, ...otherRemotes(card, declaration.url, fetched.url)].filter((d) => declaresHost(d, input.base)),
    };
  };

  /**
   * Reads card documents side by side. Each first GET is admitted in
   * declaration order before it starts, and each redirect hop in
   * declaration order once every first GET has answered, so host slots,
   * domain reservations, and the request cap never go to whichever host
   * answers first.
   */
  const readCardDocuments = async (declarations: readonly McpDeclaration[]): Promise<CardDocumentRead[]> => {
    const firsts: Array<Promise<ProbeResponse | Settled>> = [];
    for (const declaration of declarations) {
      const settled =
        settledUpfront(declaration, input) ??
        (await stopped<Settled | null>(async () => {
          await requests.enter(declaration.url);
          return null;
        }, budgetExceeded));
      firsts.push(
        settled !== null
          ? Promise.resolve(settled)
          : stopped<ProbeResponse | Settled>(() => requests.get(declaration.url, CARD_DOCUMENT_READ), budgetExceeded),
      );
    }
    const answered = await Promise.all(firsts);
    const landings: Array<Landing | Settled> = [];
    for (const [i, declaration] of declarations.entries()) {
      const first = answered[i];
      landings.push(
        'status' in first
          ? await stopped<Landing | Settled>(
              () => requests.admitHop(declaration, first, CARD_DOCUMENT_READ),
              budgetExceeded,
            )
          : first,
      );
    }
    const fetched = await Promise.all(landings.map(land));
    return declarations.map((declaration, i) => cardDocumentRead(declaration, fetched[i]));
  };

  const settleEndpoint = async (declaration: McpDeclaration): Promise<Settled> => {
    await requests.enter(declaration.url);
    const fetched = await requests.fetchDeclared(declaration, {
      maxBodyBytes: STATUS_ONLY_BODY_BYTES,
      timeoutCapMs: ENDPOINT_GET_TIMEOUT_MS,
    });
    if (!('response' in fetched)) return fetched;
    const pinned = normalizeEndpointUrl(fetched.url);
    if (pinned === null) return { outcome: 'blocked' };
    const finalUrl = pinned === normalizeEndpointUrl(declaration.url) ? undefined : pinned;
    const admitted = await admittingArtifact(
      pinned,
      input.discovery,
      requests.source,
      fetched.response.headers['www-authenticate'],
    );
    if (admitted === null) return { final_url: finalUrl, outcome: 'reciprocity-refused' };
    endpoint = pinned;
    endpointMetadata = admitted.metadata;
    return { final_url: finalUrl, outcome: 'followed', admitted_by: admitted.by };
  };

  /** How a declaration settles with no request: before the slice, or once an endpoint is admitted. */
  const settledWithoutRequest = (declaration: McpDeclaration): Settled | null =>
    settledUpfront(declaration, input) ?? (endpoint !== null ? BEYOND_ENDPOINT : null);

  /** Endpoints in declaration order, stopping at the first one admitted. */
  const settleEndpoints = async (declarations: readonly McpDeclaration[]): Promise<TrailEntry[]> => {
    const out: TrailEntry[] = [];
    for (const declaration of declarations) {
      const settled = settledWithoutRequest(declaration);
      out.push(trailEntry(declaration, settled ?? (await stopped(() => settleEndpoint(declaration), budgetExceeded))));
    }
    return out;
  };

  /** A card document declared after an endpoint the slice could admit, read at its place. */
  const readInPlace = async (declaration: McpDeclaration): Promise<CardDocumentRead> => {
    const settled = settledWithoutRequest(declaration);
    return settled !== null ? cardDocumentRead(declaration, settled) : (await readCardDocuments([declaration]))[0];
  };

  /** A URL declared twice settles once, at its first place. */
  const firstSeen = (declaration: McpDeclaration): boolean => {
    const key = declarationKey(declaration);
    if (walked.has(key)) return false;
    walked.add(key);
    return true;
  };

  const settleBatch = async (batch: readonly McpDeclaration[]): Promise<void> => {
    const declared = unique(batch.filter((declaration) => declaresHost(declaration, input.base))).filter(
      (declaration) => !walked.has(declarationKey(declaration)),
    );
    const firstEndpoint = declared.findIndex(
      (declaration) => declaration.kind === 'mcp-endpoint' && settledUpfront(declaration, input) === null,
    );
    const ahead = declared
      .slice(0, firstEndpoint === -1 ? declared.length : firstEndpoint)
      .filter((declaration) => declaration.kind === 'card-document');
    const aheadReads = await readCardDocuments(ahead);
    const cardReads = new Map(ahead.map((declaration, i) => [declarationKey(declaration), aheadReads[i]]));
    for (const declaration of declared) {
      if (!firstSeen(declaration)) continue;
      const key = declarationKey(declaration);
      if (declaration.kind === 'mcp-endpoint') {
        entries.set(key, await settleEndpoints([declaration]));
        continue;
      }
      const read = cardReads.get(key) ?? (await readInPlace(declaration));
      entries.set(key, [read.entry, ...(await settleEndpoints(read.named.filter(firstSeen)))]);
    }
  };

  let settled = Promise.resolve();
  return {
    settle: (declarations) => {
      settled = settled.then(() => settleBatch(declarations));
      return settled;
    },
    result: () => ({ endpoint, endpointMetadata, entries, evidence: requests.evidence, requests: requests.count() }),
  };
}
