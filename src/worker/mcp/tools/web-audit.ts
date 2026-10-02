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
// return isError:false. A fresh run is hosted under the site's AuditJob
// (web-audit-host.ts), the single-flight gate the transact endpoint uses.

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { TerminalEvent } from '../../../shared/audit-events';
import { leaderboardPath, scorePath } from '../../../shared/audit-routes';
import { awaitInFlightTerminal, type InFlightEnv, readInFlight } from '../../audit/inflight';
import type { AuditLogEnv } from '../../audit-web/audit-log';
import {
  type CachedWebAudit,
  get as cacheGet,
  canonicalTargetOf,
  coerceUrl,
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
import { webEnvelope } from '../../audit-web/core';
import type { FollowSwitchEnv } from '../../audit-web/follow-switch';
import { queueHitMinPurge, webTag } from '../../audit-web/hit-min-purge';
import { consumeWebAuditHourlyBudget } from '../../audit-web/limiter';
import {
  decidePublicListingWrite,
  enforcePublicListingFlipLimit,
  resolveAuditListing,
  standingPublicListing,
} from '../../audit-web/public-listing';
import { boardExcludeDomains } from '../../audit-web/seed';
import { validatePublicUrl } from '../../audit-web/ssrf';
import type { NotifyEnv } from '../../notify';
import { SPEC_VERSION } from '../../spec-version.gen';
import { getMcpRequest } from '../request-context';
import { requestHeader } from '../request-header';
import { siteOrigin } from '../site-origin';
import { hostWebAudit } from './web-audit-host';

export interface WebAuditToolsEnv extends AuditLogEnv, NotifyEnv, InFlightEnv, FollowSwitchEnv {
  ASSETS: Fetcher;
  SCORE_CACHE: R2Bucket;
  SCORE_KV?: KVNamespace;
  WEB_AUDIT_ENABLED?: string;
  MCP_ENABLED?: string;
  WEB_AUDIT_LIMITER_IP?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

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

/** The answer to a call that attached to another caller's run of the same site. */
function attachedResult(terminal: TerminalEvent | null, signal: AbortSignal | undefined) {
  if (terminal?.type === 'complete') {
    const { type: _tag, ...envelope } = terminal;
    return textContent({ audited: true, source: 'fresh-audit', attached: true, ...envelope });
  }
  if (terminal) {
    const reason = terminal.type === 'incomplete' ? 'incomplete' : terminal.error.code;
    return isError(`the audit this call attached to did not finish (${reason}); nothing was cached. Retry.`);
  }
  // A null answer after the caller aborted means the wait ended, not that
  // nothing is running; dispatching now would audit for nobody.
  if (signal?.aborted) {
    return jsonRpcError32099('the caller went away while attaching to the audit already in flight.');
  }
  return isError('the audit already in flight for this site did not answer; nothing was cached. Retry.');
}

/** The answer to a call whose own run produced `terminal`. */
function freshResult(terminal: TerminalEvent | null) {
  if (terminal?.type === 'complete') {
    const { type: _tag, ...envelope } = terminal;
    return textContent({ audited: true, source: 'fresh-audit', ...envelope });
  }
  if (terminal?.type === 'incomplete') {
    return isError('the audit did not finish within the deadline; nothing was cached. Retry.');
  }
  if (terminal) return isError(`${terminal.error.message} Nothing was cached. ${terminal.error.cta}`);
  return isError('the audit ended without a result; nothing was cached. Retry.');
}

/**
 * Resolve a domain's cached audit from per-domain R2 (https then http); null
 * on a miss. The whole envelope is returned, not just the scorecard, because
 * the read tool's response envelope needs the stored scoring instant.
 */
async function resolveCachedAudit(env: WebAuditToolsEnv, domain: string): Promise<CachedWebAudit | null> {
  for (const scheme of ['https', 'http']) {
    const target = normalizeTargetUrl(`${scheme}://${domain}/`);
    const cached: CachedWebAudit | null = await cacheGet(env, await keyFor(target, SPEC_VERSION));
    if (cached) return cached;
  }
  return null;
}

export function registerWebAuditTools(server: McpServer, env: WebAuditToolsEnv): void {
  server.registerTool(
    'get_website_audit',
    {
      title: 'Get a cached website audit',
      description:
        'Read a cached website agent-readiness scorecard by URL without re-running the audit. Returns isError:false for ' +
        'every outcome: a hit returns { found:true, ...envelope } carrying kind, tier, target, scorecard_url, ' +
        'markdown_url, json_url, freshness and the scorecard, the same envelope the result page serves at its ' +
        'json_url; a target already being audited returns { found:false, in_progress:true, started_at }; a miss ' +
        'returns { found:false, next_tool:"audit_website" }. freshness.cached is always true on a hit; ' +
        'freshness.scored_at is when the audit ran (null on a legacy entry) and freshness.refresh_after is the ' +
        'earliest time the entry leaves the 1-minute cache-reuse window, which is eligibility only, not a promise a ' +
        'fresh audit will be available, since kill switches, rate limits, and service failures still apply. The ' +
        'companion tool audit_website runs a fresh audit on a miss.',
      inputSchema: {
        url: z.string().describe('The website URL or bare domain, e.g. "anc.dev" or "https://anc.dev/".'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ url }) => {
      const siteUrl = siteOrigin();
      const parsed = coerceUrl(url);
      if (!parsed) return isError('invalid url');
      const validation = validatePublicUrl(canonicalTargetOf(parsed));
      if (!validation.ok) return isError(validation.reason);
      const domain = parsed.host;
      const hit = await resolveCachedAudit(env, domain);
      if (hit) {
        const envelope = await webEnvelope(env, { tier: 'cache', host: domain, record: hit, origin: siteUrl });
        return textContent({ found: true, ...envelope });
      }
      const running = await readInFlight(env, 'web', domain);
      if (running) {
        return textContent({
          found: false,
          in_progress: true,
          started_at: running.started_at,
          message: `an audit for ${domain} is already running; poll this tool or read the result page shortly.`,
        });
      }
      return textContent({
        found: false,
        next_tool: 'audit_website',
        spec_version: SPEC_VERSION,
        message: `no cached audit for ${domain}. Call audit_website with the same url to run a fresh audit.`,
      });
    },
  );

  server.registerTool(
    'audit_website',
    {
      title: 'Run a live website audit',
      description:
        'Run a fresh website agent-readiness audit and return the complete scorecard. Returns a single terminal scorecard ' +
        '(no progress notifications — the server is stateless per-request). A cached result younger than 1 minute is ' +
        'returned without re-running; an older one re-runs (and is still served as-is when the audit is disabled). ' +
        'Every scorecard-bearing result carries cached, scored_at, and refresh_after beside the scorecard: cached is ' +
        'true for a served cache entry or a listing-only patch and false for a result this call produced, scored_at is ' +
        'when the audit ran (null on a legacy entry, and refresh_after is the earliest time the entry leaves the ' +
        '1-minute cache-reuse window — eligibility only, not a promise a fresh audit will be available, since kill ' +
        'switches, rate limits, and service failures still apply. A fresh audit is gated like score_cli: disabled when ' +
        'WEB_AUDIT_ENABLED or MCP_ENABLED is not "true"; a request without cf-connecting-ip returns -32099 (no anon ' +
        'fallback); a per-IP burst limiter plus a 30-fresh-audits-per-hour-per-IP window apply.',
      inputSchema: {
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
            `Opt this domain in to (true) or out of (false) the public website leaderboard at ${leaderboardPath({ lane: 'web' })}. Omit to keep ` +
              "the current stored choice — a blank never erases a prior opt-in. Defaults to off only on a domain's " +
              'first-ever audit.',
          ),
        follow_declarations: z
          .boolean()
          .optional()
          .describe(
            'Follow the hosts the site declares (its MCP server, its API host) and score them with the site; ' +
              'defaults to true. false audits only the site itself and returns a transient result: never cached, ' +
              "never listed, no scorecard_url, markdown_url, or json_url, and never joined to another caller's run. " +
              'With false, a public_listing that differs from the stored choice is rejected.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, site_type, public_listing, follow_declarations }, extra) => {
      // URL validation + SSRF (the cache key needs the URL, so these precede
      // the cache read and the kill switch).
      const siteUrl = siteOrigin();
      const parsed = coerceUrl(url);
      if (!parsed) return isError('invalid url');
      const canonicalTarget = canonicalTargetOf(parsed);
      const validation = validatePublicUrl(canonicalTarget);
      if (!validation.ok) return isError(validation.reason);
      const domain = parsed.host;
      // A run that does not follow declared hosts is never saved, so no
      // stored scorecard answers it, it joins no run, and it may not change
      // the listing.
      const optedOut = follow_declarations === false;

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
      if (optedOut) {
        if (public_listing !== undefined && public_listing !== standingPublicListing(cached)) {
          return isError(
            'follow_declarations false runs an audit that is never saved, so it cannot change public_listing; ' +
              'omit public_listing or keep follow_declarations on.',
          );
        }
      } else if (
        cached &&
        !isStale(cached.scored_at, WEB_AUDIT_STALE_AFTER_MS) &&
        listingWrite.path === 'serve-cached'
      ) {
        return textContent({
          audited: false,
          source: 'cache',
          ...(await webEnvelope(env, { tier: 'cache', host: domain, record: cached, origin: siteUrl })),
        });
      }

      // Kill switches: a stale hit is still data when fresh audits are
      // off, so only a true miss surfaces the disabled message.
      if (env.MCP_ENABLED !== 'true' || env.WEB_AUDIT_ENABLED !== 'true') {
        if (cached && !optedOut) {
          return textContent({
            audited: false,
            source: 'cache',
            ...(await webEnvelope(env, { tier: 'cache', host: domain, record: cached, origin: siteUrl })),
          });
        }
        return textContent({
          audited: false,
          message:
            'the website audit is currently disabled by the operator; cached scorecards remain available via get_website_audit.',
        });
      }

      // cf-connecting-ip presence (no anon fallback).
      const ipString = requestHeader(extra, 'cf-connecting-ip');
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
      // A run already in flight for this domain is attached to rather than
      // run twice. Attaching spends no audit budget, but it holds a request
      // open for the rest of that run, so it passes the source gates above
      // first. An explicit listing choice is its own request: attaching would
      // answer it with a run that never writes the caller's opt-in.
      const signal = getMcpRequest()?.signal;
      if (public_listing === undefined && !optedOut) {
        const attached = await awaitInFlightTerminal(env, 'web', domain, signal);
        // A null answer means nothing answered in flight; the audit runs below.
        if (attached || signal?.aborted) return attachedResult(attached, signal);
      }

      // Hourly window (shared with the webapp route).
      if (env.SCORE_KV) {
        const ok = await consumeWebAuditHourlyBudget(env.SCORE_KV, ipString);
        if (!ok) return jsonRpcError32099('audit rate limit exceeded — 30 fresh audits per hour per source.');
      }

      const target = { host: domain, canonical: canonicalTarget };
      if (optedOut) {
        const run = await hostWebAudit(env, {
          target,
          siteType: site_type ?? null,
          listing: standingPublicListing(cached),
          followDeclarations: false,
          origin: siteUrl,
          attach: false,
          singleFlight: false,
          signal,
        });
        return freshResult(run.terminal);
      }

      // Per-domain flip budget (the same shared helper the webapp route calls,
      // so both surfaces draw from one budget per domain). A write that changes
      // the stored public_listing is capped per domain because the flag is
      // submitter-set with no ownership check; a no-op serve or same-value
      // re-audit spends nothing. Rejected before the write.
      if ((await enforcePublicListingFlipLimit({ write: listingWrite, kv: env.SCORE_KV, domain })) === 'rate-limited') {
        return jsonRpcError32099(
          'flip_rate_limited: too many public_listing changes for this domain; try again later.',
        );
      }

      // Fresh-window flag patch — the request only changes public_listing, so
      // no re-audit runs; the preserving writer rewrites both stores without
      // resetting scored_at. A write failure surfaces a tool error rather than
      // a fabricated success the caller would follow as a saved result. The
      // response mirrors a normal read: the envelope over the patched record.
      if (listingWrite.path === 'patch') {
        const wrote = await patchStoredPublicListing(env, listingWrite.cached, listingWrite.value);
        if (!wrote) return isError('failed to persist the public_listing change; please retry.');
        queueHitMinPurge([webTag()]);
        const patched = {
          ...listingWrite.cached,
          scorecard: scorecardWithPublicListing(listingWrite.cached.scorecard, listingWrite.value),
        };
        return textContent({
          audited: false,
          source: 'cache',
          ...(await webEnvelope(env, { tier: 'cache', host: domain, record: patched, origin: siteUrl })),
        });
      }

      // Miss or stale hit — a (re-)audit, hosted under the site's job so a
      // caller that arrives mid-run attaches to it.
      const run = await hostWebAudit(env, {
        target,
        siteType: site_type ?? null,
        listing: resolveAuditListing(listingWrite, public_listing, cached),
        followDeclarations: true,
        origin: siteUrl,
        attach: public_listing === undefined,
        singleFlight: true,
        signal,
      });
      return run.attached ? attachedResult(run.terminal, signal) : freshResult(run.terminal);
    },
  );

  server.registerTool(
    'list_website_audits',
    {
      title: 'List cached website audits',
      description:
        'Return the website half of the leaderboard (curated + opted-in). Each entry carries domain, url, name, ' +
        'score_pct, and scorecard_url. view "curated" (the default) returns only the curated board; ' +
        `view "all" adds the user-submitted domains that opted in to public listing, bounded to the first ${LIST_ALL_MAX_USER_ROWS}. ` +
        'An empty list means the board is mid-rescore; get_website_audit still serves per-domain results.',
      inputSchema: {
        view: z
          .enum(['curated', 'all'])
          .optional()
          .describe(
            'Which board to return: "curated" (default) for the curated leaderboard only, or "all" to also include ' +
              `user-submitted domains that opted in to public listing. Mirrors ${leaderboardPath({ lane: 'web', view: 'all' })}.`,
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ view }) => {
      const siteUrl = siteOrigin();
      const aggregate = await getAggregate(env, 'leaderboard', SPEC_VERSION);
      const curated = (aggregate?.entries ?? []).map((e) => ({
        domain: e.domain,
        url: e.url,
        name: e.name,
        score_pct: e.score_pct,
        scorecard_url: `${siteUrl}${scorePath(e.domain)}`,
      }));
      if ((view ?? 'curated') !== 'all') {
        return textContent({ count: curated.length, entries: curated });
      }

      // Mirror handleWebLeaderboard's view=all: exclude curated + seed domains
      // through the shared helper, then gate on the shared opt-in predicate, so
      // the tool and /web?view=all can't diverge on which user rows list.
      const excludeDomains = await boardExcludeDomains(
        env,
        curated.map((e) => e.domain),
      );
      const userRows = (await listAllWebAudits(env, { specVersion: SPEC_VERSION, excludeDomains }))
        .filter(isBoardListable)
        .slice(0, LIST_ALL_MAX_USER_ROWS)
        .map((l) => ({
          domain: l.domain,
          url: `https://${l.domain}/`,
          name: l.name,
          score_pct: l.score_pct,
          scorecard_url: `${siteUrl}${scorePath(l.domain)}`,
        }));
      const entries = curated.concat(userRows);
      return textContent({ count: entries.length, entries });
    },
  );
}
