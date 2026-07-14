// `http` probe handler (plan U4, tri-state per KTD-1). Resolves `path`
// or the first matching `path_any` candidate, issues the method with
// headers under the check's timeout, and evaluates via assertHttp.
// Every fetch flows through the SSRF guard.

import { assertHttp, classifyAliasProbe, type ExpectBlock } from '../assert';
import type { WebCheck } from '../registry';
import { guardedFetch } from '../ssrf';
import { resolveUrl, substituteEndpoint, timeoutMsFor } from './shared';
import type { HandlerContext, ProbeOutcome, ProbeStatus } from './types';

type HttpWith = {
  path?: string;
  path_any?: string[];
  method?: string;
  headers?: Record<string, string>;
  expect?: ExpectBlock;
  timeout?: number;
  retain_body?: boolean;
};

/**
 * Classify a non-passing candidate. A 404/410 is a missing surface. When
 * the check names an expected status, any other miss means the surface
 * exists but misbehaves (broken); without a status expectation the check
 * probes an affordance of an existing document, so a failed assertion
 * means the affordance is absent, not broken. A timeout is operational
 * (error) unless the check opted into an explicit hang-detection budget
 * via `with.timeout` (e.g. mcp-get-fast-fail, whose failure mode IS the
 * held-open hang).
 */
function classifyMiss(
  resp: { status: number | null; error: string | null },
  expect: ExpectBlock,
  hasExplicitTimeout: boolean,
): Exclude<ProbeStatus, 'pass' | 'na'> {
  if (resp.error !== null) {
    return resp.error.startsWith('TimeoutError') && hasExplicitTimeout ? 'broken' : 'error';
  }
  if (resp.status === 404 || resp.status === 410) return 'absent';
  return expect.status !== undefined ? 'broken' : 'absent';
}

export async function runHttp(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as HttpWith;
  const paths = w.path_any ?? (w.path !== undefined ? [w.path] : []);
  const method = w.method ?? 'GET';
  const headers = w.headers ?? {};
  const expect = w.expect ?? {};
  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);

  const evidence: ProbeOutcome['evidence'] = [];
  const misses: Array<Exclude<ProbeStatus, 'pass' | 'na'>> = [];
  for (const rawPath of paths) {
    const url = resolveUrl(ctx.base, substituteEndpoint(rawPath, ctx.mcpEndpoint));
    if (!url) continue;
    const reuseRoot = ctx.root !== undefined && url === ctx.base && method === 'GET' && w.headers === undefined;
    const resp = reuseRoot
      ? (ctx.root as NonNullable<HandlerContext['root']>)
      : await guardedFetch(url, { method, headers }, { ...ctx.fetchOptions, timeoutMs });
    const { ok, reasons } = assertHttp(expect, resp);
    evidence.push({
      url,
      status: resp.status,
      ok,
      why: reasons,
      elapsed_ms: resp.elapsed_ms,
      error: resp.error,
      ...(w.retain_body && ok ? { body: resp.body } : {}),
    });
    if (ok) return { status: 'pass', evidence };
    misses.push(classifyMiss(resp, expect, w.timeout !== undefined));
  }
  if (evidence.length === 0) {
    return { status: 'na', evidence: [{ why: ['no resolvable probe URL'] }] };
  }
  // Across path_any candidates: any broken outranks absent (something is
  // there and wrong); a definitive absence outranks an operational error.
  const status = misses.includes('broken') ? 'broken' : misses.includes('absent') ? 'absent' : 'error';
  return { status, evidence };
}

type AliasSpec = string | { path: string; headers?: Record<string, string> };

/**
 * canonical-plus-redirect-aliases eval rule (plan-003 U5, R8). The
 * canonical path is the requirement, evaluated with the standard
 * following fetch + assertions; each alias is probed WITHOUT following
 * redirects (the default handler reports only the final hop, so it can
 * never see the 301). A broken alias (inline duplicate, non-permanent or
 * off-canonical redirect) downgrades an otherwise-passing check to
 * broken; absent aliases carry no penalty.
 */
export async function runCanonicalRedirect(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as {
    path: string;
    aliases?: AliasSpec[];
    expect?: ExpectBlock;
    timeout?: number;
  };
  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);
  const expect = w.expect ?? {};
  const canonicalUrl = resolveUrl(ctx.base, w.path);
  if (!canonicalUrl) return { status: 'na', evidence: [{ why: ['no resolvable canonical URL'] }] };

  const evidence: ProbeOutcome['evidence'] = [];
  const canonicalResp = await guardedFetch(canonicalUrl, {}, { ...ctx.fetchOptions, timeoutMs });
  const { ok, reasons } = assertHttp(expect, canonicalResp);
  evidence.push({ url: canonicalUrl, role: 'canonical', status: canonicalResp.status, ok, why: reasons });

  let canonicalStatus: ProbeStatus;
  if (ok) canonicalStatus = 'pass';
  else canonicalStatus = classifyMiss(canonicalResp, expect, w.timeout !== undefined);

  let aliasBroken = false;
  for (const alias of w.aliases ?? []) {
    const spec = typeof alias === 'string' ? { path: alias } : alias;
    const aliasUrl = resolveUrl(ctx.base, substituteEndpoint(spec.path, ctx.mcpEndpoint));
    if (!aliasUrl) continue;
    const resp = await guardedFetch(
      aliasUrl,
      { headers: spec.headers },
      { ...ctx.fetchOptions, timeoutMs, followRedirects: false },
    );
    const { verdict, note } = classifyAliasProbe(resp, aliasUrl, canonicalUrl);
    evidence.push({ url: aliasUrl, role: 'alias', status: resp.status, alias_verdict: verdict, why: [note] });
    if (verdict === 'broken') aliasBroken = true;
  }

  const status = canonicalStatus === 'pass' && aliasBroken ? 'broken' : canonicalStatus;
  return { status, evidence };
}
