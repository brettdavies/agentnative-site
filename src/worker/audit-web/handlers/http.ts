// `http` probe handler (plan U4, tri-state per KTD-1). Resolves `path`
// or the first matching `path_any` candidate, issues the method with
// headers under the check's timeout, and evaluates via assertHttp.
// Every fetch flows through the SSRF guard.

import type { RetainedDocumentKey } from '../../../shared/web-audit-documents';
import { assertHttp, classifyAliasProbe, type ExpectBlock, type ProbeResponse } from '../assert';
import type { WebCheck } from '../registry';
import { guardedFetch } from '../ssrf';
import {
  endpointRedirects,
  redirectsToHttp,
  redirectsToHttpItem,
  resolveUrl,
  retryShapedWhy,
  sameOriginRecoveryLink,
  substituteEndpoint,
  timeoutMsFor,
} from './shared';
import type { EvidenceItem, HandlerContext, ProbeOutcome, ProbeStatus } from './types';

export type HttpWith = {
  path?: string;
  path_any?: string[];
  method?: string;
  headers?: Record<string, string>;
  expect?: ExpectBlock;
  timeout?: number;
  retain_body?: boolean;
  /** retained-document checks only: the document discovery kept that the check scores. */
  retained?: RetainedDocumentKey;
};

/**
 * Classify a non-passing candidate. A 404/410 is a missing surface. When
 * the check names an expected status (an exact list or an upper bound),
 * any other miss means the surface exists but misbehaves (broken);
 * without a status expectation the check probes an affordance of an
 * existing document, so a failed assertion means the affordance is
 * absent, not broken. A timeout is operational (error) unless the check
 * opted into an explicit hang-detection budget via `with.timeout` (e.g.
 * mcp-get-fast-fail, whose failure mode IS the held-open hang). A redirect
 * to http is absent: anc never takes that hop, and a surface served only
 * over plaintext must earn no more than a missing one.
 */
export function classifyMiss(
  resp: Pick<ProbeResponse, 'status' | 'error' | 'refused'>,
  expect: ExpectBlock,
  hasExplicitTimeout: boolean,
): Exclude<ProbeStatus, 'pass' | 'na'> {
  if (redirectsToHttp(resp)) return 'absent';
  if (resp.error !== null) {
    return resp.error.startsWith('TimeoutError') && hasExplicitTimeout ? 'broken' : 'error';
  }
  if (resp.status === 404 || resp.status === 410) return 'absent';
  const hasStatusExpectation = expect.status !== undefined || expect.status_below !== undefined;
  return hasStatusExpectation ? 'broken' : 'absent';
}

/** One response asserted against the check's expectations, as its evidence row. */
export function assessResponse(
  url: string,
  resp: ProbeResponse,
  w: HttpWith,
  base: string,
): { ok: boolean; item: EvidenceItem & { why: string[] } } {
  if (redirectsToHttp(resp)) {
    return { ok: false, item: { ...redirectsToHttpItem(url, resp.status), elapsed_ms: resp.elapsed_ms, error: null } };
  }
  const expect = w.expect ?? {};
  const asserted = assertHttp(expect, resp);
  const recovery =
    asserted.ok && expect.same_origin_recovery_link
      ? sameOriginRecoveryLink(resp.body ?? '', base)
      : { ok: true, why: '' };
  const ok = asserted.ok && recovery.ok;
  const reasons = recovery.why ? [...asserted.reasons, recovery.why] : asserted.reasons;
  return {
    ok,
    item: {
      url,
      status: resp.status,
      ok,
      why: reasons,
      elapsed_ms: resp.elapsed_ms,
      error: resp.error,
      ...(resp.truncated ? { truncated: true } : {}),
      ...(w.retain_body && ok ? { body: resp.body } : {}),
    },
  };
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
      : await guardedFetch(
          url,
          { method, headers },
          { ...ctx.fetchOptions, timeoutMs, ...endpointRedirects(rawPath, ctx.mcpEndpointFollowed, method) },
        );
    // Settled ahead of the assertion, as on every other probe of the MCP
    // endpoint: an expectation like `status_below: 500` would read a busy
    // answer as the fast refusal it asks for.
    const busy = rawPath.includes('{mcp_endpoint}') ? retryShapedWhy(resp.status) : null;
    if (busy !== null) {
      evidence.push({
        url,
        status: resp.status,
        ok: false,
        why: [busy],
        elapsed_ms: resp.elapsed_ms,
        error: resp.error,
      });
      misses.push('error');
      continue;
    }
    const { ok, item } = assessResponse(url, resp, w, ctx.base);
    evidence.push(item);
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

/**
 * retained-document eval rule: score a document discovery already read
 * against the check's `expect`, exactly as the same response fetched live
 * would score, with no request of its own. Discovery keeps a document only
 * when it read one, so a document it did not keep is absent.
 */
export async function runRetainedDocument(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as HttpWith & { retained: RetainedDocumentKey };
  const doc = ctx.retainedDocuments?.get(w.retained);
  if (doc === undefined) {
    return {
      status: 'absent',
      evidence: [{ retained: w.retained, why: [`discovery kept no ${w.retained} document`] }],
    };
  }
  const { ok, item } = assessResponse(doc.url, doc.response, w, ctx.base);
  const evidence = [{ ...item, retained: w.retained }];
  if (ok) return { status: 'pass', evidence };
  return { status: classifyMiss(doc.response, w.expect ?? {}, w.timeout !== undefined), evidence };
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
