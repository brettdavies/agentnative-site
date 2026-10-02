// Discovery's POST probing on the audited origin's common MCP paths: the
// legacy `initialize` and modern `tools/list` POSTs go to every path at
// once under one timeout, and a legacy answer wins.
//
// A POST is never re-sent off the audited origin. A common path that
// answers with a redirect to another origin is recorded with its target,
// and the target is declared like a card's off-origin endpoint, so it is
// probed only once its own host confirms it. A common path that answers
// with a 401 is returned with its challenge, so discovery can ask whether
// metadata on the audited host names it.

import { type ProbeResponse, parseJsonRpc } from './assert';
import { type McpDeclaration, sameOrigin } from './discovery-documents';
import { legacyInitializeBody, legacyProbeHeaders, modernProbeBody, modernProbeHeaders } from './handlers/mcp';
import type { EvidenceItem } from './handlers/types';
import type { ChallengedPath } from './mcp-auth';
import { type GuardedFetchInit, type GuardedFetchOptions, guardedFetch, REDIRECT_STATUSES } from './ssrf';

/** Where a POST answer redirected off the audited origin, as the URL a hop would request, or null. */
function offOriginRedirect(url: string, resp: ProbeResponse): string | null {
  const location = resp.headers.location;
  if (resp.status === null || !REDIRECT_STATUSES.has(resp.status) || location === undefined) return null;
  let target: string;
  try {
    target = new URL(location, url).toString();
  } catch {
    return null;
  }
  return sameOrigin(target, url) ? null : target;
}

type PostProbing = {
  endpoint: string | null;
  items: EvidenceItem[];
  redirected: McpDeclaration[];
  /** With no endpoint found, the paths whose POSTs drew a 401, in probe order. */
  challenged: ChallengedPath[];
};

/** The paths a POST lane answered with 401, the legacy lane's answer read first. */
function challengedPaths(
  candidates: ReadonlyArray<{ path: string; url: string }>,
  legacy: readonly ProbeResponse[],
  modern: readonly ProbeResponse[],
): ChallengedPath[] {
  return candidates.flatMap((candidate, i) => {
    const legacyChallenged = legacy[i].status === 401;
    const resp = legacyChallenged ? legacy[i] : modern[i];
    if (resp.status !== 401) return [];
    const probed = legacyChallenged ? 'initialize' : 'modern-tools-list';
    return [{ ...candidate, probed, challenge: resp.headers['www-authenticate'] ?? null }];
  });
}

/** Legacy `initialize` and modern `tools/list` on every common path at once; a legacy answer wins. */
export async function probeCommonPaths(
  candidates: ReadonlyArray<{ path: string; url: string }>,
  protocolVersion: string,
  timeoutMs: number,
  fetchOptions: Pick<GuardedFetchOptions, 'fetchImpl' | 'maxRedirects'> | undefined,
): Promise<PostProbing> {
  const send = (init: GuardedFetchInit) =>
    Promise.all(
      candidates.map((c) => guardedFetch(c.url, init, { ...fetchOptions, timeoutMs, crossOriginRedirects: 'return' })),
    );
  const [legacy, modern] = await Promise.all([
    send({ method: 'POST', headers: legacyProbeHeaders(), body: legacyInitializeBody(protocolVersion) }),
    send({ method: 'POST', headers: modernProbeHeaders('tools/list'), body: modernProbeBody('tools/list') }),
  ]);
  const items: EvidenceItem[] = [];
  const redirected: McpDeclaration[] = [];
  const miss = (candidate: (typeof candidates)[number], resp: ProbeResponse, probed: string, why: string): void => {
    const target = offOriginRedirect(candidate.url, resp);
    if (target === null) {
      items.push({ source: candidate.path, status: resp.status, probed: `${probed} (${why})` });
      return;
    }
    items.push({
      source: candidate.path,
      status: resp.status,
      probed: `${probed} (off-origin redirect)`,
      redirect: target,
    });
    if (!redirected.some((d) => d.url === target)) {
      redirected.push({ kind: 'mcp-endpoint', url: target, source: candidate.path });
    }
  };
  for (const [i, resp] of legacy.entries()) {
    const { path, url } = candidates[i];
    const rpc = parseJsonRpc(resp);
    const result = rpc?.result as { serverInfo?: unknown } | undefined;
    if (rpc && result && typeof result === 'object' && result.serverInfo) {
      items.push({ source: path, endpoint: url, probed: 'initialize' });
      return { endpoint: url, items, redirected, challenged: [] };
    }
    miss(candidates[i], resp, 'initialize', 'no serverInfo');
  }
  for (const [i, resp] of modern.entries()) {
    const { path, url } = candidates[i];
    const result = parseJsonRpc(resp)?.result as { tools?: unknown } | undefined;
    if (result && Array.isArray(result.tools)) {
      items.push({ source: path, endpoint: url, probed: 'modern-tools-list' });
      return { endpoint: url, items, redirected, challenged: [] };
    }
    miss(candidates[i], resp, 'modern-tools-list', 'no tools');
  }
  return { endpoint: null, items, redirected, challenged: challengedPaths(candidates, legacy, modern) };
}
