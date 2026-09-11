// Web-audit Worker routes.
//
//   POST /api/audit-web         the legacy streaming dispatch the deployed
//                               web-audit clients post to
//   GET  /web/scoring/<domain>  in-progress streaming page (JS-required)
//
// The result page lives in `src/worker/audit/result.ts`; the legacy
// `/web/<domain>` path is an adapter over it.
//
// The POST path serves cache state as data ahead of every metered gate,
// then admits a fresh audit through its gate block (kill switch,
// Turnstile, session, the session limiter with a per-IP fallback, the
// hourly window, the per-domain flip budget) and runs the lane core in
// `./core.ts`, which the unified transact endpoint composes as well. The
// legacy wire shape (`share_url`, the bare `check` and `complete` lines)
// is translated from the core's shared events here. The complete
// scorecard is written to R2 inside a ctx.waitUntil task so a mid-stream
// client disconnect still caches a completed run; a deadline-exceeded run
// streams an `incomplete` terminal and is never persisted.

import { escHtml } from '../../shared/esc-html';
import { detectPreference } from '../accept';
import { applyHeaders } from '../headers';
import type { NotifyEnv } from '../notify';
import { issue, newSession, read as readSession, SessionConfigError, type SessionEnv } from '../score/session';
import { type TurnstileEnv, verifyTurnstile } from '../score/turnstile';
import { loadShellTemplate, substituteShell } from '../shell-template';
import { SPEC_VERSION } from '../spec-version.gen';
import type { AuditLogEnv } from './audit-log';
import {
  get as cacheGet,
  canonicalTargetOf,
  getAggregate,
  isBoardListable,
  isStale,
  keyFor,
  listAllWebAudits,
  patchStoredPublicListing,
  scorecardWithPublicListing,
  sha256Hex,
  WEB_AUDIT_STALE_AFTER_MS,
  webAuditFreshness,
} from './cache';
import { flushHitMinPurge, invokeCachedPurge, runWithHitMinPurge, webTag } from './hit-min-purge';

export { canonicalTargetOf };

import { runWebAuditStream, type WebTarget } from './core';
import {
  buildWebLeaderboardBody,
  buildWebLeaderboardMarkdown,
  type WebBoardEntry,
  type WebBoardView,
} from './leaderboard-render';
import { consumeWebAuditHourlyBudget } from './limiter';
import { decidePublicListingWrite, enforcePublicListingFlipLimit, resolveAuditListing } from './public-listing';
import { boardExcludeDomains } from './seed';
import { validatePublicUrl } from './ssrf';

type RateLimit = { limit(o: { key: string }): Promise<{ success: boolean }> };

export interface WebAuditRouteEnv extends TurnstileEnv, SessionEnv, AuditLogEnv, NotifyEnv {
  ASSETS: Fetcher;
  SCORE_CACHE: R2Bucket;
  SCORE_KV?: KVNamespace;
  WEB_AUDIT_ENABLED?: string;
  // Public sitekey the /web/scoring page bakes into its Turnstile widget;
  // empty on unprovisioned envs (the client disables with an MCP pointer).
  TURNSTILE_SITEKEY?: string;
  // Session-keyed burst limiter (`<sid>:<sha256(target)>`, 10/60s) for the
  // fresh HTTP path; WEB_AUDIT_LIMITER_IP is the coarse per-IP fallback
  // (30/60s) that caps a client swapping the session cookie.
  WEB_AUDIT_LIMITER?: RateLimit;
  WEB_AUDIT_LIMITER_IP?: RateLimit;
}

export interface WebAuditRouteDeps {
  /** Injected probe fetch for tests; production uses global fetch. */
  probeFetch?: typeof fetch;
  /** Injected Turnstile siteverify fetch for tests; production uses global fetch. */
  turnstileFetch?: typeof fetch;
}

export function isWebAuditPath(pathname: string): boolean {
  return pathname === '/api/audit-web';
}

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}

/** 429 with the session cookie threaded so a rate-limit bounce keeps the session. */
function rateLimited(message: string, setCookie: string | null): Response {
  return jsonResponse({ error: 'rate_limit', message, retry_after: 60 }, 429, cookieHeader(setCookie));
}

