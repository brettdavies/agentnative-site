// Web-audit MCP tools (plan U12).
//
//   get_website_audit(url)   cheap read: R2 cache or curated projection.
//   audit_website(url)       metered fresh audit; single terminal
//                            scorecard (no progress notifications — the
//                            server runs stateless per-request, KTD-6).
//   list_website_audits()    the curated web leaderboard summaries.
//
// audit_website mirrors score_cli's audit-tier gate chain: URL validation
// + SSRF, then cache state served as data ahead of the kill switch, then
// on a miss the kill switch (WEB_AUDIT_ENABLED + the global MCP_ENABLED),
// cf-connecting-ip presence (no anon fallback -> -32099), a per-IP burst
// limiter (WEB_AUDIT_LIMITER_IP) + a KV-backed hourly window shared with
// the webapp route. Cache state is data, not failure: read outcomes
// return isError:false.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { rebuildAggregatesIfSeeded } from '../../audit-web/aggregate';
import {
  type CachedWebAudit,
  get as cacheGet,
  put as cachePut,
  isStale,
  keyFor,
  normalizeTargetUrl,
  WEB_AUDIT_STALE_AFTER_MS,
} from '../../audit-web/cache';
import { runWebAudit } from '../../audit-web/engine';
import { consumeWebAuditHourlyBudget } from '../../audit-web/limiter';
import { loadWebAuditRegistry } from '../../audit-web/registry';
import {
  assembleRemediation,
  loadWebRemediationCatalog,
  resultLine,
  type WebRemediationCatalog,
} from '../../audit-web/remediation';
import { canonicalTargetOf, coerceUrl } from '../../audit-web/route';
import type { NaReason, ScorecardStatus } from '../../audit-web/scorecard';
import { validatePublicUrl } from '../../audit-web/ssrf';
import { SPEC_VERSION } from '../../spec-version.gen';

export interface WebAuditToolsEnv {
  ASSETS: Fetcher;
  SCORE_CACHE: R2Bucket;
  SCORE_KV?: KVNamespace;
  WEB_AUDIT_ENABLED?: string;
  MCP_ENABLED?: string;
  WEB_AUDIT_LIMITER_IP?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

const SITE_URL = 'https://anc.dev';

function textContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function jsonRpcError32099(message: string) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify({ jsonrpc: '2.0', error: { code: -32099, message } }, null, 2) },
    ],
    isError: true,
  };
}

function isError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

