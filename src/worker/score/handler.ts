// The legacy /api/score handler: the GET read path and the suffixed
// representations, plus the phased-landing POST the deployed homepage
// still posts `{ input }` to. Every lane decision lives in
// `src/worker/score/core.ts`, which the unified transact endpoint
// composes as well; this file owns only the request shape, the gate
// block a legacy POST passes, and the legacy response shape.
//
//   GET  /api/score(.md|.json)?input=  read-only: registry, then cache;
//                                      a miss is 404 chain_no_resolve
//   POST /api/score(.md|.json)         { input, turnstile_token? }:
//                                      read tiers, then kill switch,
//                                      siteverify, session, limiters,
//                                      then the run
//   other methods                      405
//
// `?fromCache=false` skips both cache read tiers; the registry is still
// consulted and the cache write after a live run still fires.
//
// Telemetry: one `score.tier` log line and one Analytics Engine row per
// request, emitted from the outer try/finally so every path reports.

import { API_SCORE_PATH } from '../../shared/audit-routes';
import { isRepresentationPinned } from '../headers';
import { AUDITOR_URL } from '../spec-version.gen';
import type { CacheEnv } from './cache';
import { preferenceFor } from './content-negotiation';
import { type CliCoreEnv, isBranchScoped, loadCliIndexes, readCliTier, runCliAudit, validateCliInput } from './core';
import type { InstallSpec, ResolvedStep } from './discover-binary';
import { isScoringDisabled, type KillSwitchEnv } from './kill-switch';
import { _resetHintsIndexCache } from './orchestrate';
import { _resetRegistryIndexCache } from './registry-lookup';
import { CTA, type ScoreError, shapeScoreError, shapeScoreSuccess } from './response-shape';
import { issue, newSession, read as readSession, SessionConfigError, type SessionEnv } from './session';
import {
  buildScoreEventFields,
  emitScoreTier,
  newScoreTierTelemetry,
  recordScoreEvent,
  type ScoreTelemetryEnv,
  type ScoreTierTelemetry,
} from './telemetry';
import { isVerifyUnavailable, type TurnstileEnv, verifyTurnstile } from './turnstile';
import type { ValidatedInput } from './validate';

// ---------------------------------------------------------------------------
// Env contract
// ---------------------------------------------------------------------------

export type ScoreEnv = KillSwitchEnv &
  SessionEnv &
  TurnstileEnv &
  CacheEnv &
  CliCoreEnv &
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
// Handler
// ---------------------------------------------------------------------------

const CTA_INSTALL_ANC = CTA.installAnc;

export async function handleScore(request: Request, env: ScoreEnv): Promise<Response> {
  const telemetry = newScoreTierTelemetry();
  const start = Date.now();
  const url = new URL(request.url);
  let response: Response | undefined;
  try {
    response = withScoreVary(await handleScoreInner(url, request, env, telemetry), url.pathname);
    return response;
  } finally {
    const totalMs = Date.now() - start;
    // Response missing means handleScoreInner threw — treat as 500 for
    // the AE row so the error-code distribution still sees the
    // unhandled-exception class as 5xx rather than a missing value.
    const status = response?.status ?? 500;
    emitScoreTier(telemetry);
    recordScoreEvent(env, buildScoreEventFields(telemetry, totalMs, status));
  }
}

