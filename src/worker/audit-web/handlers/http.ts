// `http` probe handler (plan U4). Resolves `path` or the first matching
// `path_any` candidate, issues the method with headers under the check's
// timeout, and evaluates via assertHttp. Every fetch flows through the
// SSRF guard. Port of handler_http from the extracted auditor.

import { assertHttp, type ExpectBlock } from '../assert';
import type { WebCheck } from '../registry';
import { guardedFetch } from '../ssrf';
import { resolveUrl, substituteEndpoint, timeoutMsFor } from './shared';
import type { HandlerContext, ProbeOutcome } from './types';

export async function runHttp(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as {
    path?: string;
    path_any?: string[];
    method?: string;
    headers?: Record<string, string>;
    expect?: ExpectBlock;
    timeout?: number;
  };
  const paths = w.path_any ?? (w.path !== undefined ? [w.path] : []);
  const method = w.method ?? 'GET';
  const headers = w.headers ?? {};
  const expect = w.expect ?? {};
  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);

  const evidence: ProbeOutcome['evidence'] = [];
  for (const rawPath of paths) {
    const url = resolveUrl(ctx.base, substituteEndpoint(rawPath, ctx.mcpEndpoint));
    if (!url) continue;
    const resp = await guardedFetch(url, { method, headers }, { ...ctx.fetchOptions, timeoutMs });
    const { ok, reasons } = assertHttp(expect, resp);
    evidence.push({ url, status: resp.status, ok, why: reasons, elapsed_ms: resp.elapsed_ms, error: resp.error });
    if (ok) return { status: 'pass', evidence };
  }
  return { status: 'fail', evidence };
}
