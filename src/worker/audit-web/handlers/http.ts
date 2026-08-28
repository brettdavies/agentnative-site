// `http` probe handler (plan U4, tri-state per KTD-1). Resolves `path`
// or the first matching `path_any` candidate, issues the method with
// headers under the check's timeout, and evaluates via assertHttp.
// Every fetch flows through the SSRF guard.

import { assertHttp, classifyAliasProbe, type ExpectBlock } from '../assert';
import type { WebCheck } from '../registry';
import { guardedFetch } from '../ssrf';
import { resolveUrl, sameOriginRecoveryLink, substituteEndpoint, timeoutMsFor } from './shared';
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
 * the check names an expected status (an exact list or an upper bound),
 * any other miss means the surface exists but misbehaves (broken);
 * without a status expectation the check probes an affordance of an
 * existing document, so a failed assertion means the affordance is
 * absent, not broken. A timeout is operational (error) unless the check
 * opted into an explicit hang-detection budget via `with.timeout` (e.g.
 * mcp-get-fast-fail, whose failure mode IS the held-open hang).
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
  const hasStatusExpectation = expect.status !== undefined || expect.status_below !== undefined;
  return hasStatusExpectation ? 'broken' : 'absent';
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
    const asserted = assertHttp(expect, resp);
    const recovery =
      asserted.ok && expect.same_origin_recovery_link
        ? sameOriginRecoveryLink(resp.body ?? '', ctx.base)
        : { ok: true, why: '' };
    const ok = asserted.ok && recovery.ok;
    const reasons = recovery.why ? [...asserted.reasons, recovery.why] : asserted.reasons;
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
 * legacy-alias-redirects eval rule: whether the legacy MCP card paths point
 * at the canonical card instead of serving their own copy. This is its own
 * MAY row rather than a modifier on the canonical-card requirement, because
 * publishing the card and retiring its legacy aliases are separate pieces of
 * work with separate fixes, and a row carries one status and one prompt.
 *
 * Only the aliases are fetched. The canonical URL is resolved from
 * `with.canonical` for target comparison and never probed, so this row adds
 * no subrequest beyond the aliases themselves. Each alias is fetched WITHOUT
 * following redirects, because the default handler reports only the final
 * hop and could never see the 301.
 *
 * One correct redirect is enough to pass: a site serves whichever legacy
 * paths it historically published, so requiring all of them would fail a
 * site for paths it never had. An unpublished alias carries no penalty, and
 * a MAY row with nothing published at all resolves to n_a upstream.
 *
 * Without a correct redirect, the worst observed defect decides the row. An
 * inline copy is `noncompliant`: the surface answers, but it is a second
 * source of truth that can drift from the canonical card. A non-permanent or
 * off-canonical redirect is `broken`, because it actively sends agents
 * somewhere else.
 */
export async function runLegacyAliasRedirects(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as {
    canonical: string;
    aliases?: AliasSpec[];
    timeout?: number;
  };
  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);
  const canonicalUrl = resolveUrl(ctx.base, w.canonical);
  if (!canonicalUrl) return { status: 'na', evidence: [{ why: ['no resolvable canonical URL'] }] };

  const evidence: ProbeOutcome['evidence'] = [];
  let redirected = false;
  let misdirected = false;
  let inlineCopy = false;
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
    if (verdict === 'pass') redirected = true;
    else if (verdict === 'broken') {
      // A 2xx alias answered with a body of its own; every other verdict in
      // the broken bucket is a redirect that misses the canonical card.
      const status = resp.status ?? 0;
      if (status >= 200 && status < 300) inlineCopy = true;
      else misdirected = true;
    }
  }

  if (evidence.length === 0) return { status: 'na', evidence: [{ why: ['no resolvable alias URL'] }] };
  if (redirected) return { status: 'pass', evidence };
  if (misdirected) return { status: 'broken', evidence };
  if (inlineCopy) return { status: 'noncompliant', evidence };
  return { status: 'absent', evidence };
}