/** 429 for an exhausted per-domain listing-flip budget, distinct from the audit rate limit. */
function flipRateLimited(setCookie: string | null): Response {
  return jsonResponse(
    {
      error: 'flip_rate_limited',
      message: 'too many public_listing changes for this domain; try again later',
      retry_after: 3600,
    },
    429,
    cookieHeader(setCookie),
  );
}

/** Fail-fast 500 for a missing bot-defense secret on the fresh path. */
function serviceMisconfigured(err: unknown): Response {
  const details = err instanceof Error ? err.message : String(err);
  return jsonResponse({ error: 'service_misconfigured', message: details }, 500);
}

function cookieHeader(setCookie: string | null): Record<string, string> {
  return setCookie ? { 'set-cookie': setCookie } : {};
}

/** Prepend https:// when the input carries no scheme; null on unparseable input. */
export function coerceUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

export async function handleWebAudit(
  request: Request,
  env: WebAuditRouteEnv,
  ctx: ExecutionContext,
  deps: WebAuditRouteDeps = {},
): Promise<Response> {
  // 1. Method.
  if (request.method !== 'POST') {
    return new Response('method not allowed\n', {
      status: 405,
      headers: { Allow: 'POST', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  // 2. Body + URL parse.
  let body: { url?: unknown; site_type?: unknown; turnstile_token?: unknown; public_listing?: unknown };
  try {
    body = (await request.json()) as {
      url?: unknown;
      site_type?: unknown;
      turnstile_token?: unknown;
      public_listing?: unknown;
    };
  } catch {
    return jsonResponse(
      { error: 'invalid_body', message: 'POST body must be JSON { url, site_type?, turnstile_token }' },
      400,
    );
  }
  const url = coerceUrl(body.url);
  if (!url) {
    return jsonResponse({ error: 'invalid_url', message: 'provide a valid { url }' }, 400);
  }
  // Declared site type: absent = run everything.
  if (body.site_type !== undefined && body.site_type !== 'content' && body.site_type !== 'api') {
    return jsonResponse({ error: 'invalid_site_type', message: 'site_type must be "content" or "api"' }, 400);
  }
  const siteType = (body.site_type as 'content' | 'api' | undefined) ?? null;
  // Opt-in board listing: strict boolean, kept distinct from omitted so a
  // blank never erases a stored choice. Reject any non-boolean, including a
  // "false" string or a number, before any metered gate.
  if (body.public_listing !== undefined && typeof body.public_listing !== 'boolean') {
    return jsonResponse({ error: 'invalid_public_listing', message: 'public_listing must be a boolean' }, 400);
  }
  const publicListing = body.public_listing as boolean | undefined;
  const canonicalTarget = canonicalTargetOf(url);
  const shareDomain = url.host;

  // 3. SSRF pre-flight — before the cache read (the cache key needs the URL)
  // and before any probe or metered gate.
  const validation = validatePublicUrl(canonicalTarget);
  if (!validation.ok) {
    return jsonResponse({ error: validation.reason }, 400);
  }

  // 4. Cache hit — cache state is data, served ahead of every metered gate
  // including the kill switch, so a cached read needs no source IP, no
  // Turnstile, and consumes no budget (the audit_website MCP tool orders
  // its gates the same way). A hit older than the staleness threshold
  // falls through to the fresh path so a re-run refreshes the board.
  // Every result-bearing response spreads the shared freshness envelope
  // beside the scorecard, so `cached`, `scored_at`, and `refresh_after`
  // always travel together and outside schema 0.4.
  const shareUrl = `/web/${shareDomain}`;
  const cached = await cacheGet(env, await keyFor(canonicalTarget, SPEC_VERSION));
  const listingWrite = decidePublicListingWrite({ explicit: publicListing, cached });
  if (cached && !isStale(cached.scored_at, WEB_AUDIT_STALE_AFTER_MS)) {
    // A fresh hit is served as data unless an explicit, differing
    // public_listing asks for a flag-only patch — that falls through the
    // full gate stack (kill switch, Turnstile, limiters) like a fresh audit.
    if (listingWrite.path === 'serve-cached') {
      return jsonResponse(
        { ...webAuditFreshness(true, cached.scored_at), scorecard: cached.scorecard, share_url: shareUrl },
        200,
      );
    }
  }

  // 5. Kill switch — a stale hit is still data when fresh audits are off,
  // so only a true miss surfaces the 503.
  if (env.WEB_AUDIT_ENABLED !== 'true') {
    if (cached) {
      return jsonResponse(
        { ...webAuditFreshness(true, cached.scored_at), scorecard: cached.scorecard, share_url: shareUrl },
        200,
      );
    }
    return new Response('web audit is currently disabled by the operator\n', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '3600', 'cache-control': 'no-store' },
    });
  }

  // 6. Turnstile siteverify. Missing secret is a fail-fast 500 — the fresh
  // path MUST NOT accept traffic with the bot-defense layer silently
  // disabled. A tokenless direct POST is not a supported surface; agents
  // use the MCP tool.
  const token = typeof body.turnstile_token === 'string' ? body.turnstile_token : null;
  let verify: Awaited<ReturnType<typeof verifyTurnstile>>;
  try {
    verify = await verifyTurnstile(env, token, {
      fetcher: deps.turnstileFetch,
      remoteIp: request.headers.get('cf-connecting-ip') ?? undefined,
    });
  } catch (err) {
    return serviceMisconfigured(err);
  }
  if (!verify.ok) {
    if (verify.reason === 'misconfigured') return serviceMisconfigured('TURNSTILE_SECRET missing');
    return jsonResponse({ error: 'turnstile_failed', message: 'verification challenge failed; please retry' }, 400);
  }

  // 7. Session cookie mint/read. A fresh session is minted on the first
  // passing-Turnstile request; subsequent requests reuse it via the
  // `__Host-anc-session` cookie (Path=/, so a cookie minted by /api/score
  // is valid here). Missing SESSION_HMAC_SECRET is a fail-fast 500.
  let session: { sid: string };
  let setCookie: string | null = null;
  try {
    const existing = await readSession(env, request);
    if (existing) {
      session = existing;
    } else {
      const fresh = newSession();
      setCookie = await issue(env, fresh);
      session = fresh;
    }
  } catch (err) {
    if (err instanceof SessionConfigError) return serviceMisconfigured('SESSION_HMAC_SECRET missing');
    throw err;
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';

  // 8. Session limiter (10/60s) keyed `<sid>:<sha256(canonical target)>`.
  // Same session auditing the same target does not burn budget on a retry;
  // a new session requires a fresh Turnstile solve.
  if (env.WEB_AUDIT_LIMITER) {
    const key = `${session.sid}:${await sha256Hex(canonicalTarget)}`;
    const { success } = await env.WEB_AUDIT_LIMITER.limit({ key });
    if (!success) {
      return rateLimited('audit rate limit exceeded (burst)', setCookie);
    }
  }
  // 9. Coarse per-IP fallback (30/60s) — a client swapping the session
  // cookie to dodge the session limiter still gets capped.
  if (env.WEB_AUDIT_LIMITER_IP) {
    const { success } = await env.WEB_AUDIT_LIMITER_IP.limit({ key: ip });
    if (!success) {
      return rateLimited('audit rate limit exceeded (burst)', setCookie);
    }
  }
  // 10. KV hourly window (30/hr/IP), shared with the audit_website MCP tool.
  if (env.SCORE_KV) {
    const ok = await consumeWebAuditHourlyBudget(env.SCORE_KV, ip);
    if (!ok) {
      return rateLimited('audit rate limit exceeded (30 per hour per source)', setCookie);
    }
  }

  // 11. Per-domain flip budget — a write that changes the stored
  // public_listing (a flag-only patch, or a re-audit that resolves to a
  // different value) is additionally capped per domain, since the flag is
  // submitter-set with no ownership check and a flip is far cheaper than a
  // full audit. Enforced through the shared helper the MCP tool also calls, so
  // both surfaces draw from one budget per domain. A no-op serve or same-value
  // re-audit spends nothing. Rejected before the write.
  if (
    (await enforcePublicListingFlipLimit({ write: listingWrite, kv: env.SCORE_KV, domain: shareDomain })) ===
    'rate-limited'
  ) {
    return flipRateLimited(setCookie);
  }

  // 12. Fresh-window flag patch — the request only changes public_listing,
  // so no re-audit runs; the preserving writer rewrites both stores without
  // resetting scored_at. A write failure surfaces an error rather than a
  // fabricated success the client would follow as a saved result.
  if (listingWrite.path === 'patch') {
    const wrote = await patchStoredPublicListing(env, listingWrite.cached, listingWrite.value);
    if (!wrote) {
      return jsonResponse(
        { error: 'patch_failed', message: 'failed to persist the public_listing change; please retry' },
        500,
        cookieHeader(setCookie),
      );
    }
    await invokeCachedPurge(ctx, [webTag()]);
    const patchedScorecard = scorecardWithPublicListing(listingWrite.cached.scorecard, listingWrite.value);
    return jsonResponse(
      {
        ...webAuditFreshness(true, listingWrite.cached.scored_at),
        scorecard: patchedScorecard,
        share_url: shareUrl,
      },
      200,
      cookieHeader(setCookie),
    );
  }

  // 13. Miss or stale hit: run the lane core and translate its shared
  // events onto the legacy wire shape. The core writes R2, queues the
  // purge, and rebuilds the seeded aggregates inside this waitUntil task.
  const auditListing = resolveAuditListing(listingWrite, publicListing, cached);
  const target: WebTarget = { host: shareDomain, canonical: canonicalTarget };
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const write = (line: unknown) => writer.write(encoder.encode(`${JSON.stringify(line)}\n`)).catch(() => {});

  ctx.waitUntil(
    runWithHitMinPurge(ctx, async () => {
      try {
        for await (const event of runWebAuditStream({
          env,
          target,
          siteType,
          listing: auditListing,
          origin: new URL(request.url).origin,
          probeFetch: deps.probeFetch,
          surface: 'stream',
        })) {
          if (event.type === 'discovery') {
            await write({ type: 'discovery', mcp_endpoint: event.mcp_endpoint });
          } else if (event.type === 'check') {
            await write(event);
          } else if (event.type === 'complete') {
            await write({ type: 'complete', ...event.freshness, scorecard: event.scorecard, share_url: shareUrl });
          } else if (event.type === 'incomplete') {
            await write({ type: 'incomplete', scorecard: event.scorecard, share_url: null });
          } else if (event.type === 'error') {
            await write({ type: 'error', message: event.error.message });
          }
        }
      } finally {
        await writer.close().catch(() => {});
        await flushHitMinPurge();
      }
    }),
  );

  return new Response(readable, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      ...cookieHeader(setCookie),
    },
  });
}

// ---------------------------------------------------------------------------
// GET /web board + .md twin — rendered at request time. The curated
// view reads the R2 leaderboard aggregate (the same source the homepage
// pane and the list_website_audits tool read); the all view additionally
// enumerates the audit cache for non-expired user-submitted rows.
// ---------------------------------------------------------------------------

export function isWebLeaderboardPath(pathname: string): boolean {
  return pathname === '/web' || pathname === '/web.md';
}

export async function handleWebLeaderboard(request: Request, env: WebAuditRouteEnv): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'content-type': 'text/plain', 'cache-control': 'no-store' },
    });
  }
  const url = new URL(request.url);
  const wantMarkdown = url.pathname.endsWith('.md') || detectPreference(request) === 'markdown';
  // Unrecognized view values fall back to the all-cache default so a
  // mistyped parameter never 404s a shareable board URL.
  const view: WebBoardView = url.searchParams.get('view') === 'curated' ? 'curated' : 'all';
  const sortRaw = url.searchParams.get('sort');
  const sort: 'global' | 'relative' | null = sortRaw === 'relative' || sortRaw === 'global' ? sortRaw : null;

  const aggregate = await getAggregate(env, 'leaderboard', SPEC_VERSION);
  const curatedEntries: WebBoardEntry[] = (aggregate?.entries ?? []).map((e) => ({ ...e, curated: true }));

  let entries = curatedEntries;
  let userCount = 0;
  if (view === 'all') {
    const excludeDomains = await boardExcludeDomains(
      env,
      curatedEntries.map((e) => e.domain),
    );
    // Opt-in gate on the shared enumeration, upstream of both renderers, so
    // the HTML board and its .md twin can never disagree on which non-curated
    // rows list. Curated rows come from the aggregate above and never pass here.
    const userSubmitted = (await listAllWebAudits(env, { specVersion: SPEC_VERSION, excludeDomains })).filter(
      isBoardListable,
    );
    const userEntries: WebBoardEntry[] = userSubmitted.map((l) => ({
      domain: l.domain,
      url: `https://${l.domain}/`,
      name: l.name,
      description: '',
      score_pct: l.score_pct,
      score: l.score,
      curated: false,
    }));
    entries = curatedEntries.concat(userEntries);
    userCount = userEntries.length;
  }
  const renderOpts = { view, curatedCount: curatedEntries.length, userCount, sort };

  if (wantMarkdown) {
    return new Response(buildWebLeaderboardMarkdown(entries, url.origin, renderOpts), {
      status: 200,
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
    });
  }

  let template: string;
  try {
    template = await loadShellTemplate(env);
  } catch (err) {
    return new Response(`shell template unavailable: ${err instanceof Error ? err.message : String(err)}`, {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });
  }
  const html = substituteShell(template, {
    title: 'Web Agent-Readiness Leaderboard — anc.dev',
    description:
      'Agent-readiness scores for websites and their MCP servers, scored against the eight agent-native principles.',
    canonicalPath: view === 'curated' ? '/web?view=curated' : '/web',
    body: buildWebLeaderboardBody(entries, renderOpts),
  });
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ---------------------------------------------------------------------------
// Path shapes under /web/ and the header policy the scoring page shares
// ---------------------------------------------------------------------------

