// set_website_public_listing: the one MCP tool that changes a website's
// public leaderboard listing, and nothing else. It runs no audit and sends no
// request to any host outside anc; it rewrites the stored listing of an
// existing scorecard with that scorecard's scored_at preserved.
//
// Reads come first and cost what get_website_audit costs: the url, the strict
// target, the curated seed, the stored record, a miss, a missing stamp, and a
// value that already matches. Only a change reaches the gates, in the order
// audit_website applies them, and a failure before the write leaves the store
// as it was.

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { leaderboardPath, scorePath } from '../../../shared/audit-routes';
import {
  type CachedWebAudit,
  getForRequest,
  keyFor,
  WEB_ALL_BOARD_DISPLAY_MAX_AGE_MS,
  WebCacheUnavailableError,
} from '../../audit-web/cache';
import { patchWebListing, type WebCoreEnv } from '../../audit-web/core';
import {
  consumeWebAuditHourlyBudget,
  FLIP_CEILING,
  HOURLY_AUDIT_CEILING,
  HOURLY_CONTENTION_MESSAGE,
  hourWindowEndsAt,
} from '../../audit-web/limiter';
import { standingPublicListing } from '../../audit-web/public-listing';
import { isSeededDomain } from '../../audit-web/seed';
import { resolveWebTarget, type WebResolution } from '../../audit-web/web-target';
import { SPEC_VERSION } from '../../spec-version.gen';
import { emitLog } from '../../telemetry/log';
import { requestHeader } from '../request-header';
import { siteOrigin } from '../site-origin';
import {
  BURST_REFUSED,
  cacheUnavailable,
  HOURLY_FULL,
  isError,
  jsonRpcError32099,
  SOURCE_IP_REQUIRED,
  siteTarget,
  textContent,
  unreadableRecord,
} from './web-tool-results';

