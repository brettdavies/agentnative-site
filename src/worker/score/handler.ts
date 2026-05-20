// /api/score request handler — orchestrates the live-scoring pipeline.
//
// Pipeline (post 2026-05-20 gates-before-discovery reorder):
//
//   1. Validate input (U4).
//   2. Unified scorecard lookup — pre-discovery (U7). One call to
//      lookupScorecard() collapses the registry-fast-path and the R2
//      cache pre-check into a single tier-resolved decision. `curated`
//      returns the registry-hit envelope pointing at /score/<slug>;
//      `cached` returns the inline scorecard JSON; both bypass the
//      metered gates (kill-switch, Turnstile, rate-limit, DO) per R6
//      — cached scorecards are functionally identical to curated ones
//      (no sandbox cost). `miss` falls through to the live path.
//
//      The pre-discovery cache key is keyed by whatever binary is
//      cheaply derivable from input alone: install-command's
//      `spec.binary`, or a hinted github-url's `hint.binary`. A
//      github-url WITHOUT a hint has no binary upfront — that case
//      always misses here and falls through to discovery (step 6),
//      after which step 6.5 re-checks the cache with the resolved
//      binary.
//   3. GET requests stop after step 2: GET is the paste-and-share /
//      bookmark read-only contract. A miss returns 404 chain_no_resolve.
//      GET never consults gates and never reaches discovery or the DO.
//   4. [METERED GATES — POST only, after registry+cache miss.]
//      a. Kill switch (`scoring_disabled` in SCORE_KV; isolate-cached KV
//         read) — 503 + Retry-After. Cheapest gate, ordered first so a
//         flipped switch denies before any external network call.
//      b. Turnstile siteverify — 400 turnstile_failed on miss. External
//         call (~50-200ms) to challenges.cloudflare.com; the bot-defense
//         layer that guards everything below it.
//      c. Rate limit on `<session-id>:<sha256(input)>` (SCORE_LIMITER)
//         plus a coarse per-IP fallback (SCORE_LIMITER_IP). 429 with
//         Retry-After.
//      The gates fire BEFORE any outbound that costs us money or a
//      third-party quota (steps 5 and 6). An unauthenticated caller
//      cannot fan out the discovery chain at zero rate-limit cost.
//   5. GitHub accessibility pre-check (POST + github-url + no branch +
//      no hint) — single HEAD against github.com. Fast-fail private/
//      inaccessible repos as github_repo_not_accessible before the
//      ~5-call discovery fan-out. Lives AFTER the metered gates: the
//      probe is cheap but it's still an outbound, and gates apply
//      uniformly to every external call discovery would make.
//   6. Resolve InstallSpec (resolve-spec.ts). The Worker runs the
//      discovery chain (api.github.com releases, brew/crates/npm/pypi/
//      go, README parse) + brew/go fallbacks. A `chain_no_resolve` /
//      `install_unsupported` / `invalid_url_path` result bounces HERE
//      — no DO dispatch, no compute billed. The bounces land AFTER the
//      metered gates so an attacker cannot DoS the discovery layer
//      (~5 parallel registry calls + GitHub Releases per request) at
//      zero rate-limit cost.
//   6.5. Unified scorecard lookup — post-discovery cache. Discovery now
//      knows `spec.binary`, so for github-url-without-hint inputs that
//      missed at step 2 we can re-check the cache with the resolved
//      binary before paying the DO container cost. Same cache binding,
//      same key shape (`scores/<binary>/<SPEC_VERSION>.json`) as step
//      2 — readers and writers can't drift. Skipped for
//      `git-clone` specs (branch-scoped, ephemeral, never cached) and
//      when `?fromCache=false` is set. A hit here is wire-indistinguish-
//      able from a step-2 cache hit: same `freshness: 'cache-hit'`,
//      same `Cache-Control: public, max-age=300`. Both bypass the DO.
//   7. DO call with the RESOLVED InstallSpec ({spec, hash} body).
//      Pre-2026-05-20 the DO received `{input, hash}` and did its own
//      discovery; the move drops a duplicate `loadHintsIndex` and lets
//      no-resolve requests skip the container entirely. On success the
//      DO writes to SCORE_CACHE itself (do.ts), so the next request
//      for the same binary short-circuits at step 2's cache tier
//      (when the binary is derivable from input) or at step 6.5's
//      post-discovery re-check (when it isn't).
//
// `?fromCache=false` operator escape hatch: skips BOTH the pre-discovery
// (step 2) and post-discovery (step 6.5) cache read tiers. The curated
// registry is still consulted, and the cache WRITE after a live run still
// fires. Useful when "did the registry version just update?" needs an
// authoritative re-score.
//
// Telemetry: one structured log line per request, `scope: 'score.tier'`,
// captures which tier served the response (`curated` | `cache_pre` |
// `cache_post` | `live` | `error_<code>`) plus per-tier attempt + hit
// flags so we can later query "what percentage of cache hits came from
// pre vs post discovery?" via the observability binding. Not exposed in
// the response body — operational signal only.
//
// GET / POST split:
//   - GET  /api/score(.md|.json)?input=…  read-only. Registry-fast-path
//                                          only; non-registry input
//                                          returns 404 chain_no_resolve.
//                                          Used by docs links + bookmark
//                                          paste-and-share UX.
//   - POST /api/score(.md|.json)          { input, turnstile_token? }
//                                          full pipeline.
//
// Other methods → 405.

