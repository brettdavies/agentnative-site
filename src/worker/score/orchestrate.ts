// Shared /api/score orchestration core.
//
// The plan extracts the post-input-validation orchestration of
// /api/score into this file so both the human form (handler.ts) and
// the MCP score tools (get_scorecard, score_cli) compose the same
// resolver / cache / DO-dispatch pipeline.
//
// U3 landed the LOOKUP-ONLY intent (lookupOnly + shared loadHintsIndex
// cache). U5a lands the RUN-FRESH-ON-MISS intent (runFreshOnly):
// resolveSpec → post-discovery cache lookup → DO pool dispatch via
// getRandom(env.SCORE, MAX_INSTANCES). The DO writes the cache itself
// via writeCacheBestEffort; this module never writes R2 directly.
//
// handler.ts continues to inline its own copy of the run-fresh pipeline
// today; a follow-up unit (U5b) will refactor /api/score to compose
// runFreshOnly so the duplication collapses. The behavior of
// runFreshOnly here matches the inlined slice exactly so the lift is a
// straight substitution.

import { type Container, getRandom } from '@cloudflare/containers';
import * as cache from './cache';
import type { InstallSpec, ResolvedStep } from './discover-binary';
import { type DiscoveryHintsIndex, lookupScorecard, type ScorecardLookupResult } from './registry-lookup';
import { resolveSpec } from './resolve-spec';
import type { ValidatedInput } from './validate';

export interface OrchestrateEnv extends cache.CacheEnv {
  ASSETS: Fetcher;
  // SCORE binding is optional because tests that exercise only
  // lookupOnly don't need a Durable Object stub. runFreshOnly returns
  // `kind: 'sandbox_unavailable'` when SCORE is missing — this is the
  // designed behavior, not an error condition.
  SCORE?: DurableObjectNamespace;
}

// Mirrors handler.ts MAX_INSTANCES. Must match wrangler.jsonc
// containers[].max_instances so getRandom's hash space lines up with
// the CF Containers app config. Top-level prod is currently 3,
// env.staging is 10; the constant here is 10 to match handler.ts's
// existing value. Pinning the two constants together is the safety;
// they should drift only when wrangler.jsonc bumps.
const MAX_INSTANCES = 10;

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
 * get_scorecard / score_cli tools.
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

// =====================================================================
// runFreshOnly — the run-fresh-on-miss intent.
// =====================================================================
//
// Used by score_cli after lookupOnly returns kind=miss. Takes a
// ValidatedInput, resolves it to an InstallSpec, consults the
// post-discovery cache one more time (the discovery layer often
// produces a binary that the pre-discovery cache lookup couldn't
// derive), then dispatches to the Sandbox DO pool via getRandom and
// returns a typed result the caller maps to its own response shape.
//
// MUST be called only after upstream metered gates (Turnstile + session
// + SCORE_LIMITER on the human form; MCP_AUDIT_LIMITER + KV-per-hour on
// the MCP form). This function performs no rate limiting; the costly
// outbound calls (discovery fan-out and DO dispatch) fire unconditionally
// when called.

export type RunFreshResult =
  | {
      kind: 'cache_post_hit';
      scorecard: unknown;
      anc_version: string;
      tool_version: string;
      spec: InstallSpec;
      resolved_step: ResolvedStep | null;
    }
  | {
      kind: 'fresh';
      scorecard: unknown;
      anc_version: string;
      spec: InstallSpec;
      resolved_step: ResolvedStep | null;
      install_ms: number | null;
      anc_audit_ms: number | null;
    }
  | {
      kind: 'resolution_error';
      error: 'chain_no_resolve' | 'install_unsupported' | 'invalid_url_path';
      details?: string;
    }
  | { kind: 'sandbox_unavailable' }
  | { kind: 'sandbox_stub_until_u6' }
  | {
      kind: 'do_error';
      error: string;
      details?: string;
      spec: InstallSpec;
      resolved_step: ResolvedStep | null;
    }
  | { kind: 'incomplete_response_contract'; reason: 'non_json_body' | 'unrecognized_envelope' };

