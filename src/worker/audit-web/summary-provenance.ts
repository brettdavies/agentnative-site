// Where a result's evidence came from, stated once where it applies: a
// category whose evaluated rows all reached one host other than the audited
// site says so under its rollup, and a row that reached a different host
// says so under its own label.

import { rowHostOutcomes, rowHostsOf } from './provenance';
import { categoryHostLine, evaluatedAtNote, notRunScoreNote } from './provenance-copy';
import type { Rich } from './rich-text';
import type { WebScorecardRow } from './summary-model';
import { declarerOf, type TrailInput } from './summary-trail';
import type { SummaryRow } from './summary-types';

/** The check whose rows record which API description the audit read. */
const OPENAPI_CHECK = 'openapi';

/** The one host other than the audited site that every evaluated row with a host reached, if there is one. */
function categoryHost(rows: readonly SummaryRow[], entryHost: string): string | null {
  const others = new Set<string>();
  for (const row of rows) {
    if (row.notRun !== null) continue;
    for (const host of row.recordedHosts) if (host !== entryHost) others.add(host);
  }
  return others.size === 1 ? [...others][0] : null;
}

/** A category's host line and each row's host note, read against that line or the audited host. */
export function categoryProvenance(
  rows: readonly SummaryRow[],
  entryHost: string,
  trail: Pick<TrailInput, 'trail' | 'discovery' | 'domain'>,
): { hostLine: Rich | null; rows: SummaryRow[] } {
  const host = categoryHost(rows, entryHost);
  const reference = host ?? entryHost;
  return {
    hostLine: host === null ? null : categoryHostLine(host, declarerOf(host, trail)),
    rows: rows.map((row) => {
      const [only] = row.recordedHosts;
      const differs = row.notRun === null && row.recordedHosts.length === 1 && only !== reference;
      return differs ? { ...row, hostNote: evaluatedAtNote(only) } : row;
    }),
  };
}

/** Hosts whose OpenAPI description the audit read and scored as present. */
export function openapiHosts(rows: readonly WebScorecardRow[], entryHost: string): Set<string> {
  const row = rows.find((r) => r.id === OPENAPI_CHECK);
  if (row === undefined) return new Set();
  const outcomes = rowHostOutcomes(row);
  if (outcomes.length > 1) return new Set(outcomes.filter((o) => o.status === 'pass').map((o) => o.host));
  return row.status === 'pass' ? new Set(rowHostsOf(row, entryHost)) : new Set();
}

/** The score note's sentence when the public audit could not run some rows, or null when it ran them all. */
export function notRunNote(rows: readonly SummaryRow[], domain: string): Rich | null {
  const notRun = rows.filter((row) => row.notRun !== null);
  if (notRun.length === 0) return null;
  const signIn = notRun.some((row) => row.notRun?.reason === 'auth-required');
  return notRunScoreNote(notRun.length, domain, signIn);
}
