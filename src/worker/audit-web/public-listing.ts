// Shared decision for the opt-in `public_listing` flag on the web-audit
// inbound surfaces (the `POST /api/audit-web` route and the `audit_website`
// MCP tool). Each surface parses and gates the request its own way; this
// module owns only the tri-state resolution and the serve-cached / patch /
// re-audit choice so the two surfaces route identically.
//
// The flag is `boolean | undefined` end to end: an omitted request value
// stays distinct from an explicit `false` so a blank never erases a stored
// choice, collapsing to `false` only on a first-ever audit.

import { type CachedWebAudit, isStale, sha256Hex, WEB_AUDIT_STALE_AFTER_MS } from './cache';
import { consumeWebAuditFlipBudget } from './limiter';

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

/**
 * The `public_listing` value a (re-)audit should carry, shared by both
 * inbound surfaces so they resolve it identically.
 *
 * When the decision already chose the audit path its resolved value is
 * authoritative. A surface reaches its own audit branch with any other
 * decision only when its staleness snapshot lagged the decision's across
 * the request boundary; there an omitted flag must still carry the prior
 * stored choice rather than reset it, so the value is re-resolved as
 * `explicit ?? prior ?? false`.
 */
export function resolveAuditListing(
  write: PublicListingWrite,
  explicit: boolean | undefined,
  cached: CachedWebAudit | null,
): boolean {
  return write.path === 'audit' ? write.value : (explicit ?? storedPublicListing(cached) ?? false);
}

/**
 * Outcome of metering a resolved write against the per-domain flip budget.
 * `allowed` covers a write that spent a token, a no-op that spent nothing, and
 * (fail-open) a request when no KV binding is configured; `rate-limited` means
 * the domain's flip budget is exhausted and the caller must reject the flip
 * before writing.
 */
export type FlipLimitOutcome = 'allowed' | 'rate-limited';

/**
 * Meter a flag-changing write against the shared per-domain flip budget so the
 * `POST /api/audit-web` route and the `audit_website` MCP tool draw from one
 * budget per domain. Only a write that actually changes the stored flag
 * (`flagChanges` — the patch path always, a re-audit only when its resolved
 * value differs) spends a token; a serve-cached no-op or a same-value re-audit
 * is free. Keyed by a hash of the domain, following the cache-key hashing
 * convention. Fails open when no KV binding is present, mirroring the hourly
 * limiter (both surfaces skip that gate when `SCORE_KV` is unset), so a dev or
 * unprovisioned env still serves flips while the primary bot defenses
 * (Turnstile, burst + hourly limiters, the staleness gate) stand.
 */
export async function enforcePublicListingFlipLimit(input: {
  write: PublicListingWrite;
  kv: KVNamespace | undefined;
  domain: string;
}): Promise<FlipLimitOutcome> {
  if (!input.write.flagChanges) return 'allowed';
  if (!input.kv) return 'allowed';
  const ok = await consumeWebAuditFlipBudget(input.kv, await sha256Hex(input.domain));
  return ok ? 'allowed' : 'rate-limited';
}
