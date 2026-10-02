// The follow slice's request gate. Every GET the slice sends to a declared
// host is admitted here before it starts: the host takes one of the
// slice's host slots, its domain draws once on the hourly budget, and the
// request counts toward the slice's request cap and clock. A declared URL
// may take one redirect hop, which the guard validates and the slice
// charges the same way; a second hop is never taken. Requests run with
// redirects disabled, so nothing reaches a host this gate did not admit.

import type { ProbeResponse } from './assert';
import type { Declaration } from './discovery-documents';
import { type BudgetCause, hopRefusal, type Settled } from './follow-trail';
import { type PhaseBudget, resolveUrl } from './handlers/shared';
import type { EvidenceItem } from './handlers/types';
import type { ArtifactReadOptions, ArtifactSource } from './reciprocity';
import { type GuardedFetchOptions, guardedFetch, REDIRECT_STATUSES } from './ssrf';

const MAX_FOLLOWED_HOSTS = 4;
const MAX_FOLLOW_REQUESTS = 12;

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

export type ReadOptions = ArtifactReadOptions & { timeoutCapMs?: number };

/** Where a declared URL landed after at most one redirect hop, and its response. */
export type Fetched = { url: string; response: ProbeResponse };
/** The URL a declaration lands on, and its GET, started once the slice admitted that URL. */
export type Landing = { url: string; response: Promise<ProbeResponse | Settled> };

class FollowStop extends Error {
  constructor(readonly budgetCause: BudgetCause) {
    super(budgetCause);
  }
}

export interface SliceRequests {
  /** Admits a host to the slice and its domain to the budget, or throws the cause that refuses it. */
  enter(url: string): Promise<void>;
  /**
   * One GET with redirects disabled, charged to the slice's request cap
   * and clock. A document read the same way twice (a card document that
   * is also the card under its own endpoint) is requested once.
   */
  get(url: string, opts: ReadOptions): Promise<ProbeResponse>;
  /**
   * Where a declared URL's first response leads: to itself, or to the one
   * redirect hop the guard, the host cap, and the domain budget admit,
   * whose GET starts here. Settles the declaration when the hop is refused.
   */
  admitHop(declaration: Declaration, first: ProbeResponse, opts: ReadOptions): Promise<Landing | Settled>;
  /** GETs a declared URL, taking at most one admitted redirect hop. */
  fetchDeclared(declaration: Declaration, opts: ReadOptions): Promise<Fetched | Settled>;
  /** Where reciprocity reads its artifacts, through the same gate. */
  readonly source: ArtifactSource;
  readonly evidence: EvidenceItem[];
  count(): number;
}

export function sliceRequests(input: {
  budget: DomainBudget;
  phase: PhaseBudget;
  fetchOptions?: Pick<GuardedFetchOptions, 'fetchImpl'>;
}): SliceRequests {
  const evidence: EvidenceItem[] = [];
  const hosts: string[] = [];
  const reservations = new Map<string, Promise<boolean>>();
  const responseCache = new Map<string, Promise<ProbeResponse>>();
  let requests = 0;

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
  const enter = async (url: string): Promise<void> => {
    // A reservation draws on a budget shared across audits, so none is
    // spent for a host the slice has no time left to request.
    if (input.phase.slice() === null) throw new FollowStop('slice');
    const hostname = new URL(url).hostname;
    if (!admitHost(hostname)) throw new FollowStop('per-audit-cap');
    if (!(await reserve(hostname))) throw new FollowStop('domain-budget');
  };
  const request = async (url: string, opts: ReadOptions): Promise<ProbeResponse> => {
    const slice = input.phase.slice();
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
  const get = (url: string, opts: ReadOptions): Promise<ProbeResponse> => {
    const key = `${url} ${opts.maxBodyBytes} ${opts.accept ?? ''}`;
    let response = responseCache.get(key);
    if (response === undefined) {
      response = request(url, opts);
      responseCache.set(key, response);
    }
    return response;
  };
  /**
   * The hop's GET; a second redirect is never taken. An endpoint that
   * redirects again is refused; a document's second redirect is its answer.
   */
  const getHop = async (
    hop: string,
    opts: ReadOptions,
    kind: Declaration['kind'],
  ): Promise<ProbeResponse | Settled> => {
    const response = await get(hop, opts);
    return kind === 'mcp-endpoint' && response.status !== null && REDIRECT_STATUSES.has(response.status)
      ? { final_url: hop, outcome: 'reciprocity-refused' }
      : response;
  };
  const admitHop = async (
    declaration: Declaration,
    first: ProbeResponse,
    opts: ReadOptions,
  ): Promise<Landing | Settled> => {
    const location = first.headers.location;
    if (first.status === null || !REDIRECT_STATUSES.has(first.status) || location === undefined) {
      return { url: declaration.url, response: Promise.resolve(first) };
    }
    const hop = resolveUrl(declaration.url, location);
    const refused = hopRefusal(hop, declaration.kind);
    if (refused !== null) return refused;
    await enter(hop);
    return { url: hop, response: stopped(() => getHop(hop, opts, declaration.kind), budgetExceeded) };
  };

  return {
    enter,
    get,
    admitHop,
    fetchDeclared: async (declaration, opts) =>
      land(await admitHop(declaration, await get(declaration.url, opts), opts)),
    source: { get, decline: (url, why) => evidence.push({ url, blocked: why }) },
    evidence,
    count: () => requests,
  };
}

/**
 * Reads declared documents side by side. Each first GET is admitted in
 * declaration order before it starts, and each redirect hop in
 * declaration order once every first GET has answered, so host slots,
 * domain reservations, and the request cap never go to whichever host
 * answers first.
 */
export async function readDeclaredDocuments<T extends Declaration>(
  requests: SliceRequests,
  declarations: readonly T[],
  upfront: (declaration: T) => Settled | null,
  opts: ReadOptions,
): Promise<Array<Fetched | Settled>> {
  const firsts: Array<Promise<ProbeResponse | Settled>> = [];
  for (const declaration of declarations) {
    const settled =
      upfront(declaration) ??
      (await stopped<Settled | null>(async () => {
        await requests.enter(declaration.url);
        return null;
      }, budgetExceeded));
    firsts.push(
      settled !== null
        ? Promise.resolve(settled)
        : stopped<ProbeResponse | Settled>(() => requests.get(declaration.url, opts), budgetExceeded),
    );
  }
  const answered = await Promise.all(firsts);
  const landings: Array<Landing | Settled> = [];
  for (const [i, declaration] of declarations.entries()) {
    const first = answered[i];
    landings.push(
      'status' in first
        ? await stopped<Landing | Settled>(() => requests.admitHop(declaration, first, opts), budgetExceeded)
        : first,
    );
  }
  return Promise.all(landings.map(land));
}

/** Where a landing ends: its URL and response, or how its GET settled. */
export async function land(landing: Landing | Settled): Promise<Fetched | Settled> {
  if (!('response' in landing)) return landing;
  const response = await landing.response;
  return 'status' in response ? { url: landing.url, response } : response;
}

export function budgetExceeded(cause: BudgetCause): Settled {
  return { outcome: 'budget-exceeded', cause };
}

/** Runs one declaration's requests, settling a cap or budget stop through `onStop`. */
export async function stopped<T>(run: () => Promise<T>, onStop: (cause: BudgetCause) => T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof FollowStop) return onStop(err.budgetCause);
    throw err;
  }
}
