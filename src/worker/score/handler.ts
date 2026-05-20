// /api/score request handler — orchestrates the live-scoring pipeline.
//
// Plan U5 + U7 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md
// "U5 Approach", "U7 Approach"):
//
//   1. Validate input (U4).
//   2. Unified scorecard lookup (U7). One call to lookupScorecard()
//      collapses the registry-fast-path and the R2 cache fallback into
//      a single tier-resolved decision. `curated` returns the
//      registry-hit envelope pointing at /score/<slug>; `cached` returns
//      the inline scorecard JSON; both bypass the metered gates
//      (kill-switch, Turnstile, rate-limit, DO) per R6 — cached
//      scorecards are functionally identical to curated ones (no
//      sandbox cost). `miss` falls through to the live path.
//   3. GET requests stop after step 2: GET is the paste-and-share /
//      bookmark read-only contract. A miss returns 404 chain_no_resolve.
//   4. Kill switch (`scoring_disabled` in SCORE_KV) — 503 + Retry-After.
//   5. Turnstile siteverify (POST only) — 400 turnstile_failed on miss.
//   6. Rate limit on `<session-id>:<sha256(input)>` (SCORE_LIMITER) and a
//      coarse per-IP fallback (SCORE_LIMITER_IP). 429 with Retry-After.
//   7. DO call — U6 owns the install + score flow. On success the DO
//      writes to SCORE_CACHE itself (do.ts), so the next request for the
//      same binary short-circuits at step 2's cache tier.
//
// `?fromCache=false` operator escape hatch: skips the R2 read tier (step
// 2 cache fallback) but still consults the curated registry AND still
// writes to the cache after a live run. Useful when "did the registry
// version just update?" needs an authoritative re-score.
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
import { checkGithubAccessibility } from './github-accessibility';
import { isScoringDisabled, type KillSwitchEnv } from './kill-switch';
import {
  type DiscoveryHintsIndex,
  deriveShareBinary,
  lookupRegistry,
  lookupScorecard,
  type RegistryIndex,
} from './registry-lookup';
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
// Handler
// ---------------------------------------------------------------------------

const CTA_INSTALL_ANC = CTA.installAnc;

