// Shared KV-backed hourly window for fresh web audits (plan U7/U12).
//
// Both the /api/audit-web streaming route and the audit_website MCP tool
// consume from the same per-IP hourly budget, so a caller can't get one
// ceiling via the webapp and another via MCP. Mirrors consumeHourlyBudget
// in scorecard-audit.ts: the CF rate-limit binding enforces the per-60s
// burst floor; this layer enforces the hourly ceiling the binding can't
// express (its max period is 60 seconds).

const HOUR_MS = 3_600_000;
const HOURLY_AUDIT_CEILING = 30;
const HOURLY_KV_TTL_SECONDS = 7200;

// Per-domain flip ceiling for flag-changing writes (opt-in/opt-out). Sized
// well above a legitimate owner's correction rate — opt in, then change your
// mind a couple of times — but far below what rapid listing-flip griefing
// needs. The window is the same fixed hour the audit ceiling uses.
const FLIP_CEILING = 5;

/** Consume one unit of the hourly budget for `ip`. Returns false when exhausted. */
export async function consumeWebAuditHourlyBudget(kv: KVNamespace, ip: string): Promise<boolean> {
  const bucket = Math.floor(Date.now() / HOUR_MS);
  const key = `web_audit:${ip}:${bucket}`;
  const currentRaw = await kv.get(key);
  const current = currentRaw ? Number.parseInt(currentRaw, 10) : 0;
  if (Number.isNaN(current) || current >= HOURLY_AUDIT_CEILING) return false;
  await kv.put(key, String(current + 1), { expirationTtl: HOURLY_KV_TTL_SECONDS });
  return true;
}

/**
 * Consume one unit of the per-domain flip budget for `domainHash`. Returns
 * false when the domain's hourly flip budget is exhausted. Keyed by domain,
 * not IP, so griefing one site from rotating IPs still shares a single budget
 * and flips across different domains stay independent.
 */
export async function consumeWebAuditFlipBudget(kv: KVNamespace, domainHash: string): Promise<boolean> {
  const bucket = Math.floor(Date.now() / HOUR_MS);
  const key = `web_audit_flip:${domainHash}:${bucket}`;
  const currentRaw = await kv.get(key);
  const current = currentRaw ? Number.parseInt(currentRaw, 10) : 0;
  if (Number.isNaN(current) || current >= FLIP_CEILING) return false;
  await kv.put(key, String(current + 1), { expirationTtl: HOURLY_KV_TTL_SECONDS });
  return true;
}
