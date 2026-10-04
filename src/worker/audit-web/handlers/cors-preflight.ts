// CORS posture handler for the `mcp-cors-preflight` / `mcp-cors-actual`
// pair. Each check id issues BOTH probes (the OPTIONS preflight and an
// Origin-bearing JSON-RPC POST) and classifies its own surface from the
// pair, so the two concurrently-running checks need no shared engine
// state. A consistent no-CORS posture (no Access-Control-Allow-Origin on
// either surface) is a deliberate choice and returns n_a with
// na_reason 'posture-consistent'; only partial or misconfigured CORS
// scores broken. Returns a reasonless n_a when the target path cannot
// resolve (no discovered MCP endpoint).

import type { WebCheck } from '../registry';
import { guardedFetch, STATUS_ONLY_BODY_BYTES } from '../ssrf';
import { LEGACY_TOOLS_LIST_BODY, legacyProbeHeaders } from './mcp';
import {
  endpointRedirects,
  resolveUrl,
  retryShapedAnswer,
  retryShapedWhy,
  substituteEndpoint,
  timeoutMsFor,
} from './shared';
import type { EvidenceItem, HandlerContext, ProbeOutcome, ProbeStatus } from './types';

type CorsWith = {
  path: string;
  surface: 'preflight' | 'actual';
  origin?: string;
  request_method?: string;
  request_headers?: string;
  timeout?: number;
};

const POSTURE_WHY = 'no Allow-Origin on the preflight or the POST: consistent no-CORS posture';

function is2xx(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

export async function runCorsPreflight(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as CorsWith;
  if (w.surface !== 'preflight' && w.surface !== 'actual') {
    throw new Error(`cors-preflight: check "${check.id}" needs with.surface "preflight" or "actual"`);
  }
  const url = resolveUrl(ctx.base, substituteEndpoint(w.path, ctx.mcpEndpoint));
  if (!url) {
    return { status: 'na', evidence: [{ why: ['no endpoint to preflight'] }] };
  }
  const origin = w.origin ?? 'https://example.com';
  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);
  const redirects = endpointRedirects(w.path, ctx.mcpEndpointFollowed);
  const postHeaders: Record<string, string> = { ...legacyProbeHeaders(), Origin: origin };
  if (ctx.mcpSessionId) postHeaders['Mcp-Session-Id'] = ctx.mcpSessionId;

  // Both verdicts read response headers only, so neither probe buffers a
  // body a hostile target could make arbitrarily large.
  const [pre, post] = await Promise.all([
    guardedFetch(
      url,
      {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': w.request_method ?? 'POST',
          'Access-Control-Request-Headers': w.request_headers ?? 'content-type',
        },
      },
      { ...ctx.fetchOptions, timeoutMs, maxBodyBytes: STATUS_ONLY_BODY_BYTES, ...redirects },
    ),
    guardedFetch(
      url,
      { method: 'POST', headers: postHeaders, body: LEGACY_TOOLS_LIST_BODY },
      { ...ctx.fetchOptions, timeoutMs, maxBodyBytes: STATUS_ONLY_BODY_BYTES, ...redirects },
    ),
  ]);

  const preAcao = pre.headers['access-control-allow-origin'] ?? null;
  const postAcao = post.headers['access-control-allow-origin'] ?? null;
  const preEv: EvidenceItem = {
    probe: 'preflight',
    url,
    status: pre.status,
    allow_origin: preAcao,
    allow_methods: pre.headers['access-control-allow-methods'] ?? null,
    allow_headers: pre.headers['access-control-allow-headers'] ?? null,
    error: pre.error,
  };
  const postEv: EvidenceItem = { probe: 'post', url, status: post.status, allow_origin: postAcao, error: post.error };
  // The classified surface's own probe row leads, so the generic n_a
  // evidence line (first row's `why`) always describes this check.
  const evidence = w.surface === 'preflight' ? [preEv, postEv] : [postEv, preEv];

  // Each id owns one surface, so a sibling probe that failed or was asked
  // to retry cannot suppress a check whose own probe answered. The sibling
  // is still needed to read the pair as a posture, so when its answer is
  // unusable the surface's own Allow-Origin classifies and a pair without
  // one is an operational unknown, not a declared opt-out. A busy answer's
  // headers describe the layer reporting the load, so they are never read
  // as either surface's posture.
  const [own, sibling] = w.surface === 'preflight' ? [pre, post] : [post, pre];
  if (own.error !== null) {
    return { status: 'error', evidence };
  }
  const ownBusy = retryShapedWhy(own.status);
  if (ownBusy !== null) {
    evidence[0].why = [ownBusy];
    return { status: 'error', evidence };
  }
  const siblingBusy = retryShapedAnswer(sibling.status);
  const siblingUnusable =
    sibling.error !== null ? `failed (${sibling.error})` : siblingBusy !== null ? `answered ${siblingBusy}` : null;
  const siblingUnknown = (label: string): { status: ProbeStatus; why: string } => ({
    status: 'error',
    why: `the ${label} probe ${siblingUnusable}, so the no-CORS posture cannot be confirmed`,
  });

  const classifyPreflight = (): { status: ProbeStatus; why: string } => {
    if (preAcao !== null) {
      return is2xx(pre.status)
        ? { status: 'pass', why: 'preflight declares CORS with a 2xx' }
        : { status: 'broken', why: `Allow-Origin on a non-2xx preflight (${pre.status}): misconfigured` };
    }
    if (siblingUnusable !== null) return siblingUnknown('POST');
    if (postAcao !== null) {
      return {
        status: 'broken',
        why: 'the POST carries Allow-Origin but the preflight does not: inconsistent posture',
      };
    }
    return { status: 'na', why: POSTURE_WHY };
  };
  const classifyActual = (): { status: ProbeStatus; why: string } => {
    if (postAcao !== null) return { status: 'pass', why: 'the POST response carries Allow-Origin' };
    if (siblingUnusable !== null) return siblingUnknown('preflight');
    if (preAcao !== null) {
      return { status: 'broken', why: 'the preflight declares CORS but the POST omits Allow-Origin' };
    }
    return { status: 'na', why: POSTURE_WHY };
  };

  const verdict = w.surface === 'preflight' ? classifyPreflight() : classifyActual();
  evidence[0].why = [verdict.why];
  return {
    status: verdict.status,
    ...(verdict.status === 'na' ? { na_reason: 'posture-consistent' as const } : {}),
    evidence,
  };
}
