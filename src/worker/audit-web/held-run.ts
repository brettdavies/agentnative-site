// A followed run the transact surfaces hold back from replacing the site's
// saved scorecard because a declared domain's spent hourly budget shaped it
// (domain-budget-hold.ts): the reason its inline result shows, and the
// listing the saved scorecard carries once the caller's explicit choice, if it
// made one, is applied.

import { type CachedWebAudit, patchStoredPublicListing, type WebCacheEnv } from './cache';
import { domainBudgetHold } from './domain-budget-hold';
import type { DomainRefusal } from './follow-requests';
import { queueHitMinPurge, webTag } from './hit-min-purge';
import { hourWindowEndsAt } from './limiter';
import { standingPublicListing } from './public-listing';
import type { WebScorecard } from './scorecard';
import type { TransientReason } from './summary-transient';

interface HeldRun {
  reason: TransientReason;
  /** The listing stored once the caller's explicit choice, if any, is applied. */
  listing: boolean;
}

/**
 * An explicit choice that differs from the saved listing is written onto the
 * saved scorecard with its rows and scored_at kept, as the listing patch
 * writes it, and the board purge that patch queues is queued. A blank
 * request leaves the saved listing as it stands, because the hold reads the
 * saved record at the moment the run would have written it. A store that
 * could not be read, or a write that failed, leaves the listing that stands.
 */
async function applyListing(
  env: WebCacheEnv,
  saved: CachedWebAudit | null,
  explicit: boolean | undefined,
): Promise<boolean> {
  const standing = standingPublicListing(saved);
  if (saved === null || explicit === undefined || explicit === standing) return standing;
  if (!(await patchStoredPublicListing(env, saved, explicit))) return standing;
  queueHitMinPurge([webTag()]);
  return explicit;
}

/**
 * The hold on a complete followed run of `target`, or null when the run
 * saves as any audit. `refusals` names what refused each domain the run's
 * follow slice could not reserve, which says when trying again can help.
 */
export async function heldRun(
  env: WebCacheEnv,
  target: { host: string; canonical: string },
  scorecard: WebScorecard,
  explicit: boolean | undefined,
  refusals: Readonly<Record<string, DomainRefusal>>,
): Promise<HeldRun | null> {
  const hold = await domainBudgetHold(env, target.canonical, scorecard);
  if (hold === null) return null;
  return {
    reason: {
      kind: 'domain-budget',
      domain: hold.domain,
      host: target.host,
      savedScoredAt: hold.saved?.scored_at ?? null,
      retry:
        refusals[hold.domain] === 'hourly-window'
          ? { after: 'hour', at: hourWindowEndsAt(Date.now()) }
          : { after: 'minute' },
    },
    listing: await applyListing(env, hold.saved, explicit),
  };
}
