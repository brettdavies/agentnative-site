// Whether a run a declared domain's spent hourly budget shaped may replace
// the site's saved scorecard. That refusal says nothing about the site, so
// a saved scorecard stands in its place; with none saved, the run is saved
// like any audit. Every path that saves an audit asks here, so the curated
// board and the on-demand surfaces hold the same runs.

import { SPEC_VERSION } from '../spec-version.gen';
import { type CachedWebAudit, getForRequest, keyFor, type WebCacheEnv, WebCacheUnavailableError } from './cache';
import { domainBudgetRefusal } from './domain-budget';
import type { WebScorecard } from './scorecard';

export interface DomainBudgetHold {
  /** The registrable domain whose spent budget left rows unevaluated. */
  domain: string;
  /** The saved record the run leaves in place; null when the store could not be read. */
  saved: CachedWebAudit | null;
}

/**
 * The hold on `scorecard`, a complete run of `targetUrl`, or null when it
 * saves as any audit. The saved object is read strictly: a store that
 * cannot be read holds, because the object it could not read may be there.
 */
export async function domainBudgetHold(
  env: WebCacheEnv,
  targetUrl: string,
  scorecard: Pick<WebScorecard, 'declared_hosts' | 'results' | 'mcp_endpoint'>,
): Promise<DomainBudgetHold | null> {
  const domain = domainBudgetRefusal(scorecard);
  if (domain === null) return null;
  let saved: CachedWebAudit | null;
  try {
    saved = await getForRequest(env, await keyFor(targetUrl, SPEC_VERSION));
  } catch (err) {
    if (err instanceof WebCacheUnavailableError) return { domain, saved: null };
    throw err;
  }
  return saved === null ? null : { domain, saved };
}
