// GET /score/<target>, /score/<target>/md, and /score/<target>/json: one
// route serves curated CLI slugs, live CLI binaries, branch-scoped runs,
// and website hosts in three representations from one envelope.
//
//   canonicalize ....... a trailing `.html` or slash is a 301 to the bare
//                        form; a percent-encoded target is a 301 to its
//                        encoded canonical form
//   split .............. the trailing `md` or `json` segment picks the
//                        representation; no extension is parsed, so a host
//                        under a TLD such as `.md` is an ordinary target
//   classify ........... the shared classifier picks the lane; a reserved
//                        name or a rejected target is a 404
//   branch ............. R2 under the `owner/repo@branch` key, else 404
//   website ............ R2 under the https key, else 404
//   cli ................ the isolate-cached registry index first (a load
//                        failure is a 503 with Retry-After): a curated slug
//                        with a scorecard serves the build-emitted asset
//                        (only status 200 counts), a curated binary alias
//                        is a 301 to its slug, anything else is an R2 live
//                        lookup, else 404
//   /json .............. checks the in-flight flag before any R2 read and
//                        answers 202 while it exists; never reads or sets
//                        the session cookie
//   bare path .......... negotiates `Accept: application/json` and
//                        `Accept: text/markdown`; `?v=` is ignored for
//                        rendering and makes the response uncacheable
//   cache class ........ named by this route for the tier it served: a
//                        curated page is HIT-1d (its JSON path-keyed), a
//                        live, branch, or website result is HIT-min under
//                        the tag its writer purges, in every representation
//
// The 404 body is one sentence, one prefilled `/audit` link, and a
// "Did you mean?" list from the registry (CLI shapes) or the seed list
// plus the leaderboard aggregate's hosts (host shapes), never a form or a
// sitekey. The legacy `/score/live/<binary>` and `/web/<host>` paths are
// adapters over the same renderer.

import {
  type AuditEnvelope,
  buildCliEnvelope,
  buildRegistryEnvelope,
  buildWebEnvelope,
  curatedEntryForBinary,
  hasScorecard,
  type RegistryEntryLike,
} from '../../shared/audit-envelope';
import {
  auditPath,
  classifyTarget,
  isResultTarget,
  type Lane,
  type Representation,
  SCORE_PREFIX,
  scoreJsonPath,
  scoreMarkdownPath,
  scorePath,
  splitRepresentation,
  suggestTargets,
} from '../../shared/audit-routes';
import { escHtml } from '../../shared/esc-html';
import { resultAlternateLinks } from '../../shared/result-head';
import { type ReauditControl, type ResultTier, type SpineInput, shortDate } from '../../shared/result-spine';
import { buildScorecardBody, buildScorecardMarkdown } from '../../shared/scorecard-format.mjs';
import { detectResultPreference } from '../accept';
import { canonicalTargetOf, getAggregate, get as webCacheGet, keyFor as webKeyFor } from '../audit-web/cache';
import { normalizeScorecardCategories } from '../audit-web/display';
import { loadWebAuditRegistry } from '../audit-web/registry';
import { loadWebRemediationCatalog, type WebRemediationCatalog } from '../audit-web/remediation';
import { loadWebSeed, type WebSeedEntry } from '../audit-web/seed';
import { freshnessHtml, freshnessState } from '../audit-web/summary-freshness';
import type { WebSummaryInput } from '../audit-web/summary-input';
import { buildWebSummaryMarkdown } from '../audit-web/summary-markdown';
import { buildWebSummaryBody } from '../audit-web/summary-render';
import { applyHeaders, type CacheClassSpec, resultCacheClass } from '../headers';
import { get as cliCacheGet, keyFor as cliKeyFor } from '../score/cache';
import { loadRegistryIndex, type RegistryIndex } from '../score/registry-lookup';
import { loadShellTemplate, substituteShell } from '../shell-template';
import { SPEC_VERSION } from '../spec-version.gen';
import { emitLog } from '../telemetry/log';
import { envelopeJsonBody, readInFlight } from './api';

export type ResultEnv = {
  ASSETS: Fetcher;
  SCORE_CACHE: R2Bucket;
  SCORE_KV?: KVNamespace;
  TURNSTILE_SITEKEY?: string;
};

