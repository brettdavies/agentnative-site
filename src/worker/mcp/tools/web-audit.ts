// Web-audit MCP tools (plan U12).
//
//   get_website_audit(url)   cheap read: R2 cache or curated projection.
//   audit_website(url)       metered fresh audit; single terminal
//                            scorecard (no progress notifications — the
//                            server runs stateless per-request, KTD-6).
//   list_website_audits()    the curated web leaderboard summaries.
//
// audit_website mirrors score_cli's audit-tier gate chain: kill switch
// (WEB_AUDIT_ENABLED + the global MCP_ENABLED), URL validation + SSRF,
// cf-connecting-ip presence (no anon fallback -> -32099), WEB_AUDIT_LIMITER
// burst + a KV-backed hourly window shared with the webapp route. Cache
// state is data, not failure: read outcomes return isError:false.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  type CachedWebAudit,
  get as cacheGet,
  put as cachePut,
  keyFor,
  normalizeTargetUrl,
} from '../../audit-web/cache';
import { runWebAudit } from '../../audit-web/engine';
import { consumeWebAuditHourlyBudget } from '../../audit-web/limiter';
import { loadWebAuditRegistry } from '../../audit-web/registry';
import { canonicalTargetOf, coerceUrl } from '../../audit-web/route';
import { validatePublicUrl } from '../../audit-web/ssrf';
import { SPEC_VERSION } from '../../spec-version.gen';

export interface WebAuditToolsEnv {
  ASSETS: Fetcher;
  SCORE_CACHE: R2Bucket;
  SCORE_KV?: KVNamespace;
  WEB_AUDIT_ENABLED?: string;
  MCP_ENABLED?: string;
  WEB_AUDIT_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
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
      '(no progress notifications — the server is stateless per-request). Gated like score_cli: disabled when ' +
      'WEB_AUDIT_ENABLED or MCP_ENABLED is not "true"; a request without cf-connecting-ip returns -32099 (no anon ' +
      'fallback); WEB_AUDIT_LIMITER burst plus a per-hour window apply. On an existing cached result, returns it ' +
      'without re-running.',
    { url: z.string().describe('The website URL or bare domain to audit.') },
    async ({ url }, extra) => {
      // Kill switches.
      if (env.MCP_ENABLED !== 'true' || env.WEB_AUDIT_ENABLED !== 'true') {
        return textContent({
          audited: false,
          message:
            'the website audit is currently disabled by the operator; cached scorecards remain available via get_website_audit.',
        });
      }
      // URL validation + SSRF.
      const parsed = coerceUrl(url);
      if (!parsed) return isError('invalid url');
      const canonicalTarget = canonicalTargetOf(parsed);
      const validation = validatePublicUrl(canonicalTarget);
      if (!validation.ok) return isError(validation.reason);
      const domain = parsed.host;
      const shareUrl = `${SITE_URL}/web/${domain}`;

      // Cache hit short-circuits (cache state is data).
      const cached: CachedWebAudit | null = await cacheGet(env, await keyFor(canonicalTarget, SPEC_VERSION));
      if (cached) {
        return textContent({ audited: false, source: 'cache', scorecard: cached.scorecard, share_url: shareUrl });
      }

      // cf-connecting-ip presence (no anon fallback).
      const ip = extra?.requestInfo?.headers?.['cf-connecting-ip'];
      const ipString = typeof ip === 'string' ? ip : null;
      if (!ipString) {
        return jsonRpcError32099(
          'fresh audits require a source IP; missing cf-connecting-ip is not rate-limit-keyable.',
        );
      }
      // Burst limiter.
      if (env.WEB_AUDIT_LIMITER) {
        const { success } = await env.WEB_AUDIT_LIMITER.limit({ key: ipString });
        if (!success)
          return jsonRpcError32099('audit rate limit exceeded — burst window (5 per 60 seconds per source).');
      }
      // Hourly window (shared with the webapp route).
      if (env.SCORE_KV) {
        const ok = await consumeWebAuditHourlyBudget(env.SCORE_KV, ipString);
        if (!ok) return jsonRpcError32099('audit rate limit exceeded — 5 fresh audits per hour per source.');
      }

      // Run the engine to completion (terminal-only; no streaming on MCP).
      const registry = await loadWebAuditRegistry(env);
      let scorecard: unknown = null;
      let complete = false;
      for await (const event of runWebAudit({ url: canonicalTarget, registry, specVersion: SPEC_VERSION })) {
        if (event.type === 'complete') {
          scorecard = event.scorecard;
          complete = event.complete;
        }
      }
      if (!complete || !scorecard) {
        return isError('the audit did not finish within the deadline; nothing was cached. Retry.');
      }
      await cachePut(env, canonicalTarget, scorecard, SPEC_VERSION);
      return textContent({
        audited: true,
        source: 'fresh-audit',
        scorecard,
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
