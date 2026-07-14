// `scoped-llms` probe handler (plan-003 U8, R15/KTD-5). Enumerates
// per-section llms.txt / llms-full.txt candidates from the UNION of the
// root llms.txt link index and top-level sitemap paths, deduplicated
// before probing.
//
// SSRF: every candidate href comes from the target's own
// (attacker-controlled) documents, so candidates are restricted to the
// audited origin and each probe still flows through
// validatePublicUrl/guardedFetch — an off-origin or private-IP href is
// dropped, never fetched.

import type { WebCheck } from '../registry';
import { guardedFetch, validatePublicUrl } from '../ssrf';
import { timeoutMsFor } from './shared';
import type { HandlerContext, ProbeOutcome, ProbeStatus } from './types';

const DEFAULT_MAX_CANDIDATES = 8;
const MARKDOWN_LINK_RE = /\]\(([^)\s]+)\)/g;
const SITEMAP_LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

function topLevelDir(href: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.origin !== new URL(base).origin) return null; // off-origin href: dropped, never fetched
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return null; // a root-level file has no section directory
  return `/${segments[0]}`;
}

/**
 * The deduplicated union of top-level section directories referenced by
 * the root llms.txt link index and the sitemap. Pure; exported for the
 * engine to compute once per audit.
 */
export function enumerateScopedDirs(llmsBody: string, sitemapBody: string, base: string): string[] {
  const dirs = new Set<string>();
  for (const match of llmsBody.matchAll(MARKDOWN_LINK_RE)) {
    const dir = topLevelDir(match[1], base);
    if (dir) dirs.add(dir);
  }
  for (const match of sitemapBody.matchAll(SITEMAP_LOC_RE)) {
    const dir = topLevelDir(match[1], base);
    if (dir) dirs.add(dir);
  }
  return [...dirs];
}

export async function runScopedLlms(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as { file?: string; max_candidates?: number; timeout?: number };
  const file = w.file ?? 'llms.txt';
  const cap = w.max_candidates ?? DEFAULT_MAX_CANDIDATES;
  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);
  const dirs = (ctx.scopedDirs ?? []).slice(0, cap);

  if (dirs.length === 0) {
    return { status: 'absent', evidence: [{ why: ['no section directories in the root llms.txt or sitemap'] }] };
  }

  const evidence: ProbeOutcome['evidence'] = [];
  const misses: Array<Exclude<ProbeStatus, 'pass' | 'na'>> = [];
  for (const dir of dirs) {
    const url = new URL(`${dir}/${file}`, ctx.base).toString();
    const validation = validatePublicUrl(url);
    if (!validation.ok) {
      evidence.push({ url, blocked: validation.reason });
      continue;
    }
    const resp = await guardedFetch(url, {}, { ...ctx.fetchOptions, timeoutMs });
    if (resp.error !== null) {
      evidence.push({ url, status: null, error: resp.error });
      misses.push('error');
      continue;
    }
    if (resp.status === 200) {
      const body = resp.body ?? '';
      const valid = body.trim().length > 0 && /^#|\]\(/m.test(body);
      evidence.push({ url, status: resp.status, ok: valid });
      if (valid) return { status: 'pass', evidence };
      misses.push('broken');
      continue;
    }
    evidence.push({ url, status: resp.status, ok: false });
    misses.push(resp.status === 404 || resp.status === 410 ? 'absent' : 'broken');
  }
  if (misses.length === 0) {
    return { status: 'absent', evidence };
  }
  const status = misses.includes('broken') ? 'broken' : misses.includes('absent') ? 'absent' : 'error';
  return { status, evidence };
}
