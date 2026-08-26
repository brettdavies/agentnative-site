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
import { guardedFetch } from '../ssrf';
import { resolveUrl, substituteEndpoint, timeoutMsFor } from './shared';
import type { EvidenceItem, HandlerContext, ProbeOutcome, ProbeStatus } from './types';

type CorsWith = {
  path: string;
  surface: 'preflight' | 'actual';
  origin?: string;
  request_method?: string;
  request_headers?: string;
  timeout?: number;
};

const POST_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

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
  const postHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Origin: origin,
  };
  if (ctx.mcpSessionId) postHeaders['Mcp-Session-Id'] = ctx.mcpSessionId;

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
      { ...ctx.fetchOptions, timeoutMs },
    ),
    guardedFetch(url, { method: 'POST', headers: postHeaders, body: POST_BODY }, { ...ctx.fetchOptions, timeoutMs }),
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

  if (pre.error !== null || post.error !== null) {
    return { status: 'error', evidence };
  }

  const classifyPreflight = (): { status: ProbeStatus; why: string } => {
    if (preAcao !== null) {
      return is2xx(pre.status)
        ? { status: 'pass', why: 'preflight declares CORS with a 2xx' }
        : { status: 'broken', why: `Allow-Origin on a non-2xx preflight (${pre.status}): misconfigured` };
    }
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