export interface WebListingToolEnv extends WebCoreEnv {
  WEB_AUDIT_ENABLED?: string;
  WEB_AUDIT_LIMITER_IP?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

const TOOL = 'set_website_public_listing';
const UNCHANGED = 'nothing was changed';
const DISPLAY_DAYS = WEB_ALL_BOARD_DISPLAY_MAX_AGE_MS / 86_400_000;

const DESCRIPTION =
  `Opt a website in to or out of the public website leaderboard at ${leaderboardPath({ lane: 'web', view: 'all' })}, ` +
  'and change nothing else. Call it only when the user explicitly asks to list or unlist a site; audit_website ' +
  'never changes the listing. The site needs a stored audit: on a miss the answer is { changed: false, found: ' +
  'false, next_tool: "audit_website" }. Sending the value already stored writes nothing and spends nothing. A ' +
  'change rewrites only the stored listing, keeping the scorecard and its scored_at, and spends the per-IP burst ' +
  `limit, one of the ${HOURLY_AUDIT_CEILING} fresh audits per 60 minutes per IP that audit_website also draws on, ` +
  `and one of ${FLIP_CEILING} listing changes per hour per site across all callers; a breach, or a request without ` +
  'cf-connecting-ip, returns isError: true with a JSON-RPC -32099 error in the text. anc does not check who owns ' +
  'the site. A curated site is always listed and is not changed. The leaderboard shows an opted-in site while its ' +
  `scorecard is under ${DISPLAY_DAYS} days old. When WEB_AUDIT_ENABLED is not "true" nothing is written, and the ` +
  'answer is isError: false with changed: false.';

const URL_DESCRIPTION =
  'The website URL or bare domain whose listing to change, e.g. "anc.dev"; read at its https origin. www.<domain> ' +
  'changes the <domain> listing when that scorecard records that one of the two hosts redirects to the other (its ' +
  'site_hosts lists both); otherwise www.<domain> is its own site.';

const LISTING_DESCRIPTION =
  'true lists the site on the public website leaderboard; false removes it from the leaderboard. Required.';

async function isCurated(env: WebListingToolEnv, domain: string): Promise<boolean> {
  try {
    return await isSeededDomain(env, domain);
  } catch {
    return false;
  }
}

/** The site's stored audit; the resolution may already hold it, and an unreadable record throws. */
async function readStoredAudit(env: WebListingToolEnv, resolution: WebResolution): Promise<CachedWebAudit | null> {
  if (resolution.stored !== undefined) return resolution.stored;
  return getForRequest(env, await keyFor(resolution.target.canonical, SPEC_VERSION));
}

function listedUntil(record: CachedWebAudit, listed: boolean): string | null {
  const scoredAt = Date.parse(record.scored_at ?? '');
  if (!listed || Number.isNaN(scoredAt)) return null;
  return new Date(scoredAt + WEB_ALL_BOARD_DISPLAY_MAX_AGE_MS).toISOString();
}

export function registerWebListingTool(server: McpServer, env: WebListingToolEnv): void {
  server.registerTool(
    TOOL,
    {
      title: "Set a website's public listing",
      description: DESCRIPTION,
      inputSchema: z.strictObject({
        url: z.string().describe(URL_DESCRIPTION),
        public_listing: z.boolean().describe(LISTING_DESCRIPTION),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, public_listing }, extra) => {
      const siteUrl = siteOrigin();
      const site = siteTarget(url);
      if (!site.ok) return isError(site.reason);
      let resolution: WebResolution;
      try {
        resolution = await resolveWebTarget(env, site.target, 'strict');
      } catch (err) {
        if (err instanceof WebCacheUnavailableError) return cacheUnavailable(site.target.host, TOOL, UNCHANGED);
        throw err;
      }
      const domain = resolution.target.host;
      const links = {
        board_url: `${siteUrl}${leaderboardPath({ lane: 'web', view: 'all' })}`,
        scorecard_url: `${siteUrl}${scorePath(domain)}`,
      };

      if (await isCurated(env, domain)) {
        return textContent({
          changed: false,
          curated: true,
          target: domain,
          public_listing: true,
          ...links,
          message: `${domain} is a curated site and is always listed; nothing was changed.`,
        });
      }

      let stored: CachedWebAudit | null;
      try {
        stored = await readStoredAudit(env, resolution);
      } catch (err) {
        if (err instanceof WebCacheUnavailableError) return unreadableRecord(domain, TOOL, UNCHANGED);
        throw err;
      }
      if (stored === null) {
        return textContent({
          changed: false,
          found: false,
          next_tool: 'audit_website',
          message: `no stored audit for ${domain}; nothing was changed. Call audit_website with the same url to run one, then call ${TOOL} again.`,
        });
      }
      if (!stored.scored_at) {
        return textContent({
          changed: false,
          found: true,
          next_tool: 'audit_website',
          message: `the stored audit for ${domain} carries no scored_at; nothing was changed. Call audit_website with the same url to refresh it, then call ${TOOL} again.`,
        });
      }

      const answer = (record: CachedWebAudit, changed: boolean) => {
        const listed = standingPublicListing(record);
        const until = listedUntil(record, listed);
        const lapsed = until !== null && Date.parse(until) < Date.now();
        const state = listed ? 'listed' : 'not listed';
        const message = changed
          ? `${domain} is now ${state}; nothing else changed.`
          : `${domain} is already ${state}; nothing was changed.`;
        return textContent({
          changed,
          target: domain,
          public_listing: listed,
          scored_at: record.scored_at,
          listed_until: until,
          ...links,
          ...(lapsed ? { next_tool: 'audit_website' } : {}),
          message: lapsed
            ? `${message} Its scorecard is past the ${DISPLAY_DAYS}-day display window, so it stays off the board until audit_website saves a newer one.`
            : message,
        });
      };

      if (standingPublicListing(stored) === public_listing) return answer(stored, false);

      if (env.WEB_AUDIT_ENABLED !== 'true') {
        return textContent({
          changed: false,
          disabled: true,
          target: domain,
          public_listing: standingPublicListing(stored),
          message: 'the operator has switched listing changes off; nothing was changed.',
        });
      }

      const ipString = requestHeader(extra, 'cf-connecting-ip');
      if (!ipString) return jsonRpcError32099(SOURCE_IP_REQUIRED);
      if (env.WEB_AUDIT_LIMITER_IP) {
        const { success } = await env.WEB_AUDIT_LIMITER_IP.limit({ key: ipString });
        if (!success) return jsonRpcError32099(BURST_REFUSED);
      }
      if (env.SCORE_KV) {
        const hourly = await consumeWebAuditHourlyBudget(env.SCORE_KV, ipString);
        if (hourly === 'full') return jsonRpcError32099(HOURLY_FULL);
        if (hourly === 'contended') return jsonRpcError32099(HOURLY_CONTENTION_MESSAGE);
      }

      const outcome = await patchWebListing(env, resolution.target, public_listing);
      if (!outcome.ok && outcome.reason === 'flip_rate_limited') {
        return jsonRpcError32099(
          `flip_rate_limited: this site's listing changes for this hour are used up (${FLIP_CEILING} per hour across all callers); nothing was changed. Retry after ${hourWindowEndsAt(Date.now())}.`,
        );
      }
      if (!outcome.ok) {
        return isError(
          `patch_failed: the listing change did not save; nothing was changed, and this attempt used one of the site's ${FLIP_CEILING} listing changes this hour. Retry once; if it fails again, stop and report.`,
        );
      }
      // `written: false` means the re-read found the value already stored: no change happened.
      if (outcome.written) emitLog({ scope: 'web-listing.change' }, { target: domain, public_listing, surface: 'mcp' });
      return answer(outcome.cached, outcome.written);
    },
  );
}
