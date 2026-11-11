// Pair resolution: the first step of every web audit. A host and its www or
// bare sibling are one site when the root of either answers its first request
// with a redirect to the other. The audited host's root fetch doubles as the
// reachability probe and the first hop it takes is the observation; the
// sibling's root is requested once, in parallel, and never followed. A
// redirect to a third host is not a fold, and neither is a sibling that gives
// no answer: the pair report says which of those happened.

import { sitePairOf } from '../../shared/audit-routes';
import type { ProbeResponse } from './assert';
import { REDIRECT_STATUSES } from './request-hop';
import { type AuditFetchOptions, guardedFetch, STATUS_ONLY_BODY_BYTES } from './ssrf';

export type PairOutcome = 'folded' | 'unfolded' | 'no-answer';

export type PairReport = {
  outcome: PairOutcome;
  /** Status of the audited host's root at its first hop; null when it gave none. */
  requestedStatus: number | null;
  /** Status of the sibling's root; null when it gave none within the bound. */
  siblingStatus: number | null;
};

export type SiteResolution = {
  /** The audited host's root, redirects followed. */
  root: ProbeResponse;
  /** The origin the checks probe, with a trailing slash. */
  base: string;
  /** The site's name: the audited host, or the bare host of a folded pair. */
  name: string;
  /** Both hosts of a folded pair, bare first; null when the audit covers one host. */
  siteHosts: readonly [string, string] | null;
  /** The pair report; null when no pair was resolved (no pair, or a plaintext root). */
  pair: PairReport | null;
  /** The sibling's origin when it answered without redirecting to the audited host. */
  sibling: string | null;
  /** The audited host's own origin, with a trailing slash. */
  requestedBase: string;
};

export type ResolveSiteInput = {
  url: string;
  fetchOptions: AuditFetchOptions;
  timeoutMs: number;
  /** How long the sibling's root is awaited once the audited host's root fetch has completed. */
  siblingWaitMs: number;
};

/** Whether a root answered at all: a status that is not a throttle or a server error. */
function answered(status: number | null): boolean {
  return status !== null && status !== 429 && status < 500;
}

/** The host a first-hop redirect lands on when it lands on an https URL, else null. */
function redirectTarget(response: ProbeResponse, requestUrl: string): string | null {
  const location = response.headers.location;
  if (response.status === null || !REDIRECT_STATUSES.has(response.status) || !location) return null;
  try {
    const next = new URL(location, requestUrl);
    return next.protocol === 'https:' ? next.host : null;
  } catch {
    return null;
  }
}

async function within<T>(pending: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([pending, bound]);
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveSite(input: ResolveSiteInput): Promise<SiteResolution> {
  const typed = new URL(input.url);
  const requestedBase = `${typed.protocol}//${typed.host}/`;
  const options = { ...input.fetchOptions, timeoutMs: input.timeoutMs };
  const pair = typed.protocol === 'https:' ? sitePairOf(typed.host) : null;

  if (pair === null) {
    const root = await guardedFetch(requestedBase, {}, options);
    return { root, base: requestedBase, name: typed.host, siteHosts: null, pair: null, sibling: null, requestedBase };
  }

  const siblingHost = typed.host === pair.www ? pair.apex : pair.www;
  const siblingBase = `https://${siblingHost}/`;
  const firstHop = guardedFetch(requestedBase, {}, { ...options, followRedirects: false });
  const siblingRoot = guardedFetch(
    siblingBase,
    {},
    { ...options, followRedirects: false, maxBodyBytes: STATUS_ONLY_BODY_BYTES },
  );
  const root = await guardedFetch(requestedBase, {}, options);
  if (root.refused === 'insecure-scheme') {
    return { root, base: requestedBase, name: typed.host, siteHosts: null, pair: null, sibling: null, requestedBase };
  }

  const first = await firstHop;
  const requestedLandsOnSibling = redirectTarget(first, requestedBase) === siblingHost;
  const sibling = await within(siblingRoot, requestedLandsOnSibling ? 0 : input.siblingWaitMs);
  const requestedStatus = first.status;
  const siblingStatus = sibling?.status ?? null;

  const siblingLandsOnRequested = sibling !== null && redirectTarget(sibling, siblingBase) === typed.host;
  const folded = requestedLandsOnSibling || siblingLandsOnRequested;

  if (folded) {
    return {
      root,
      base: requestedLandsOnSibling ? siblingBase : requestedBase,
      name: pair.apex,
      siteHosts: [pair.apex, pair.www],
      pair: { outcome: 'folded', requestedStatus, siblingStatus },
      sibling: null,
      requestedBase,
    };
  }

  const outcome: PairOutcome = answered(requestedStatus) && answered(siblingStatus) ? 'unfolded' : 'no-answer';
  return {
    root,
    base: requestedBase,
    name: typed.host,
    siteHosts: null,
    pair: { outcome, requestedStatus, siblingStatus },
    sibling: answered(siblingStatus) ? siblingBase : null,
    requestedBase,
  };
}
