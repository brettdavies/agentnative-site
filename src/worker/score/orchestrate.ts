// The CLI orchestration primitives every CLI surface composes: the
// lane core (`./core.ts`, behind both transact endpoints), the MCP
// get_scorecard and score_cli tools.
//
//   lookupOnly ..... registry, then the R2 cache; no fresh audit
//   runFreshOnly ... resolveSpec, the post-discovery cache lookup, then
//                    a Durable Object dispatch through the getRandom pool,
//                    read line by line: `phase` lines go to the optional
//                    callback, the one result line becomes the result
//
// The Durable Object body is NDJSON; a body that is exactly one JSON
// object is read as the result line. A stream that closes without a
// result line is `incomplete_response_contract`. The caller's abort
// signal stops the read. The Durable Object writes the cache and purges
// itself; this module never writes R2. Neither function rate-limits: the
// caller's gates run first.

import { type Container, getRandom } from '@cloudflare/containers';
import { CLI_PHASES, type CliPhase } from '../../shared/audit-events';
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
// Takes a ValidatedInput, resolves it to an InstallSpec, consults the
// post-discovery cache once more (discovery often produces a binary the
// pre-discovery lookup could not derive), then dispatches to the Sandbox
// DO pool through getRandom and returns a typed result the caller maps
// to its own response shape.
//
// Called only after the caller's metered gates. This function performs
// no rate limiting; the costly outbound calls (discovery fan-out and DO
// dispatch) fire unconditionally when called.

// spec + resolved_step are present on every variant where the
// orchestrator passed the post-discovery skip gate (i.e. resolveSpec
// returned ok) before bouncing on the DO layer. The MCP score_cli
// consumer ignores these fields on error variants; the handler reads
// them to preserve byte-identical Analytics Engine row attribution
// (binary / pm / resolved_step) across success and DO-failure paths.
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
      /** The commit a source clone scored; null for an installed binary. */
      source_sha: string | null;
    }
  | {
      kind: 'resolution_error';
      error: 'chain_no_resolve' | 'install_unsupported' | 'invalid_url_path';
      details?: string;
    }
  | { kind: 'sandbox_unavailable'; spec?: InstallSpec; resolved_step?: ResolvedStep | null }
  | { kind: 'sandbox_stub_until_u6'; spec?: InstallSpec; resolved_step?: ResolvedStep | null }
  | {
      kind: 'do_error';
      error: string;
      details?: string;
      spec: InstallSpec;
      resolved_step: ResolvedStep | null;
    }
  | {
      kind: 'incomplete_response_contract';
      reason: 'non_json_body' | 'unrecognized_envelope' | 'stream_ended';
      spec?: InstallSpec;
      resolved_step?: ResolvedStep | null;
    };

/** One `phase` line from the Durable Object, as written. */
export type PhaseLine = { phase: CliPhase; at: string };

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
  // Runs once the spec is known and before the post-discovery cache read
  // or the sandbox dispatch, so a caller can key state by the resolved
  // binary while the run is still ahead.
  onResolved?: (spec: InstallSpec) => Promise<void>;
  /** Receives each `phase` line as the Durable Object writes it. */
  onPhase?: (line: PhaseLine) => void;
  /** Aborting it stops the Durable Object read; the call rejects with the reason. */
  signal?: AbortSignal;
}

// DO envelope classification helpers. Exported so handler.ts can
// reuse them at its variant switch (U5b) without redeclaring locally —
// single home, no drift between the orchestrator and the human form.
export function isStubError(payload: unknown): boolean {
  return (
    typeof payload === 'object' && payload !== null && (payload as { error?: string }).error === 'sandbox_stub_until_u6'
  );
}

