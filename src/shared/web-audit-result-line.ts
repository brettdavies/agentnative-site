// The always-shown Result line of a web-audit row, built from the shared
// reason phrases. The result page, its markdown twin, the MCP reads, and the
// progress page all build it here, so a row reads the same words while it
// streams and once it is saved. Typechecked under both the client and the
// Worker configs, so it names neither environment.

import { FINDING_STATUSES, type FindingStatus, NA_REASONS, type NaReason, naReasonPhrase } from './web-audit-findings';

/** One host a row's evidence was requested from, with that host's own outcome on a row over several hosts. */
export type HostOutcome = { host: string; status?: string; na_reason?: string };

const HOST_STATUS_WORDS: Readonly<Record<FindingStatus, string>> = {
  pass: 'pass',
  noncompliant: 'noncompliant',
  broken: 'broken',
  absent: 'missing',
  n_a: 'n/a',
  skip: 'skip',
  error: 'error',
};

/**
 * Each host's own outcome, as `api.example.com: pass, api2.example.com:
 * broken`, or null unless the row evaluated more than one host and recorded
 * an outcome for each.
 */
function hostOutcomesText(hosts: readonly HostOutcome[] | undefined): string | null {
  if (!hosts || hosts.length < 2) return null;
  const parts: string[] = [];
  for (const entry of hosts) {
    const status = FINDING_STATUSES.find((s) => s === entry.status);
    if (status === undefined) return null;
    parts.push(`${entry.host}: ${HOST_STATUS_WORDS[status]}`);
  }
  return parts.join(', ');
}

function isNaReason(value: string | undefined): value is NaReason {
  return (NA_REASONS as readonly string[]).includes(value ?? '');
}

/**
 * The Result line, derived uniformly from status and evidence (affirmative
 * for pass, negative otherwise). An `n_a` row with a reason leads with that
 * reason's shared phrase, which names `host`, the row's host. A row over
 * several hosts ends with each host's own outcome.
 */
export function resultLine(
  status: FindingStatus,
  evidence: string | null,
  naReason: string | undefined,
  host: string,
  hosts?: readonly HostOutcome[],
): string {
  const detail = evidence && evidence.length > 0 ? ` (${evidence})` : '';
  const perHost = hostOutcomesText(hosts);
  const line = `${leadOf(status, naReason, host)}${detail}`;
  return perHost === null ? line : `${line}; ${perHost}`;
}

function leadOf(status: FindingStatus, naReason: string | undefined, host: string): string {
  switch (status) {
    case 'pass':
      return 'Verified';
    case 'noncompliant':
      return 'Works but does not conform';
    case 'broken':
      return 'Present but broken';
    case 'absent':
      return 'Not found';
    case 'n_a':
      return isNaReason(naReason) ? naReasonPhrase(naReason, host) : 'Not applicable';
    case 'skip':
      return 'Not evaluated: audit deadline exceeded';
    case 'error':
      return 'Not evaluated';
  }
}
