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
      if (!burstAdmits) return { admitted: false };
      if (!kv) return { admitted: true };
      const take = await attempt(() => readDeclaredDomainWindow(kv, hash, options.hourlyCeiling));
      if (take === FAILED) return { admitted: false, layerError: 'read-refused' };
      if (take === null) return { admitted: false };
      if ((await attempt(take)) === FAILED) return { admitted: true, layerError: 'put-admitted' };
      return { admitted: true };
    },
  };
}