async function loadCuratedProjection(env: WebAuditToolsEnv, path: string): Promise<unknown | null> {
  try {
    const res = await env.ASSETS.fetch(new Request(`https://assets.internal/_internal/web-scorecards/${path}`));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

type ScorecardRow = {
  id: string;
  status: ScorecardStatus;
  na_reason?: NaReason;
  evidence: string | null;
};

/**
 * Enrich audit_website scorecard rows in place-shape (R14): every row
 * gains a derived `result` line, and a non-passing row (broken / absent)
 * carries the inline remediation object. Passing and n_a rows carry no
 * remediation (nothing to fix / not applicable).
 */
function withInlineRemediation(scorecard: unknown, catalog: WebRemediationCatalog): unknown {
  if (!scorecard || typeof scorecard !== 'object' || !Array.isArray((scorecard as { results?: unknown }).results)) {
    return scorecard;
  }
  const rows = (scorecard as { results: ScorecardRow[] }).results;
  return {
    ...scorecard,
    results: rows.map((row) => {
      const result = resultLine(row.status, row.evidence, row.na_reason);
      if (row.status === 'broken' || row.status === 'absent') {
        const remediation = assembleRemediation(catalog[row.id], {
          checkId: row.id,
          origin: SITE_URL,
          evidence: row.evidence,
        });
        return { ...row, result, remediation };
      }
      return { ...row, result };
    }),
  };
}

async function catalogOrEmpty(env: WebAuditToolsEnv): Promise<WebRemediationCatalog> {
  // A missing catalog degrades to generic prompts rather than failing the
  // audit result (R10).
  try {
    return await loadWebRemediationCatalog(env);
  } catch {
    return {};
  }
}

/** Resolve a domain's scorecard: R2 (https then http) then the curated projection. */
async function resolveScorecard(env: WebAuditToolsEnv, domain: string): Promise<unknown | null> {
  for (const scheme of ['https', 'http']) {
    const target = normalizeTargetUrl(`${scheme}://${domain}/`);
    const cached: CachedWebAudit | null = await cacheGet(env, await keyFor(target, SPEC_VERSION));
    if (cached) return cached.scorecard;
  }
  return loadCuratedProjection(env, `${domain}.json`);
}

export function registerWebAuditTools(server: McpServer, env: WebAuditToolsEnv): void {
  server.tool(
    'get_website_audit',
    'Read a cached website agent-readiness scorecard by URL without re-running the audit. Returns isError:false for ' +
      'both outcomes: a hit returns { found:true, scorecard, share_url }; a miss returns { found:false, ' +
      'next_tool:"audit_website" }. The companion tool audit_website runs a fresh audit on a miss.',
    { url: z.string().describe('The website URL or bare domain, e.g. "anc.dev" or "https://anc.dev/".') },
    async ({ url }) => {
      const parsed = coerceUrl(url);
      if (!parsed) return isError('invalid url');
      const validation = validatePublicUrl(canonicalTargetOf(parsed));
      if (!validation.ok) return isError(validation.reason);
      const domain = parsed.host;
      const scorecard = await resolveScorecard(env, domain);
      if (scorecard) {
        return textContent({
          found: true,
          scorecard,
          share_url: `${SITE_URL}/web/${domain}`,
          spec_version: SPEC_VERSION,
        });
      }
      return textContent({
        found: false,
        next_tool: 'audit_website',
        message: `no cached audit for ${domain}. Call audit_website with the same url to run a fresh audit.`,
      });
    },
  );

  server.tool(
    'audit_website',
    'Run a fresh website agent-readiness audit and return the complete scorecard. Returns a single terminal scorecard ' +
      '(no progress notifications — the server is stateless per-request). A cached result younger than 5 minutes is ' +
      'returned without re-running; an older one re-runs (and is still served as-is when the audit is disabled). A ' +
      'fresh audit is gated like score_cli: disabled when WEB_AUDIT_ENABLED or MCP_ENABLED is not "true"; a request ' +
      'without cf-connecting-ip returns -32099 (no anon fallback); a per-IP burst limiter plus a ' +
      '30-fresh-audits-per-hour-per-IP window apply.',
    {
      url: z.string().describe('The website URL or bare domain to audit.'),
      site_type: z
        .enum(['content', 'api'])
        .optional()
        .describe(
          'Declared site type scoping applicability: "content" (blog/docs/marketing) or "api" (REST API and/or ' +
            'interactive app). Omit to run everything. MCP surfaces are auto-detected regardless.',
        ),
    },
    async ({ url, site_type }, extra) => {
      // URL validation + SSRF (the cache key needs the URL, so these precede
      // the cache read and the kill switch).
      const parsed = coerceUrl(url);
      if (!parsed) return isError('invalid url');
      const canonicalTarget = canonicalTargetOf(parsed);
      const validation = validatePublicUrl(canonicalTarget);
      if (!validation.ok) return isError(validation.reason);
      const domain = parsed.host;
      const shareUrl = `${SITE_URL}/web/${domain}`;

      // Cache hit short-circuits ahead of the kill switch: cache state is
      // data, so a cached scorecard is served even when the audit is off.
      // A hit older than the staleness threshold falls through to the
      // fresh path (still behind every gate below) so a re-run refreshes
      // the board.
      const cached: CachedWebAudit | null = await cacheGet(env, await keyFor(canonicalTarget, SPEC_VERSION));
      if (cached && !isStale(cached.scored_at, WEB_AUDIT_STALE_AFTER_MS)) {
        return textContent({
          audited: false,
          source: 'cache',
          scorecard: withInlineRemediation(cached.scorecard, await catalogOrEmpty(env)),
          share_url: shareUrl,
        });
      }

      // Kill switches: a stale hit is still data when fresh audits are
      // off, so only a true miss surfaces the disabled message.
      if (env.MCP_ENABLED !== 'true' || env.WEB_AUDIT_ENABLED !== 'true') {
        if (cached) {
          return textContent({
            audited: false,
            source: 'cache',
            scorecard: withInlineRemediation(cached.scorecard, await catalogOrEmpty(env)),
            share_url: shareUrl,
          });
        }
        return textContent({
          audited: false,
          message:
            'the website audit is currently disabled by the operator; cached scorecards remain available via get_website_audit.',
        });
      }

      // cf-connecting-ip presence (no anon fallback).
      const ip = extra?.requestInfo?.headers?.['cf-connecting-ip'];
      const ipString = typeof ip === 'string' ? ip : null;
      if (!ipString) {
        return jsonRpcError32099(
          'fresh audits require a source IP; missing cf-connecting-ip is not rate-limit-keyable.',
        );
      }
      // Per-IP burst limiter.
      if (env.WEB_AUDIT_LIMITER_IP) {
        const { success } = await env.WEB_AUDIT_LIMITER_IP.limit({ key: ipString });
        if (!success)
          return jsonRpcError32099('audit rate limit exceeded — burst window (30 per 60 seconds per source).');
      }
      // Hourly window (shared with the webapp route).
      if (env.SCORE_KV) {
        const ok = await consumeWebAuditHourlyBudget(env.SCORE_KV, ipString);
        if (!ok) return jsonRpcError32099('audit rate limit exceeded — 30 fresh audits per hour per source.');
      }

      // Run the engine to completion (terminal-only; no streaming on MCP).
      const registry = await loadWebAuditRegistry(env);
      let scorecard: unknown = null;
      let complete = false;
      for await (const event of runWebAudit({
        url: canonicalTarget,
        registry,
        siteType: site_type ?? null,
        specVersion: SPEC_VERSION,
      })) {
        if (event.type === 'complete') {
          scorecard = event.scorecard;
          complete = event.complete;
        }
      }
      if (!complete || !scorecard) {
        return isError('the audit did not finish within the deadline; nothing was cached. Retry.');
      }
      await cachePut(env, canonicalTarget, scorecard, SPEC_VERSION);
      await rebuildAggregatesIfSeeded(env, domain, SPEC_VERSION);
      return textContent({
        audited: true,
        source: 'fresh-audit',
        scorecard: withInlineRemediation(scorecard, await catalogOrEmpty(env)),
        share_url: shareUrl,
        spec_version: SPEC_VERSION,
      });
    },
  );

  server.tool(
    'list_website_audits',
    'Return the curated web leaderboard: summaries of the websites on anc.dev/web. Each entry carries domain, url, ' +
      'name, score_pct, and share_url. This board is curated (not every audited URL appears).',
    {},
    async () => {
      const index = (await loadCuratedProjection(env, 'index.json')) as Array<{
        domain: string;
        url: string;
        name: string;
        description?: string;
        score_pct: number;
      }> | null;
      const entries = (index ?? []).map((e) => ({
        domain: e.domain,
        url: e.url,
        name: e.name,
        score_pct: e.score_pct,
        share_url: `${SITE_URL}/web/${e.domain}`,
      }));
      return textContent({ count: entries.length, entries });
    },
  );
}