export interface RunFreshOptions {
  specVersion: string;
  // sha256 of the raw user input; threaded into the DO request body for
  // telemetry alignment with the /api/score path's per-request log line.
  // The DO does not consume the hash on the wire; it lives in the body
  // for symmetry with the human form so DO-side log queries stay
  // identical across both surfaces.
  inputHash: string;
  // Operator escape hatch: skip the post-discovery cache lookup. The
  // pre-discovery cache lookup (lookupOnly's tier 2) is upstream of
  // this function; this flag covers tier 3 only.
  skipCachePost?: boolean;
  // Injectable fetcher passed through to resolveSpec for the discovery
  // fan-out. Threaded so tests can intercept the brew / npm / pypi /
  // GitHub Releases outbound calls without monkey-patching globalThis.
  fetcher?: typeof fetch;
}

function isStubError(payload: unknown): boolean {
  return (
    typeof payload === 'object' && payload !== null && (payload as { error?: string }).error === 'sandbox_stub_until_u6'
  );
}

function isDoSuccess(
  payload: unknown,
): payload is { scorecard: unknown; anc_version: string; install_ms?: number; anc_audit_ms?: number } {
  if (typeof payload !== 'object' || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  return 'scorecard' in obj && typeof obj.anc_version === 'string';
}

function isDoError(payload: unknown): payload is { error: string; details?: string } {
  if (typeof payload !== 'object' || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  return typeof obj.error === 'string';
}

export async function runFreshOnly(
  input: ValidatedInput,
  env: OrchestrateEnv,
  hintsIndex: DiscoveryHintsIndex,
  opts: RunFreshOptions,
): Promise<RunFreshResult> {
  // Step 1: resolveSpec. Discovery fan-out + brew/go fallbacks live
  // here; failure exits before the DO is touched.
  const resolution = await resolveSpec(input, hintsIndex, { fetcher: opts.fetcher });
  if (!resolution.ok) {
    return { kind: 'resolution_error', error: resolution.error, details: resolution.details };
  }
  const spec = resolution.spec;
  const resolved_step: ResolvedStep | null = resolution.resolved_step ?? null;

  // Step 2: post-discovery cache lookup. Discovery now knows
  // spec.binary, which the pre-discovery lookup couldn't derive for
  // github-url-without-hint inputs. A hit here is wire-indistinguishable
  // from a pre-discovery hit; the kind tag lets the caller distinguish
  // for telemetry purposes only.
  //
  // Skip conditions match handler.ts:
  //   - spec.pm === 'git-clone' (branch-scoped scores aren't cached;
  //     caching under the bare binary would clobber default-branch
  //     scorecards).
  //   - opts.skipCachePost (operator escape hatch).
  if (spec.pm !== 'git-clone' && !opts.skipCachePost) {
    const cached = await cache.get(env, cache.keyFor(spec.binary, opts.specVersion));
    if (cached) {
      return {
        kind: 'cache_post_hit',
        scorecard: cached.scorecard,
        anc_version: cached.anc_version,
        tool_version: cached.tool_version,
        spec,
        resolved_step,
      };
    }
  }

  // Step 3: DO dispatch via getRandom. The DO writes the cache itself
  // via writeCacheBestEffort against scores/<binary>/<spec-version>.json,
  // so the next request for the same binary short-circuits at
  // lookupOnly's cache tier (or the post-discovery tier above, when the
  // input is a github-url-without-hint).
  if (!env.SCORE) {
    return { kind: 'sandbox_unavailable' };
  }

  const stub = (await getRandom(
    env.SCORE as unknown as DurableObjectNamespace<Container>,
    MAX_INSTANCES,
  )) as DurableObjectStub;

  const doRes = await stub.fetch(
    new Request('https://do.internal/score', {
      method: 'POST',
      body: JSON.stringify({ spec, hash: opts.inputHash }),
      headers: { 'content-type': 'application/json' },
    }),
  );

  let doPayload: unknown;
  try {
    doPayload = await doRes.json();
  } catch {
    return { kind: 'incomplete_response_contract', reason: 'non_json_body' };
  }

  if (isStubError(doPayload)) return { kind: 'sandbox_stub_until_u6' };

  if (isDoError(doPayload)) {
    return { kind: 'do_error', error: doPayload.error, details: doPayload.details, spec, resolved_step };
  }

  if (isDoSuccess(doPayload)) {
    return {
      kind: 'fresh',
      scorecard: doPayload.scorecard,
      anc_version: doPayload.anc_version,
      spec,
      resolved_step,
      install_ms: typeof doPayload.install_ms === 'number' ? doPayload.install_ms : null,
      anc_audit_ms: typeof doPayload.anc_audit_ms === 'number' ? doPayload.anc_audit_ms : null,
    };
  }

  return { kind: 'incomplete_response_contract', reason: 'unrecognized_envelope' };
}
