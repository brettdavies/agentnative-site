// Shared decision for the opt-in `public_listing` flag on the web-audit
// inbound surfaces (the `POST /api/audit-web` route and the `audit_website`
// MCP tool). Each surface parses and gates the request its own way; this
// module owns only the tri-state resolution and the serve-cached / patch /
// re-audit choice so the two surfaces route identically.
//
// The flag is `boolean | undefined` end to end: an omitted request value
// stays distinct from an explicit `false` so a blank never erases a stored
// choice, collapsing to `false` only on a first-ever audit.

import { type CachedWebAudit, isStale, WEB_AUDIT_STALE_AFTER_MS } from './cache';

/**
 * The stored flag read from a cached envelope, or `undefined` when the
 * object carries no flag key (a pre-opt-in write). A missing key is left
 * undefined rather than coerced so callers can tell "no stored choice" from
 * an explicit stored `false`.
 */
export function storedPublicListing(cached: CachedWebAudit | null): boolean | undefined {
  const value = (cached?.scorecard as { public_listing?: unknown } | null | undefined)?.public_listing;
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * The write path a resolved request takes.
 *
 * `flagChanges` reports whether the write alters the stored listing value
 * (as opposed to a no-op serve or a same-value re-audit), letting a caller
 * meter flag flips separately from audit volume.
 */
export type PublicListingWrite =
  | { path: 'serve-cached'; flagChanges: false }
  | { path: 'patch'; value: boolean; cached: CachedWebAudit; flagChanges: true }
  | { path: 'audit'; value: boolean; flagChanges: boolean };

/**
 * Resolve the tri-state request value against the stored entry and choose a
 * write path.
 *
 * A fresh cached hit serves cached for an omitted or value-matching request
 * and patches (flag-only, `scored_at`-preserving) for an explicit value the
 * stored envelope does not already carry. An object with no stored flag key
 * never matches an explicit value, so an explicit request always patches it
 * to make the stored schema exact. A stale hit or a first-ever miss
 * re-audits, resolving the flag as `explicit ?? prior ?? false` so a blank
 * preserves a prior stored choice and only a first-ever audit defaults off.
 */
export function decidePublicListingWrite(input: {
  explicit: boolean | undefined;
  cached: CachedWebAudit | null;
  now?: number;
}): PublicListingWrite {
  const { explicit, cached } = input;
  const prior = storedPublicListing(cached);

  if (cached && !isStale(cached.scored_at, WEB_AUDIT_STALE_AFTER_MS, input.now)) {
    if (explicit === undefined || explicit === prior) {
      return { path: 'serve-cached', flagChanges: false };
    }
    return { path: 'patch', value: explicit, cached, flagChanges: true };
  }

  const value = explicit ?? prior ?? false;
  return { path: 'audit', value, flagChanges: value !== (prior ?? false) };
}