// Strict domain slug: labels of alphanumerics + hyphens joined by dots,
// optional :port. No uppercase, no path traversal, bounded length. This
// is the user-input boundary for the R2 lookup, so the regex is tight.
const DOMAIN_SLUG_RE = /^(?=.{1,253}(?::|$))[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*(:[0-9]{1,5})?$/;

/** Reserved `/web/scoring` prefix — the in-progress streaming page. */
export function isWebScoringPath(pathname: string): boolean {
  return pathname === '/web/scoring' || pathname === '/web/scoring.md' || pathname.startsWith('/web/scoring/');
}

export type WebScoringPathMatch = { domain: string | null; isMarkdown: boolean };

export function parseWebScoringPath(pathname: string): WebScoringPathMatch | null {
  if (pathname === '/web/scoring') return { domain: null, isMarkdown: false };
  if (pathname === '/web/scoring.md') return { domain: null, isMarkdown: true };
  const m = pathname.match(/^\/web\/scoring\/([^/]+?)(\.md)?$/);
  if (!m) return null;
  return DOMAIN_SLUG_RE.test(m[1]) ? { domain: m[1], isMarkdown: m[2] === '.md' } : null;
}

function withNegotiatedHeaders(
  request: Request,
  response: Response,
  servedMarkdown: boolean,
  pathname: string,
  opts: { noStore?: boolean } = {},
): Response {
  const headed = applyHeaders(response, { request, servedMarkdown, pathname });
  if (opts.noStore) {
    headed.headers.set('Cache-Control', 'no-store');
    headed.headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
    headed.headers.delete('Cache-Tag');
  }
  return headed;
}

// ---------------------------------------------------------------------------
// GET /web/scoring/<domain> in-progress streaming page (JS-required)
// ---------------------------------------------------------------------------

// The page is transient and carries a request-time sitekey, so it is never
// cached and never indexed.
const SCORING_HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
} as const;

