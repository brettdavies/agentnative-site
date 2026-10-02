// llms.txt quality trio (format / links / when-to-use). Reads the retained
// wave-1 `/llms.txt` body so format and when-to-use issue no extra fetch.
// Link probes are SSRF-guarded and budgeted like scoped-llms. An http link,
// or one that redirects to http, is never requested: llmstxt.org asks for a
// markdown link per item and never for plaintext, so such a link is present
// but not usable over https.

import type { WebCheck } from '../registry';
import { guardedFetch, STATUS_ONLY_BODY_BYTES, validatePublicUrl } from '../ssrf';
import { remainingDeadlineMs, timeoutMsFor } from './shared';
import type { EvidenceItem, HandlerContext, ProbeOutcome, ProbeStatus } from './types';

const MARKDOWN_LINK_RE = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const DEFAULT_MAX_LINKS = 8;
const WHEN_TO_USE_HEADING = /^#{1,3}\s+.*(when\s+to\s+use|programmatic access|when to (?:connect|call) (?:the )?mcp)/im;

type QualityOp = 'format' | 'links' | 'when-to-use';

/** Which miss decides the links row when several links miss. */
const MISS_ORDER = ['broken', 'noncompliant', 'absent', 'error'] as const;

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
  for (const match of body.matchAll(MARKDOWN_LINK_RE)) {
    const raw = match[1];
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

/** One link's evidence and its own verdict, which the row's evidence line reads to name the link that decided it. */
async function probeLink(
  href: string,
  timeoutMs: number,
  ctx: HandlerContext,
): Promise<{ verdict: Exclude<ProbeStatus, 'na'>; item: EvidenceItem }> {
  const validation = validatePublicUrl(href);
  if (!validation.ok) return { verdict: 'absent', item: { url: href, blocked: validation.reason, ok: false } };
  if (validation.url.protocol !== 'https:') {
    return {
      verdict: 'noncompliant',
      item: { url: href, blocked: 'not https', ok: false, why: ['not https; not requested'] },
    };
  }
  const resp = await guardedFetch(href, {}, { ...ctx.fetchOptions, timeoutMs, maxBodyBytes: STATUS_ONLY_BODY_BYTES });
  if (resp.refused === 'insecure-scheme') {
    return {
      verdict: 'noncompliant',
      item: { url: href, status: resp.status, ok: false, why: ['redirects to http; not requested'] },
    };
  }
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

  const evidence: ProbeOutcome['evidence'] = [];
  const misses: Array<Exclude<ProbeStatus, 'pass' | 'na'>> = [];
  for (const href of hrefs) {
    const slice = remainingDeadlineMs(deadlineAt);
    if (slice <= 0) {
      evidence.push({ why: ['nested-probe budget exhausted'] });
      misses.push('error');
      break;
    }
    const { verdict, item } = await probeLink(href, slice, ctx);
    evidence.push({ ...item, link_verdict: verdict });
    if (verdict !== 'pass') misses.push(verdict);
  }

  if (misses.length === 0) return { status: 'pass', evidence };
  const status = MISS_ORDER.find((miss) => misses.includes(miss)) ?? 'error';
  const exhausted = evidence.some((row) => Array.isArray(row.why) && row.why.includes('nested-probe budget exhausted'));
  return { status, evidence, ...(exhausted ? { incomplete: true } : {}) };
}
