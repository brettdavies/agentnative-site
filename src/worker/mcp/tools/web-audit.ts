// Web-audit MCP tools (plan U12).
//
//   get_website_audit(url)   cheap read: per-domain R2 cache.
//   audit_website(url)       metered fresh audit; single terminal
//                            scorecard (no progress notifications — the
//                            server runs stateless per-request, KTD-6).
//   list_website_audits()    the board summaries from the R2 leaderboard
//                            aggregate (the same object /web renders).
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
  getAggregate,
  isBoardListable,
  isStale,
  keyFor,
  listAllWebAudits,
  normalizeTargetUrl,
  patchStoredPublicListing,
  scorecardWithPublicListing,
  WEB_AUDIT_STALE_AFTER_MS,
} from '../../audit-web/cache';
import { enrichWebScorecardForDisplay } from '../../audit-web/display';
import { runWebAudit } from '../../audit-web/engine';
import { consumeWebAuditHourlyBudget } from '../../audit-web/limiter';
import { decidePublicListingWrite, resolveAuditListing } from '../../audit-web/public-listing';
import { loadWebAuditRegistry, type WebAuditRegistry } from '../../audit-web/registry';
import { loadWebRemediationCatalog, type WebRemediationCatalog } from '../../audit-web/remediation';
import { canonicalTargetOf, coerceUrl } from '../../audit-web/route';
import { loadWebSeed } from '../../audit-web/seed';
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

// Upper bound on opted-in user rows returned under view=all. The /web board
// renders every opted-in row, but an MCP response is a single unpaginated JSON
// payload, so the user-cache enumeration is capped rather than dumped whole.
// Parity with /web?view=all holds for any user set within this cap.
const LIST_ALL_MAX_USER_ROWS = 100;

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

async function catalogOrEmpty(env: WebAuditToolsEnv): Promise<WebRemediationCatalog> {
  // A missing catalog degrades to generic prompts rather than failing the
  // audit result.
  try {
    return await loadWebRemediationCatalog(env);
  } catch {
    return {};
  }
}

async function registryOrNull(env: WebAuditToolsEnv): Promise<WebAuditRegistry | null> {
  // A failed registry load falls back to the stored category shape rather
  // than failing the read.
  try {
    return await loadWebAuditRegistry(env);
  } catch {
    return null;
  }
}

/**
 * Read-time enrichment shared by both MCP read tools: current category
 * split plus per-row remediation. Without a registry the category shape
 * falls back to the stored one, but remediation is still attached.
 */
async function enrichForRead(env: WebAuditToolsEnv, scorecard: unknown): Promise<unknown> {
  const catalog = await catalogOrEmpty(env);
  const registry = await registryOrNull(env);
  return enrichWebScorecardForDisplay(scorecard, { registry, catalog, origin: SITE_URL });
}

