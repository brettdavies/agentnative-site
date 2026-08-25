// llms.txt quality trio (format / links / when-to-use). Reads the retained
// wave-1 `/llms.txt` body so format and when-to-use issue no extra fetch.
// Link probes are SSRF-guarded and budgeted like scoped-llms.

import type { WebCheck } from '../registry';
import { guardedFetch, validatePublicUrl } from '../ssrf';
import { timeoutMsFor } from './shared';
import type { HandlerContext, ProbeOutcome, ProbeStatus } from './types';

const MARKDOWN_LINK_RE = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const DEFAULT_MAX_LINKS = 8;
const WHEN_TO_USE_HEADING = /^#{1,3}\s+.*(when\s+to\s+use|programmatic access|when to (?:connect|call) (?:the )?mcp)/im;

type QualityOp = 'format' | 'links' | 'when-to-use';

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
  const cap = w.max_candidates ?? DEFAULT_MAX_LINKS;
  const hrefs = hrefsFrom(body, ctx.base).slice(0, cap);
  if (hrefs.length === 0) {
    return { status: 'absent', evidence: [{ why: ['llms.txt has no followable links'] }] };
  }

  const evidence: ProbeOutcome['evidence'] = [];
  const misses: Array<Exclude<ProbeStatus, 'pass' | 'na'>> = [];
  for (const href of hrefs) {
    const validation = validatePublicUrl(href);
    if (!validation.ok) {
      evidence.push({ url: href, blocked: validation.reason, ok: false });
      misses.push('absent');
      continue;
    }
    const resp = await guardedFetch(href, {}, { ...ctx.fetchOptions, timeoutMs });
    if (resp.error !== null || resp.status === null) {
      evidence.push({ url: href, status: resp.status, error: resp.error, ok: false });
      misses.push('error');
      continue;
    }
    const ok = resp.status >= 200 && resp.status < 400;
    evidence.push({ url: href, status: resp.status, ok });
    if (!ok) misses.push(resp.status === 404 || resp.status === 410 ? 'absent' : 'broken');
  }

  if (misses.length === 0) return { status: 'pass', evidence };
  const status = misses.includes('broken') ? 'broken' : misses.includes('absent') ? 'absent' : 'error';
  return { status, evidence };
}
