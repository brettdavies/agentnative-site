// The follow slice: one hop from the audited site to the off-origin hosts
// its discovery documents declare, under its own share of the deadline.
//
// A card-document declaration is fetched to learn the endpoint it names.
// An endpoint declaration gets one GET of its own URL, which may take one
// redirect hop the slice validates and charges itself, then reciprocity on
// the final host (reciprocity.ts). Endpoints are tried in declaration order
// and the first one admitted is the slice's endpoint, so the requests a
// declaration list can cause stop at the endpoint the audit will use.
//
// Every failure of an endpoint's reciprocity, from a dead host to a card
// naming another URL, records one outcome, so the trail cannot be read as
// an oracle for what a third-party host serves. Caps, budgets, and guard
// refusals are decided before any request and record their own outcomes.
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
  type BudgetCause,
  declarationKey,
  declaresHost,
  refusal,
  type Settled,
  settledUpfront,
  type TrailEntry,
  trailEntry,
  unique,
} from './follow-trail';
import { phaseBudget, resolveUrl } from './handlers/shared';
import type { EvidenceItem } from './handlers/types';
import { type ArtifactReadOptions, type ArtifactSource, admittingArtifact, normalizeEndpointUrl } from './reciprocity';
import type { WebAuditDiscoveryConfig } from './registry';
import {
  DOCUMENT_MAX_BODY_BYTES,
  type GuardedFetchOptions,
  guardedFetch,
  REDIRECT_STATUSES,
  STATUS_ONLY_BODY_BYTES,
} from './ssrf';

const FOLLOW_SLICE_MS = 6_000;
const MAX_FOLLOWED_HOSTS = 4;
const MAX_FOLLOW_REQUESTS = 12;
// A streamable-HTTP endpoint may hold a GET open as an event stream; the
// GET only looks for a redirect and a challenge, so a hang must not spend
// the slice reciprocity needs.
const ENDPOINT_GET_TIMEOUT_MS = 3_000;

/**
 * The hourly budget for each declared domain, drawn once per audit and
 * domain before the first request the slice sends there.
 */
export interface DomainBudget {
  /** The key a host's requests are charged to. */
  keyOf(hostname: string): string;
  /** Reserves this audit's unit for `key`; false when that key's budget is spent. */
  reserve(key: string): Promise<boolean>;
}

export const ALWAYS_ADMIT_BUDGET: DomainBudget = { keyOf: (hostname) => hostname, reserve: async () => true };

export interface FollowInput {
  /** The audited origin, scheme + host + trailing slash. */
  base: string;
  declarations: readonly McpDeclaration[];
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
  /** Per declaration key: its entry, then the entries of what a followed card document declared. */
  entries: ReadonlyMap<string, TrailEntry[]>;
  evidence: EvidenceItem[];
  requests: number;
}

type ReadOptions = ArtifactReadOptions & { timeoutCapMs?: number };

class FollowStop extends Error {
  constructor(readonly budgetCause: BudgetCause) {
    super(budgetCause);
  }
}

