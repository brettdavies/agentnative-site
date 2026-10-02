// Shared KV-backed hourly windows, one per lane, keyed
// `audit:<lane>:<ip>:<hour>`.
//
// The transact endpoint, the /api/audit-web streaming route, and the
// audit_website MCP tool all consume the web lane's budget, so a caller
// can't get one ceiling via one surface and another via the next. Mirrors
// consumeHourlyBudget in scorecard-audit.ts: the CF rate-limit binding
// enforces the per-60s burst floor; this layer enforces the hourly ceiling
// the binding can't express (its max period is 60 seconds).

import type { Lane } from '../../shared/audit-routes';

const HOUR_MS = 3_600_000;
const HOURLY_AUDIT_CEILING = 30;
const HOURLY_KV_TTL_SECONDS = 7200;

// Per-domain flip ceiling for flag-changing writes (opt-in/opt-out). Sized
// well above a legitimate owner's correction rate — opt in, then change your
// mind a couple of times — but far below what rapid listing-flip griefing
// needs. The window is the same fixed hour the audit ceiling uses.
const FLIP_CEILING = 5;

// Audits an hour that may reach one declared registrable domain, across
// every site and caller that declares it. Matched to the per-IP audit
// ceiling, so one caller's full hour of audits of a site fits, while a
// hostile site declaring a third party cannot turn many callers into more
// than this many audits' worth of requests to it.
const DECLARED_DOMAIN_HOURLY_CEILING = 30;

/** KV key prefix of the declared-domain budget: `<prefix>:<sha256(domain)>:<hour bucket>`. */
export const DECLARED_DOMAIN_BUDGET_PREFIX = 'web_audit_follow';

/**
 * Fixed-hour KV counter behind every hourly budget: read the current
 * bucket count, refuse at the ceiling, otherwise increment under the
 * shared TTL. The key is `<prefix>:<id>:<hour bucket>`.
 */
export async function consumeHourlyBucketBudget(
  kv: KVNamespace,
  prefix: string,
  id: string,
  ceiling: number,
): Promise<boolean> {
  const bucket = Math.floor(Date.now() / HOUR_MS);
  const key = `${prefix}:${id}:${bucket}`;
  const currentRaw = await kv.get(key);
  const current = currentRaw ? Number.parseInt(currentRaw, 10) : 0;
  if (Number.isNaN(current) || current >= ceiling) return false;
  await kv.put(key, String(current + 1), { expirationTtl: HOURLY_KV_TTL_SECONDS });
  return true;
}

/** Consume one unit of `lane`'s hourly budget for `ip`. Returns false when exhausted. */
export async function consumeLaneHourlyBudget(kv: KVNamespace, lane: Lane, ip: string): Promise<boolean> {
  return consumeHourlyBucketBudget(kv, `audit:${lane}`, ip, HOURLY_AUDIT_CEILING);
}

/** The web lane's hourly budget for `ip`. Returns false when exhausted. */
export async function consumeWebAuditHourlyBudget(kv: KVNamespace, ip: string): Promise<boolean> {
  return consumeLaneHourlyBudget(kv, 'web', ip);
}

/**
 * Consume one unit of the per-domain flip budget for `domainHash`. Returns
 * false when the domain's hourly flip budget is exhausted. Keyed by domain,
 * not IP, so griefing one site from rotating IPs still shares a single budget
 * and flips across different domains stay independent.
 */
export async function consumeWebAuditFlipBudget(kv: KVNamespace, domainHash: string): Promise<boolean> {
  return consumeHourlyBucketBudget(kv, 'web_audit_flip', domainHash, FLIP_CEILING);
}

/**
 * Consume one audit's unit of the hourly budget of a declared registrable
 * domain, keyed by the domain's hash. Returns false when that domain's
 * hour is spent.
 */
export async function consumeDeclaredDomainBudget(
  kv: KVNamespace,
  domainHash: string,
  ceiling: number = DECLARED_DOMAIN_HOURLY_CEILING,
): Promise<boolean> {
  return consumeHourlyBucketBudget(kv, DECLARED_DOMAIN_BUDGET_PREFIX, domainHash, ceiling);
}