/** Resolve a domain's scorecard from per-domain R2 (https then http); null on a miss. */
async function resolveScorecard(env: WebAuditToolsEnv, domain: string): Promise<unknown | null> {
  for (const scheme of ['https', 'http']) {
    const target = normalizeTargetUrl(`${scheme}://${domain}/`);
    const cached: CachedWebAudit | null = await cacheGet(env, await keyFor(target, SPEC_VERSION));
    if (cached) return cached.scorecard;
  }
  return null;
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
          scorecard: await enrichForRead(env, scorecard),
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
      public_listing: z
        .boolean()
        .optional()
        .describe(
          'Opt this domain in to (true) or out of (false) the public web leaderboard at anc.dev/web. Omit to keep ' +
            "the current stored choice — a blank never erases a prior opt-in. Defaults to off only on a domain's " +
            'first-ever audit.',
        ),
    },
    async ({ url, site_type, public_listing }, extra) => {
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
      // Resolve the opt-in flag against the stored entry once. A fresh hit
      // only short-circuits when the request asks for no flag change; an
      // explicit, differing public_listing falls through the full gate stack
      // (kill switch, cf-connecting-ip, limiters) like a fresh audit and then
      // takes the scored_at-preserving patch below, so a flag flip never
      // bypasses a gate the kill switch also enforces.
      const listingWrite = decidePublicListingWrite({ explicit: public_listing, cached });
      if (cached && !isStale(cached.scored_at, WEB_AUDIT_STALE_AFTER_MS) && listingWrite.path === 'serve-cached') {
        return textContent({
          audited: false,
          source: 'cache',
          scorecard: await enrichForRead(env, cached.scorecard),
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
            scorecard: await enrichForRead(env, cached.scorecard),
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

      // Fresh-window flag patch — the request only changes public_listing, so
      // no re-audit runs; the preserving writer rewrites both stores without
      // resetting scored_at. A write failure surfaces a tool error rather than
      // a fabricated success the caller would follow as a saved result. The
      // response mirrors a normal read: patched scorecard + share_url.
      if (listingWrite.path === 'patch') {
        const wrote = await patchStoredPublicListing(env, listingWrite.cached, listingWrite.value);
        if (!wrote) return isError('failed to persist the public_listing change; please retry.');
        const patched = scorecardWithPublicListing(listingWrite.cached.scorecard, listingWrite.value);
        return textContent({
          audited: false,
          source: 'cache',
          scorecard: await enrichForRead(env, patched),
          share_url: shareUrl,
        });
      }

      // Miss or stale hit — a (re-)audit.
      const auditListing = resolveAuditListing(listingWrite, public_listing, cached);

      // Run the engine to completion (terminal-only; no streaming on MCP).
      const registry = await loadWebAuditRegistry(env);
      let scorecard: unknown = null;
      let complete = false;
      for await (const event of runWebAudit({
        url: canonicalTarget,
        registry,
        siteType: site_type ?? null,
        publicListing: auditListing,
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
        scorecard: await enrichForRead(env, scorecard),
        share_url: shareUrl,
        spec_version: SPEC_VERSION,
      });
    },
  );

  server.tool(
    'list_website_audits',
    'Return the web leaderboard (curated + opted-in): summaries of the websites on anc.dev/web. Each entry carries ' +
      'domain, url, name, score_pct, and share_url. view "curated" (the default) returns only the curated board; ' +
      `view "all" adds the user-submitted domains that opted in to public listing, bounded to the first ${LIST_ALL_MAX_USER_ROWS}. ` +
      'An empty list means the board is mid-rescore; get_website_audit still serves per-domain results.',
    {
      view: z
        .enum(['curated', 'all'])
        .optional()
        .describe(
          'Which board to return: "curated" (default) for the curated leaderboard only, or "all" to also include ' +
            'user-submitted domains that opted in to public listing. Mirrors anc.dev/web?view=all.',
        ),
    },
    async ({ view }) => {
      const aggregate = await getAggregate(env, 'leaderboard', SPEC_VERSION);
      const curated = (aggregate?.entries ?? []).map((e) => ({
        domain: e.domain,
        url: e.url,
        name: e.name,
        score_pct: e.score_pct,
        share_url: `${SITE_URL}/web/${e.domain}`,
      }));
      if ((view ?? 'curated') !== 'all') {
        return textContent({ count: curated.length, entries: curated });
      }

      // view=all mirrors handleWebLeaderboard: dedup user rows against both the
      // rendered curated rows AND the seed (the aggregate can lag the seed
      // either way), then gate on the shared opt-in predicate. Without this
      // exclude set a curated domain would surface twice and the tool would
      // diverge from /web?view=all.
      const excludeDomains = new Set(curated.map((e) => e.domain));
      try {
        for (const s of await loadWebSeed(env)) excludeDomains.add(s.domain);
      } catch {
        // Seed unavailable: the curated-row exclusion above still dedups every
        // domain the board actually renders.
      }
      const userRows = (await listAllWebAudits(env, { specVersion: SPEC_VERSION, excludeDomains }))
        .filter(isBoardListable)
        .slice(0, LIST_ALL_MAX_USER_ROWS)
        .map((l) => ({
          domain: l.domain,
          url: `https://${l.domain}/`,
          name: l.name,
          score_pct: l.score_pct,
          share_url: `${SITE_URL}/web/${l.domain}`,
        }));
      const entries = curated.concat(userRows);
      return textContent({ count: entries.length, entries });
    },
  );
}
