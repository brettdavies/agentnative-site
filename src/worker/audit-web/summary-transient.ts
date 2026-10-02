// Why a website result was not saved, and the one line its inline render
// shows in place of the freshness sentence.

import { scorePath } from '../../shared/audit-routes';
import { escHtml } from '../../shared/esc-html';
import { shortDate } from '../../shared/result-spine';

/**
 * When a held run may be tried again: once the hourly window refusing it
 * turns at `at`, or in about a minute, which clears a burst-floor refusal
 * and a budget layer's error.
 */
export type DomainBudgetRetry = { after: 'hour'; at: string } | { after: 'minute' };

export type TransientReason =
  /** The caller asked not to follow the hosts the site declares. */
  | { kind: 'opt-out' }
  /** A declared domain spent its hourly probe budget, so the site's saved scorecard stands. */
  | { kind: 'domain-budget'; domain: string; host: string; savedScoredAt: string | null; retry: DomainBudgetRetry };

function timeEl(iso: string, text: string): string {
  return `<time datetime="${escHtml(iso)}">${escHtml(text)}</time>`;
}

function retrySentence(retry: DomainBudgetRetry): string {
  if (retry.after === 'minute') return ' Try again in a minute.';
  const at = Date.parse(retry.at);
  if (Number.isNaN(at)) return '';
  return ` Try again after ${timeEl(retry.at, `${new Date(at).toISOString().slice(11, 13)}:00 UTC`)}.`;
}

export function transientReasonHtml(reason: TransientReason): string {
  if (reason.kind === 'opt-out') return 'Not saved: declared hosts were not followed for this run.';
  const date = shortDate(reason.savedScoredAt);
  const saved =
    reason.savedScoredAt && date
      ? `the saved scorecard from ${timeEl(reason.savedScoredAt, date)}`
      : 'the saved scorecard';
  return (
    `Not saved: ${escHtml(reason.domain)} reached anc's hourly probe limit; ` +
    `<a href="${escHtml(scorePath(reason.host))}">${saved}</a> is unchanged.${retrySentence(reason.retry)}`
  );
}
