// `auth-md` probe handler (plan-003 U6, R7). Probes the agent
// auth/registration metadata doc (Cloudflare's auth.md pattern):
// a markdown guide at /.well-known/auth.md or /auth.md telling an agent
// how to obtain credentials. Antecedent `auth-present` gates this to
// sites that actually expose an auth surface, so an open site is n_a,
// never penalized.

import type { WebCheck } from '../registry';
import { guardedFetch } from '../ssrf';
import { resolveUrl, timeoutMsFor } from './shared';
import type { HandlerContext, ProbeOutcome, ProbeStatus } from './types';

const MARKDOWNISH_CT = /markdown|text\/plain/i;
const HTML_CT = /text\/html/i;

export async function runAuthMd(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as { path_any?: string[]; path?: string; timeout?: number };
  const paths = w.path_any ?? (w.path !== undefined ? [w.path] : ['/.well-known/auth.md', '/auth.md']);
  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);

  const evidence: ProbeOutcome['evidence'] = [];
  const misses: Array<Exclude<ProbeStatus, 'pass' | 'na'>> = [];
  for (const rawPath of paths) {
    const url = resolveUrl(ctx.base, rawPath);
    if (!url) continue;
    const resp = await guardedFetch(url, {}, { ...ctx.fetchOptions, timeoutMs });
    if (resp.error !== null) {
      evidence.push({ url, status: null, error: resp.error });
      misses.push('error');
      continue;
    }
    const ct = resp.headers['content-type'] ?? '';
    const body = resp.body ?? '';
    if (resp.status === 200) {
      // Valid = a non-empty markdown/plain document (or one that at
      // least opens with a markdown heading); an HTML page or an empty
      // body at the auth.md path is a present-but-broken surface.
      const looksMarkdown = MARKDOWNISH_CT.test(ct) || (!HTML_CT.test(ct) && /^\s*#/.test(body));
      const valid = body.trim().length > 0 && looksMarkdown;
      evidence.push({ url, status: resp.status, ok: valid, content_type: ct });
      if (valid) return { status: 'pass', evidence };
      misses.push('broken');
      continue;
    }
    evidence.push({ url, status: resp.status, ok: false });
    misses.push(resp.status === 404 || resp.status === 410 ? 'absent' : 'broken');
  }
  const status = misses.includes('broken') ? 'broken' : misses.includes('absent') ? 'absent' : 'error';
  return { status, evidence };
}
