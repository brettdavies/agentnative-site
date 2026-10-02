// The budget every declared registrable domain shares across audits and
// callers: the follow slice reserves one unit per audit and domain before
// its first request there (follow-requests.ts). Both layers key on the
// domain's hash. The rate-limit binding is the 60-second burst floor,
// because the KV window is a read then a write on an eventually consistent
// store, so audits running at once can all read the same count; the KV
// window is the hourly ceiling the binding cannot express.
//
// A layer whose binding is absent admits, as the listing flip budget does
// without KV. A layer that throws refuses: the audit still completes, with
// that domain's hosts unprobed, and an outage spends no third party's budget.

import { getDomain } from 'tldts';
import { sha256Hex } from './cache';
import type { DomainBudget } from './follow-requests';
import { consumeDeclaredDomainBudget } from './limiter';

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

/** The declared-domain budget over `env`'s bindings; `hourlyCeiling` overrides the audits-per-hour ceiling. */
export function declaredDomainBudget(env: DomainBudgetEnv, options: { hourlyCeiling?: number } = {}): DomainBudget {
  const { SCORE_KV: kv, WEB_AUDIT_DOMAIN_LIMITER: burst } = env;
  return {
    keyOf: registrableDomainOf,
    reserve: async (domain) => {
      try {
        const hash = await sha256Hex(domain);
        if (burst && !(await burst.limit({ key: hash })).success) return false;
        return kv ? await consumeDeclaredDomainBudget(kv, hash, options.hourlyCeiling) : true;
      } catch {
        return false;
      }
    },
  };
}
