// `scoring_disabled` operator kill switch.
//
// Plan U5 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md
// "Cost ceiling and abuse mitigation" step 3): the Worker reads
// `env.SCORE_KV.get("scoring_disabled")` first thing in /api/score.
// Truthy → 503 with Retry-After: 3600. Operator flips via
// `wrangler kv:key put SCORE_KV scoring_disabled true` in seconds.
//
// In-memory cache for the lifetime of a single Worker invocation only.
// Workers isolates are short-lived and re-instantiate frequently, so a
// process-lifetime cache is enough to coalesce many concurrent requests
// against the same invocation without making the kill-switch sticky
// across the operator's flip. A flip propagates to all isolates within
// the global KV-read TTL (≤60 s).

export type KillSwitchEnv = {
  SCORE_KV: KVNamespace;
};

const CACHE_TTL_MS = 30_000;

type CacheEntry = { value: boolean; expiresAt: number };
let cache: CacheEntry | null = null;

export async function isScoringDisabled(env: KillSwitchEnv): Promise<boolean> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  const raw = await env.SCORE_KV.get('scoring_disabled');
  const value = raw === 'true' || raw === '1';
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Test-only — drops the cache so a unit test's stub KV is read on the next call. */
export function _resetKillSwitchCache(): void {
  cache = null;
}