const SCORING_MARKDOWN_HEADERS = {
  'Content-Type': 'text/markdown; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
} as const;

export async function handleWebScoringPage(request: Request, env: WebAuditRouteEnv): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'content-type': 'text/plain', 'cache-control': 'no-store' },
    });
  }
  const url = new URL(request.url);
  const match = parseWebScoringPath(url.pathname);
  if (!match) {
    return withNegotiatedHeaders(
      request,
      new Response('not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }),
      false,
      url.pathname,
    );
  }

  const wantMarkdown = match.isMarkdown || detectPreference(request) === 'markdown';
  if (wantMarkdown) {
    return withNegotiatedHeaders(
      request,
      new Response(scoringMarkdown(match.domain, url.origin), { status: 200, headers: SCORING_MARKDOWN_HEADERS }),
      true,
      url.pathname,
      { noStore: true },
    );
  }

  const title = match.domain ? `Auditing ${match.domain} — anc.dev` : 'Audit a website — anc.dev';
  const description = match.domain
    ? `Running the agent-readiness audit for ${match.domain}.`
    : 'Start an agent-readiness audit at anc.dev/web-audit.';
  const canonicalPath = match.domain ? `/web/scoring/${match.domain}` : '/web/scoring';

  let template: string;
  try {
    template = await loadShellTemplate(env);
  } catch (err) {
    return new Response(`shell template unavailable: ${err instanceof Error ? err.message : String(err)}`, {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });
  }
  const body = match.domain ? scoringBody(match.domain, env.TURNSTILE_SITEKEY ?? '') : scoringPointerBody();
  const html = substituteShell(template, { title, description, canonicalPath, body });
  return withNegotiatedHeaders(
    request,
    new Response(html, { status: 200, headers: SCORING_HTML_HEADERS }),
    false,
    url.pathname,
    { noStore: true },
  );
}

