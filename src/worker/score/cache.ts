// R2 read/write wrapper for live-scoring scorecards.
//
// Plan U7 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md
// lines 1994-2123). Single source of truth for the cache key shape so
// reads and writes can't drift.
//
// Cache key: `scores/{binary}/{anc-version}.json`. The {anc-version} slot
// is filled with the build-time `SPEC_VERSION` constant at launch
// (handoff Decision 2 + gotcha 3, .context/handoffs/2026-05-19-001):
// computing the running anc binary's version requires installing it
// first, which defeats the cache. Spec bumps already mean an anc bump in
// practice, so SPEC_VERSION-as-proxy carries the "anc bump invalidates"
// property at the cost of caching across anc-only bumps that don't bump
// the spec. The 7-day R2 lifecycle reaps the entry on the long tail.
//
// Refusal-to-cache-half-state: put() throws if `ancVersion` or
// `toolVersion` is empty. The cached payload IS the contract; a partial
// entry would silently degrade future cache reads.
//
// Write failures are best-effort: logged, never thrown to the caller.
// One missed cache write costs at most one extra sandbox spawn the
// next time; throwing would cost the user the response they came for.

export type CacheEnv = { SCORE_CACHE: R2Bucket };

export type CachedScorecard = {
  spec_version: string;
  anc_version: string;
  tool_version: string;
  scorecard: unknown;
};

// Per-write Cache-Control header. Keeps CDN edges from over-caching the
// R2 object outside the Worker's view. R2 bucket lifecycle handles the
// 7-day origin TTL — configured once via:
//
//   wrangler r2 bucket lifecycle add anc-score-cache --prefix scores/ --expiration 7d
//
// Documented under RELEASES.md "Sandbox image releases" so a future
// bucket recreate doesn't lose the TTL.
const CACHE_CONTROL = 'public, max-age=300, s-maxage=300';

export function keyFor(binary: string, ancVersion: string): string {
  return `scores/${binary}/${ancVersion}.json`;
}

export async function get(env: CacheEnv, key: string): Promise<CachedScorecard | null> {
  // R2's `get(key)` returns an `R2ObjectBody | null`; the body is
  // consumed via `.json()` / `.text()` / etc. This differs from KV's
  // `get(key, "json")` shape — historically a footgun when porting
  // helpers between the two binding types.
  let obj: R2ObjectBody | null;
  try {
    obj = await env.SCORE_CACHE.get(key);
  } catch (err) {
    // R2 read failure: treat as miss + log. Never throw — the live path
    // can still produce a result for the user.
    console.log(JSON.stringify({ scope: 'cache.get', key, error: errMsg(err) }));
    return null;
  }
  if (obj === null) return null;

  let raw: unknown;
  try {
    raw = await obj.json();
  } catch (err) {
    // Malformed JSON body: treat as corrupted + best-effort delete.
    console.log(JSON.stringify({ scope: 'cache.get', key, error: `json_parse: ${errMsg(err)}` }));
    env.SCORE_CACHE.delete(key).catch(() => {
      // delete failed — entry will age out via the 7-day R2 lifecycle.
    });
    return null;
  }

  if (!isCachedScorecard(raw)) {
    // Schema-corrupted entry: log, best-effort delete, treat as miss. A
    // future request will recompute and overwrite.
    console.log(JSON.stringify({ scope: 'cache.get', key, error: 'corrupted_payload' }));
    env.SCORE_CACHE.delete(key).catch(() => {
      // delete failed — entry will age out via the 7-day R2 lifecycle.
    });
    return null;
  }
  return raw;
}

export async function put(
  env: CacheEnv,
  key: string,
  scorecard: unknown,
  ancVersion: string,
  toolVersion: string,
  specVersion: string,
): Promise<void> {
  if (!ancVersion) throw new Error('cache.put: ancVersion required (refusal-to-cache-half-state)');
  if (!toolVersion) throw new Error('cache.put: toolVersion required (refusal-to-cache-half-state)');
  if (!specVersion) throw new Error('cache.put: specVersion required (refusal-to-cache-half-state)');

  const payload: CachedScorecard = {
    spec_version: specVersion,
    anc_version: ancVersion,
    tool_version: toolVersion,
    scorecard,
  };

  try {
    await env.SCORE_CACHE.put(key, JSON.stringify(payload), {
      httpMetadata: {
        contentType: 'application/json',
        cacheControl: CACHE_CONTROL,
      },
    });
  } catch (err) {
    // Best-effort: a write failure does not block the user's response.
    console.log(JSON.stringify({ scope: 'cache.put', key, error: errMsg(err) }));
  }
}

function isCachedScorecard(value: unknown): value is CachedScorecard {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.spec_version === 'string' &&
    obj.spec_version.length > 0 &&
    typeof obj.anc_version === 'string' &&
    obj.anc_version.length > 0 &&
    typeof obj.tool_version === 'string' &&
    obj.tool_version.length > 0 &&
    'scorecard' in obj
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