export type ResultDeps = {
  /** Clock for the Re-audit countdown and the host-candidate memo. */
  now?: () => number;
};

const RETRY_AFTER_SECONDS = 30;
const HOST_CANDIDATES_TTL_MS = 60_000;
const SUGGESTION_LIMIT = 5;
const REDIRECT_HEADERS = { 'Cache-Control': 'public, max-age=300' } as const;

const REAUDIT_SCRIPT = '/js/reaudit.js';

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handleResultRoute(request: Request, env: ResultEnv, deps: ResultDeps = {}): Promise<Response> {
  const denied = methodDenied(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const canonical = canonicalizeResultPathname(url.pathname);
  if (canonical !== url.pathname) {
    // A `.html` or trailing-slash form redirects only to a target the
    // route can serve; anything else is the 404 for the raw path.
    const target = splitRepresentation(canonical);
    if (target && classifyTarget(target.target).ok) return redirect(canonical);
  }

  const split = splitRepresentation(url.pathname);
  if (!split) {
    const rep = negotiate(request, trailingRepresentation(url.pathname));
    const raw = url.pathname.slice(SCORE_PREFIX.length).replace(/\/(md|json)$/, '');
    return notFound(request, env, deps, { target: decodeURIComponentSafe(raw), lane: null, rep });
  }
  const expected = pathFor(split.target, split.representation);
  if (expected !== url.pathname) return redirect(expected);
  return serveResult(request, env, deps, { target: split.target, representation: split.representation });
}

/** `/score/live/<binary>` and its `.md` twin, served through the unified renderer. */
export function handleLegacyLiveScorePath(request: Request, env: ResultEnv, deps: ResultDeps = {}): Promise<Response> {
  return serveLegacyPath(request, env, deps, { pattern: /^\/score\/live\/([^/]+?)(\.md|\.html)?$/, lane: 'cli' });
}

/** `/web/<host>` and its `.md` twin, served through the unified renderer. */
export function handleLegacyWebResultPath(request: Request, env: ResultEnv, deps: ResultDeps = {}): Promise<Response> {
  return serveLegacyPath(request, env, deps, { pattern: /^\/web\/([^/]+?)(\.md|\.html)?$/, lane: 'web' });
}

// A lane-specific path names its lane up front. Its `.html` form redirects
// to the unified page only for a target the route can serve; anything else
// is the 404, never a throw from the path builder.
async function serveLegacyPath(
  request: Request,
  env: ResultEnv,
  deps: ResultDeps,
  legacy: { pattern: RegExp; lane: Lane },
): Promise<Response> {
  const denied = methodDenied(request);
  if (denied) return denied;
  const match = new URL(request.url).pathname.match(legacy.pattern);
  const target = match ? decodeURIComponentSafe(match[1]) : '';
  const classified = classifyTarget(target);
  const servable =
    match !== null && classified.ok && classified.lane === legacy.lane && isResultTarget(classified.target);
  if (match?.[2] === '.html') {
    if (servable) return redirect(pathFor(classified.target, 'html'));
    return notFound(request, env, deps, { target, lane: legacy.lane, rep: negotiate(request, 'html'), legacy: true });
  }
  const representation: Representation = match?.[2] === '.md' ? 'md' : 'html';
  if (!servable) {
    const rep = negotiate(request, representation);
    return notFound(request, env, deps, { target, lane: legacy.lane, rep, legacy: true });
  }
  return serveResult(request, env, deps, { target: classified.target, representation, legacy: true });
}

/** The representation a bare path serves: what the client asked for, or the pinned segment. */
function negotiate(request: Request, representation: Representation): Representation {
  return representation === 'html' ? detectResultPreference(request) : representation;
}

function methodDenied(request: Request): Response | null {
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  return new Response('method not allowed\n', {
    status: 405,
    headers: { Allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 301, headers: { Location: location, ...REDIRECT_HEADERS } });
}

/** Strip a trailing `.html` and trailing slashes so host-shaped paths never reach the assets binding's rewriting. */
function canonicalizeResultPathname(pathname: string): string {
  let out = pathname;
  while (out.length > SCORE_PREFIX.length && out.endsWith('/')) out = out.slice(0, -1);
  if (out.endsWith('.html')) out = out.slice(0, -'.html'.length);
  return out;
}

function trailingRepresentation(pathname: string): Representation {
  if (pathname.endsWith('/json')) return 'json';
  if (pathname.endsWith('/md')) return 'md';
  return 'html';
}

function pathFor(target: string, representation: Representation): string {
  if (representation === 'json') return scoreJsonPath(target);
  if (representation === 'md') return scoreMarkdownPath(target);
  return scorePath(target);
}

function decodeURIComponentSafe(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Lane dispatch
// ---------------------------------------------------------------------------

type Served = { target: string; representation: Representation; legacy?: boolean };

type Rendered = {
  envelope: AuditEnvelope;
  tier: ResultTier;
  spine: SpineInput;
  /** Server-rendered HTML body and markdown twin for the envelope. */
  html: () => Promise<string>;
  markdown: () => Promise<string>;
  /** The page's `<meta name="robots">` equivalent: branch pages are unlisted. */
  noindex: boolean;
};

async function serveResult(request: Request, env: ResultEnv, deps: ResultDeps, served: Served): Promise<Response> {
  const url = new URL(request.url);
  const negotiated = served.representation === 'html';
  const representation = negotiate(request, served.representation);
  const classified = classifyTarget(served.target);
  if (!classified.ok) {
    return notFound(request, env, deps, {
      target: served.target,
      lane: null,
      rep: representation,
      legacy: served.legacy,
    });
  }
  // A form the classifier normalizes (case, whitespace) has one canonical page.
  if (!served.legacy && classified.target !== served.target) {
    return redirect(pathFor(classified.target, served.representation));
  }
  const ctx: RenderContext = {
    request,
    env,
    deps,
    url,
    served,
    lane: classified.lane,
    representation,
    negotiated,
    origin: url.origin,
  };

  if (classified.lane === 'web') return serveWeb(ctx, classified.target);
  if (classified.kind === 'cli-branch') return serveBranch(ctx, classified.target);
  return serveCli(ctx, classified.target);
}

type RenderContext = {
  request: Request;
  env: ResultEnv;
  deps: ResultDeps;
  url: URL;
  served: Served;
  lane: Lane;
  representation: Representation;
  /** True when the bare path chose the representation from `Accept`. */
  negotiated: boolean;
  origin: string;
};

async function serveWeb(ctx: RenderContext, host: string): Promise<Response> {
  const inFlight = await inFlightResponse(ctx, 'web', host);
  if (inFlight) return inFlight;
  const canonical = canonicalTargetOf(new URL(`https://${host}/`));
  const record = await webCacheGet(ctx.env, await webKeyFor(canonical, SPEC_VERSION));
  if (!record) return missing(ctx, host, 'web');

  const envelope = buildWebEnvelope({ tier: 'cache', target: host, record, origin: ctx.origin });
  const now = ctx.deps.now?.() ?? Date.now();
  const state = freshnessState(envelope.freshness, now);
  const refreshAfter = envelope.freshness.refresh_after;
  const control: ReauditControl = refreshAfter
    ? { kind: 'countdown', target: host, refreshAfter, secondsLeft: Math.ceil((Date.parse(refreshAfter) - now) / 1000) }
    : { kind: 'refresh', target: host, lane: 'web' };
  const spine: SpineInput = {
    target: host,
    lane: 'web',
    tier: 'cache',
    freshnessHtml: `<span data-web-audit-freshness>${freshnessHtml(state)}</span>`,
    linked: true,
    control,
  };
  // Listing follows provenance: a seeded host is indexable, an on-demand
  // one is not; the same seed entry names the page.
  const seedEntry = await seedEntryFor(ctx.env, host);
  const summaryInput = async (): Promise<WebSummaryInput> => {
    const [remediationLoad, registryLoad] = await Promise.allSettled([
      loadWebRemediationCatalog(ctx.env),
      loadWebAuditRegistry(ctx.env),
    ]);
    const remediation: WebRemediationCatalog = remediationLoad.status === 'fulfilled' ? remediationLoad.value : {};
    let normalized: unknown = record.scorecard;
    if (registryLoad.status === 'fulfilled') {
      try {
        normalized = normalizeScorecardCategories(record.scorecard, registryLoad.value);
      } catch {
        normalized = record.scorecard;
      }
    }
    const targetUrl = (normalized as { tool?: { url?: string } }).tool?.url ?? record.target_url;
    return {
      scorecard: normalized as WebSummaryInput['scorecard'],
      domain: host,
      name: seedEntry?.name,
      targetUrl,
      remediation,
      origin: ctx.origin,
      freshness: envelope.freshness,
      now,
      spine,
      links: { scorecard: envelope.scorecard_url, markdown: envelope.markdown_url, json: envelope.json_url },
    };
  };
  return respond(ctx, {
    envelope,
    tier: 'cache',
    spine,
    noindex: seedEntry === undefined,
    html: async () => buildWebSummaryBody(await summaryInput()),
    markdown: async () => buildWebSummaryMarkdown(await summaryInput()),
  });
}

async function serveBranch(ctx: RenderContext, target: string): Promise<Response> {
  const inFlight = await inFlightResponse(ctx, 'cli', target);
  if (inFlight) return inFlight;
  const registry = await registryOrNull(ctx.env);
  const record = await cliCacheGet(ctx.env, cliKeyFor(target, SPEC_VERSION));
  if (!record) return missing(ctx, target, 'cli');
  const sourceSha = (record as { source_sha?: unknown }).source_sha;
  const envelope = buildCliEnvelope({
    tier: 'cache',
    target,
    record,
    registry: registry ?? { by_slug: {} },
    origin: ctx.origin,
    sourceSha: typeof sourceSha === 'string' ? sourceSha : undefined,
  });
  const date = shortDate(cliScoredAt(record));
  const sha = envelope.source_sha ? envelope.source_sha.slice(0, 7) : null;
  const scored = sha ? `Scored at <code>${escHtml(sha)}</code>` : 'Scored';
  const freshness = `${scored}${date ? ` on ${escHtml(date)}` : ''}. Re-audit runs a fresh audit.`;
  return respondCli(ctx, envelope, record, {
    target,
    lane: 'cli',
    tier: 'cache',
    freshnessHtml: freshness,
    linked: true,
    control: { kind: 'refresh', target, lane: 'cli' },
  });
}

async function serveCli(ctx: RenderContext, target: string): Promise<Response> {
  let registry: RegistryIndex;
  try {
    registry = await loadRegistryIndex(ctx.env);
  } catch {
    return unavailable(ctx);
  }
  const slugEntry = Object.hasOwn(registry.by_slug, target) ? registry.by_slug[target] : undefined;
  if (hasScorecard(slugEntry)) {
    const curated = await serveCurated(ctx, slugEntry);
    if (curated) return curated;
  }
  const alias = curatedEntryForBinary(target, registry);
  if (hasScorecard(alias) && alias.name !== target) return redirect(pathFor(alias.name, ctx.served.representation));

  const inFlight = await inFlightResponse(ctx, 'cli', target);
  if (inFlight) return inFlight;
  const record = await cliCacheGet(ctx.env, cliKeyFor(target, SPEC_VERSION));
  if (!record) return missing(ctx, target, 'cli');
  const envelope = buildCliEnvelope({ tier: 'cache', target, record, registry, origin: ctx.origin });
  const date = shortDate(cliScoredAt(record));
  const version = record.tool_version ? `v${escHtml(record.tool_version)}` : '';
  const freshness = `Scored${version ? ` ${version}` : ''}${date ? ` on ${escHtml(date)}` : ''}. Re-audit runs a fresh audit.`;
  return respondCli(ctx, envelope, record, {
    target,
    lane: 'cli',
    tier: 'cache',
    freshnessHtml: freshness,
    linked: true,
    control: { kind: 'refresh', target, lane: 'cli' },
  });
}

async function seedEntryFor(env: ResultEnv, host: string): Promise<WebSeedEntry | undefined> {
  try {
    return (await loadWebSeed(env)).find((entry) => entry.domain === host);
  } catch {
    return undefined;
  }
}

async function registryOrNull(env: ResultEnv): Promise<RegistryIndex | null> {
  try {
    return await loadRegistryIndex(env);
  } catch {
    return null;
  }
}

function cliScoredAt(record: { scored_at?: unknown; scorecard: unknown }): string | null {
  if (typeof record.scored_at === 'string') return record.scored_at;
  const started = (record.scorecard as { run?: { started_at?: unknown } } | null)?.run?.started_at;
  return typeof started === 'string' ? started : null;
}

/** A curated slug serves the build-emitted asset; anything but a 200 is not a hit. */
async function serveCurated(ctx: RenderContext, entry: RegistryEntryLike): Promise<Response | null> {
  // The binding's html_handling serves `<slug>.html` at the extensionless
  // path and answers the `.html` form with a redirect; ask the way a browser does.
  const suffix = ctx.representation === 'json' ? '.json' : ctx.representation === 'md' ? '.md' : '';
  const asset = await ctx.env.ASSETS.fetch(new Request(`https://assets.internal${scorePath(entry.name)}${suffix}`));
  if (asset.status !== 200) return null;
  if (ctx.representation === 'json') {
    let baked: { spec_version?: unknown; scorecard?: unknown };
    try {
      baked = (await asset.json()) as { spec_version?: unknown; scorecard?: unknown };
    } catch {
      return null;
    }
    const envelope = buildRegistryEnvelope({
      entry,
      origin: ctx.origin,
      specVersion: typeof baked.spec_version === 'string' ? baked.spec_version : SPEC_VERSION,
      scorecard: baked.scorecard,
    });
    return finish(ctx, jsonResponse(envelopeJsonBody(envelope)), 'json', { curated: true });
  }
  const body = await asset.text();
  const headers: Record<string, string> =
    ctx.representation === 'md' ? {} : { 'content-type': 'text/html; charset=utf-8' };
  return finish(ctx, new Response(body, { status: 200, headers }), ctx.representation, { curated: true });
}

async function inFlightResponse(ctx: RenderContext, lane: Lane, target: string): Promise<Response | null> {
  if (ctx.representation !== 'json') return null;
  const flag = await readInFlight(ctx.env, lane, target);
  if (!flag) return null;
  return new Response(JSON.stringify({ in_progress: true, started_at: flag.started_at }), {
    status: 202,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-robots-tag': 'noindex',
    },
  });
}

function unavailable(ctx: RenderContext): Response {
  const body =
    ctx.representation === 'json'
      ? JSON.stringify({ error: { code: 'service_misconfigured', message: 'The registry index is unavailable.' } })
      : 'The registry index is unavailable; try again shortly.\n';
  const headers: Record<string, string> = { 'retry-after': String(RETRY_AFTER_SECONDS) };
  if (ctx.representation === 'html') headers['content-type'] = 'text/plain; charset=utf-8';
  return finish(ctx, new Response(body, { status: 503, headers }), ctx.representation);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// A live or branch result is on-demand, so its page is unlisted.
async function respondCli(
  ctx: RenderContext,
  envelope: AuditEnvelope,
  record: { tool_version: string; anc_version: string; spec_version: string; scorecard: unknown },
  spine: SpineInput,
): Promise<Response> {
  const scorecard = record.scorecard as Parameters<typeof buildScorecardBody>[1];
  const tool = {
    name: (scorecard as { tool?: { name?: string } }).tool?.name ?? spine.target,
    binary: (scorecard as { tool?: { binary?: string } }).tool?.binary ?? spine.target,
  };
  const links = { scorecard: envelope.scorecard_url, markdown: envelope.markdown_url, json: envelope.json_url };
  return respond(ctx, {
    envelope,
    tier: 'cache',
    spine,
    noindex: true,
    html: async () =>
      buildScorecardBody(tool, scorecard, { version: record.tool_version, spine, showBadgePreview: false }),
    markdown: async () =>
      buildScorecardMarkdown(tool, scorecard, {
        version: record.tool_version,
        baseUrl: ctx.origin,
        links,
        lane: 'cli',
        tier: 'cache',
      }),
  });
}

async function respond(ctx: RenderContext, rendered: Rendered): Promise<Response> {
  const { representation } = ctx;
  const noindex = rendered.noindex;
  if (representation === 'json') {
    return finish(ctx, jsonResponse(envelopeJsonBody(rendered.envelope), noindex), 'json', { noindex });
  }
  if (representation === 'md') {
    const body = await rendered.markdown();
    return finish(ctx, new Response(body, { status: 200 }), 'md', { noindex });
  }
  let template: string;
  try {
    template = await loadShellTemplate(ctx.env);
  } catch (err) {
    return new Response(`shell template unavailable: ${err instanceof Error ? err.message : String(err)}`, {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const { target, lane } = rendered.spine;
  const pct = rendered.envelope.score_pct;
  const title = `${target} — ${lane === 'web' ? 'Agent-Readiness Audit' : 'Agent-Native Scorecard'}`;
  const description =
    lane === 'web'
      ? `${target} scored ${pct ?? 0}% for agent-readiness against the agentnative web audit (spec ${rendered.envelope.spec_version}).`
      : `${target} scored ${pct ?? 0}% against the agent-native CLI standard (spec ${rendered.envelope.spec_version}).`;
  const body = `${await rendered.html()}${controlAssets(ctx, rendered.spine)}`;
  const html = substituteShell(template, {
    title,
    description,
    canonicalPath: scorePath(target),
    markdownTwinPath: scoreMarkdownPath(target),
    body,
    alternatesHtml: resultAlternateLinks(target),
  });
  return finish(
    ctx,
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    'html',
    {
      noindex,
    },
  );
}

/** The sitekey meta and the control's script ship only on pages that carry the control. */
function controlAssets(ctx: RenderContext, spine: SpineInput): string {
  if (!spine.control) return '';
  const sitekey = escHtml(ctx.env.TURNSTILE_SITEKEY ?? '');
  return `\n<meta name="turnstile-sitekey" content="${sitekey}" />\n<script defer src="${REAUDIT_SCRIPT}"></script>`;
}

function jsonResponse(body: Record<string, unknown>, noindex = false): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: noindex ? { 'x-robots-tag': 'noindex' } : {} });
}

/**
 * Apply the site header policy for the representation actually served,
 * keyed by the request path so pinned twins carry no Vary and the bare
 * path does, with the cache class this route knows and the path cannot:
 * a curated page is bake-at-build, a live result is HIT-min under its
 * purge tag. A `?v=` query makes the response uncacheable. A JSON
 * response never carries a cookie.
 */
function finish(
  ctx: RenderContext,
  response: Response,
  representation: Representation,
  opts: { noindex?: boolean; curated?: boolean } = {},
): Response {
  const servedMarkdown = representation === 'md';
  const servedJson = representation === 'json';
  const cache: CacheClassSpec = ctx.url.searchParams.has('v')
    ? { klass: 'miss' }
    : resultCacheClass({ curated: opts.curated === true, lane: ctx.lane, target: ctx.served.target, representation });
  const headed = applyHeaders(response, {
    request: ctx.request,
    servedMarkdown,
    servedJson,
    pathname: scorePath(ctx.served.target),
    cache,
  });
  if (opts.noindex) headed.headers.set('X-Robots-Tag', 'noindex');
  if (ctx.negotiated) headed.headers.set('Vary', 'Accept, User-Agent');
  headed.headers.delete('Set-Cookie');
  return headed;
}

// ---------------------------------------------------------------------------
// 404: one sentence, one prefilled audit link, a "Did you mean?" list.
// ---------------------------------------------------------------------------

type NotFoundInput = { target: string; lane: Lane | null; rep: Representation; legacy?: boolean };

// A healthy candidate list holds for the minute; a degraded one (no
// aggregate) is retried sooner so an R2 blip does not pin seed-only lists.
const HOST_CANDIDATES_DEGRADED_TTL_MS = 10_000;
let hostCandidatesMemo: { at: number; ttl: number; hosts: string[]; env: ResultEnv } | null = null;
let aggregateWarned = false;

/** Test-only: drop the host-candidate memo. */
export function _resetResultCaches(): void {
  hostCandidatesMemo = null;
  aggregateWarned = false;
}

async function cliCandidates(env: ResultEnv): Promise<string[]> {
  const registry = await registryOrNull(env);
  if (!registry) return [];
  const names = new Set<string>();
  for (const entry of Object.values(registry.by_slug)) {
    if (!hasScorecard(entry)) continue;
    names.add(entry.name);
    if (entry.binary) names.add(entry.binary);
  }
  return [...names];
}

/** Seeded hosts plus the leaderboard aggregate's hosts, memoized for a minute; a null aggregate degrades to seed-only. */
async function hostCandidates(env: ResultEnv, now: number): Promise<string[]> {
  if (hostCandidatesMemo && hostCandidatesMemo.env === env && now - hostCandidatesMemo.at < hostCandidatesMemo.ttl) {
    return hostCandidatesMemo.hosts;
  }
  const hosts = new Set<string>();
  try {
    for (const entry of await loadWebSeed(env)) hosts.add(entry.domain);
  } catch {
    // A missing seed leaves the aggregate as the only source.
  }
  const aggregate = await getAggregate(env, 'leaderboard', SPEC_VERSION);
  if (aggregate) {
    for (const entry of aggregate.entries) hosts.add(entry.domain);
  } else if (!aggregateWarned) {
    aggregateWarned = true;
    emitLog({ scope: 'audit.result' }, { outcome: 'aggregate_unavailable', fallback: 'seed_only' }, { level: 'warn' });
  }
  const ttl = aggregate ? HOST_CANDIDATES_TTL_MS : HOST_CANDIDATES_DEGRADED_TTL_MS;
  hostCandidatesMemo = { at: now, ttl, hosts: [...hosts], env };
  return hostCandidatesMemo.hosts;
}

async function suggestionsFor(env: ResultEnv, deps: ResultDeps, target: string, lane: Lane | null): Promise<string[]> {
  if (!target || !lane) return [];
  const candidates = lane === 'web' ? await hostCandidates(env, deps.now?.() ?? Date.now()) : await cliCandidates(env);
  return suggestTargets(target, candidates, { limit: SUGGESTION_LIMIT });
}

function missing(ctx: RenderContext, target: string, lane: Lane): Promise<Response> {
  return notFound(ctx.request, ctx.env, ctx.deps, { target, lane, rep: ctx.representation, legacy: ctx.served.legacy });
}

async function notFound(request: Request, env: ResultEnv, deps: ResultDeps, input: NotFoundInput): Promise<Response> {
  const { origin, pathname } = new URL(request.url);
  const audit = auditPath(input.lane ? { lane: input.lane, target: input.target } : { target: input.target });
  const suggestions = await suggestionsFor(env, deps, input.target, input.lane);
  const message = `No audit exists for ${input.target} yet.`;
  const opts = { request, pathname, servedMarkdown: input.rep === 'md', servedJson: input.rep === 'json' };

  if (input.rep === 'json') {
    const body = {
      error: { code: 'not_found', message },
      audit_url: `${origin}${audit}`,
      suggestions: suggestions.map((s) => ({ target: s, scorecard_url: `${origin}${scorePath(s)}` })),
    };
    return applyHeaders(new Response(JSON.stringify(body), { status: 404 }), opts);
  }
  if (input.rep === 'md') {
    const lines = [
      `# No audit exists for \`${input.target}\` yet.`,
      '',
      `[Audit \`${input.target}\`](${origin}${audit})`,
      '',
    ];
    if (suggestions.length > 0) {
      lines.push('## Did you mean?', '', ...suggestions.map((s) => `- [${s}](${origin}${scorePath(s)})`), '');
    }
    return applyHeaders(new Response(lines.join('\n'), { status: 404 }), opts);
  }
  const did =
    suggestions.length > 0
      ? `\n<section class="result-suggest"><h2>Did you mean?</h2><ul>${suggestions
          .map((s) => `<li><a href="${escHtml(scorePath(s))}">${escHtml(s)}</a></li>`)
          .join('')}</ul></section>`
      : '';
  const body = `<article class="container scorecard-page result-missing">
<header class="result-spine"><h1 class="result-spine__title">No audit exists for <code>${escHtml(input.target)}</code> yet.</h1>
<p class="live-score-summary__meta"><a class="btn btn--primary" href="${escHtml(audit)}">Audit <code>${escHtml(input.target)}</code></a></p></header>${did}
</article>`;
  let template: string;
  try {
    template = await loadShellTemplate(env);
  } catch (err) {
    return new Response(`shell template unavailable: ${err instanceof Error ? err.message : String(err)}`, {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const html = substituteShell(template, {
    title: 'Not audited yet — anc.dev',
    description: message,
    canonicalPath: pathname,
    markdownTwinPath: input.legacy ? undefined : `${pathname}/md`,
    body,
    alternatesHtml: '',
  });
  return applyHeaders(
    new Response(html, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    opts,
  );
}
