// `cors-preflight` probe handler (plan U4). Issues OPTIONS with Origin /
// Access-Control-Request-Method / Access-Control-Request-Headers and
// passes on a 200/204 that carries Access-Control-Allow-Origin. Returns
// n_a when the target path can't resolve (no discovered MCP endpoint).
// Port of handler_cors_preflight.

import type { WebCheck } from '../registry';
import { guardedFetch } from '../ssrf';
import { resolveUrl, substituteEndpoint, timeoutMsFor } from './shared';
import type { HandlerContext, ProbeOutcome } from './types';

export async function runCorsPreflight(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as {
    path: string;
    origin?: string;
    request_method?: string;
    request_headers?: string;
    timeout?: number;
  };
  const url = resolveUrl(ctx.base, substituteEndpoint(w.path, ctx.mcpEndpoint));
  if (!url) {
    return { status: 'na', evidence: [{ why: ['no endpoint to preflight'] }] };
  }
  const resp = await guardedFetch(
    url,
    {
      method: 'OPTIONS',
      headers: {
        Origin: w.origin ?? 'https://example.com',
        'Access-Control-Request-Method': w.request_method ?? 'POST',
        'Access-Control-Request-Headers': w.request_headers ?? 'content-type',
      },
    },
    { ...ctx.fetchOptions, timeoutMs: timeoutMsFor(w.timeout, ctx.defaultTimeoutMs) },
  );
  const allowOrigin = resp.headers['access-control-allow-origin'] ?? null;
  const ok = (resp.status === 200 || resp.status === 204) && allowOrigin !== null;
  // No Allow-Origin anywhere = CORS simply not implemented (absent); an
  // Allow-Origin on a non-2xx preflight = misconfigured (broken).
  let status: ProbeOutcome['status'];
  if (ok) status = 'pass';
  else if (resp.error) status = 'error';
  else if (allowOrigin === null) status = 'absent';
  else status = 'broken';
  return {
    status,
    evidence: [
      {
        url,
        status: resp.status,
        allow_origin: allowOrigin,
        allow_methods: resp.headers['access-control-allow-methods'] ?? null,
        allow_headers: resp.headers['access-control-allow-headers'] ?? null,
        error: resp.error,
      },
    ],
  };
}