import type { Container } from '@cloudflare/containers';
import { getRandom } from '@cloudflare/containers';
import { detectScorePreference } from '../accept';
import { CHECKER_URL, SPEC_VERSION } from '../spec-version.gen';
import type { CacheEnv } from './cache';
import * as cache from './cache';
import { checkGithubAccessibility } from './github-accessibility';
import { isScoringDisabled, type KillSwitchEnv } from './kill-switch';
import {
  type DiscoveryHintsIndex,
  deriveShareBinary,
  lookupRegistry,
  lookupScorecard,
  type RegistryIndex,
} from './registry-lookup';
import { resolveSpec } from './resolve-spec';
import { CTA, type ScoreError, shapeScoreError, shapeScoreSuccess, statusForError } from './response-shape';
import { issue, newSession, read as readSession, SessionConfigError, type SessionEnv } from './session';
import { TurnstileConfigError, type TurnstileEnv, verifyTurnstile } from './turnstile';
import { type ValidatedInput, validateInput } from './validate';

// Sandbox DO instance pool size. Must match `max_instances` in
// wrangler.jsonc `containers[]` so getRandom's hash space lines up with
// the CF Containers app config — under-shooting wastes provisioned
// capacity; over-shooting picks IDs that don't have a container.
const MAX_INSTANCES = 10;

// ---------------------------------------------------------------------------
// Env contract
// ---------------------------------------------------------------------------

export type ScoreEnv = KillSwitchEnv &
  SessionEnv &
  TurnstileEnv &
  CacheEnv & {
    ASSETS: Fetcher;
    SCORE: DurableObjectNamespace;
    SCORE_LIMITER: RateLimit;
    SCORE_LIMITER_IP?: RateLimit;
  };

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

// ---------------------------------------------------------------------------
// Registry / hints index loading. Cached at module scope across invocations
// in the same isolate (Workers re-instantiate isolates frequently, so this
// is bounded and recovers from build-deploy drift within seconds).
// ---------------------------------------------------------------------------

let registryIndexPromise: Promise<RegistryIndex> | null = null;
let hintsIndexPromise: Promise<DiscoveryHintsIndex> | null = null;

async function fetchAssetJson<T>(env: ScoreEnv, path: string): Promise<T> {
  const res = await env.ASSETS.fetch(new Request(`https://assets.internal${path}`));
  if (!res.ok) throw new Error(`asset fetch failed: ${path} (status ${res.status})`);
  return (await res.json()) as T;
}

function loadRegistryIndex(env: ScoreEnv): Promise<RegistryIndex> {
  if (!registryIndexPromise) {
    registryIndexPromise = fetchAssetJson<RegistryIndex>(env, '/registry-index.json').catch((err) => {
      registryIndexPromise = null;
      throw err;
    });
  }
  return registryIndexPromise;
}

function loadHintsIndex(env: ScoreEnv): Promise<DiscoveryHintsIndex> {
  if (!hintsIndexPromise) {
    hintsIndexPromise = fetchAssetJson<DiscoveryHintsIndex>(env, '/discovery-hints-index.json').catch((err) => {
      hintsIndexPromise = null;
      throw err;
    });
  }
  return hintsIndexPromise;
}

/** Test-only — drop in-memory index caches. */
export function _resetIndexCache(): void {
  registryIndexPromise = null;
  hintsIndexPromise = null;
}

// ---------------------------------------------------------------------------
// Telemetry — per-request tier accumulator.
//
// One structured log line per request, scope `score.tier`, captures which
// tier served the response and the pre/post-discovery cache attempt+hit
// flags so operators can later query "what percentage of cache hits came
// from pre vs post discovery?" via the observability binding. NOT exposed
// in the response body — operational signal, not part of the R11 triad
// contract.
//
// `tier` records the resolution branch that produced the response:
//   - `curated`     — registry-fast-path hit
//   - `cache_pre`   — step 2 R2 cache hit (binary derivable from input)
//   - `cache_post`  — step 6.5 R2 cache hit (binary discovered, then re-checked)
//   - `live`        — DO dispatched and returned success
//   - `error_<code>`— terminal error (validation, gate denial, no-resolve, etc.)
//
// The accumulator is mutated as the pipeline progresses; the single log
// line is emitted in a try/finally so every code path reports.
// ---------------------------------------------------------------------------

type Telemetry = {
  tier: string;
  cache_pre_attempted: boolean;
  cache_pre_hit: boolean;
  cache_post_attempted: boolean;
  cache_post_hit: boolean;
  binary: string | null;
  input_kind: string | null;
};

function newTelemetry(): Telemetry {
  return {
    tier: 'unset',
    cache_pre_attempted: false,
    cache_pre_hit: false,
    cache_post_attempted: false,
    cache_post_hit: false,
    binary: null,
    input_kind: null,
  };
}