// The sitekey meta and the page script are injected in the body substitution
// rather than the shared shell, so the shell template needs no per-page slot.
function scoringBody(domain: string, sitekey: string): string {
  const d = escHtml(domain);
  return `<article class="container scorecard-page" data-web-audit-scoring>
  <meta name="turnstile-sitekey" content="${escHtml(sitekey)}" />
  <header class="scorecard-header">
    <h1>Auditing <code>${d}</code>&hellip;</h1>
    <p class="live-score-summary__meta">Each check streams in as it resolves. You'll be forwarded to the saved scorecard when the audit finishes.</p>
  </header>
  <p class="live-score__status" data-web-audit-status role="status" aria-live="polite">Starting audit&hellip;</p>
  <table class="audit-table">
    <tbody data-web-audit-results></tbody>
  </table>
  <p class="scorecard-cta" data-web-audit-retry hidden>
    <a class="btn" href="/web-audit">Start another audit</a>
  </p>
  <noscript>
    <p>This page streams a live audit with JavaScript. Without it, fetch <a href="/web/${d}.md">/web/${d}.md</a> for a saved result, or run the <code>audit_website</code> MCP tool at <a href="/mcp">/mcp</a>.</p>
  </noscript>
  <script defer src="/js/web-audit-scoring.js"></script>
</article>`;
}

function scoringPointerBody(): string {
  return `<article class="container scorecard-page">
  <header class="scorecard-header">
    <h1>Audit a website</h1>
    <p class="live-score-summary__meta">This is the in-progress page for a running audit.</p>
  </header>
  <section class="scorecard-cta">
    <p>Start an audit at <a href="/web-audit">anc.dev/web-audit</a>, or call the <code>audit_website</code> MCP tool.</p>
  </section>
</article>`;
}

function scoringMarkdown(domain: string | null, origin: string): string {
  if (!domain) {
    return [
      '# Audit a website',
      '',
      `This is the in-progress page for a running audit. Start one at [${origin}/web-audit](${origin}/web-audit) or call the \`audit_website\` MCP tool.`,
      '',
    ].join('\n');
  }
  return [
    `# Auditing ${domain}`,
    '',
    `A live audit for ${domain} runs in the browser. For a saved result, fetch [/web/${domain}.md](/web/${domain}.md), or call the \`audit_website\` MCP tool with \`${domain}\`.`,
    '',
  ].join('\n');
}
