// POST /api/score: the one transact endpoint for both lanes. The lane is
// a server decision made from the target's shape, so the progress page,
// the smoke script, the operator hatch, and the error vocabulary stay
// single.
//
//   method + Content-Type ... a non-POST is 405; a non-JSON body is 415
//   parse .................... { target | input, turnstile_token?, site_type?,
//                                public_listing?, refresh? }; ?fromCache=false
//   classify ................. the shared classifier; a rejection is a 400
//   lane validation .......... cli: the worker validator
//                              web: the https origin + the SSRF gate, before
//                                   any cache read
//   unmetered tiers .......... cli: registry, then cache (skipped by refresh
//                                   and ?fromCache=false; a branch target
//                                   never serves from cache)
//                              web: cache (a fresh hit serves; a stale hit
//                                   or a listing change falls through); the
//                                   operator hatch is CLI-only
//   in flight ................ the KV flag for this input answers 202 to a
//                              tokenless POST and attaches a tokened one;
//                              ?fromCache=false bypasses it on the CLI lane
//   tokenless ................ 403 turnstile_failed, no budget spent
//   admitTransact ............ kill switch, client identity, siteverify,
//                              session, limiters
//   run ...................... Accept x-ndjson streams the event union;
//                              otherwise the terminal envelope or the error
//                              object as one JSON body. A throw from a lane
//                              core is the terminal error line, never an
//                              escaped exception.
//
// During the phased landing the non-streaming JSON responses carry the
// legacy `share_url` and the registry hit's nested `scorecard.kind` and
// `scorecard.scorecard_url` beside the envelope, because the deployed
// homepage reads them until the entry form switches over. A body that
// carries the legacy `input` key is CLI-only for the same reason: that
// client cannot render a website envelope, so a website under it is
// refused as unrecognized input.

import type { AuditEnvelope } from '../../shared/audit-envelope';
import {
  type AuditErrorObject,
  type AuditEvent,
  auditError,
  auditErrorFor,
  CTA_RETRY,
  completeEvent,
} from '../../shared/audit-events';
import {
  API_SCORE_PATH,
  type ClassifiedTarget,
  classifyTarget,
  type Lane,
  targetOfSpec,
} from '../../shared/audit-routes';
import { wantsEventStream } from '../accept';
import { sha256Hex } from '../audit-web/cache';
import {
  meterWebAuditFlip,
  patchWebListing,
  prepareWebTarget,
  readWebTier,
  runWebAuditStream,
  type WebCoreEnv,
  webCacheEnvelope,
} from '../audit-web/core';
import { flushHitMinPurge, runWithHitMinPurge } from '../audit-web/hit-min-purge';
import type { WebSiteType } from '../audit-web/registry';
import {
  type CliCoreEnv,
  type CliIndexes,
  type CliValidated,
  isBranchScoped,
  loadCliIndexes,
  readCliTier,
  runCliAudit,
  validateCliInput,
} from '../score/core';
import { CTA, type ScoreError, toAuditError } from '../score/response-shape';
import type { ScoreTelemetryEnv } from '../score/telemetry';
import { AUDITOR_URL, SITE_SPEC_VERSION, SPEC_VERSION } from '../spec-version.gen';
import { emitLog } from '../telemetry/log';
import { type Admission, type AdmitDeps, type AdmitEnv, admitTransact } from './admit';

export type AuditApiEnv = AdmitEnv & CliCoreEnv & WebCoreEnv & Partial<ScoreTelemetryEnv>;

export type AuditApiDeps = AdmitDeps & {
  /** Injected probe fetch for the website engine in tests. */
  probeFetch?: typeof fetch;
};

export function isAuditApiPath(pathname: string): boolean {
  return pathname === API_SCORE_PATH;
}

/** The relay's deadline, the TTL of the in-flight flags. */
export const RELAY_DEADLINE_SECONDS = 90;

const CTA_INPUT = 'Enter a CLI tool, a GitHub repository, or a website.';

type ParsedBody = {
  target: string;
  token: string | null;
  siteType: WebSiteType | null;
  publicListing: boolean | undefined;
  refresh: boolean;
  /** The body used the legacy `input` key, so it came from the deployed CLI form. */
  legacyInput: boolean;
};

type ParseFailure = { status: number } & AuditErrorObject;

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    ...extra,
  };
}