function emitTelemetry(t: Telemetry): void {
  console.log(
    JSON.stringify({
      scope: 'score.tier',
      tier: t.tier,
      cache_pre_attempted: t.cache_pre_attempted,
      cache_pre_hit: t.cache_pre_hit,
      cache_post_attempted: t.cache_post_attempted,
      cache_post_hit: t.cache_post_hit,
      binary: t.binary,
      input_kind: t.input_kind,
    }),
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const CTA_INSTALL_ANC = CTA.installAnc;

export async function handleScore(request: Request, env: ScoreEnv): Promise<Response> {
  const telemetry = newTelemetry();
  try {
    return await handleScoreInner(request, env, telemetry);
  } finally {
    emitTelemetry(telemetry);
  }
}

async function handleScoreInner(request: Request, env: ScoreEnv, telemetry: Telemetry): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const preference = preferenceForResponse(url.pathname, request);

  if (method !== 'GET' && method !== 'POST') {
    telemetry.tier = 'error_unrecognized_input';
    return shapeWithPreference(
      shapeScoreError({
        code: 'unrecognized_input',
        cta_text: 'Use GET /api/score?input=… or POST /api/score {input}.',
      }),
      preference,
      { status: 405 },
    );
  }

  // 1. Parse + validate input.
  let rawInput: string | null;
  let turnstileToken: string | null = null;
  if (method === 'POST') {
    const parsed = await parsePostBody(request);
    if (!parsed.ok) {
      telemetry.tier = 'error_unrecognized_input';
      return shapeWithPreference(
        shapeScoreError({
          code: 'unrecognized_input',
          cta_text: 'POST body must be JSON {"input": "...", "turnstile_token?": "..."}',
        }),
        preference,
      );
    }
    rawInput = parsed.input;
    turnstileToken = parsed.turnstile_token;
  } else {
    rawInput = url.searchParams.get('input');
  }

  if (!rawInput) {
    telemetry.tier = 'error_unrecognized_input';
    return shapeWithPreference(shapeScoreError({ code: 'unrecognized_input', cta_text: CTA_INSTALL_ANC }), preference);
  }

  const registryIndex = await loadRegistryIndex(env);
  const hintsIndex = await loadHintsIndex(env);

  const validated = validateInput(rawInput, registryIndex);
  if (validated.kind === 'unknown') {
    telemetry.tier = `error_${validated.error}`;
    return shapeWithPreference(shapeScoreError(validationErrorFor(validated.error, rawInput)), preference);
  }
  telemetry.input_kind = validated.kind;

  // 2. Unified scorecard lookup — registry tier first, then R2 cache
  //    tier when the binary is cheaply derivable. Both hit kinds are
  //    unmetered (R6 extended to cached scorecards).
  //
  //    `?fromCache=false` skips the R2 read tier so an operator can
  //    force a fresh registry consult + live run. The cache WRITE
  //    after the live run still fires (so the next request benefits).
  //
  //    Branch-on-github-url SKIPS the curated/cache tiers entirely.
  //    Curated scorecards are scored against release artifacts, NOT
  //    arbitrary branches; serving a curated scorecard for a branch
  //    request would be misleading. The user asked for THIS branch —
  //    respect that and live-score it. The cache write after the live
  //    run is also skipped (the live path passes the branch into the
  //    git clone; caching under the bare binary name would clobber
  //    the default-branch scorecard).
  const skipCache = url.searchParams.get('fromCache') === 'false';
  const isBranchScopedUrl = validated.kind === 'github-url' && typeof validated.branch === 'string';
  // Pre-discovery cache attempt is recorded for any non-branch input
  // that didn't opt out via ?fromCache=false. Whether the attempt
  // results in a hit depends on lookupScorecard's tier-2 path —
  // install-command and hinted github-url paste have a binary upfront
  // and reach the cache read; github-url-without-hint silently skips
  // the R2 read inside lookupScorecard (no binary derivable). We treat
  // "attempted" as the policy intent (we WOULD have looked it up if a
  // binary were available) rather than the wire fact, so the field
  // stays useful for the "what percentage of cache hits came from
  // round-1 vs round-2?" question even when the round-1 read was a
  // structural no-op.
  if (!isBranchScopedUrl && !skipCache) {
    telemetry.cache_pre_attempted = true;
  }
  const lookup = isBranchScopedUrl
    ? ({ kind: 'miss' } as const)
    : await lookupScorecard(validated, env, registryIndex, hintsIndex, {
        specVersion: SPEC_VERSION,
        skipCache,
      });

  if (lookup.kind === 'curated') {
    telemetry.tier = 'curated';
    telemetry.binary = lookup.entry.binary ?? null;
    return shapeWithPreference(
      shapeScoreSuccess(
        {
          kind: 'registry_hit',
          tool: lookup.entry,
          scorecard_url: lookup.scorecard_url,
          // Surface the curated score so the homepage form can render a
          // "Curated · N% pass rate" reward inline before the redirect.
          // null when the registry entry predates the U8+ enrichment
          // (gracefully degrades on the client).
          score_pct: typeof lookup.entry.score_pct === 'number' ? lookup.entry.score_pct : null,
        },
        lookup.anc_version,
        'cache-hit',
      ),
      preference,
    );
  }

  if (lookup.kind === 'cached') {
    telemetry.tier = 'cache_pre';
    telemetry.cache_pre_hit = true;
    const shareUrl = shareUrlForInput(validated, hintsIndex);
    telemetry.binary = shareUrl ? shareUrl.replace(/^\/score\/live\//, '') : null;
    return shapeWithPreference(
      shapeScoreSuccess(lookup.scorecard, lookup.anc_version, 'cache-hit', shareUrl),
      preference,
    );
  }

  // GET requests stop after the read-only tiers: paste-and-share contract.
  if (method === 'GET') {
    telemetry.tier = 'error_chain_no_resolve';
    return shapeWithPreference(shapeScoreError({ code: 'chain_no_resolve', cta_text: CTA_INSTALL_ANC }), preference);
  }

  // 4. Metered gates — kill-switch, Turnstile, rate-limit. These fire
  //    BEFORE any cost-bearing outbound (the GitHub HEAD probe at step 5
  //    and the discovery fan-out at step 6). Discovery alone can issue
  //    5+ parallel HTTPS calls (brew/crates/npm/pypi/go/GitHub Releases/
  //    README); without gates ahead of it, an unauthenticated caller
  //    could fire the fan-out at zero rate-limit cost and burn through
  //    third-party quotas (notably api.github.com's 60/hr unauthenticated
  //    cap, pooled across Cloudflare egress IPs).
  //
  //    The R6 unmetered contract is preserved because curated + cache
  //    hits short-circuit at step 2 — they never reach this block. Only
  //    POSTs that missed both read-only tiers pay these gates.
  //
  //    Gate ordering inside this block is by ascending cost:
  //      a. kill-switch  — KV read with isolate-level cache (cheapest)
  //      b. Turnstile    — external siteverify call (~50-200ms)
  //      c. rate-limit   — bindings call (cheap but mints session first)
  //    A flipped kill switch denies before any external network call,
  //    so a kill-switched Worker can't be used to flood siteverify or
  //    the limiter even at zero score-handler cost.

  // 4a. Kill switch (operator flip).
  if (await isScoringDisabled(env)) {
    telemetry.tier = 'error_scoring_disabled';
    return shapeWithPreference(shapeScoreError({ code: 'scoring_disabled', cta_text: CTA_INSTALL_ANC }), preference);
  }

  // 4b. Turnstile siteverify. Misconfigured env (no secret) is a fail-fast
  // 500 — the route MUST NOT accept POST traffic with the bot-defense
  // layer disabled.
  let verifyResult: Awaited<ReturnType<typeof verifyTurnstile>>;
  try {
    verifyResult = await verifyTurnstile(env, turnstileToken, {
      remoteIp: request.headers.get('cf-connecting-ip') ?? undefined,
    });
  } catch (err) {
    telemetry.tier = 'error_service_misconfigured';
    return shapeWithPreference(serviceMisconfigured(err), preference);
  }

  if (!verifyResult.ok) {
    if (verifyResult.reason === 'misconfigured') {
      telemetry.tier = 'error_service_misconfigured';
      return shapeWithPreference(serviceMisconfigured('TURNSTILE_SECRET missing'), preference);
    }
    telemetry.tier = 'error_turnstile_failed';
    return shapeWithPreference(shapeScoreError({ code: 'turnstile_failed', cta_text: CTA_INSTALL_ANC }), preference);
  }

  // 4c. Session cookie + rate limit. Fresh session is minted on first
  //   passing-Turnstile request; subsequent requests reuse it via cookie.
  let session: { sid: string } | null;
  let setCookie: string | null = null;
  try {
    session = await readSession(env, request);
    if (!session) {
      const fresh = newSession();
      setCookie = await issue(env, fresh);
      session = fresh;
    }
  } catch (err) {
    if (err instanceof SessionConfigError) {
      telemetry.tier = 'error_service_misconfigured';
      return shapeWithPreference(serviceMisconfigured('SESSION_HMAC_SECRET missing'), preference);
    }
    throw err;
  }

  const inputHash = await sha256(rawInput);
  const limiterKey = `${session.sid}:${inputHash}`;

  const limited = await env.SCORE_LIMITER.limit({ key: limiterKey });
  if (!limited.success) {
    telemetry.tier = 'error_rate_limited';
    return shapeWithPreference(
      shapeScoreError({ code: 'rate_limited', retry_after: 60, cta_text: CTA_INSTALL_ANC }),
      preference,
      { setCookie },
    );
  }

  // Coarse per-IP fallback: a session that swaps cookies still gets capped.
  if (env.SCORE_LIMITER_IP) {
    const ipKey = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const ipLimited = await env.SCORE_LIMITER_IP.limit({ key: ipKey });
    if (!ipLimited.success) {
      telemetry.tier = 'error_rate_limited';
      return shapeWithPreference(
        shapeScoreError({ code: 'rate_limited', retry_after: 60, cta_text: CTA_INSTALL_ANC }),
        preference,
        { setCookie },
      );
    }
  }

  // 5. GitHub accessibility pre-check. For github-url inputs without a
  //    hint and without an explicit branch, probe github.com directly
  //    with a HEAD before paying the discovery fan-out (and any
  //    downstream DO cold-start cost). A 404 from github means the repo
  //    is private, deleted, or never existed — discovery can't resolve
  //    a binary regardless. Fast-fail with `github_repo_not_accessible`
  //    so the user sees an honest "we can't see that repo" panel rather
  //    than a generic `chain_no_resolve` after several upstream-API
  //    round-trips.
  //
  //    The probe runs AFTER the metered gates because it's an outbound
  //    HTTPS call, and the gate ordering principle is uniform: every
  //    cost-bearing fetch (HEAD probe, discovery fan-out, DO dispatch)
  //    sits behind the same kill-switch / Turnstile / rate-limit
  //    boundary. The ~50-300ms HEAD is a fast-fail that lives one tier
  //    away from discovery, not pre-gate.
  //
  //    Skip conditions (each is an information-preserving short-circuit):
  //      - non-github-url input (slug / install-command — no repo to probe)
  //      - github-url with explicit branch (the live path clones anyway;
  //        HEAD on the repo root tells us nothing about the branch
  //        existing)
  //      - github-url that resolved to a hint (we already know the
  //        install path; a transient github 404 here shouldn't break a
  //        repo we've explicitly curated install metadata for)
  //
  //    Fail-OPEN on anything other than a clean 404: 5xx, network
  //    timeout, abort all fall through to discovery so a github outage
  //    doesn't silently break scoring. The accessibility module's
  //    in-isolate cache absorbs repeated probes for the same repo.
  if (validated.kind === 'github-url' && !validated.branch) {
    const registryHit = lookupRegistry(validated, registryIndex, hintsIndex);
    if (registryHit.kind !== 'hint') {
      const accessibility = await checkGithubAccessibility(validated.owner, validated.repo);
      if (accessibility.state === 'not_accessible') {
        telemetry.tier = 'error_github_repo_not_accessible';
        return shapeWithPreference(
          shapeScoreError({
            code: 'github_repo_not_accessible',
            cta_text: CTA_INSTALL_ANC,
          }),
          preference,
          { setCookie },
        );
      }
    }
  }

  // 6. Resolve InstallSpec. Pre-2026-05-20 this happened inside the DO;
  //    moving it to the Worker means a `chain_no_resolve` paste (e.g.
  //    brettdavies/dotfiles) bounces here in ~200 ms instead of spinning
  //    up a container to discover the same fact. The brew/go fallbacks
  //    live here too — they share the discovery chain's fetcher, so a
  //    single `globalThis.fetch` covers every outbound this step makes
  //    (tests inject via globalThis.fetch on the request boundary;
  //    production runs on Cloudflare's fetch).
  //
  //    Failure here exits the pipeline AFTER the metered gates have
  //    already cleared. The discovery fan-out is the most expensive
  //    cost-bearing operation on the live path (~5 parallel registry
  //    calls + GitHub Releases) and the gates exist precisely to keep
  //    unauthenticated traffic from firing it. A no-resolve still ate
  //    one rate-limit slot and one Turnstile siteverify — that's the
  //    designed behavior, not a leak.
  const resolution = await resolveSpec(validated, hintsIndex);
  if (!resolution.ok) {
    telemetry.tier = `error_${resolution.error}`;
    return shapeWithPreference(resolutionErrorToResponse(resolution.error, resolution.details), preference, {
      setCookie,
    });
  }
  const spec = resolution.spec;
  telemetry.binary = spec.binary;

  // 6.5. Post-discovery cache lookup. Discovery now knows `spec.binary`,
  //      which the step-2 pre-discovery check couldn't derive for
  //      github-url-without-hint inputs. Re-check the cache with the
  //      resolved binary before paying the DO container cost.
  //
  //      Same cache binding, same key shape as step 2 — readers and
  //      writers can't drift. A hit here is wire-indistinguishable from
  //      a step-2 hit (same `freshness: 'cache-hit'`, same Cache-Control
  //      `public, max-age=300`); both bypass the DO.
  //
  //      Skip conditions:
  //        - `spec.pm === 'git-clone'`: branch-scoped scores aren't
  //          cached (no share_url, ephemeral). Caching under the bare
  //          binary name would clobber the default-branch scorecard,
  //          so the live path skips the write too and this read has
  //          nothing meaningful to consult.
  //        - `skipCache` (?fromCache=false): the operator escape hatch
  //          is documented as "do not consult any cache, force a live
  //          run" — applies uniformly to both round-1 and round-2.
  //
  //      Telemetry: `cache_post_attempted` records whether we issued
  //      the R2 read; `cache_post_hit` flips when the read returned a
  //      payload. The combination lets us separate "we tried and the
  //      cache was empty" from "we never tried" for hit-rate analysis.
  if (spec.pm !== 'git-clone' && !skipCache) {
    telemetry.cache_post_attempted = true;
    const cached = await cache.get(env, cache.keyFor(spec.binary, SPEC_VERSION));
    if (cached) {
      telemetry.cache_post_hit = true;
      telemetry.tier = 'cache_post';
      const shareUrl = shareUrlForInput(validated, hintsIndex);
      return shapeWithPreference(
        shapeScoreSuccess(cached.scorecard, cached.anc_version, 'cache-hit', shareUrl),
        preference,
        { setCookie },
      );
    }
  }

  // 7. DO call — the DO now receives a resolved InstallSpec rather than
  //    a raw ValidatedInput. The contract narrowed in the 2026-05-20
  //    discovery-move; do.ts no longer fans out to the discovery chain
  //    or runs brew/go fallbacks (those happen at step 6 above). The DO
  //    returns either `{scorecard, anc_version}` on success or
  //    `{error, details?}` on failure, mapped below into the typed
  //    ScoreError union. The DO still writes successful scorecards to
  //    SCORE_CACHE itself (U7), so the next request for the same binary
  //    short-circuits at step 2's cache tier.
  //
  // Pool of MAX_INSTANCES DO instances via getRandom (plan U6
  // K-decision). Each request picks a random instance — parallel load
  // spreads across the pool instead of queuing serially behind a
  // single container session. Critical for Show HN spike absorption
  // (singleton bottlenecked at one exec at a time inside the SDK
  // session, observed 2026-05-18; cold-start + parallel queue =
  // cascading 60s timeouts).
  //
  // getRandom (from @cloudflare/containers) calls
  // `binding.idFromName('instance-${0..N-1}')` + `binding.get(id)`. IDs
  // are stable across requests so the same instance reuses its warm
  // container session for subsequent requests routed to it.
  const stub = (await getRandom(
    env.SCORE as unknown as DurableObjectNamespace<Container>,
    MAX_INSTANCES,
  )) as DurableObjectStub;
  const doRes = await stub.fetch(
    new Request('https://do.internal/score', {
      method: 'POST',
      body: JSON.stringify({ spec, hash: inputHash }),
      headers: { 'content-type': 'application/json' },
    }),
  );

  let doPayload: unknown;
  try {
    doPayload = await doRes.json();
  } catch {
    telemetry.tier = 'error_incomplete_response_contract';
    return shapeWithPreference(
      shapeScoreError({
        code: 'incomplete_response_contract',
        details: 'DO returned non-JSON',
        cta_text: CTA_INSTALL_ANC,
      }),
      preference,
      { setCookie },
    );
  }

  // Defense-in-depth: if the binding ever points back at the U3 stub
  // (botched rollback, misconfigured wrangler.jsonc) the user gets a
  // typed 503 instead of a raw stub error envelope.
  if (isStubError(doPayload)) {
    telemetry.tier = 'error_sandbox_stub_until_u6';
    return shapeWithPreference(
      shapeScoreError({ code: 'sandbox_stub_until_u6', cta_text: CTA_INSTALL_ANC }),
      preference,
      { setCookie },
    );
  }

  if (isDoError(doPayload)) {
    telemetry.tier = `error_${doPayload.error}`;
    return shapeWithPreference(mapDoError(doPayload), preference, { setCookie });
  }

  if (isDoSuccess(doPayload)) {
    telemetry.tier = 'live';
    const shareUrl = shareUrlForInput(validated, hintsIndex);
    return shapeWithPreference(
      shapeScoreSuccess(doPayload.scorecard, doPayload.anc_version, 'live', shareUrl),
      preference,
      { setCookie },
    );
  }

  // DO returned 2xx but with an unrecognized envelope shape. Fail loud
  // per R11 rather than synthesize a partial success.
  telemetry.tier = 'error_incomplete_response_contract';
  return shapeWithPreference(
    shapeScoreError({
      code: 'incomplete_response_contract',
      details: 'DO returned unrecognized envelope shape',
      cta_text: CTA_INSTALL_ANC,
    }),
    preference,
    { setCookie },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PostBody = { ok: true; input: string; turnstile_token: string | null } | { ok: false };

async function parsePostBody(request: Request): Promise<PostBody> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false };
  }
  if (!body || typeof body !== 'object') return { ok: false };
  const obj = body as Record<string, unknown>;
  const input = typeof obj.input === 'string' ? obj.input : null;
  const token = typeof obj.turnstile_token === 'string' ? obj.turnstile_token : null;
  if (!input) return { ok: false };
  return { ok: true, input, turnstile_token: token };
}

function preferenceForResponse(pathname: string, request: Request): 'json' | 'markdown' {
  if (pathname.endsWith('.json')) return 'json';
  if (pathname.endsWith('.md')) return 'markdown';
  return detectScorePreference(request);
}

function shapeWithPreference(
  jsonResponse: Response,
  preference: 'json' | 'markdown',
  opts: { status?: number; setCookie?: string | null } = {},
): Response {
  const status = opts.status ?? jsonResponse.status;
  const headers = new Headers(jsonResponse.headers);
  if (opts.setCookie) headers.append('Set-Cookie', opts.setCookie);

  if (preference === 'json') {
    return new Response(jsonResponse.body, { status, headers });
  }

  // Minimal markdown rendering — U8 may polish, but U5 honors the
  // content-negotiation contract today.
  // Reading the body twice for markdown rendering: clone the response.
  return renderMarkdownVariant(jsonResponse, status, headers);
}

async function renderMarkdownVariantAsync(
  jsonResponse: Response,
  status: number,
  baseHeaders: Headers,
): Promise<Response> {
  const payload = (await jsonResponse.json()) as Record<string, unknown>;
  const md = renderJsonAsMarkdown(payload);
  const headers = new Headers(baseHeaders);
  headers.set('Content-Type', 'text/markdown; charset=utf-8');
  return new Response(md, { status, headers });
}

function renderMarkdownVariant(jsonResponse: Response, status: number, baseHeaders: Headers): Response {
  return new Response(
    new ReadableStream({
      async start(controller) {
        const md = await renderMarkdownVariantAsync(jsonResponse.clone(), status, baseHeaders).then((r) => r.text());
        controller.enqueue(new TextEncoder().encode(md));
        controller.close();
      },
    }),
    { status, headers: markdownHeaders(baseHeaders) },
  );
}

function markdownHeaders(base: Headers): Headers {
  const headers = new Headers(base);
  headers.set('Content-Type', 'text/markdown; charset=utf-8');
  return headers;
}

function renderJsonAsMarkdown(payload: Record<string, unknown>): string {
  const triad = [
    `**spec_version:** ${String(payload.spec_version ?? 'unknown')}`,
    `**checker_url:** ${String(payload.checker_url ?? CHECKER_URL)}`,
  ];
  if (payload.error) {
    const err = payload.error as { code: string; details?: string; cta_text?: string };
    return [
      '# anc.dev — score request rejected',
      '',
      `**error:** \`${err.code}\``,
      err.details ? `**details:** ${err.details}` : null,
      ...triad,
      '',
      err.cta_text ?? CTA_INSTALL_ANC,
      '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const scorecard = payload.scorecard as
    | { kind?: string; scorecard_url?: string; tool?: { name?: string } }
    | undefined;
  if (scorecard?.kind === 'registry_hit') {
    return [
      `# anc.dev — ${scorecard.tool?.name ?? 'tool'} (registry hit)`,
      '',
      `Scorecard: ${scorecard.scorecard_url}`,
      ...triad,
      '',
    ].join('\n');
  }
  return ['# anc.dev — score response', '', '```json', JSON.stringify(payload, null, 2), '```', ''].join('\n');
}

function isStubError(payload: unknown): boolean {
  return (
    typeof payload === 'object' && payload !== null && (payload as { error?: string }).error === 'sandbox_stub_until_u6'
  );
}

// ---------------------------------------------------------------------------
// DO response envelope type guards + error mapping (U6 contract).
//
// The DO returns one of two shapes after install + score:
//   success:  { scorecard: <anc JSON envelope>, anc_version: '0.3.1' }
//   failure:  { error: '<ScoreErrorCode>', details?: '<string>' }
//
// The handler narrows on the envelope shape, then maps DO error codes to
// user-facing ScoreError variants. Codes the DO knows about but the user
// envelope doesn't (anc_check_failed, anc_version_unreadable) collapse to
// incomplete_response_contract so R11's hard-gate semantics hold.

function isDoSuccess(payload: unknown): payload is { scorecard: unknown; anc_version: string } {
  if (typeof payload !== 'object' || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  return 'scorecard' in obj && typeof obj.anc_version === 'string';
}

function isDoError(payload: unknown): payload is { error: string; details?: string } {
  if (typeof payload !== 'object' || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  return typeof obj.error === 'string';
}

// Translate a `resolveSpec()` failure into a shaped ScoreError response.
// Worker-side resolution can fail in three ways: no spec discoverable
// (chain_no_resolve), an unsupported PM after fallback (install_unsupported
// pm=brew_only / pm=go_no_binary), or a branch-shape that bypassed
// validate.ts somehow (invalid_url_path — defense in depth). The pm
// extraction here mirrors mapDoError() so the user-facing error envelope
// shape is identical regardless of which tier produced the bounce.
function resolutionErrorToResponse(
  error: 'chain_no_resolve' | 'install_unsupported' | 'invalid_url_path',
  details?: string,
): Response {
  if (error === 'chain_no_resolve') {
    return shapeScoreError({ code: 'chain_no_resolve', cta_text: CTA_INSTALL_ANC });
  }
  if (error === 'invalid_url_path') {
    return shapeScoreError({
      code: 'invalid_url_path',
      cta_text: 'Paste the repo root URL (e.g. https://github.com/owner/repo), not a branch or release link.',
    });
  }
  // install_unsupported — extract pm from `details` (e.g. `pm=brew_only`).
  // Worker-side resolveSpec only emits brew_only and go_no_binary today;
  // any other pm collapses to a generic chain_resolved_install_failed so
  // the user-facing envelope doesn't claim a pm we can't classify.
  const pm = details?.match(/^pm=(\w+)/)?.[1];
  if (pm === 'brew_only' || pm === 'brew' || pm === 'bun' || pm === 'go_no_binary') {
    return shapeScoreError({ code: 'install_unsupported', pm, cta_text: CTA_INSTALL_ANC });
  }
  return shapeScoreError({
    code: 'chain_resolved_install_failed',
    details: details ?? '',
    cta_text: CTA_INSTALL_ANC,
  });
}

function mapDoError(payload: { error: string; details?: string }): Response {
  const details = payload.details ?? '';
  switch (payload.error) {
    case 'chain_no_resolve':
      return shapeScoreError({ code: 'chain_no_resolve', cta_text: CTA_INSTALL_ANC });
    case 'chain_resolved_install_failed':
      return shapeScoreError({ code: 'chain_resolved_install_failed', details, cta_text: CTA_INSTALL_ANC });
    case 'chain_resolved_no_binary_produced':
      return shapeScoreError({ code: 'chain_resolved_no_binary_produced', details, cta_text: CTA_INSTALL_ANC });
    case 'install_unsupported': {
      // DO emits details like `pm=brew_only` or `pm=bun`. ScoreError.pm is a
      // closed union over the PMs the user-facing error envelope knows
      // about. After the 2026-05-18 rework: 'brew_only' (brew formula
      // exists but has no alternative PM via the discovery fallback),
      // 'brew' (legacy code path kept for safety — should be unreachable
      // post-rework but still maps to a sensible variant if emitted),
      // and 'bun' (kept for safety; bun is now installable so this
      // branch should also be unreachable). Any other pm bouncing here
      // collapses to chain_resolved_install_failed so we don't lie
      // about which surface is broken.
      const pm = details.match(/^pm=(\w+)/)?.[1];
      if (pm === 'brew_only' || pm === 'brew' || pm === 'bun' || pm === 'go_no_binary') {
        return shapeScoreError({ code: 'install_unsupported', pm, cta_text: CTA_INSTALL_ANC });
      }
      return shapeScoreError({ code: 'chain_resolved_install_failed', details, cta_text: CTA_INSTALL_ANC });
    }
    case 'timeout':
      // DO doesn't differentiate install-phase vs score-phase timeout
      // (the 60 s budget covers both). Defaulting to 'score' matches the
      // common case: install completes quickly, anc check is the long pole.
      return shapeScoreError({ code: 'timeout', phase: 'score', cta_text: CTA_INSTALL_ANC });
    default:
      // anc_check_failed / anc_version_unreadable / setOutboundHandler
      // failures land here. R11 demands the response triad; if we can't
      // deliver scorecard + anc_version, surface the contract gap loudly
      // rather than synthesize a partial.
      return shapeScoreError({
        code: 'incomplete_response_contract',
        details: `${payload.error}${details ? `: ${details.slice(0, 160)}` : ''}`,
        cta_text: CTA_INSTALL_ANC,
      });
  }
}

function validationErrorFor(
  code: ValidatedInput & { kind: 'unknown' } extends infer T ? (T extends { error: infer E } ? E : never) : never,
  raw: string,
): ScoreError {
  switch (code) {
    case 'invalid_url':
      return { code: 'invalid_url', details: raw.slice(0, 200), cta_text: CTA_INSTALL_ANC };
    case 'non_https_url':
      return { code: 'non_https_url', cta_text: 'Use https:// — http:// is not allowed.' };
    case 'non_github_host':
      return { code: 'non_github_host', cta_text: 'anc.dev only scores public GitHub repos.' };
    case 'invalid_url_path':
      return {
        code: 'invalid_url_path',
        cta_text: 'Paste the repo root URL (e.g. https://github.com/owner/repo), not a branch or release link.',
      };
    case 'unparseable_install_command':
      return {
        code: 'unparseable_install_command',
        details: raw.slice(0, 200),
        cta_text: CTA_INSTALL_ANC,
      };
    default:
      return { code: 'unrecognized_input', cta_text: CTA_INSTALL_ANC };
  }
}

function serviceMisconfigured(err: unknown): Response {
  const details = err instanceof Error ? err.message : String(err);
  return shapeScoreError({ code: 'service_misconfigured', details, cta_text: CTA_INSTALL_ANC });
}

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build the shareable HTML URL for an inline-scorecard response. Reads the
 * cache-tier binary derivation from registry-lookup so the share URL and
 * the cache key the DO writes to stay in lockstep. The `/score/live/`
 * prefix nests under the existing `/score/<tool>` curated namespace; the
 * string "live" is reserved in the registry (scorecards.mjs) so no
 * curated tool can collide.
 *
 * Returns null when the binary isn't derivable upfront (github-url without
 * a hint). In that case the JSON response ships without `share_url`; the
 * user still has the scorecard inline and can re-paste to re-score.
 */
function shareUrlForInput(input: ValidatedInput, hintsIndex: DiscoveryHintsIndex): string | null {
  const binary = deriveShareBinary(input, hintsIndex);
  return binary ? `/score/live/${binary}` : null;
}

// Statically referenced so `_unused` linters see these as live exports —
// the type-narrowing utility for the validation switch.
void statusForError;
void SPEC_VERSION;
void TurnstileConfigError;