export async function followDeclarations(input: FollowInput): Promise<FollowResult> {
  const budget = phaseBudget(FOLLOW_SLICE_MS, input.timeoutMs, input);
  const evidence: EvidenceItem[] = [];
  const hosts: string[] = [];
  const reservations = new Map<string, Promise<boolean>>();
  const entries = new Map<string, TrailEntry[]>();
  let requests = 0;
  let endpoint: string | null = null;

  const admitHost = (hostname: string): boolean => {
    if (hosts.includes(hostname)) return true;
    if (hosts.length >= MAX_FOLLOWED_HOSTS) return false;
    hosts.push(hostname);
    return true;
  };
  const reserve = (hostname: string): Promise<boolean> => {
    const key = input.budget.keyOf(hostname);
    let reservation = reservations.get(key);
    if (reservation === undefined) {
      reservation = input.budget.reserve(key);
      reservations.set(key, reservation);
    }
    return reservation;
  };
  /** Admits a host to the slice and its domain to the budget, or throws the cause that refuses it. */
  const enter = async (url: string): Promise<void> => {
    const hostname = new URL(url).hostname;
    if (!admitHost(hostname)) throw new FollowStop('per-audit-cap');
    if (!(await reserve(hostname))) throw new FollowStop('domain-budget');
  };
  const responseCache = new Map<string, Promise<ProbeResponse>>();
  /**
   * One GET with redirects disabled, charged to the slice's request cap
   * and clock. A document read the same way twice (a card document that
   * is also the card under its own endpoint) is requested once.
   */
  const get = (url: string, opts: ReadOptions) => {
    const key = `${url} ${opts.maxBodyBytes} ${opts.accept ?? ''}`;
    let response = responseCache.get(key);
    if (response === undefined) {
      response = request(url, opts);
      responseCache.set(key, response);
    }
    return response;
  };
  const request = async (url: string, opts: ReadOptions): Promise<ProbeResponse> => {
    const slice = budget.slice();
    if (slice === null) throw new FollowStop('slice');
    if (requests >= MAX_FOLLOW_REQUESTS) throw new FollowStop('per-audit-cap');
    requests += 1;
    const response = await guardedFetch(url, opts.accept === undefined ? {} : { headers: { accept: opts.accept } }, {
      ...input.fetchOptions,
      timeoutMs: Math.min(slice, opts.timeoutCapMs ?? slice),
      maxBodyBytes: opts.maxBodyBytes,
      followRedirects: false,
    });
    evidence.push({
      url,
      host: new URL(url).host,
      status: response.status,
      ...(response.error !== null ? { error: response.error } : {}),
      ...(response.truncated ? { truncated: true } : {}),
    });
    return response;
  };
  const source: ArtifactSource = {
    get,
    decline: (url, why) => evidence.push({ url, blocked: why }),
  };

  /**
   * GETs a declared URL, taking at most one redirect hop once its target
   * passes the guard, the host cap, and the domain budget. Returns the
   * final URL and its response, or how the declaration settles instead.
   */
  const fetchDeclared = async (
    declaration: McpDeclaration,
    opts: ReadOptions,
  ): Promise<{ url: string; response: ProbeResponse } | Settled> => {
    const first = await get(declaration.url, opts);
    const location = first.headers.location;
    if (first.status === null || !REDIRECT_STATUSES.has(first.status) || location === undefined) {
      return { url: declaration.url, response: first };
    }
    const hop = resolveUrl(declaration.url, location);
    const refused = hop === '' ? ({ outcome: 'blocked' } as const) : refusal(hop, declaration.kind);
    if (refused !== null) return refused;
    await enter(hop);
    const response = await get(hop, opts);
    if (response.status !== null && REDIRECT_STATUSES.has(response.status)) {
      return { final_url: hop, outcome: 'reciprocity-refused' };
    }
    return { url: hop, response };
  };

  /** Reads a card document for the endpoints it names, which settle later in declaration order. */
  const readCardDocument = async (declaration: McpDeclaration): Promise<CardDocumentRead> => {
    await enter(declaration.url);
    const fetched = await fetchDeclared(declaration, {
      maxBodyBytes: DOCUMENT_MAX_BODY_BYTES,
      accept: MCP_SERVER_CARD_TYPE,
    });
    if (!('response' in fetched)) return { entry: trailEntry(declaration, fetched), named: [] };
    const finalUrl = fetched.url === declaration.url ? undefined : fetched.url;
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

  const settleEndpoint = async (declaration: McpDeclaration): Promise<Settled> => {
    await enter(declaration.url);
    const fetched = await fetchDeclared(declaration, {
      maxBodyBytes: STATUS_ONLY_BODY_BYTES,
      timeoutCapMs: ENDPOINT_GET_TIMEOUT_MS,
    });
    if (!('response' in fetched)) return fetched;
    const pinned = normalizeEndpointUrl(fetched.url);
    if (pinned === null) return { outcome: 'blocked' };
    const finalUrl = pinned === normalizeEndpointUrl(declaration.url) ? undefined : pinned;
    const admittedBy = await admittingArtifact(
      pinned,
      input.discovery,
      source,
      fetched.response.headers['www-authenticate'],
    );
    if (admittedBy === null) return { final_url: finalUrl, outcome: 'reciprocity-refused' };
    endpoint = pinned;
    return { final_url: finalUrl, outcome: 'followed', admitted_by: admittedBy };
  };

  /** Endpoints in declaration order, stopping at the first one admitted. */
  const settleEndpoints = async (declarations: readonly McpDeclaration[]): Promise<TrailEntry[]> => {
    const out: TrailEntry[] = [];
    for (const declaration of declarations) {
      const upfront = settledUpfront(declaration, input);
      if (upfront !== null) out.push(trailEntry(declaration, upfront));
      else if (endpoint !== null) {
        out.push(trailEntry(declaration, { outcome: 'not-followed', reason: 'beyond-endpoint-of-record' }));
      } else out.push(trailEntry(declaration, await stopped(() => settleEndpoint(declaration), budgetExceeded)));
    }
    return out;
  };

  const declared = unique(input.declarations.filter((declaration) => declaresHost(declaration, input.base)));
  // Card documents are read concurrently; the endpoints they name join the
  // declaration-ordered walk below at their card's place.
  const cardReads = new Map(
    await Promise.all(
      declared
        .filter((declaration) => declaration.kind === 'card-document')
        .map(async (declaration) => {
          const upfront = settledUpfront(declaration, input);
          const read =
            upfront !== null
              ? { entry: trailEntry(declaration, upfront), named: [] }
              : await stopped(
                  () => readCardDocument(declaration),
                  (cause) => ({ entry: trailEntry(declaration, budgetExceeded(cause)), named: [] }),
                );
          return [declarationKey(declaration), read] as const;
        }),
    ),
  );
  const walked = new Set<string>();
  /** A URL declared twice settles once, at its first place. */
  const firstSeen = (declaration: McpDeclaration): boolean => {
    const key = declarationKey(declaration);
    if (walked.has(key)) return false;
    walked.add(key);
    return true;
  };
  for (const declaration of declared) {
    if (!firstSeen(declaration)) continue;
    const read = cardReads.get(declarationKey(declaration));
    entries.set(
      declarationKey(declaration),
      read === undefined
        ? await settleEndpoints([declaration])
        : [read.entry, ...(await settleEndpoints(read.named.filter(firstSeen)))],
    );
  }
  return { endpoint, entries, evidence, requests };
}

type CardDocumentRead = { entry: TrailEntry; named: McpDeclaration[] };

function budgetExceeded(cause: BudgetCause): Settled {
  return { outcome: 'budget-exceeded', cause };
}

/** Runs one declaration's requests, settling a cap or budget stop through `onStop`. */
async function stopped<T>(run: () => Promise<T>, onStop: (cause: BudgetCause) => T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof FollowStop) return onStop(err.budgetCause);
    throw err;
  }
}
