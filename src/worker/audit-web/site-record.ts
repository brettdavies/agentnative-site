// Where a finished audit is saved and what else its write changes. A host and
// its www sibling are one site when either root redirects to the other: the
// scorecard is stored under the bare host with both hosts in `site_hosts`, the
// sibling's stored record is deleted so the site has one, and the pair's pages
// are purged. An audit that sees both roots answer with no redirect between
// them is two sites, and drops a fold the bare host's record held. An audit
// that cannot tell, because a root gave no answer, keeps a recorded fold.

import { sitePairOf } from '../../shared/audit-routes';
import { SPEC_VERSION } from '../spec-version.gen';
import { type CachedWebAudit, get as cacheGet, keyFor, patchStoredScorecard, remove, type WebCacheEnv } from './cache';
import { storedPublicListing } from './public-listing';
import type { WebScorecard } from './scorecard';
import type { PairReport } from './site-pair';
import { recordedSiteHosts, targetOfHost, type WebTarget } from './web-target';

export type SiteRecordInput = {
  /** The target the request resolved to before the run. */
  target: WebTarget;
  /** The host the audit started at. */
  requested: WebTarget;
  /** What the engine observed of the pair; null when the host has no pair. */
  pair: PairReport | null;
  scorecard: WebScorecard;
  /** The caller's explicit listing choice; undefined for a blank request. */
  explicit: boolean | undefined;
  /** The listing resolved against `target`'s stored record before the run. */
  listing: boolean;
};

export type SiteRecord = {
  /** Where the scorecard is stored: the site's name. */
  target: WebTarget;
  scorecard: WebScorecard;
  listing: boolean;
  /** Hosts, besides the target, whose pages this write changes. */
  alsoPurge: readonly string[];
  /** The sibling's record the write replaces; deleted once the write lands. */
  supersedes: WebTarget | null;
  /** The bare host's record whose fold this write ends, from an audit of the www host. */
  foldToDrop: CachedWebAudit | null;
};

async function read(env: WebCacheEnv, target: WebTarget): Promise<CachedWebAudit | null> {
  return cacheGet(env, await keyFor(target.canonical, SPEC_VERSION));
}

function withListing(scorecard: WebScorecard, listing: boolean): WebScorecard {
  return scorecard.public_listing === listing ? scorecard : { ...scorecard, public_listing: listing };
}

/**
 * The record this audit writes. Reads at most the bare host's record, plus the
 * www host's when a folded write has no listing choice to take from the
 * caller or the bare host.
 */
export async function planSiteRecord(env: WebCacheEnv, input: SiteRecordInput): Promise<SiteRecord> {
  const { target, requested, pair, scorecard } = input;
  const hosts = sitePairOf(requested.host);
  const plain: SiteRecord = {
    target,
    scorecard,
    listing: input.listing,
    alsoPurge: [],
    supersedes: null,
    foldToDrop: null,
  };
  if (pair === null || hosts === null) return plain;

  const apex = targetOfHost(hosts.apex);
  const www = targetOfHost(hosts.www);
  const apexRecord = await read(env, apex);
  const recorded = recordedSiteHosts(apexRecord).includes(hosts.www);

  if (pair.outcome === 'folded') {
    let listing = input.explicit ?? storedPublicListing(apexRecord);
    if (listing === undefined) listing = storedPublicListing(await read(env, www)) ?? false;
    return {
      target: apex,
      scorecard: withListing(scorecard, listing),
      listing,
      alsoPurge: [www.host],
      supersedes: www,
      foldToDrop: null,
    };
  }

  if (pair.outcome === 'no-answer' && recorded) {
    const stamped: WebScorecard = {
      ...scorecard,
      tool: { name: apex.host, url: apex.canonical },
      site_hosts: [apex.host, www.host],
    };
    return { ...plain, target: apex, scorecard: stamped };
  }

  const other = requested.host === www.host ? apex : www;
  const listing = requested.host === target.host ? input.listing : (input.explicit ?? false);
  return {
    target: requested,
    scorecard: withListing(scorecard, listing),
    listing,
    alsoPurge: recorded ? [other.host] : [],
    supersedes: null,
    foldToDrop: recorded && requested.host === www.host ? apexRecord : null,
  };
}

/**
 * The changes a landed write calls for beyond the write itself: the sibling's
 * record deleted, and an ended fold removed from the bare host's record. Each
 * is best-effort and logs its own failure; a record that stays is retried by
 * the next audit of the pair and kept off every listing meanwhile.
 */
export async function settleSiteRecord(env: WebCacheEnv, record: SiteRecord): Promise<void> {
  if (record.supersedes !== null) await remove(env, record.supersedes.canonical, SPEC_VERSION);
  if (record.foldToDrop !== null) {
    const { site_hosts: _fold, ...rest } = record.foldToDrop.scorecard as Record<string, unknown>;
    await patchStoredScorecard(env, record.foldToDrop, rest, 'web-cache.put');
  }
}