async function handleScoreInner(
  url: URL,
  request: Request,
  env: ScoreEnv,
  telemetry: ScoreTierTelemetry,
): Promise<Response> {
  const method = request.method.toUpperCase();
  const preference = preferenceFor(url.pathname, request);

  if (method !== 'GET' && method !== 'POST') {
    telemetry.tier = 'error_unrecognized_input';
    return shapeWithPreference(
      shapeScoreError({
        code: 'unrecognized_input',
        cta_text: `Use GET ${API_SCORE_PATH}?input=… or POST ${API_SCORE_PATH} {input}.`,
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

  const indexes = await loadCliIndexes(env);
  const validated = validateCliInput(rawInput, indexes);
  // input_kind is set before the early return so the AE row records
  // `invalid` for a validation reject rather than a null field.
  telemetry.input_kind = validated.kind;
  if (validated.kind === 'unknown') {
    telemetry.tier = `error_${validated.error}`;
    return shapeWithPreference(shapeScoreError(validationErrorFor(validated.error, rawInput)), preference);
  }

  // 2. The unmetered tiers: registry, then the R2 cache when the binary is
  //    cheaply derivable. A branch-scoped target never serves from this
  //    tier: its record is a snapshot under its own key, read by the
  //    result page. ?fromCache=false skips the tier too.
  const skipCache = url.searchParams.get('fromCache') === 'false';
  const origin = url.origin;
  if (!isBranchScoped(validated) && !skipCache) telemetry.cache_pre_attempted = true;
  const tier = await readCliTier(env, validated, indexes, { origin, skipCache });

  if (tier.kind === 'registry') {
    telemetry.tier = 'curated';
    telemetry.binary = tier.entry.binary ?? null;
    telemetry.freshness = 'registry-hit';
    telemetry.resolved_step = 'registry';
    return shapeWithPreference(
      shapeScoreSuccess(
        {
          kind: 'registry_hit',
          tool: tier.entry,
          scorecard_url: tier.scorecardUrl,
          // The curated score rides along so the homepage form can render
          // its reward line before the redirect; null when the entry
          // predates score_pct.
          score_pct: typeof tier.entry.score_pct === 'number' ? tier.entry.score_pct : null,
        },
        tier.ancVersion,
        'cache-hit',
      ),
      preference,
    );
  }

  if (tier.kind === 'cache') {
    telemetry.tier = 'cache_pre';
    telemetry.cache_pre_hit = true;
    telemetry.freshness = 'cache-hit';
    telemetry.binary = tier.shareUrl ? tier.binary : null;
    return shapeWithPreference(
      shapeScoreSuccess(tier.scorecard, tier.ancVersion, 'cache-hit', tier.shareUrl),
      preference,
    );
  }

  // GET requests stop after the read-only tiers: paste-and-share contract.
  if (method === 'GET') {
    telemetry.tier = 'error_chain_no_resolve';
    return shapeWithPreference(shapeScoreError({ code: 'chain_no_resolve', cta_text: CTA_INSTALL_ANC }), preference);
  }

  // 4. The metered gates, by ascending cost: kill switch, siteverify,
  //    session plus limiters. Curated and cache hits never reach here.
  if (await isScoringDisabled(env)) {
    telemetry.tier = 'error_scoring_disabled';
    return shapeWithPreference(shapeScoreError({ code: 'scoring_disabled', cta_text: CTA_INSTALL_ANC }), preference);
  }

  const verifyResult = await verifyTurnstile(env, turnstileToken, {
    remoteIp: request.headers.get('cf-connecting-ip') ?? undefined,
  });
  if (!verifyResult.ok) {
    if (verifyResult.reason === 'misconfigured') {
      telemetry.tier = 'error_service_misconfigured';
      return shapeWithPreference(serviceMisconfigured('TURNSTILE_SECRET missing'), preference);
    }
    if (isVerifyUnavailable(verifyResult.reason)) {
      telemetry.tier = 'error_service_misconfigured';
      return shapeWithPreference(serviceMisconfigured(`siteverify ${verifyResult.reason}`), preference);
    }
    telemetry.tier = 'error_turnstile_failed';
    return shapeWithPreference(shapeScoreError({ code: 'turnstile_failed', cta_text: CTA_INSTALL_ANC }), preference);
  }

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
  const limited = await env.SCORE_LIMITER.limit({ key: `${session.sid}:${inputHash}` });
  if (!limited.success) {
    telemetry.tier = 'error_rate_limited';
    return shapeWithPreference(
      shapeScoreError({ code: 'rate_limited', retry_after: 60, cta_text: CTA_INSTALL_ANC }),
      preference,
      { setCookie },
    );
  }
  if (env.SCORE_LIMITER_IP) {
    const ipLimited = await env.SCORE_LIMITER_IP.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' });
    if (!ipLimited.success) {
      telemetry.tier = 'error_rate_limited';
      return shapeWithPreference(
        shapeScoreError({ code: 'rate_limited', retry_after: 60, cta_text: CTA_INSTALL_ANC }),
        preference,
        { setCookie },
      );
    }
  }

  // 5. The run: the accessibility probe, spec resolution, the
  //    post-discovery cache tier, and the Durable Object, all in the core.
  const outcome = await runCliAudit({ env, validated, indexes, inputHash, origin, skipCachePost: skipCache });
  const applySpecTelemetry = (spec: InstallSpec | undefined, resolved_step: ResolvedStep | null | undefined): void => {
    if (!spec) return;
    telemetry.binary = spec.binary;
    telemetry.pm = spec.pm;
    telemetry.resolved_step = resolved_step ?? null;
    telemetry.cache_post_attempted = spec.pm !== 'git-clone' && !skipCache;
  };

  switch (outcome.kind) {
    case 'cache': {
      applySpecTelemetry(outcome.spec, outcome.resolvedStep);
      telemetry.cache_post_hit = true;
      telemetry.tier = 'cache_post';
      telemetry.freshness = 'cache-hit';
      return shapeWithPreference(
        shapeScoreSuccess(outcome.scorecard, outcome.ancVersion, 'cache-hit', outcome.shareUrl),
        preference,
        { setCookie },
      );
    }
    case 'live': {
      applySpecTelemetry(outcome.spec, outcome.resolvedStep);
      telemetry.tier = 'live';
      telemetry.freshness = 'live';
      telemetry.install_ms = outcome.installMs;
      telemetry.anc_audit_ms = outcome.ancAuditMs;
      return shapeWithPreference(
        shapeScoreSuccess(outcome.scorecard, outcome.ancVersion, 'live', outcome.shareUrl),
        preference,
        { setCookie },
      );
    }
    case 'bounce': {
      applySpecTelemetry(outcome.spec, outcome.resolvedStep);
      telemetry.tier = outcome.tier;
      return shapeWithPreference(shapeScoreError(outcome.error), preference, { setCookie });
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

// Vary is derived from the request path, not from freshness: the
// extensionless endpoint negotiates JSON vs markdown by Accept alone
// (detectScorePreference never reads User-Agent), while the suffix-pinned
// twins are one representation each. Stamped once at the handler boundary
// so no per-branch header set can drift from the shared predicate.
function withScoreVary(response: Response, pathname: string): Response {
  if (isRepresentationPinned(pathname)) {
    response.headers.delete('Vary');
  } else {
    response.headers.set('Vary', 'Accept');
  }
  return response;
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