export async function handleScore(request: Request, env: ScoreEnv): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const preference = preferenceForResponse(url.pathname, request);

  if (method !== 'GET' && method !== 'POST') {
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
    return shapeWithPreference(shapeScoreError({ code: 'unrecognized_input', cta_text: CTA_INSTALL_ANC }), preference);
  }

  const registryIndex = await loadRegistryIndex(env);
  const hintsIndex = await loadHintsIndex(env);

  const validated = validateInput(rawInput, registryIndex);
  if (validated.kind === 'unknown') {
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
  const lookup = isBranchScopedUrl
    ? ({ kind: 'miss' } as const)
    : await lookupScorecard(validated, env, registryIndex, hintsIndex, {
        specVersion: SPEC_VERSION,
        skipCache,
      });

  if (lookup.kind === 'curated') {
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
    const shareUrl = shareUrlForInput(validated, hintsIndex);
    return shapeWithPreference(
      shapeScoreSuccess(lookup.scorecard, lookup.anc_version, 'cache-hit', shareUrl),
      preference,
    );
  }

  // GET requests stop after the read-only tiers: paste-and-share contract.
  if (method === 'GET') {
    return shapeWithPreference(shapeScoreError({ code: 'chain_no_resolve', cta_text: CTA_INSTALL_ANC }), preference);
  }

  // 3. Kill switch (operator flip).
  if (await isScoringDisabled(env)) {
    return shapeWithPreference(shapeScoreError({ code: 'scoring_disabled', cta_text: CTA_INSTALL_ANC }), preference);
  }

  // 4. Turnstile siteverify. Misconfigured env (no secret) is a fail-fast
  // 500 — the route MUST NOT accept POST traffic with the bot-defense
  // layer disabled.
  let verifyResult: Awaited<ReturnType<typeof verifyTurnstile>>;
  try {
    verifyResult = await verifyTurnstile(env, turnstileToken, {
      remoteIp: request.headers.get('cf-connecting-ip') ?? undefined,
    });
  } catch (err) {
    return shapeWithPreference(serviceMisconfigured(err), preference);
  }

  if (!verifyResult.ok) {
    if (verifyResult.reason === 'misconfigured') {
      return shapeWithPreference(serviceMisconfigured('TURNSTILE_SECRET missing'), preference);
    }
    return shapeWithPreference(shapeScoreError({ code: 'turnstile_failed', cta_text: CTA_INSTALL_ANC }), preference);
  }

  // 5. Session cookie + rate limit. Fresh session is minted on first
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
      return shapeWithPreference(serviceMisconfigured('SESSION_HMAC_SECRET missing'), preference);
    }
    throw err;
  }

  const inputHash = await sha256(rawInput);
  const limiterKey = `${session.sid}:${inputHash}`;

  const limited = await env.SCORE_LIMITER.limit({ key: limiterKey });
  if (!limited.success) {
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
      return shapeWithPreference(
        shapeScoreError({ code: 'rate_limited', retry_after: 60, cta_text: CTA_INSTALL_ANC }),
        preference,
        { setCookie },
      );
    }
  }

  // 6. GitHub accessibility pre-check. For github-url inputs without a
  //    hint and without an explicit branch, probe github.com directly
  //    with a HEAD before paying the DO cold-start cost. A 404 from
  //    github means the repo is private, deleted, or never existed —
  //    the sandbox cannot resolve a binary regardless. Fast-fail with
  //    `github_repo_not_accessible` so the user sees an honest "we
  //    can't see that repo" panel rather than a generic
  //    `chain_no_resolve` after a multi-second spin-up.
  //
  //    Skip conditions (each preserves the DO's existing behavior):
  //      - non-github-url input (slug / install-command — no repo to probe)
  //      - github-url with explicit branch (DO clones anyway; HEAD on
  //        the repo root tells us nothing about the branch existing)
  //      - github-url that resolved to a hint (we already know the
  //        install path; a transient github 404 here shouldn't break a
  //        repo we've explicitly curated install metadata for)
  //
  //    Fail-OPEN on anything other than a clean 404: 5xx, network
  //    timeout, abort all fall through to the DO so a github outage
  //    doesn't silently break scoring. The accessibility module's
  //    in-isolate cache absorbs repeated probes for the same repo.
  if (validated.kind === 'github-url' && !validated.branch) {
    const registryHit = lookupRegistry(validated, registryIndex, hintsIndex);
    if (registryHit.kind !== 'hint') {
      const accessibility = await checkGithubAccessibility(validated.owner, validated.repo);
      if (accessibility.state === 'not_accessible') {
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

  // 7. DO call — U6 ships the install + score flow; U7 wires the
  //    post-success cache write inside the DO itself (do.ts), so this
  //    handler doesn't need a follow-up write step. The DO returns
  //   either `{scorecard, anc_version}` on success or `{error, details?}`
  //   on failure, mapped below into the typed ScoreError union.
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
      body: JSON.stringify({ input: validated, hash: inputHash }),
      headers: { 'content-type': 'application/json' },
    }),
  );

  let doPayload: unknown;
  try {
    doPayload = await doRes.json();
  } catch {
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
    return shapeWithPreference(
      shapeScoreError({ code: 'sandbox_stub_until_u6', cta_text: CTA_INSTALL_ANC }),
      preference,
      { setCookie },
    );
  }

  if (isDoError(doPayload)) {
    return shapeWithPreference(mapDoError(doPayload), preference, { setCookie });
  }

  if (isDoSuccess(doPayload)) {
    const shareUrl = shareUrlForInput(validated, hintsIndex);
    return shapeWithPreference(
      shapeScoreSuccess(doPayload.scorecard, doPayload.anc_version, 'live', shareUrl),
      preference,
      { setCookie },
    );
  }

  // DO returned 2xx but with an unrecognized envelope shape. Fail loud
  // per R11 rather than synthesize a partial success.
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