function errorResponse(status: number, error: AuditErrorObject, extra: Record<string, string> = {}): Response {
  const headers = jsonHeaders(extra);
  if (error.error.retry_after !== undefined) headers['retry-after'] = String(error.error.retry_after);
  return new Response(JSON.stringify({ ...error, spec_version: SPEC_VERSION, auditor_url: AUDITOR_URL }), {
    status,
    headers,
  });
}

async function parseBody(request: Request): Promise<ParsedBody | ParseFailure> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(contentType)) {
    return {
      status: 415,
      ...auditErrorFor('invalid_body', { cta: 'Send a JSON body with Content-Type: application/json.' }),
    };
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { status: 400, ...auditErrorFor('invalid_body', { cta: CTA_INPUT }) };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 400, ...auditErrorFor('invalid_body', { cta: CTA_INPUT }) };
  }
  const body = raw as Record<string, unknown>;
  const legacyInput = typeof body.target !== 'string' && typeof body.input === 'string';
  const target = typeof body.target === 'string' ? body.target : legacyInput ? (body.input as string) : null;
  if (target === null) return { status: 400, ...auditErrorFor('target_empty', { cta: CTA_INPUT }) };
  if (body.site_type !== undefined && body.site_type !== 'content' && body.site_type !== 'api') {
    return { status: 400, ...auditErrorFor('invalid_site_type', { cta: 'Use "content" or "api".' }) };
  }
  if (body.public_listing !== undefined && typeof body.public_listing !== 'boolean') {
    return { status: 400, ...auditErrorFor('invalid_public_listing', { cta: 'Send true or false.' }) };
  }
  return {
    target,
    token: typeof body.turnstile_token === 'string' && body.turnstile_token ? body.turnstile_token : null,
    siteType: (body.site_type as WebSiteType | undefined) ?? null,
    publicListing: body.public_listing as boolean | undefined,
    refresh: body.refresh === true,
    legacyInput,
  };
}

// ---------------------------------------------------------------------------
// In-flight flags (KV): `inflight:<lane>:<input>` at accepted, the
// result-keyed twin once the result target is known, both deleted at the
// terminal line and expiring with the relay deadline otherwise.
// ---------------------------------------------------------------------------

type InFlight = { started_at: string };

function inflightKey(lane: Lane, key: string): string {
  return `inflight:${lane}:${key}`;
}

// A KV read that fails is a miss: the flag is a dedup hint, never a gate.
export async function readInFlight(
  env: { SCORE_KV?: KVNamespace },
  lane: Lane,
  input: string,
): Promise<InFlight | null> {
  if (!env.SCORE_KV) return null;
  try {
    const raw = await env.SCORE_KV.get(inflightKey(lane, input));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<InFlight>;
    return typeof parsed.started_at === 'string' ? { started_at: parsed.started_at } : null;
  } catch {
    return null;
  }
}

class InFlightFlags {
  private keys = new Set<string>();
  constructor(
    private readonly env: AuditApiEnv,
    private readonly lane: Lane,
    readonly startedAt: string,
  ) {}

  async mark(...keys: string[]): Promise<void> {
    const kv = this.env.SCORE_KV;
    if (!kv) return;
    const value = JSON.stringify({ started_at: this.startedAt });
    await Promise.all(
      keys.map((key) => {
        const full = inflightKey(this.lane, key);
        this.keys.add(full);
        return kv.put(full, value, { expirationTtl: RELAY_DEADLINE_SECONDS }).catch(() => {});
      }),
    );
  }

  async clear(): Promise<void> {
    const kv = this.env.SCORE_KV;
    if (!kv) return;
    await Promise.all([...this.keys].map((key) => kv.delete(key).catch(() => {})));
    this.keys.clear();
  }
}

// ---------------------------------------------------------------------------
// Telemetry: one audit.request row per call. A streamed run's row is owned
// by the relay, which emits it once the terminal line is known.
// ---------------------------------------------------------------------------

type RequestRow = {
  lane: Lane | null;
  tier: string;
  outcome: string;
  status: number;
  refresh: boolean;
  stream: boolean;
  target: string | null;
  /** Server-side reason behind a denial or a swallowed throw. */
  detail?: string;
  /** Set by the relay when it takes over emission for a stream. */
  deferred: boolean;
};

