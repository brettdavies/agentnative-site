// Detects a YAML frontmatter block at the head of the root markdown twin.
// The generic http handler compiles body_regex with the `m` flag, so a
// `^---` anchor also matches a mid-document thematic break; recognizing a
// frontmatter opener requires scanning from the first byte, which needs a
// dedicated handler. Detection is structural only (fence pair + at least one
// key line): the audit reads "is there a well-formed block", not the parsed
// values, so pulling a YAML parser into the Worker bundle buys nothing.

import type { WebCheck } from '../registry';
import { guardedFetch } from '../ssrf';
import { resolveUrl, timeoutMsFor } from './shared';
import type { HandlerContext, ProbeOutcome } from './types';

type MarkdownFrontmatterWith = {
  path?: string;
  headers?: Record<string, string>;
  timeout?: number;
};

const HTML_CT = /text\/html/i;
const FENCE = /^(?:---|\.\.\.)$/;
const KEY_LINE = /^\S[^:]*:(\s|$)/;

export async function runMarkdownFrontmatter(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as MarkdownFrontmatterWith;
  const path = w.path ?? '/';
  const headers = w.headers ?? { Accept: 'text/markdown' };
  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);

  const url = resolveUrl(ctx.base, path);
  if (!url) return { status: 'error', evidence: [{ why: ['no resolvable probe URL'] }] };

  const resp = await guardedFetch(url, { headers }, { ...ctx.fetchOptions, timeoutMs });
  if (resp.error !== null || resp.status === null) {
    return { status: 'error', evidence: [{ url, status: resp.status, error: resp.error }] };
  }

  // The antecedent should preclude an HTML root here; guard anyway so a stray
  // `---` in HTML never reads as a frontmatter fence.
  const contentType = resp.headers['content-type'] ?? '';
  if (HTML_CT.test(contentType)) {
    return {
      status: 'absent',
      evidence: [{ url, status: resp.status, ok: false, why: ['root served HTML, not a markdown twin'] }],
    };
  }

  const body = resp.body.charCodeAt(0) === 0xfeff ? resp.body.slice(1) : resp.body;
  const lines = body.split(/\r?\n/);
  if (lines[0] !== '---') {
    return {
      status: 'absent',
      evidence: [{ url, status: resp.status, ok: false, why: ['no leading frontmatter fence'] }],
    };
  }

  let terminator = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      terminator = i;
      break;
    }
  }
  if (terminator === -1) {
    return {
      status: 'broken',
      evidence: [{ url, status: resp.status, ok: false, why: ['unterminated frontmatter fence'] }],
    };
  }

  let keyLines = 0;
  for (let i = 1; i < terminator; i++) {
    if (KEY_LINE.test(lines[i])) keyLines += 1;
  }
  if (keyLines === 0) {
    return {
      status: 'broken',
      evidence: [{ url, status: resp.status, ok: false, why: ['frontmatter fence encloses no key line'] }],
    };
  }

  return {
    status: 'pass',
    evidence: [{ url, status: resp.status, ok: true, why: [`frontmatter present (${keyLines} key lines)`] }],
  };
}
