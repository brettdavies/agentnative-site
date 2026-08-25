// Content-without-JS / SSR content floor. The root HTML must carry an H1
// and a minimum of visible text so a non-JS agent can read the page.
// When that floor fails but a passing `llms.txt` links resolvable
// same-origin content, the handler returns `na` (KD1: soften, no pass
// credit) after bounded SSRF-safe probes of those links. Antecedents do
// not fetch; the retained llms.txt body is the only twin signal.

import type { WebCheck } from '../registry';
import { guardedFetch, validatePublicUrl } from '../ssrf';
import { timeoutMsFor } from './shared';
import type { HandlerContext, ProbeOutcome } from './types';

const MIN_VISIBLE_CHARS = 200;
const MAX_TWIN_PROBES = 3;
const MIN_TWIN_CHARS = 40;
const MARKDOWN_LINK_RE = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const INDEX_PATHS = new Set(['/llms.txt', '/llms-full.txt', '/robots.txt', '/sitemap.xml', '/favicon.ico']);

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function floorMet(html: string): { ok: boolean; why: string[] } {
  const hasH1 = /<h1[\s>]/i.test(html);
  const text = visibleText(html);
  const why: string[] = [
    hasH1 ? 'h1 present' : 'no h1 in raw HTML',
    `visible text ${text.length} chars (min ${MIN_VISIBLE_CHARS})`,
  ];
  return { ok: hasH1 && text.length >= MIN_VISIBLE_CHARS, why };
}

function contentHrefs(llmsBody: string, base: string): string[] {
  const origin = new URL(base).origin;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of llmsBody.matchAll(MARKDOWN_LINK_RE)) {
    let url: URL;
    try {
      url = new URL(match[1], base);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    const path = url.pathname.replace(/\/$/, '') || '/';
    if (INDEX_PATHS.has(url.pathname) || INDEX_PATHS.has(path)) continue;
    if (url.pathname === '/' || path === '') continue;
    const href = url.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

export async function runContentWithoutJs(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as { timeout?: number };
  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);
  const root = ctx.root;
  if (!root || root.status === null) {
    return { status: 'error', evidence: [{ why: ['root fetch unavailable'] }] };
  }

  const html = root.body ?? '';
  const floor = floorMet(html);
  if (floor.ok) {
    return { status: 'pass', evidence: [{ url: ctx.base, status: root.status, ok: true, why: floor.why }] };
  }

  const llmsBody = ctx.retainedBodies?.get('llms-txt') ?? '';
  if (llmsBody.length === 0) {
    return {
      status: 'absent',
      evidence: [{ url: ctx.base, status: root.status, ok: false, why: [...floor.why, 'no retained llms.txt body'] }],
    };
  }

  const hrefs = contentHrefs(llmsBody, ctx.base).slice(0, MAX_TWIN_PROBES);
  const evidence: ProbeOutcome['evidence'] = [{ url: ctx.base, status: root.status, ok: false, why: floor.why }];
  for (const href of hrefs) {
    const validation = validatePublicUrl(href);
    if (!validation.ok) {
      evidence.push({ url: href, blocked: validation.reason });
      continue;
    }
    const resp = await guardedFetch(href, {}, { ...ctx.fetchOptions, timeoutMs });
    if (resp.error !== null || resp.status === null) {
      evidence.push({ url: href, status: resp.status, error: resp.error });
      continue;
    }
    const body = resp.body ?? '';
    const substantial = resp.status >= 200 && resp.status < 300 && body.trim().length >= MIN_TWIN_CHARS;
    evidence.push({ url: href, status: resp.status, ok: substantial, why: [`twin body ${body.trim().length} chars`] });
    if (substantial) {
      return {
        status: 'na',
        evidence: [...evidence, { why: ['digital twin discoverable via resolvable llms.txt content link'] }],
      };
    }
  }

  return {
    status: 'absent',
    evidence: [
      ...evidence,
      {
        why: [
          hrefs.length === 0 ? 'llms.txt has no same-origin content links' : 'llms.txt content links did not resolve',
        ],
      },
    ],
  };
}
