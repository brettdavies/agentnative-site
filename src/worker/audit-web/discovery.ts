// MCP endpoint discovery. Probes well-known cards first (extracting
// mcp_endpoint / url / transport.endpoint), then POSTs legacy
// `initialize` to the common paths and takes the first that returns a
// serverInfo; when that pass finds nothing, a modern header-routed
// `tools/list` pass over the same paths takes the first `tools` result,
// so a modern-only server is still discoverable. Evidence records which
// probe found the endpoint. All egress flows through the SSRF guard.
//
// The card's endpoint is attacker-controlled, so it is restricted to the
// audited origin the same way scoped-llms restricts llms.txt hrefs: an
// off-origin declaration is recorded and dropped, never probed. Every
// hop is sliced against the per-audit deadline, so the three passes
// together cannot outrun the audit budget.

import { parseJsonRpc } from './assert';
import { legacyInitializeBody, legacyProbeHeaders, modernProbeBody, modernProbeHeaders } from './handlers/mcp';
import { remainingDeadlineMs, resolveUrl } from './handlers/shared';
import type { EvidenceItem } from './handlers/types';
import type { WebAuditDiscoveryConfig } from './registry';
import { type GuardedFetchOptions, guardedFetch } from './ssrf';

export interface DiscoveryOptions {
  timeoutMs: number;
  fetchOptions?: Pick<GuardedFetchOptions, 'fetchImpl' | 'maxRedirects'>;
  /** Absolute per-audit deadline in ms; hops stop once it is spent. */
  deadlineAt?: number;
  /** Injectable clock, matching the engine's deterministic deadline tests. */
  now?: () => number;
}

export interface DiscoveryResult {
  endpoint: string | null;
  evidence: EvidenceItem[];
}

function sameOrigin(candidate: string, base: string): boolean {
  try {
    return new URL(candidate).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

export async function discoverMcpEndpoint(
  base: string,
  cfg: WebAuditDiscoveryConfig,
  opts: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const evidence: EvidenceItem[] = [];
  const now = opts.now ?? Date.now;
  const deadlineAt = opts.deadlineAt ?? Number.POSITIVE_INFINITY;
  /** This hop's slice of the remaining audit budget; null once it is spent. */
  const hopBudget = (): number | null => {
    const slice = Math.min(opts.timeoutMs, remainingDeadlineMs(deadlineAt, now()));
    return slice > 0 ? slice : null;
  };
  const exhausted = (): DiscoveryResult => {
    evidence.push({ note: 'per-audit deadline exceeded during discovery' });
    return { endpoint: null, evidence };
  };

  for (const wk of cfg.well_known) {
    const url = resolveUrl(base, wk);
    if (!url) continue;
    const timeoutMs = hopBudget();
    if (timeoutMs === null) return exhausted();
    const resp = await guardedFetch(url, {}, { ...opts.fetchOptions, timeoutMs });
    if (resp.status !== 200) continue;
    const card = parseJsonRpc(resp) ?? {};
    const transport = card.transport as { endpoint?: string } | undefined;
    const ep = (card.mcp_endpoint as string) || (card.url as string) || transport?.endpoint;
    if (ep) {
      const resolved = resolveUrl(base, ep);
      if (!sameOrigin(resolved, base)) {
        evidence.push({ source: wk, endpoint: resolved, blocked: 'off-origin endpoint declaration' });
        continue;
      }
      const item: EvidenceItem = { source: wk, endpoint: resolved };
      // Surface the card's auth declaration for the mcp-auth antecedent.
      if (card.authentication !== undefined || card.auth !== undefined) item.authentication = true;
      evidence.push(item);
      return { endpoint: resolved, evidence };
    }
    evidence.push({ source: wk, note: 'card present, no endpoint field' });
  }

  const legacyInit = {
    method: 'POST',
    headers: legacyProbeHeaders(),
    body: legacyInitializeBody(cfg.protocol_version),
  };
  for (const p of cfg.common_paths) {
    const url = resolveUrl(base, p);
    if (!url) continue;
    const timeoutMs = hopBudget();
    if (timeoutMs === null) return exhausted();
    const resp = await guardedFetch(url, legacyInit, { ...opts.fetchOptions, timeoutMs });
    const rpc = parseJsonRpc(resp);
    const result = rpc?.result as { serverInfo?: unknown } | undefined;
    if (rpc && result && typeof result === 'object' && result.serverInfo) {
      evidence.push({ source: p, endpoint: url, probed: 'initialize' });
      return { endpoint: url, evidence };
    }
    evidence.push({ source: p, status: resp.status, probed: 'initialize (no serverInfo)' });
  }

  const modernInit = { method: 'POST', headers: modernProbeHeaders('tools/list'), body: modernProbeBody('tools/list') };
  for (const p of cfg.common_paths) {
    const url = resolveUrl(base, p);
    if (!url) continue;
    const timeoutMs = hopBudget();
    if (timeoutMs === null) return exhausted();
    const resp = await guardedFetch(url, modernInit, { ...opts.fetchOptions, timeoutMs });
    const rpc = parseJsonRpc(resp);
    const result = rpc?.result as { tools?: unknown } | undefined;
    if (result && Array.isArray(result.tools)) {
      evidence.push({ source: p, endpoint: url, probed: 'modern-tools-list' });
      return { endpoint: url, evidence };
    }
    evidence.push({ source: p, status: resp.status, probed: 'modern-tools-list (no tools)' });
  }

  return { endpoint: null, evidence };
}
