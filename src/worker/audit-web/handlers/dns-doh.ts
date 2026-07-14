// `dns-doh` probe handler (plan U4). Queries DNS-over-HTTPS (JSON API,
// `Accept: application/dns-json`) for agent-discovery records under the
// `_agents` namespace. Passes when any queried name returns Status:0
// with a non-empty Answer. Status:3 (NXDOMAIN) is definitive-absent and
// stops that name; the fallback resolver is tried only on a resolver-
// level failure (network error or unparseable body). Port of
// handler_dns_doh.
//
// The DoH resolvers are the guarded egress targets here — public
// hostnames (cloudflare-dns.com, dns.google) that pass the SSRF guard.

import type { WebCheck } from '../registry';
import { guardedFetch } from '../ssrf';
import { substituteHost, timeoutMsFor } from './shared';
import type { EvidenceItem, HandlerContext, ProbeOutcome } from './types';

const DEFAULT_RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];

export async function runDnsDoh(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  if (!ctx.host) {
    return { status: 'na', evidence: [{ why: ['no host in URL'] }] };
  }
  const w = check.with as { names: string[]; type?: string; resolvers?: string[]; timeout?: number };
  const names = w.names.map((n) => substituteHost(n, ctx.host));
  const rtype = w.type ?? 'SVCB';
  const resolvers = w.resolvers ?? DEFAULT_RESOLVERS;
  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);

  const evidence: EvidenceItem[] = [];
  for (const name of names) {
    for (const resolver of resolvers) {
      const url = `${resolver}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(rtype)}`;
      const resp = await guardedFetch(
        url,
        { headers: { Accept: 'application/dns-json' } },
        { ...ctx.fetchOptions, timeoutMs },
      );
      let data: { Status?: number; Answer?: unknown[] } | null = null;
      try {
        data = JSON.parse(resp.body);
      } catch {
        data = null;
      }
      if (resp.error || data === null) continue; // resolver-level failure — try the fallback resolver
      const answers = Array.isArray(data.Answer) ? data.Answer : [];
      const ok = data.Status === 0 && answers.length > 0;
      evidence.push({ name, resolver, dns_status: data.Status ?? null, answers: answers.length });
      if (ok) return { status: 'pass', evidence };
      break; // definitive DNS answer (e.g. NXDOMAIN) — move to the next name
    }
  }
  // Any definitive empty answer means the records are absent; nothing
  // definitive at all (every resolver failed) is an operational error.
  if (evidence.length > 0) return { status: 'absent', evidence };
  return { status: 'error', evidence: [{ why: ['all DoH resolvers failed'] }] };
}
