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
// off-origin declaration is recorded and dropped, never probed. Each pass
// probes its candidates concurrently under one shared slice, and every
// slice is bounded by both the per-audit deadline and the discovery
// budget, so the three passes together cannot outrun the audit budget
// even against a target that never answers.

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

// Hard wall-clock cap on the whole discovery phase. Discovery is a
// prerequisite for the MCP checks, not the audit itself, so it must never
// starve the check waves: a target that tarpits unsolicited POSTs (drops
// them without responding until the socket times out) would otherwise eat
// one full per-check timeout per candidate path and spend the entire
// per-audit deadline before the first real check runs.
const DISCOVERY_BUDGET_MS = 12_000;

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
  const deadlineAt = Math.min(opts.deadlineAt ?? Number.POSITIVE_INFINITY, now() + DISCOVERY_BUDGET_MS);
  /** This pass's slice of the remaining discovery budget; null once spent. */
  const passBudget = (): number | null => {
    const slice = Math.min(opts.timeoutMs, remainingDeadlineMs(deadlineAt, now()));
    return slice > 0 ? slice : null;
  };
  const exhausted = (): DiscoveryResult => {
    evidence.push({ note: 'per-audit deadline exceeded during discovery' });
    return { endpoint: null, evidence };
  };
  /** Probe every candidate in one concurrent pass; results stay in path order. */
  const probeAll = (urls: string[], init: Parameters<typeof guardedFetch>[1], timeoutMs: number) =>
    Promise.all(urls.map((url) => guardedFetch(url, init, { ...opts.fetchOptions, timeoutMs })));

  // Pass 1: well-known cards. All candidates fetch concurrently; the first
  // (in configured order) that yields a same-origin endpoint wins.
  {
    const urls = cfg.well_known.map((wk) => resolveUrl(base, wk)).filter((u) => u.length > 0);
    const timeoutMs = passBudget();
    if (timeoutMs === null) return exhausted();
    const responses = await probeAll(urls, {}, timeoutMs);
    for (const [i, resp] of responses.entries()) {
      const wk = cfg.well_known[i];
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
  }

  // Pass 2: legacy initialize on the common paths, concurrently.
  {
    const legacyInit = {
      method: 'POST',
      headers: legacyProbeHeaders(),
      body: legacyInitializeBody(cfg.protocol_version),
    };
    const paths = cfg.common_paths.filter((p) => resolveUrl(base, p).length > 0);
    const timeoutMs = passBudget();
    if (timeoutMs === null) return exhausted();
    const responses = await probeAll(
      paths.map((p) => resolveUrl(base, p)),
      legacyInit,
      timeoutMs,
    );
    for (const [i, resp] of responses.entries()) {
      const p = paths[i];
      const url = resolveUrl(base, p);
      const rpc = parseJsonRpc(resp);
      const result = rpc?.result as { serverInfo?: unknown } | undefined;
      if (rpc && result && typeof result === 'object' && result.serverInfo) {
        evidence.push({ source: p, endpoint: url, probed: 'initialize' });
        return { endpoint: url, evidence };
      }
      evidence.push({ source: p, status: resp.status, probed: 'initialize (no serverInfo)' });
    }
  }

  // Pass 3: modern header-routed tools/list on the same paths, concurrently.
  {
    const modernInit = {
      method: 'POST',
      headers: modernProbeHeaders('tools/list'),
      body: modernProbeBody('tools/list'),
    };
    const paths = cfg.common_paths.filter((p) => resolveUrl(base, p).length > 0);
    const timeoutMs = passBudget();
    if (timeoutMs === null) return exhausted();
    const responses = await probeAll(
      paths.map((p) => resolveUrl(base, p)),
      modernInit,
      timeoutMs,
    );
    for (const [i, resp] of responses.entries()) {
      const p = paths[i];
      const url = resolveUrl(base, p);
      const rpc = parseJsonRpc(resp);
      const result = rpc?.result as { tools?: unknown } | undefined;
      if (result && Array.isArray(result.tools)) {
        evidence.push({ source: p, endpoint: url, probed: 'modern-tools-list' });
        return { endpoint: url, evidence };
      }
      evidence.push({ source: p, status: resp.status, probed: 'modern-tools-list (no tools)' });
    }
  }

  return { endpoint: null, evidence };
}
