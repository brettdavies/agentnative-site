// /api/score request handler — orchestrates the live-scoring pipeline.
//
// Pipeline (post 2026-05-20 gates-before-discovery reorder):
//
//   1. Validate input.
//   2. Unified scorecard lookup — pre-discovery. One call to
//      lookupOnly() collapses the registry-fast-path and the R2
//      cache pre-check into a single tier-resolved decision. `curated`
//      returns the registry-hit envelope pointing at /score/<slug>;
//      `cached` returns the inline scorecard JSON; both bypass the
//      metered gates (kill-switch, Turnstile, rate-limit, DO) — cached
//      scorecards are functionally identical to curated ones (no
//      sandbox cost). `miss` falls through to the live path.
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

import { detectScorePreference } from '../accept';
import { AUDITOR_URL, SPEC_VERSION } from '../spec-version.gen';
import type { CacheEnv } from './cache';
import type { InstallSpec, ResolvedStep } from './discover-binary';
import { checkGithubAccessibility } from './github-accessibility';
import { isScoringDisabled, type KillSwitchEnv } from './kill-switch';
import { _resetHintsIndexCache, loadHintsIndex, lookupOnly, runFreshOnly } from './orchestrate';
import {
  _resetRegistryIndexCache,
  type DiscoveryHintsIndex,
  deriveShareBinary,
  deriveShareBinaryFromSpec,
  loadRegistryIndex,
  lookupRegistry,
} from './registry-lookup';
import { CTA, type ScoreError, shapeScoreError, shapeScoreSuccess, statusForError } from './response-shape';
import { issue, newSession, read as readSession, SessionConfigError, type SessionEnv } from './session';
import {
  type FreshnessTag,
  type InputKindTag,
  type PmTag,
  recordScoreEvent,
  type ScoreEventFields,
  type ScoreTelemetryEnv,
} from './telemetry';
import { TurnstileConfigError, type TurnstileEnv, verifyTurnstile } from './turnstile';
import { type ValidatedInput, validateInput } from './validate';

// ---------------------------------------------------------------------------
// Env contract
// ---------------------------------------------------------------------------

export type ScoreEnv = KillSwitchEnv &
  SessionEnv &
  TurnstileEnv &
  CacheEnv &
  ScoreTelemetryEnv & {
    ASSETS: Fetcher;
    // Optional because a mid-rollback Worker (between v2-drop-sandbox
    // and v3-restore-sandbox) deploys cleanly without the SCORE binding.
    // runFreshOnly returns kind 'sandbox_unavailable' when SCORE is
    // missing; without the binding-presence guard the SDK throws on the
    // undefined namespace and surfaces as Cloudflare error 1101.
    SCORE?: DurableObjectNamespace;
    SCORE_LIMITER: RateLimit;
    SCORE_LIMITER_IP?: RateLimit;
  };

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

// ---------------------------------------------------------------------------
// Hints index loading. Both the registry-index loader (registry-lookup.ts)
// and the discovery-hints loader (orchestrate.ts) live outside handler.ts
// so /api/score and the MCP get_scorecard tool share one isolate-level
// cache for each index. The orchestrate.ts loader was lifted out of this
// file in U3 of the MCP endpoint plan.
// ---------------------------------------------------------------------------

/** Test-only — drop in-memory index caches. */
export function _resetIndexCache(): void {
  _resetRegistryIndexCache();
  _resetHintsIndexCache();
}

// ---------------------------------------------------------------------------
// Telemetry — per-request tier accumulator.
//
// One structured log line per request, scope `score.tier`, captures which
// tier served the response and the pre/post-discovery cache attempt+hit
// flags so operators can later query "what percentage of cache hits came
// from pre vs post discovery?" via the observability binding. NOT exposed
// in the response body — operational signal, not part of the
// spec_version + anc_version + auditor_url response contract.
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
  // U10 Analytics Engine fields — see telemetry.ts for the blob/double
  // slot map. Captured here as the pipeline advances; folded into a
  // single writeDataPoint call in handleScore's finally block.
  pm: PmTag | null;
  freshness: FreshnessTag | null;
  resolved_step: ResolvedStep | 'registry' | null;
  install_ms: number | null;
  anc_audit_ms: number | null;
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
    pm: null,
    freshness: null,
    resolved_step: null,
    install_ms: null,
    anc_audit_ms: null,
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

