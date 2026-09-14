// Source-level guard over the WebMCP bundle: an in-page tool prepares the
// page and stops. Every construct below is a way a tool could transact on a
// visitor's behalf — submitting the entry form through its handlers, driving
// a control, or walking to the progress page — so the guard bans the
// construct rather than trusting each tool to stay read-and-fill.
//
// `form.submit()` is deliberately absent from the ban list: the entry form's
// action is a GET that only prefills the audit page, and submitting it fires
// no submit handler. `requestSubmit()` does fire them, which is the whole
// difference.
//
// Comment lines are skipped so a module can name a banned construct while
// explaining why it does not use one.

import { SCORING_PATH } from '../../src/shared/audit-routes';

export type GuardRule = { rule: string; why: string; re: RegExp };

export type GuardHit = { file: string; line: number; rule: string; text: string };

export const GUARD_RULES: readonly GuardRule[] = [
  {
    rule: 'requestSubmit',
    why: 'fires the form submit handler, which acquires a token and posts',
    re: /\brequestSubmit\s*\(/,
  },
  {
    rule: 'synthetic submit event',
    why: 'a dispatched submit event reaches the same handler',
    re: /new\s+SubmitEvent\s*\(|new\s+Event\s*\(\s*['"`]submit['"`]/,
  },
  {
    rule: 'element click',
    why: 'driving a control is the human gesture these tools must not forge',
    re: /\.click\s*\(/,
  },
  {
    rule: 'reaudit control',
    why: 'the Re-audit control starts a fresh run on click',
    re: /data-reaudit/,
  },
  {
    rule: 'startAudit',
    why: 'the transact entry point: it spends a Turnstile token and navigates',
    re: /\bstartAudit\b/,
  },
  {
    rule: 'progress page navigation',
    why: 'the progress page runs the audit; no tool may send a visitor there',
    re: new RegExp(`${SCORING_PATH}\\b|\\bscoringPath\\s*\\(|\\bSCORING_PATH\\b`),
  },
  {
    rule: 'direct navigation',
    why: 'only submitting the entry form GET may move the visitor',
    re: /\blocation\s*\.\s*(?:href\s*=|assign\s*\(|replace\s*\()|\bwindow\s*\.\s*open\s*\(/,
  },
];

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#)/;

/** Every banned construct in one source file, by line. */
export function scanWebMcpSource(source: string, file: string): GuardHit[] {
  const hits: GuardHit[] = [];
  source.split('\n').forEach((text, index) => {
    if (COMMENT_LINE.test(text)) return;
    for (const { rule, re } of GUARD_RULES) {
      if (re.test(text)) hits.push({ file, line: index + 1, rule, text: text.trim() });
    }
  });
  return hits;
}

export function formatHits(hits: readonly GuardHit[]): string {
  const why = new Map(GUARD_RULES.map((r) => [r.rule, r.why]));
  return hits.map((h) => `${h.file}:${h.line}: ${h.rule} (${why.get(h.rule)})\n    ${h.text}`).join('\n');
}
