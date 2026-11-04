// llms.txt quality trio (format / links / when-to-use). Reads the retained
// source `/llms.txt` body so format and when-to-use issue no extra fetch.
// Link probes are SSRF-guarded and run side by side under the audit's cap; a
// link not answered by the check's deadline reads as the budget running out,
// whichever order the others finished in. An http link, or one that redirects
// to http, is never requested: llmstxt.org asks for a markdown link per item
// and never for plaintext, so such a link is present but not usable over https.

import { oneAtATime } from '../audit-slots';
import type { WebCheck } from '../registry';
import { guardedFetch, STATUS_ONLY_BODY_BYTES, validatePublicUrl } from '../ssrf';
import {
  markdownHrefs,
  plaintextItem,
  redirectsToHttp,
  redirectsToHttpItem,
  remainingDeadlineMs,
  timeoutMsFor,
} from './shared';
import type { EvidenceItem, HandlerContext, ProbeOutcome, ProbeStatus } from './types';

export const DEFAULT_MAX_LINKS = 8;
const BUDGET_EXHAUSTED_WHY = 'nested-probe budget exhausted';
const WHEN_TO_USE_HEADING = /^#{1,3}\s+.*(when\s+to\s+use|programmatic access|when to (?:connect|call) (?:the )?mcp)/im;

type QualityOp = 'format' | 'links' | 'when-to-use';

/**
 * Which miss decides the links row when several links miss. A dead link
 * outranks an http one because noncompliant earns credit and absent does
 * not: listing an http link must never lift a row a dead link decides.
 */
const MISS_ORDER = ['broken', 'absent', 'noncompliant', 'error'] as const;

function formatWhy(body: string): { ok: boolean; why: string[] } {
  const hasH1 = /^#\s+\S/m.test(body);
  const hasSummary = /^>\s+\S/m.test(body);
  const hasLinks = /\]\([^)\s]+\)/.test(body);
  const why = [
    hasH1 ? 'h1 present' : 'no h1',
    hasSummary ? 'summary blockquote present' : 'no summary blockquote',
    hasLinks ? 'link index present' : 'no markdown link index',
  ];
  return { ok: hasH1 && hasSummary && hasLinks, why };
}

function hrefsFrom(body: string, base: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of markdownHrefs(body)) {
    if (raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('javascript:')) continue;
    let href: string;
    try {
      href = new URL(raw, base).toString();
    } catch {
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

type LinkProbe = { verdict: Exclude<ProbeStatus, 'na'>; item: EvidenceItem; exhausted?: true };

function budgetExhausted(href: string): LinkProbe {
  return { verdict: 'error', item: { url: href, ok: false, why: [BUDGET_EXHAUSTED_WHY] }, exhausted: true };
}

/** One link's evidence and its own verdict, which the row's evidence line reads to name the link that decided it. */
async function probeLink(href: string, deadlineAt: number, ctx: HandlerContext): Promise<LinkProbe> {
  const validation = validatePublicUrl(href);
  if (!validation.ok) return { verdict: 'absent', item: { url: href, blocked: validation.reason, ok: false } };
  if (validation.url.protocol !== 'https:') {
    return {
      verdict: 'noncompliant',
      item: { url: href, ...plaintextItem('not https') },
    };
  }
  const timeoutMs = remainingDeadlineMs(deadlineAt);
  if (timeoutMs <= 0) return budgetExhausted(href);
  const resp = await guardedFetch(href, {}, { ...ctx.fetchOptions, timeoutMs, maxBodyBytes: STATUS_ONLY_BODY_BYTES });
  if (resp.error?.startsWith('TimeoutError')) return budgetExhausted(href);
  if (redirectsToHttp(resp)) return { verdict: 'noncompliant', item: redirectsToHttpItem(href, resp.status) };
  if (resp.error !== null || resp.status === null) {
    return { verdict: 'error', item: { url: href, status: resp.status, error: resp.error, ok: false } };
  }
  const ok = resp.status >= 200 && resp.status < 400;
  const verdict = ok ? 'pass' : resp.status === 404 || resp.status === 410 ? 'absent' : 'broken';
  return { verdict, item: { url: href, status: resp.status, ok } };
}

export async function runLlmsTxtQuality(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as { op?: QualityOp; max_candidates?: number; timeout?: number };
  const op = w.op ?? 'format';
  const body = ctx.retainedBodies?.get('llms-txt') ?? '';
  if (body.length === 0) {
    return { status: 'absent', evidence: [{ why: ['no retained llms.txt body'] }] };
  }

  if (op === 'format') {
    const { ok, why } = formatWhy(body);
    return { status: ok ? 'pass' : 'absent', evidence: [{ url: `${ctx.base}llms.txt`, ok, why }] };
  }

  if (op === 'when-to-use') {
    const ok = WHEN_TO_USE_HEADING.test(body);
    return {
      status: ok ? 'pass' : 'absent',
      evidence: [
        {
          url: `${ctx.base}llms.txt`,
          ok,
          why: [ok ? 'when-to-use or programmatic-access heading present' : 'no when-to-use heading'],
        },
      ],
    };
  }

  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);
  const deadlineAt = Date.now() + timeoutMs;
  const cap = w.max_candidates ?? DEFAULT_MAX_LINKS;
  const hrefs = hrefsFrom(body, ctx.base).slice(0, cap);
  if (hrefs.length === 0) {
    return { status: 'absent', evidence: [{ why: ['llms.txt has no followable links'] }] };
  }

  const probes = await (ctx.fanOut ?? oneAtATime)(hrefs, (href) => probeLink(href, deadlineAt, ctx));
  const evidence = probes.map(({ verdict, item }) => ({ ...item, link_verdict: verdict }));
  const verdicts = probes.map((probe) => probe.verdict);
  const status = MISS_ORDER.find((miss) => verdicts.includes(miss)) ?? 'pass';
  return { status, evidence, ...(probes.some((probe) => probe.exhausted) ? { incomplete: true } : {}) };
}
