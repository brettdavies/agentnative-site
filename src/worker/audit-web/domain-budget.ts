// The budget a declared registrable domain draws on across the audits that
// reach it: the follow slice reserves one unit per audit and domain before
// its first request there (follow-requests.ts). Both layers key on the
// domain's hash, and both are approximate. The KV window is the hourly
// ceiling the binding cannot express, a read then a write on an eventually
// consistent store, so audits running at once can all read the same count.
// The rate-limit binding is the 60-second burst floor beneath it, and
// Cloudflare keeps its counters local to the location the Worker runs in
// and eventually consistent, so the floor applies per Cloudflare location.
//
// A layer whose binding is absent admits, as the listing flip budget does
// without KV. A burst check or hourly read that throws refuses: the audit
// still completes, with that domain's hosts unprobed, and an outage spends
// no third party's budget. A write that throws after the read showed room
// admits: the burst floor already admitted the audit and the hour had room,
// and Workers KV refuses a second write to one key within a second, which
// audits of one domain running at once reach routinely. The burst floor
// still bounds those audits; the hour under-counts them. Each reservation a
// layer error decides is counted on the audit's run record.

import { getDomain } from 'tldts';
import { sha256Hex } from './cache';
import type { DomainBudget, Reservation } from './follow-requests';
import { readDeclaredDomainWindow } from './limiter';
import { recordedHostsOf, rowHostOutcomes } from './provenance';
import type { WebScorecard } from './scorecard';

export interface DomainBudgetEnv {
  SCORE_KV?: KVNamespace;
  WEB_AUDIT_DOMAIN_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

/**
 * The registrable domain a host's requests are charged to, under the public
 * suffix list with its private section, so tenants of a shared suffix
 * (`a.github.io`, `x.workers.dev`) each hold a budget of their own. A host
 * that is itself a public suffix is charged as itself.
 */
export function registrableDomainOf(hostname: string): string {
  // WHATWG URL keeps trailing dots as written, and `example.com.` names
  // the same domain as `example.com`.
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  // Hostname validation off: a label tldts would reject (`-a`, `a-`, or
  // longer than 63 characters) must still charge its parent domain, or
  // every junk label under a third party would open a fresh budget.
  return getDomain(host, { allowPrivateDomains: true, validateHostname: false }) ?? host;
}

const FAILED = Symbol('failed');

async function attempt<T>(run: () => Promise<T>): Promise<T | typeof FAILED> {
  try {
    return await run();
  } catch {
    return FAILED;
  }
}

/** The declared-domain budget over `env`'s bindings; `hourlyCeiling` overrides the audits-per-hour ceiling. */
export function declaredDomainBudget(env: DomainBudgetEnv, options: { hourlyCeiling?: number } = {}): DomainBudget {
  const { SCORE_KV: kv, WEB_AUDIT_DOMAIN_LIMITER: burst } = env;
  return {
    keyOf: registrableDomainOf,
    reserve: async (domain): Promise<Reservation> => {
      const hash = await sha256Hex(domain);
      const burstAdmits = burst ? await attempt(async () => (await burst.limit({ key: hash })).success) : true;
      if (burstAdmits === FAILED) return { admitted: false, layerError: 'burst-refused' };
      if (!burstAdmits) return { admitted: false, refusedBy: 'burst-floor' };
      if (!kv) return { admitted: true };
      const take = await attempt(() => readDeclaredDomainWindow(kv, hash, options.hourlyCeiling));
      if (take === FAILED) return { admitted: false, layerError: 'read-refused' };
      if (take === null) return { admitted: false, refusedBy: 'hourly-window' };
      if ((await attempt(take)) === FAILED) return { admitted: true, layerError: 'put-admitted' };
      return { admitted: true };
    },
  };
}

const BUDGET_REASON = 'declared-host-budget-exceeded';

const MCP_DECLARATION_KINDS: ReadonlySet<unknown> = new Set(['mcp-endpoint', 'card-document']);

/**
 * Whether the MCP rows were scored at the audited site's own endpoint. The
 * endpoint of record is the site's own whenever discovery found one, and a
 * declared endpoint the slice admitted is then recorded as beyond it, so a
 * followed endpoint in the trail means the rows were scored off the site.
 */
function scoredAtOwnEndpoint(scorecard: Pick<WebScorecard, 'declared_hosts' | 'mcp_endpoint'>): boolean {
  if (typeof scorecard.mcp_endpoint !== 'string') return false;
  return !(scorecard.declared_hosts ?? []).some(
    (entry) => entry.kind === 'mcp-endpoint' && entry.outcome === 'followed',
  );
}

/**
 * The registrable domain whose spent hourly budget left rows of `scorecard`
 * unevaluated, or null when none did. That refusal says nothing about the
 * site, so a run it touched does not replace the site's saved scorecard. A
 * refusal no row depended on, and rows the per-audit cap or the slice kept
 * from a host, are a property of the run's own declarations and save as usual.
 *
 * A refused MCP endpoint or card document counts as a dependency of the MCP
 * rows unless they were scored at the site's own endpoint: the slice tries
 * those declarations only while it has admitted no endpoint, so the refusal
 * decided which endpoint the rows describe, even when they name another host.
 */
export function domainBudgetRefusal(
  scorecard: Pick<WebScorecard, 'declared_hosts' | 'results' | 'mcp_endpoint'>,
): string | null {
  const refused = new Map<string, string>();
  let mcpRefusal: string | null = null;
  for (const entry of scorecard.declared_hosts ?? []) {
    if (entry.outcome !== 'budget-exceeded' || entry.cause !== 'domain-budget') continue;
    const url = typeof entry.final_url === 'string' ? entry.final_url : entry.url;
    if (typeof url !== 'string' || !URL.canParse(url)) continue;
    const { host, hostname } = new URL(url);
    refused.set(host, hostname);
    if (mcpRefusal === null && MCP_DECLARATION_KINDS.has(entry.kind)) mcpRefusal = hostname;
  }
  if (refused.size === 0) return null;
  if (mcpRefusal !== null && !scoredAtOwnEndpoint(scorecard)) return registrableDomainOf(mcpRefusal);
  for (const row of scorecard.results) {
    const hosts = [
      ...(row.na_reason === BUDGET_REASON ? recordedHostsOf(row) : []),
      ...rowHostOutcomes(row).flatMap((outcome) => (outcome.na_reason === BUDGET_REASON ? [outcome.host] : [])),
    ];
    const hostname = hosts.map((host) => refused.get(host)).find((name) => name !== undefined);
    if (hostname !== undefined) return registrableDomainOf(hostname);
  }
  return null;
}
