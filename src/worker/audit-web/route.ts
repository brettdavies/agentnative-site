// Web-audit Worker routes (plan U7 + U8).
//
//   POST /api/audit-web   streaming NDJSON audit dispatch (U7)
//   GET  /web/<domain>    shareable cached result page + .md twin (U8)
//
// The POST path admits a request through the kill switch, SSRF pre-flight,
// no-anon-fallback IP check, burst limiter, and a KV-backed hourly window
// (mirroring the score_cli audit-tier posture), then runs the engine and
// streams each check result as it resolves. The complete scorecard is
// written to R2 inside a ctx.waitUntil task so a mid-stream client
// disconnect still caches a completed run (KTD-13: only complete runs are
// cached; a deadline-exceeded run streams an `incomplete` terminal and is
// never persisted).

import { detectPreference } from '../accept';
import { SPEC_VERSION } from '../spec-version.gen';
import { type CachedWebAudit, get as cacheGet, put as cachePut, keyFor, normalizeTargetUrl } from './cache';
import { runWebAudit } from './engine';
import { consumeWebAuditHourlyBudget } from './limiter';
import { loadWebAuditRegistry } from './registry';
import { loadWebRemediationCatalog, type WebRemediationCatalog } from './remediation';
import type { EngineResult } from './scorecard';
import { validatePublicUrl } from './ssrf';
import { buildWebSummaryBody, buildWebSummaryMarkdown } from './summary-render';