export function isDoSuccess(payload: unknown): payload is {
  scorecard: unknown;
  anc_version: string;
  install_ms?: number;
  anc_audit_ms?: number;
  source_sha?: string;
} {
  if (typeof payload !== 'object' || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  return 'scorecard' in obj && typeof obj.anc_version === 'string';
}

export function isDoError(payload: unknown): payload is { error: string; details?: string } {
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
  if (opts.onResolved) await opts.onResolved(spec);

  // Step 2: post-discovery cache lookup. Discovery now knows
  // spec.binary, which the pre-discovery lookup couldn't derive for
  // github-url-without-hint inputs. A hit here is wire-indistinguishable
  // from a pre-discovery hit; the kind tag lets the caller distinguish
  // for telemetry purposes only.
  //
  // A branch target is a snapshot: its record lives under its own key
  // and no transact tier serves it, so only a binary consults the cache
  // here. opts.skipCachePost is the operator escape hatch.
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
  // via writeCacheBestEffort under the target's key, so the next request
  // for the same binary short-circuits at lookupOnly's cache tier (or the
  // post-discovery tier above, when the input is a github-url-without-hint)
  // and a branch snapshot is readable by the result page.
  //
  // spec + resolved_step are threaded onto every error variant from here
  // down so the human-form caller (handler.ts) can preserve AE-row
  // attribution (binary / pm / resolved_step) on sandbox_unavailable /
  // sandbox_stub_until_u6 / incomplete_response_contract paths. Without
  // this, operators querying "which tools hit sandbox errors most often"
  // would see null attribution on those rows.
  if (!env.SCORE) {
    return { kind: 'sandbox_unavailable', spec, resolved_step };
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
      signal: opts.signal,
    }),
  );

  const read = await readResultLine(doRes.body, opts.onPhase, opts.signal);
  if (read.kind === 'non_json') {
    return { kind: 'incomplete_response_contract', reason: 'non_json_body', spec, resolved_step };
  }
  if (read.kind === 'ended') {
    return { kind: 'incomplete_response_contract', reason: 'stream_ended', spec, resolved_step };
  }
  const doPayload = read.payload;

  if (isStubError(doPayload)) return { kind: 'sandbox_stub_until_u6', spec, resolved_step };

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
      source_sha: typeof doPayload.source_sha === 'string' && doPayload.source_sha ? doPayload.source_sha : null,
    };
  }

  return { kind: 'incomplete_response_contract', reason: 'unrecognized_envelope', spec, resolved_step };
}

// ---------------------------------------------------------------------------
// The line reader
// ---------------------------------------------------------------------------

const PHASE_NAMES: ReadonlySet<string> = new Set(CLI_PHASES);

type ReadOutcome = { kind: 'line'; payload: unknown } | { kind: 'non_json' } | { kind: 'ended' };

function isPhaseLine(payload: unknown): payload is { type: 'phase' } & PhaseLine {
  if (typeof payload !== 'object' || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  return (
    obj.type === 'phase' && typeof obj.phase === 'string' && PHASE_NAMES.has(obj.phase) && typeof obj.at === 'string'
  );
}

// One promise that rejects with the signal's reason the moment it aborts,
// raced against every read so a stalled body never outlives the signal.
function abortRejection(signal: AbortSignal): { rejection: Promise<never>; release: () => void } {
  let onAbort: (() => void) | null = null;
  const rejection = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  rejection.catch(() => {});
  return { rejection, release: () => onAbort && signal.removeEventListener('abort', onAbort) };
}

async function readResultLine(
  body: ReadableStream<Uint8Array> | null,
  onPhase: ((line: PhaseLine) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadOutcome> {
  if (!body) return { kind: 'ended' };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const classify = (raw: string): ReadOutcome | null => {
    const line = raw.trim();
    if (!line) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      return { kind: 'non_json' };
    }
    if (isPhaseLine(payload)) {
      onPhase?.({ phase: payload.phase, at: payload.at });
      return null;
    }
    return { kind: 'line', payload };
  };
  let buffered = '';
  const abort = signal ? abortRejection(signal) : null;
  try {
    while (true) {
      const { value, done } = abort ? await Promise.race([reader.read(), abort.rejection]) : await reader.read();
      buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const outcome = classify(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (outcome) return outcome;
        newline = buffered.indexOf('\n');
      }
      if (done) return classify(buffered) ?? { kind: 'ended' };
    }
  } finally {
    abort?.release();
    reader.cancel().catch(() => {});
  }
}
