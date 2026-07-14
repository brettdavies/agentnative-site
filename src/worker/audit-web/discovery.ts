// MCP endpoint discovery (plan U5). Probes well-known cards first
// (extracting mcp_endpoint / url / transport.endpoint), then POSTs
// `initialize` to the common paths and takes the first that returns a
// serverInfo. Port of discover_mcp_endpoint. All egress flows through
// the SSRF guard.

import { parseJsonRpc } from './assert';
import { resolveUrl } from './handlers/shared';
import type { EvidenceItem } from './handlers/types';
import type { WebAuditDiscoveryConfig } from './registry';
import { type GuardedFetchOptions, guardedFetch } from './ssrf';

export interface DiscoveryOptions {
  timeoutMs: number;
  fetchOptions?: Pick<GuardedFetchOptions, 'fetchImpl' | 'maxRedirects'>;
}

export interface DiscoveryResult {
  endpoint: string | null;
  evidence: EvidenceItem[];
}

function initializeBody(protocolVersion: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'agent-web-audit', version: '1.0' },
    },
  });
}

export async function discoverMcpEndpoint(
  base: string,
  cfg: WebAuditDiscoveryConfig,
  opts: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const evidence: EvidenceItem[] = [];
  const fetchOpts = { ...opts.fetchOptions, timeoutMs: opts.timeoutMs };

  for (const wk of cfg.well_known) {
    const url = resolveUrl(base, wk);
    if (!url) continue;
    const resp = await guardedFetch(url, {}, fetchOpts);
    if (resp.status !== 200) continue;
    const card = parseJsonRpc(resp) ?? {};
    const transport = card.transport as { endpoint?: string } | undefined;
    const ep = (card.mcp_endpoint as string) || (card.url as string) || transport?.endpoint;
    if (ep) {
      const resolved = resolveUrl(base, ep);
      const item: EvidenceItem = { source: wk, endpoint: resolved };
      // Surface the card's auth declaration for the mcp-auth antecedent.
      if (card.authentication !== undefined || card.auth !== undefined) item.authentication = true;
      evidence.push(item);
      return { endpoint: resolved, evidence };
    }
    evidence.push({ source: wk, note: 'card present, no endpoint field' });
  }

  for (const p of cfg.common_paths) {
    const url = resolveUrl(base, p);
    if (!url) continue;
    const resp = await guardedFetch(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: initializeBody(cfg.protocol_version),
      },
      fetchOpts,
    );
    const rpc = parseJsonRpc(resp);
    const result = rpc?.result as { serverInfo?: unknown } | undefined;
    if (rpc && result && typeof result === 'object' && result.serverInfo) {
      evidence.push({ source: p, endpoint: url, probed: 'initialize' });
      return { endpoint: url, evidence };
    }
    evidence.push({ source: p, status: resp.status, probed: 'initialize (no serverInfo)' });
  }

  return { endpoint: null, evidence };
}