export interface WebAuditRouteEnv {
  ASSETS: Fetcher;
  SCORE_CACHE: R2Bucket;
  SCORE_KV?: KVNamespace;
  WEB_AUDIT_ENABLED?: string;
  WEB_AUDIT_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

export interface WebAuditRouteDeps {
  /** Injected probe fetch for tests; production uses global fetch. */
  probeFetch?: typeof fetch;
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

/** Canonical audited target: scheme + host + `/` (drops port-less path/query/fragment beyond the origin). */
export function canonicalTargetOf(url: URL): string {
  return `${url.protocol}//${url.host}/`;
}

function checkEvent(result: EngineResult): string {
  return `${JSON.stringify({
    type: 'check',
    id: result.id,
    principle: result.principle,
    keyword: result.keyword,
    status: result.status,
    evidence: result.evidence,
  })}\n`;
}

export async function handleWebAudit(
  request: Request,
  env: WebAuditRouteEnv,
  ctx: ExecutionContext,
  deps: WebAuditRouteDeps = {},
): Promise<Response> {
  // 1. Kill switch.
  if (env.WEB_AUDIT_ENABLED !== 'true') {
    return new Response('web audit is currently disabled by the operator\n', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '3600', 'cache-control': 'no-store' },
    });
  }
  // 2. Method.
  if (request.method !== 'POST') {
    return new Response('method not allowed\n', {
      status: 405,
      headers: { Allow: 'POST', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  // 3. Body + URL parse.
  let body: { url?: unknown; site_type?: unknown };
  try {
    body = (await request.json()) as { url?: unknown; site_type?: unknown };
  } catch {
    return jsonResponse({ error: 'invalid_body', message: 'POST body must be JSON { url, site_type? }' }, 400);
  }
  const url = coerceUrl(body.url);
  if (!url) {
    return jsonResponse({ error: 'invalid_url', message: 'provide a valid { url }' }, 400);
  }
  // Declared site type (R6): absent = run everything.
  if (body.site_type !== undefined && body.site_type !== 'content' && body.site_type !== 'api') {
    return jsonResponse({ error: 'invalid_site_type', message: 'site_type must be "content" or "api"' }, 400);
  }
  const siteType = (body.site_type as 'content' | 'api' | undefined) ?? null;
  const canonicalTarget = canonicalTargetOf(url);
  const shareDomain = url.host;

  // 4. SSRF pre-flight — before any probe or limiter spend.
  const validation = validatePublicUrl(canonicalTarget);
  if (!validation.ok) {
    return jsonResponse({ error: validation.reason }, 400);
  }

  // 5. cf-connecting-ip presence (no anon fallback at the audit tier).
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip) {
    return jsonResponse({ error: 'rate_limit', message: 'fresh audits require a source IP (cf-connecting-ip)' }, 429);
  }
  // 6. Burst limiter.
  if (env.WEB_AUDIT_LIMITER) {
    const { success } = await env.WEB_AUDIT_LIMITER.limit({ key: ip });
    if (!success) {
      return jsonResponse({ error: 'rate_limit', message: 'audit rate limit exceeded (burst)' }, 429);
    }
  }
  // 7. KV hourly window (shared with the audit_website MCP tool).
  if (env.SCORE_KV) {
    const ok = await consumeWebAuditHourlyBudget(env.SCORE_KV, ip);
    if (!ok) {
      return jsonResponse({ error: 'rate_limit', message: 'audit rate limit exceeded (5 per hour per source)' }, 429);
    }
  }

  // 8. Cache hit — return the cached scorecard without re-running.
  const shareUrl = `/web/${shareDomain}`;
  const cached = await cacheGet(env, await keyFor(canonicalTarget, SPEC_VERSION));
  if (cached) {
    return jsonResponse({ cached: true, scorecard: cached.scorecard, share_url: shareUrl }, 200);
  }

  // 9. Miss — stream the engine, cache the completed result via waitUntil.
  const registry = await loadWebAuditRegistry(env);
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const pump = (async () => {
    let scorecard: unknown = null;
    let complete = false;
    try {
      for await (const event of runWebAudit({
        url: canonicalTarget,
        registry,
        siteType,
        specVersion: SPEC_VERSION,
        fetchOptions: deps.probeFetch ? { fetchImpl: deps.probeFetch } : undefined,
      })) {
        if (event.type === 'discovery') {
          await writer
            .write(encoder.encode(`${JSON.stringify({ type: 'discovery', mcp_endpoint: event.endpoint })}\n`))
            .catch(() => {});
        } else if (event.type === 'result') {
          await writer.write(encoder.encode(checkEvent(event.result))).catch(() => {});
        } else {
          scorecard = event.scorecard;
          complete = event.complete;
        }
      }
      if (scorecard && complete) {
        await cachePut(env, canonicalTarget, scorecard, SPEC_VERSION);
      }
      const terminal = complete
        ? { type: 'complete', scorecard, share_url: shareUrl }
        : { type: 'incomplete', scorecard, share_url: null };
      await writer.write(encoder.encode(`${JSON.stringify(terminal)}\n`)).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await writer.write(encoder.encode(`${JSON.stringify({ type: 'error', message })}\n`)).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  ctx.waitUntil(pump);

  return new Response(readable, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

// ---------------------------------------------------------------------------
// GET /web/<domain> result page + .md twin (U8)
// ---------------------------------------------------------------------------

// Strict domain slug: labels of alphanumerics + hyphens joined by dots,
// optional :port. No uppercase, no path traversal, bounded length. This
// is the user-input boundary for the R2 lookup, so the regex is tight.
const DOMAIN_SLUG_RE = /^(?=.{1,253}(?::|$))[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*(:[0-9]{1,5})?$/;

export type WebResultPathMatch = { domain: string; isMarkdown: boolean };

export function parseWebResultPath(pathname: string): WebResultPathMatch | null {
  const md = pathname.match(/^\/web\/([^/]+)\.md$/);
  if (md) return DOMAIN_SLUG_RE.test(md[1]) ? { domain: md[1], isMarkdown: true } : null;
  const m = pathname.match(/^\/web\/([^/]+)$/);
  if (!m) return null;
  return DOMAIN_SLUG_RE.test(m[1]) ? { domain: m[1], isMarkdown: false } : null;
}

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
  'X-Robots-Tag': 'noindex',
} as const;

const MARKDOWN_HEADERS = {
  'Content-Type': 'text/markdown; charset=utf-8',
  'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
  'X-Robots-Tag': 'noindex',
} as const;

let shellTemplatePromise: Promise<string> | null = null;
async function loadShellTemplate(env: { ASSETS: Fetcher }): Promise<string> {
  if (!shellTemplatePromise) {
    shellTemplatePromise = (async () => {
      const res = await env.ASSETS.fetch(new Request('https://assets.internal/_internal/score-live-shell.html'));
      if (!res.ok) throw new Error(`web-audit shell template missing (status ${res.status})`);
      return await res.text();
    })().catch((err) => {
      shellTemplatePromise = null;
      throw err;
    });
  }
  return shellTemplatePromise;
}

export function _resetWebShellTemplateCache(): void {
  shellTemplatePromise = null;
}

function substituteShell(
  template: string,
  fields: { title: string; description: string; canonicalPath: string; body: string },
): string {
  return template
    .replaceAll('{{TITLE}}', esc(fields.title))
    .replaceAll('{{DESCRIPTION}}', esc(fields.description))
    .replaceAll('{{CANONICAL_PATH}}', esc(fields.canonicalPath))
    .replaceAll('{{BODY}}', fields.body);
}

function esc(s: string): string {
  return s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/**
 * Resolve a domain's audit for the result page. R2 (on-demand audits)
 * wins; on a miss, fall back to the committed curated projection at
 * /_internal/web-scorecards/<domain>.json (leaderboard seeds, static +
 * committed, independent of R2 per KTD-8). Tries https then http for the
 * R2 key since the cache is scheme-specific.
 */
async function lookupByDomain(
  env: WebAuditRouteEnv,
  domain: string,
): Promise<{ scorecard: unknown; targetUrl: string } | null> {
  for (const scheme of ['https', 'http']) {
    const targetUrl = normalizeTargetUrl(`${scheme}://${domain}/`);
    const cached: CachedWebAudit | null = await cacheGet(env, await keyFor(targetUrl, SPEC_VERSION));
    if (cached) return { scorecard: cached.scorecard, targetUrl };
  }
  const curated = await loadCuratedScorecard(env, domain);
  if (curated) return { scorecard: curated, targetUrl: normalizeTargetUrl(`https://${domain}/`) };
  return null;
}

async function loadCuratedScorecard(env: WebAuditRouteEnv, domain: string): Promise<unknown | null> {
  try {
    const res = await env.ASSETS.fetch(new Request(`https://assets.internal/_internal/web-scorecards/${domain}.json`));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function handleWebResultPage(request: Request, env: WebAuditRouteEnv): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { 'content-type': 'text/plain' } });
  }
  const url = new URL(request.url);
  const match = parseWebResultPath(url.pathname);
  if (!match) return renderNotFound(env, '(invalid)', false);

  const wantMarkdown = match.isMarkdown || detectPreference(request) === 'markdown';
  const hit = await lookupByDomain(env, match.domain);
  if (!hit) return renderNotFound(env, match.domain, wantMarkdown);

  // A missing remediation catalog degrades to generic prompts (R10).
  let remediation: WebRemediationCatalog = {};
  try {
    remediation = await loadWebRemediationCatalog(env);
  } catch {
    remediation = {};
  }

  const scorecard = hit.scorecard as {
    tool?: { name?: string; url?: string };
    score_pct?: number;
  };
  const input = {
    scorecard: scorecard as never,
    domain: match.domain,
    targetUrl: scorecard.tool?.url ?? hit.targetUrl,
    remediation,
    origin: new URL(request.url).origin,
  };

  if (wantMarkdown) {
    return new Response(buildWebSummaryMarkdown(input), { status: 200, headers: MARKDOWN_HEADERS });
  }

  const pct = scorecard.score_pct ?? 0;
  const title = `${match.domain} — Agent-Readiness Audit`;
  const description = `${match.domain} scored ${pct}% for agent-readiness against the agentnative web audit (spec ${SPEC_VERSION}).`;
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
    title,
    description,
    canonicalPath: `/web/${match.domain}`,
    body: buildWebSummaryBody(input),
  });
  return new Response(html, { status: 200, headers: HTML_HEADERS });
}

async function renderNotFound(env: WebAuditRouteEnv, domain: string, wantMarkdown: boolean): Promise<Response> {
  if (wantMarkdown) {
    const lines = [
      `# ${domain} is not audited yet`,
      '',
      'No cached agent-readiness audit exists for this domain. Run one at [anc.dev/web-audit](https://anc.dev/web-audit) or call the `audit_website` MCP tool.',
      '',
    ];
    return new Response(lines.join('\n'), { status: 404, headers: MARKDOWN_HEADERS });
  }
  const body = `<header class="scorecard-header">
  <h1><code>${esc(domain)}</code> is not audited yet</h1>
  <p class="live-score-summary__meta">No cached agent-readiness audit exists for this domain.</p>
</header>
<section class="scorecard-cta">
  <p>Run one at <a href="/web-audit">anc.dev/web-audit</a> or call the <code>audit_website</code> MCP tool.</p>
</section>`;
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
    title: `Not audited — anc.dev`,
    description: `No cached agent-readiness audit for ${domain}.`,
    canonicalPath: `/web/${domain}`,
    body,
  });
  return new Response(html, { status: 404, headers: HTML_HEADERS });
}
