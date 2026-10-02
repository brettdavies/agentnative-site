// The display vocabulary every website result surface shares. STATUS_LABELS
// is the single enumeration of the seven web scorecard statuses; STATUS_ORDER
// derives from it rather than repeating the list, so a status added there
// reaches the labels, the marks, the counts, and the machine context together.

import type { ScorecardStatus } from './scorecard';

// Locked label strings for the two scores: the RELATIVE headline reads as the
// site's own score; GLOBAL is explicitly framed against the maximal site so
// the two percentages do not compete.
export const RELATIVE_LABEL = 'site score';
export const RELATIVE_SUBLABEL = 'relative to the checks that apply to this site';
export const GLOBAL_LABEL = 'of a maximally agent-ready site';

export const STATUS_LABELS: Record<ScorecardStatus, string> = {
  pass: 'PASS',
  noncompliant: 'NONCOMPLIANT',
  broken: 'BROKEN',
  absent: 'MISSING',
  n_a: 'N/A',
  skip: 'SKIP',
  error: 'ERROR',
};

// Check-row marks: pass ✓, noncompliant ~, absent (missing) !, broken/error ✕,
// n_a/skip –. Broken outranks absent in severity (a present-but-broken surface
// misleads agents) so it carries the fail mark, while a noncompliant surface
// works and reads as a partial.
const STATUS_MARKS: Record<ScorecardStatus, string> = {
  pass: '✓',
  noncompliant: '~',
  broken: '✕',
  absent: '!',
  n_a: '–',
  skip: '–',
  error: '✕',
};

/** The seven statuses in documented order, derived from the one enumeration. */
export const STATUS_ORDER = Object.keys(STATUS_LABELS) as ScorecardStatus[];

// The RFC-2119 keyword is a per-check obligation, so it renders on each check
// row and never on a category header: a category holds a mix of keywords, and
// the scorer weighs each check by its own, never by its group.
export const TIER_LABELS: Record<string, string> = { must: 'MUST', should: 'SHOULD', may: 'MAY' };

export function statusLabel(status: ScorecardStatus): string {
  return STATUS_LABELS[status] ?? String(status).toUpperCase();
}

export function statusMark(status: ScorecardStatus): string {
  return STATUS_MARKS[status] ?? '–';
}