function emitRequestRow(row: RequestRow, startedMs: number): void {
  emitLog(
    { scope: 'audit.request' },
    {
      lane: row.lane,
      tier: row.tier,
      outcome: row.outcome,
      status: row.status,
      refresh: row.refresh,
      stream: row.stream,
      target: row.target,
      duration_ms: Date.now() - startedMs,
      ...(row.detail !== undefined ? { detail: row.detail } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleAuditApi(
  request: Request,
  env: AuditApiEnv,
  ctx: ExecutionContext,
  deps: AuditApiDeps = {},
): Promise<Response> {
  const started = Date.now();
  const row: RequestRow = {
    lane: null,
    tier: 'unset',
    outcome: 'unset',
    status: 500,
    refresh: false,
    stream: false,
    target: null,
    deferred: false,
  };
  try {
    const response = await handle(request, env, ctx, deps, row, started);
    row.status = response.status;
    return response;
  } finally {
    if (!row.deferred) emitRequestRow(row, started);
  }
}

async function handle(
  request: Request,
  env: AuditApiEnv,
  ctx: ExecutionContext,
  deps: AuditApiDeps,
  row: RequestRow,
  started: number,
): Promise<Response> {
  if (request.method.toUpperCase() !== 'POST') {
    row.outcome = 'method';
    return new Response('method not allowed\n', {
      status: 405,
      headers: { Allow: 'POST', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const parsed = await parseBody(request);
  if ('status' in parsed) {
    row.outcome = `error_${parsed.error.code}`;
    return errorResponse(parsed.status, { error: parsed.error });
  }
  row.refresh = parsed.refresh;
  row.stream = wantsEventStream(request);

  const classified = classifyTarget(parsed.target);
  if (!classified.ok) {
    row.outcome = `error_${classified.reason}`;
    return errorResponse(400, auditError(classified.reason, classified.message, { cta: CTA_INPUT }));
  }
  row.lane = classified.lane;
  row.target = classified.target;
  if (parsed.legacyInput && classified.lane === 'web') {
    row.outcome = 'error_unrecognized_input';
    return errorResponse(400, auditErrorFor('unrecognized_input', { cta: CTA_INPUT }));
  }
  const origin = new URL(request.url).origin;
  const skipCache = new URL(request.url).searchParams.get('fromCache') === 'false';
  const common = { request, env, ctx, deps, row, origin, parsed, skipCache, started };
  return classified.lane === 'web' ? handleWeb(common, classified) : handleCli(common, classified);
}

type Common = {
  request: Request;
  env: AuditApiEnv;
  ctx: ExecutionContext;
  deps: AuditApiDeps;
  row: RequestRow;
  origin: string;
  parsed: ParsedBody;
  skipCache: boolean;
  started: number;
};

function inProgressResponse(flag: InFlight): Response {
  return new Response(JSON.stringify({ in_progress: true, started_at: flag.started_at }), {
    status: 202,
    headers: jsonHeaders(),
  });
}

function cookieHeader(admission: Extract<Admission, { ok: true }>): Record<string, string> {
  return admission.setCookie ? { 'set-cookie': admission.setCookie } : {};
}

function tokenlessResponse(): Response {
  return errorResponse(403, auditErrorFor('turnstile_failed', { cta: 'Start the audit from the page.' }));
}

function admissionResponse(admission: Extract<Admission, { ok: false }>, row: RequestRow): Response {
  row.outcome = `error_${admission.error.code}`;
  if (admission.detail !== undefined) row.detail = admission.detail;
  return errorResponse(
    admission.status,
    { error: admission.error },
    admission.setCookie ? { 'set-cookie': admission.setCookie } : {},
  );
}

async function admit(common: Common, lane: Lane, target: string): Promise<Admission> {
  return admitTransact({
    lane,
    request: common.request,
    token: common.parsed.token,
    target,
    env: common.env,
    deps: common.deps,
  });
}

// ---------------------------------------------------------------------------
// Website lane
// ---------------------------------------------------------------------------

async function handleWeb(
  common: Common,
  classified: Extract<ClassifiedTarget, { ok: true; lane: 'web' }>,
): Promise<Response> {
  const { env, row, parsed, origin } = common;
  const prepared = prepareWebTarget(classified.target);
  if (!prepared.ok) {
    row.outcome = 'error_invalid_target';
    return errorResponse(400, auditErrorFor('invalid_target', { cta: CTA_INPUT, details: prepared.reason }));
  }
  const target = prepared.target;
  const tier = await readWebTier(env, target, parsed.publicListing);

  if (tier.kind === 'serve') {
    row.tier = 'cache';
    row.outcome = 'hit';
    return jsonEnvelope(webCacheEnvelope(target, tier.cached, origin));
  }

  const inFlight = await readInFlight(env, 'web', classified.target);
  if (inFlight) {
    row.tier = 'inflight';
    row.outcome = parsed.token ? 'attach' : 'in_progress';
    return inProgressResponse(inFlight);
  }
  if (!parsed.token) {
    row.outcome = 'tokenless';
    return tokenlessResponse();
  }

  const admission = await admit(common, 'web', target.host);
  if (!admission.ok) {
    // A stale record is still data when the lane is off.
    if (admission.error.code === 'web_audit_disabled' && tier.cached) {
      row.tier = 'cache';
      row.outcome = 'hit_disabled';
      return jsonEnvelope(webCacheEnvelope(target, tier.cached, origin));
    }
    return admissionResponse(admission, row);
  }
  const cookie = cookieHeader(admission);

  if (tier.kind === 'patch') {
    const outcome = await patchWebListing(env, target, tier);
    if (!outcome.ok) {
      row.outcome = `error_${outcome.reason}`;
      const status = outcome.reason === 'flip_rate_limited' ? 429 : 500;
      return errorResponse(
        status,
        auditErrorFor(outcome.reason, { cta: CTA_RETRY, retry_after: status === 429 ? 3600 : undefined }),
        cookie,
      );
    }
    await flushHitMinPurge().catch(() => {});
    row.tier = 'cache';
    row.outcome = 'patched';
    return jsonEnvelope(webCacheEnvelope(target, outcome.cached, origin), cookie);
  }

  if (!(await meterWebAuditFlip(env, target, tier.write))) {
    row.outcome = 'error_flip_rate_limited';
    return errorResponse(429, auditErrorFor('flip_rate_limited', { cta: CTA_RETRY, retry_after: 3600 }), cookie);
  }
  const listing = tier.listing;

  row.tier = 'live';
  const flags = new InFlightFlags(env, 'web', new Date().toISOString());
  await flags.mark(classified.target, target.host);
  const events = runWebAuditStream({
    env,
    target,
    siteType: parsed.siteType,
    listing,
    origin,
    probeFetch: common.deps.probeFetch,
    surface: 'stream',
  });
  return relay(common, { lane: 'web', target: classified.target }, events, flags, cookie);
}

// ---------------------------------------------------------------------------
// CLI lane
// ---------------------------------------------------------------------------

async function handleCli(
  common: Common,
  classified: Extract<ClassifiedTarget, { ok: true; lane: 'cli' }>,
): Promise<Response> {
  const { env, row, parsed, origin } = common;
  const indexes = await loadCliIndexes(env);
  const validated = validateCliInput(classified.target, indexes);
  if (validated.kind === 'unknown') {
    row.outcome = `error_${validated.error}`;
    return errorResponse(400, toAuditError(validationError(validated.error, classified.target)));
  }
  const branch = isBranchScoped(validated);
  // A refresh and the operator hatch both skip the cache tier; the registry
  // is always consulted, so a curated tool never runs the sandbox.
  const skipCache = common.skipCache || parsed.refresh;
  const tier = await readCliTier(env, validated, indexes, { origin, skipCache });

  if (tier.kind === 'registry') {
    row.tier = 'registry';
    row.outcome = 'hit';
    return jsonEnvelope(
      tier.envelope,
      {},
      {
        scorecard: {
          kind: 'registry_hit',
          tool: tier.entry,
          scorecard_url: tier.scorecardUrl,
          score_pct: tier.entry.score_pct ?? null,
        },
        anc_version: tier.ancVersion,
      },
    );
  }
  if (tier.kind === 'cache') {
    row.tier = 'cache';
    row.outcome = 'hit';
    return jsonEnvelope(tier.envelope, {}, { share_url: tier.shareUrl ?? undefined });
  }

  // The operator hatch bypasses the flag; a refresh attaches like any transact.
  const inFlight = common.skipCache ? null : await readInFlight(env, 'cli', classified.target);
  if (inFlight) {
    row.tier = 'inflight';
    row.outcome = parsed.token ? 'attach' : 'in_progress';
    return inProgressResponse(inFlight);
  }
  if (!parsed.token) {
    row.outcome = 'tokenless';
    return tokenlessResponse();
  }

  const admission = await admit(common, 'cli', classified.target);
  if (!admission.ok) return admissionResponse(admission, row);
  const cookie = cookieHeader(admission);

  row.tier = 'live';
  const flags = new InFlightFlags(env, 'cli', new Date().toISOString());
  const branchTarget =
    branch && validated.kind === 'github-url' && validated.branch
      ? [`${validated.owner}/${validated.repo}@${validated.branch}`]
      : [];
  await flags.mark(classified.target, ...branchTarget);
  const events = runCliStream({ common, validated, indexes, flags, skipCache: common.skipCache || parsed.refresh });
  return relay(common, { lane: 'cli', target: classified.target }, events, flags, cookie);
}

async function* runCliStream(input: {
  common: Common;
  validated: CliValidated;
  indexes: CliIndexes;
  flags: InFlightFlags;
  skipCache: boolean;
}): AsyncGenerator<AuditEvent> {
  const { common, validated, indexes } = input;
  yield { type: 'phase', phase: 'resolving', at: new Date().toISOString() };
  const outcome = await runCliAudit({
    env: common.env,
    validated,
    indexes,
    inputHash: await sha256Hex(common.parsed.target),
    origin: common.origin,
    skipCachePost: input.skipCache,
    // The result-keyed twin, marked as soon as the binary is known (a
    // git-clone target was already marked at accepted).
    onResolved: async (spec) => {
      if (spec.pm !== 'git-clone') await input.flags.mark(targetOfSpec(spec));
    },
  });
  if (outcome.kind === 'bounce') {
    common.row.tier = outcome.tier;
    yield { type: 'bounce', ...toAuditError(outcome.error) };
    return;
  }
  common.row.tier = outcome.kind;
  yield completeEvent(outcome.envelope);
}

// ---------------------------------------------------------------------------
// Relay: one JSON body, or a line-framed stream with a heartbeat while
// silent. The terminal telemetry fields, the request row, and the flag
// cleanup run from the consumer inside ctx.waitUntil, so a client that goes
// away does not strand them.
// ---------------------------------------------------------------------------

const HEARTBEAT_MS = 10_000;

type StreamMeta = { lane: Lane; target: string };

function isTerminal(event: AuditEvent): boolean {
  return event.type === 'complete' || event.type === 'incomplete' || event.type === 'bounce' || event.type === 'error';
}

// Drain a lane core. A throw becomes the terminal error line, so the stream
// always ends on a typed line and the JSON path answers the shared error
// object instead of an escaped exception.
async function consume(
  events: AsyncGenerator<AuditEvent>,
  row: RequestRow,
  forward: (event: AuditEvent) => Promise<void>,
): Promise<AuditEvent | null> {
  let terminal: AuditEvent | null = null;
  try {
    for await (const event of events) {
      terminal = event;
      await forward(event);
    }
  } catch (err) {
    row.detail = err instanceof Error ? err.message : String(err);
    terminal = { type: 'error', ...auditErrorFor('incomplete_response_contract', { cta: CTA_RETRY }) };
    await forward(terminal);
  }
  return terminal;
}

async function relay(
  common: Common,
  meta: StreamMeta,
  events: AsyncGenerator<AuditEvent>,
  flags: InFlightFlags,
  cookie: Record<string, string>,
): Promise<Response> {
  const { ctx, row } = common;
  const accepted: AuditEvent = { type: 'accepted', lane: meta.lane, target: meta.target, started_at: flags.startedAt };
  if (!row.stream) {
    let terminal: AuditEvent | null = null;
    await runWithHitMinPurge(ctx, async () => {
      try {
        terminal = await consume(events, row, async () => {});
      } finally {
        await flags.clear();
        await flushHitMinPurge().catch(() => {});
      }
    });
    return terminalResponse(terminal, row, cookie);
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const write = (event: AuditEvent) => writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => {});
  // Every write happens inside the background task: a write on a
  // TransformStream settles only once the reader consumes it, so a write
  // awaited before the Response is returned never settles.
  row.deferred = true;
  ctx.waitUntil(
    runWithHitMinPurge(ctx, async () => {
      let terminal: AuditEvent | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = setInterval(() => {
        void write({ type: 'heartbeat', at: new Date().toISOString() });
      }, HEARTBEAT_MS);
      const stopHeartbeat = () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
      };
      try {
        await write(accepted);
        terminal = await consume(events, row, async (event) => {
          // No heartbeat may land after the terminal line.
          if (isTerminal(event)) stopHeartbeat();
          await write(event);
        });
      } finally {
        stopHeartbeat();
        row.outcome = terminal ? outcomeOf(terminal) : 'incomplete_response_contract';
        row.status = 200;
        await flags.clear();
        await flushHitMinPurge().catch(() => {});
        await writer.close().catch(() => {});
        emitRequestRow(row, common.started);
      }
    }),
  );
  return new Response(readable, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      ...cookie,
    },
  });
}

function outcomeOf(terminal: AuditEvent): string {
  if (terminal.type === 'complete') return 'complete';
  if (terminal.type === 'bounce' || terminal.type === 'error') return `error_${terminal.error.code}`;
  if (terminal.type === 'incomplete') return 'incomplete';
  return 'incomplete_response_contract';
}

function terminalResponse(terminal: AuditEvent | null, row: RequestRow, cookie: Record<string, string>): Response {
  if (!terminal) {
    row.outcome = 'incomplete_response_contract';
    return errorResponse(500, auditErrorFor('incomplete_response_contract', { cta: CTA_RETRY }), cookie);
  }
  row.outcome = outcomeOf(terminal);
  if (terminal.type === 'complete') {
    const { type: _type, ...envelope } = terminal;
    return jsonEnvelope(envelope, cookie, envelope.kind === 'cli' ? legacyCliFields(envelope) : {});
  }
  if (terminal.type === 'bounce' || terminal.type === 'error') {
    return errorResponse(statusForCode(terminal.error.code), { error: terminal.error }, cookie);
  }
  if (terminal.type === 'incomplete') {
    return new Response(JSON.stringify({ incomplete: true, scorecard: terminal.scorecard }), {
      status: 200,
      headers: jsonHeaders(cookie),
    });
  }
  row.outcome = 'incomplete_response_contract';
  return errorResponse(500, auditErrorFor('incomplete_response_contract', { cta: CTA_RETRY }), cookie);
}

// The deployed homepage forwards to `share_url`; a result with a page names it.
function legacyCliFields(envelope: AuditEnvelope): Record<string, unknown> {
  return envelope.scorecard_url && !envelope.target.includes('@') ? { share_url: envelope.scorecard_url } : {};
}

function statusForCode(code: string): number {
  switch (code) {
    case 'rate_limited':
    case 'flip_rate_limited':
      return 429;
    case 'turnstile_failed':
      return 403;
    case 'turnstile_unavailable':
    case 'scoring_disabled':
    case 'web_audit_disabled':
    case 'sandbox_unavailable':
      return 503;
    case 'chain_no_resolve':
    case 'github_repo_not_accessible':
      return 404;
    case 'install_unsupported':
    case 'chain_resolved_install_failed':
    case 'chain_resolved_no_binary_produced':
    case 'discovery_redirect_loop':
    case 'unreachable':
      return 502;
    case 'timeout':
      return 504;
    case 'incomplete_response_contract':
    case 'service_misconfigured':
    case 'patch_failed':
      return 500;
    default:
      return 400;
  }
}

/** The envelope as every JSON surface serves it, with the site version triad beside it. */
export function envelopeJsonBody(envelope: AuditEnvelope): Record<string, unknown> {
  return {
    ...envelope,
    site_spec_version: SITE_SPEC_VERSION,
    auditor_url: AUDITOR_URL,
    ...(envelope.anc_version ? { anc_version: envelope.anc_version } : {}),
  };
}

function jsonEnvelope(
  envelope: AuditEnvelope,
  cookie: Record<string, string> = {},
  legacy: Record<string, unknown> = {},
): Response {
  const body = { ...envelopeJsonBody(envelope), ...legacy };
  return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders(cookie) });
}

function validationError(code: string, raw: string): ScoreError {
  const cta = CTA.installAnc;
  switch (code) {
    case 'invalid_url':
      return { code: 'invalid_url', details: raw.slice(0, 200), cta_text: cta };
    case 'non_https_url':
      return { code: 'non_https_url', cta_text: 'Use https://; http:// is not allowed.' };
    case 'non_github_host':
      return { code: 'non_github_host', cta_text: 'Only public GitHub repos are scored.' };
    case 'invalid_url_path':
      return {
        code: 'invalid_url_path',
        cta_text: 'Paste the repo root URL (e.g. https://github.com/owner/repo), not a branch or release link.',
      };
    case 'unparseable_install_command':
      return { code: 'unparseable_install_command', details: raw.slice(0, 200), cta_text: cta };
    default:
      return { code: 'unrecognized_input', cta_text: cta };
  }
}
