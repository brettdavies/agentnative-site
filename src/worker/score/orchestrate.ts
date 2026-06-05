// Shared /api/score orchestration core (in-progress per the MCP plan).
//
// The plan extracts the post-input-validation orchestration of
// /api/score into this file so both the human form (handler.ts) and
// the MCP score tools (get_scorecard, score_cli) compose the same
// resolver / cache / DO-dispatch pipeline.
//
// U3 (this unit) lands the LOOKUP-ONLY intent: a thin wrapper around
// `lookupScorecard()` plus the shared `loadHintsIndex` cache. The
// run-fresh-on-miss intent — `resolveSpec()` plus the DO pool dispatch
// via `getRandom(env.SCORE, MAX_INSTANCES)` — lands in U5 when
// handler.ts's body is slimmed to compose this orchestrator end-to-end.
//
// Why lift `loadHintsIndex` here and not leave it private in
// handler.ts: the MCP get_scorecard tool needs the same isolate-level
// hints cache to feed into `lookupScorecard()`. Putting the loader in
// orchestrate.ts is the smallest move that lets both /api/score and
// the MCP path share one cache without re-fetching `/discovery-hints-
// index.json` twice per isolate.

import type * as cache from './cache';
import { type DiscoveryHintsIndex, lookupScorecard, type ScorecardLookupResult } from './registry-lookup';
import type { ValidatedInput } from './validate';

export interface OrchestrateEnv extends cache.CacheEnv {
  ASSETS: Fetcher;
}

let hintsIndexPromise: Promise<DiscoveryHintsIndex> | null = null;

async function fetchAssetJson<T>(env: OrchestrateEnv, path: string): Promise<T> {
  const res = await env.ASSETS.fetch(new Request(`https://assets.internal${path}`));
  if (!res.ok) throw new Error(`asset fetch failed: ${path} (status ${res.status})`);
  return (await res.json()) as T;
}

export function loadHintsIndex(env: OrchestrateEnv): Promise<DiscoveryHintsIndex> {
  if (!hintsIndexPromise) {
    hintsIndexPromise = fetchAssetJson<DiscoveryHintsIndex>(env, '/discovery-hints-index.json').catch((err) => {
      hintsIndexPromise = null;
      throw err;
    });
  }
  return hintsIndexPromise;
}

/** Test-only — drop the in-memory hints-index promise. */
export function _resetHintsIndexCache(): void {
  hintsIndexPromise = null;
}

export interface LookupOnlyOptions {
  specVersion: string;
  skipCache?: boolean;
}

/**
 * Lookup-only intent: registry first, R2 cache second, no fresh audit.
 * Composed by both /api/score (for its cache-pre tier) and the MCP
 * get_scorecard / score_cli tools (for the read tier on both, plus the
 * "should I spin a container?" gate on score_cli).
 *
 * The run-fresh-on-miss intent lands in U5; for now, a `miss` result is
 * returned as-is and the caller decides what to do.
 */
export async function lookupOnly(
  input: ValidatedInput,
  env: OrchestrateEnv,
  registryIndex: Parameters<typeof lookupScorecard>[2],
  hintsIndex: DiscoveryHintsIndex,
  opts: LookupOnlyOptions,
): Promise<ScorecardLookupResult> {
  return lookupScorecard(input, env, registryIndex, hintsIndex, opts);
}