// Map the in-handler Telemetry shape into the AE writeDataPoint
// payload. Pure function so the telemetry-regression test can pin
// every slot's derivation. blob1 maps ValidatedInput.kind ('slug' |
// 'install-command' | 'github-url' | 'unknown') onto the AE input-
// kind union — 'slug' becomes 'registry' because validate.ts only
// emits 'slug' for inputs that matched the by_slug index. Error
// codes are derived by stripping the `error_` prefix the in-handler
// tier string carries; non-error tiers (curated / cache_pre /
// cache_post / live / unset) return null in blob3.
function buildScoreEventFields(t: Telemetry, totalMs: number, status: number): ScoreEventFields {
  const errorCode = t.tier.startsWith('error_') ? (t.tier.slice('error_'.length) as ScoreError['code']) : null;
  return {
    input_kind: mapInputKind(t.input_kind),
    pm: t.pm,
    error_code: errorCode,
    freshness: t.freshness,
    resolved_step: t.resolved_step,
    total_ms: totalMs,
    install_ms: t.install_ms,
    anc_audit_ms: t.anc_audit_ms,
    response_status: status,
    tool: t.binary,
  };
}

function mapInputKind(kind: string | null): InputKindTag | null {
  switch (kind) {
    case 'slug':
      return 'registry';
    case 'install-command':
      return 'install-command';
    case 'github-url':
      return 'github-url';
    case 'unknown':
      return 'invalid';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const CTA_INSTALL_ANC = CTA.installAnc;

export async function handleScore(request: Request, env: ScoreEnv): Promise<Response> {
  const telemetry = newTelemetry();
  const start = Date.now();
  let response: Response | undefined;
  try {
    response = await handleScoreInner(request, env, telemetry);
    return response;
  } finally {
    const totalMs = Date.now() - start;
    // Response missing means handleScoreInner threw — treat as 500 for
    // the AE row so the error-code distribution still sees the
    // unhandled-exception class as 5xx rather than a missing value.
    const status = response?.status ?? 500;
    emitTelemetry(telemetry);
    recordScoreEvent(env, buildScoreEventFields(telemetry, totalMs, status));
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
  // Set input_kind before the early-return so AE blob1 records `invalid`
  // for validation rejects rather than leaving the field null.
  telemetry.input_kind = validated.kind;
  if (validated.kind === 'unknown') {
    telemetry.tier = `error_${validated.error}`;
    return shapeWithPreference(shapeScoreError(validationErrorFor(validated.error, rawInput)), preference);
  }

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
  // results in a hit depends on lookupOnly's tier-2 path —
  // install-command and hinted github-url paste have a binary upfront
  // and reach the cache read; github-url-without-hint silently skips
  // the R2 read inside lookupOnly (no binary derivable). We treat
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
    : await lookupOnly(validated, env, registryIndex, hintsIndex, {
        specVersion: SPEC_VERSION,
        skipCache,
      });

  if (lookup.kind === 'curated') {
    telemetry.tier = 'curated';
    telemetry.binary = lookup.entry.binary ?? null;
    telemetry.freshness = 'registry-hit';
    telemetry.resolved_step = 'registry';
    return shapeWithPreference(
      shapeScoreSuccess(
        {
          kind: 'registry_hit',
          tool: lookup.entry,
          scorecard_url: lookup.scorecard_url,
          // Surface the curated score so the homepage form can render a
          // "Curated · N% pass rate" reward inline before the redirect.
          // null when the registry entry predates the score_pct
          // enrichment (gracefully degrades on the client).
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
    telemetry.freshness = 'cache-hit';
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

  // 6 + 6.5 + 7. Resolve InstallSpec, consult the post-discovery cache,
  //    dispatch to the Sandbox DO. The orchestrator at `./orchestrate`
  //    owns this slice and is shared with the MCP score_cli tool so
  //    /api/score and the MCP form compose the same cache + DO pipeline.
  //    AGENTS.md line 104's symmetry contract ("the two tools compose
  //    the same /api/score orchestration core, so cache semantics never
  //    drift between MCP and the human form on /") is enforced by
  //    structure here, not by convention.
  //
  //    Per-variant telemetry mutation happens INSIDE each switch arm
  //    BEFORE the response is constructed so the outer try/finally in
  //    handleScore sees the final state when it emits the AE row. Every
  //    arm where resolveSpec succeeded (every kind other than
  //    'resolution_error') sets four spec-derived telemetry fields
  //    uniformly:
  //      - binary, pm, resolved_step from the resolved InstallSpec
  //      - cache_post_attempted = spec.pm !== 'git-clone' && !skipCache
  //    This preserves byte-identical Analytics Engine row attribution
  //    across success and DO-failure paths so the operator query "which
  //    tools hit sandbox errors most often?" keeps working post-refactor.
  const result = await runFreshOnly(validated, env, hintsIndex, {
    specVersion: SPEC_VERSION,
    inputHash,
    skipCachePost: skipCache,
  });

  const applySpecTelemetry = (spec: InstallSpec | undefined, resolved_step: ResolvedStep | null | undefined): void => {
    if (!spec) return;
    telemetry.binary = spec.binary;
    telemetry.pm = spec.pm;
    telemetry.resolved_step = resolved_step ?? null;
    telemetry.cache_post_attempted = spec.pm !== 'git-clone' && !skipCache;
  };

  switch (result.kind) {
    case 'cache_post_hit': {
      applySpecTelemetry(result.spec, result.resolved_step);
      telemetry.cache_post_hit = true;
      telemetry.tier = 'cache_post';
      telemetry.freshness = 'cache-hit';
      return shapeWithPreference(
        shapeScoreSuccess(result.scorecard, result.anc_version, 'cache-hit', shareUrlForSpec(result.spec)),
        preference,
        { setCookie },
      );
    }
    case 'fresh': {
      applySpecTelemetry(result.spec, result.resolved_step);
      telemetry.tier = 'live';
      telemetry.freshness = 'live';
      telemetry.install_ms = result.install_ms;
      telemetry.anc_audit_ms = result.anc_audit_ms;
      return shapeWithPreference(
        shapeScoreSuccess(result.scorecard, result.anc_version, 'live', shareUrlForSpec(result.spec)),
        preference,
        { setCookie },
      );
    }
    case 'resolution_error': {
      telemetry.tier = `error_${result.error}`;
      return shapeWithPreference(resolutionErrorToResponse(result.error, result.details), preference, { setCookie });
    }
    case 'sandbox_unavailable': {
      applySpecTelemetry(result.spec, result.resolved_step);
      telemetry.tier = 'error_sandbox_unavailable';
      return shapeWithPreference(
        shapeScoreError({ code: 'sandbox_unavailable', cta_text: CTA_INSTALL_ANC }),
        preference,
        { setCookie },
      );
    }
    case 'sandbox_stub_until_u6': {
      applySpecTelemetry(result.spec, result.resolved_step);
      telemetry.tier = 'error_sandbox_stub_until_u6';
      return shapeWithPreference(
        shapeScoreError({ code: 'sandbox_stub_until_u6', cta_text: CTA_INSTALL_ANC }),
        preference,
        { setCookie },
      );
    }
    case 'do_error': {
      applySpecTelemetry(result.spec, result.resolved_step);
      telemetry.tier = `error_${result.error}`;
      return shapeWithPreference(mapDoError({ error: result.error, details: result.details }), preference, {
        setCookie,
      });
    }
    case 'incomplete_response_contract': {
      applySpecTelemetry(result.spec, result.resolved_step);
      telemetry.tier = 'error_incomplete_response_contract';
      const details =
        result.reason === 'non_json_body' ? 'DO returned non-JSON' : 'DO returned unrecognized envelope shape';
      return shapeWithPreference(
        shapeScoreError({ code: 'incomplete_response_contract', details, cta_text: CTA_INSTALL_ANC }),
        preference,
        { setCookie },
      );
    }
  }
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

  // Minimal markdown rendering — honors the content-negotiation
  // contract; deeper polish lives in summary-render.ts.
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
    `**auditor_url:** ${String(payload.auditor_url ?? AUDITOR_URL)}`,
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

// ---------------------------------------------------------------------------
// DO error mapping.
//
// runFreshOnly classifies the DO envelope (success / sandbox_stub /
// do_error / incomplete_response_contract) inside the orchestrator;
// the handler receives a discriminated union and only owns the user-
// facing error envelope mapping below. mapDoError translates the DO
// error code into the typed ScoreError union the user-facing response
// shape exposes. Codes the DO knows about but the user envelope
// doesn't (anc_audit_failed, anc_version_unreadable) collapse to
// incomplete_response_contract so the hard-gate semantics on the
// response triad hold.

// Translate a resolveSpec failure into a shaped ScoreError response.
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
      // common case: install completes quickly, anc audit is the long pole.
      return shapeScoreError({ code: 'timeout', phase: 'score', cta_text: CTA_INSTALL_ANC });
    default:
      // anc_audit_failed / anc_version_unreadable / setOutboundHandler
      // failures land here. If we can't deliver scorecard + anc_version,
      // surface the contract gap loudly rather than synthesize a partial:
      // a missing-field response shape would leak into the cache and
      // poison subsequent reads.
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
 * Build the shareable HTML URL for an inline-scorecard response BEFORE
 * discovery has run. Used by the pre-discovery cache-hit branch (step 2,
 * `lookup.kind === 'cached'`), where only the input-derived binary
 * (install-command spec or hinted github-url) is known. The `/score/live/`
 * prefix nests under the existing `/score/<tool>` curated namespace; the
 * string "live" is reserved in the registry (scorecards.mjs) so no
 * curated tool can collide.
 *
 * Returns null for github-url-without-hint inputs (no upfront binary;
 * `shareUrlForSpec` handles those after discovery) and for branch-scoped
 * pastes (no shareable surface by design).
 */
function shareUrlForInput(input: ValidatedInput, hintsIndex: DiscoveryHintsIndex): string | null {
  const binary = deriveShareBinary(input, hintsIndex);
  return binary ? `/score/live/${binary}` : null;
}

/**
 * Build the shareable HTML URL once discovery has resolved an `InstallSpec`.
 * Used by the post-discovery cache-hit branch (step 6.5) and the live-success
 * branch (DO returned a scorecard) so github-url-without-hint inputs still
 * get a `share_url` keyed by the discovered binary. The derivation uses the
 * same value the DO writes the R2 cache under, so the share URL and the
 * /score/live/<binary> read path stay in lockstep.
 *
 * Returns null for branch-scoped (git-clone) specs and for any binary that
 * fails the public slug regex — see `deriveShareBinaryFromSpec` for the
 * rationale.
 */
function shareUrlForSpec(spec: import('./discover-binary').InstallSpec): string | null {
  const binary = deriveShareBinaryFromSpec(spec);
  return binary ? `/score/live/${binary}` : null;
}

// Statically referenced so `_unused` linters see these as live exports —
// the type-narrowing utility for the validation switch.
void statusForError;
void SPEC_VERSION;
void TurnstileConfigError;
