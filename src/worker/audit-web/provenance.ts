// Provenance on a web scorecard: the hosts each row's evidence came from,
// and the tolerant reads every surface applies to a stored scorecard that
// may predate the provenance, follow-state, trail, or registry fields.

import { hostOf } from '../../shared/url-host';
import { FINDING_STATUSES, type FindingStatus, NA_REASONS, type NaReason } from '../../shared/web-audit-findings';
import { worstTargetStatus } from './handlers/shared';
import type { EvidenceItem, ProbeStatus } from './handlers/types';
import { isRegistryFingerprintPrefix } from './registry';

/** One host a row's evidence was requested from; on a row over several targets, also that host's own outcome. */
export interface RowHost {
  host: string;
  status?: FindingStatus;
  na_reason?: NaReason;
}

const TARGET_STATUSES: readonly ProbeStatus[] = ['pass', 'noncompliant', 'broken', 'absent', 'na', 'error'];

/** One entry of the declared-hosts trail. */
export type DeclaredHostEntry = Record<string, unknown>;

/** Whether an audit followed the hosts its target declares, as a reader sees it. */
export type FollowState = 'on' | 'off' | 'not-evaluated';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The host an item's URL names, else the host it records outright, else null. */
function itemHost(item: EvidenceItem): string | null {
  if (typeof item.url === 'string') return hostOf(item.url);
  return typeof item.host === 'string' && item.host.length > 0 ? item.host : null;
}

type HostOutcome = { statuses: ProbeStatus[]; na_reason?: NaReason };

function hostEntry(host: string, outcome: HostOutcome | undefined): RowHost {
  if (outcome === undefined) return { host };
  const status = worstTargetStatus(outcome.statuses);
  if (status !== 'na') return { host, status };
  return { host, status: 'n_a', ...(outcome.na_reason !== undefined ? { na_reason: outcome.na_reason } : {}) };
}

/**
 * The distinct hosts a row's evidence was requested from, in evidence
 * order, plus `host` when there is exactly one. An item the SSRF guard
 * refused never reached its host, so it names none. An item with no URL
 * that names a `host` is a row a declared host kept from being evaluated,
 * and it names that host. A row that evaluated several targets on more
 * than one host (the API anchors) gives each host its own outcome, read
 * from its items' `target_status`.
 */
export function rowHostFields(evidence: readonly EvidenceItem[]): { hosts: RowHost[]; host?: string } {
  const hosts: string[] = [];
  const outcomes = new Map<string, HostOutcome>();
  for (const item of evidence) {
    if (item.blocked !== undefined) continue;
    const host = itemHost(item);
    if (host === null) continue;
    if (!hosts.includes(host)) hosts.push(host);
    const status = TARGET_STATUSES.find((s) => s === item.target_status);
    if (status === undefined) continue;
    const outcome = outcomes.get(host) ?? { statuses: [] };
    outcome.statuses.push(status);
    outcome.na_reason ??= NA_REASONS.find((reason) => reason === item.na_reason);
    outcomes.set(host, outcome);
  }
  const perHost = hosts.length > 1 && hosts.every((host) => outcomes.has(host));
  return {
    hosts: hosts.map((host) => (perHost ? hostEntry(host, outcomes.get(host)) : { host })),
    ...(hosts.length === 1 ? { host: hosts[0] } : {}),
  };
}

/** The audited host of a stored scorecard, read from its target URL. */
export function entryHostOf(targetUrl: unknown): string | null {
  return typeof targetUrl === 'string' ? hostOf(targetUrl) : null;
}

/**
 * Whether a row recorded where its evidence came from. One that did not,
 * whether the fields are missing or malformed, reads as evaluated at the
 * audited host on every surface.
 */
export function recordsRowHosts(row: { hosts?: unknown; host?: unknown }): boolean {
  return Array.isArray(row.hosts) || typeof row.host === 'string';
}

/**
 * The hosts a row reads as evaluated at: the ones it recorded, else the
 * audited host. A row whose evidence named no host was read from the
 * audited site's own documents.
 */
export function rowHostsOf(row: { hosts?: unknown; host?: unknown }, entryHost: string | null): string[] {
  const recorded = Array.isArray(row.hosts)
    ? row.hosts.flatMap((entry) => (isRecord(entry) && typeof entry.host === 'string' ? [entry.host] : []))
    : typeof row.host === 'string'
      ? [row.host]
      : [];
  if (recorded.length > 0) return recorded;
  return entryHost === null ? [] : [entryHost];
}

/** The host a row's result line names: its first host, else the audited host, else empty. */
export function rowHostOf(row: { hosts?: unknown; host?: unknown }, entryHost: string | null): string {
  return rowHostsOf(row, entryHost)[0] ?? '';
}

/** The hosts the row recorded, without the audited-host reading a row that recorded none gets. */
export function recordedHostsOf(row: { hosts?: unknown; host?: unknown }): string[] {
  return rowHostsOf(row, null);
}

/** The one host the row recorded, or null for a row that recorded none or several. */
export function recordedHostOf(row: { hosts?: unknown; host?: unknown }): string | null {
  const hosts = recordedHostsOf(row);
  return hosts.length === 1 ? hosts[0] : null;
}

/** Each host's own outcome on a row over several hosts, as recorded; empty otherwise. */
export function rowHostOutcomes(row: { hosts?: unknown }): RowHost[] {
  if (!Array.isArray(row.hosts)) return [];
  return row.hosts.flatMap((entry): RowHost[] => {
    if (!isRecord(entry) || typeof entry.host !== 'string') return [];
    const status = FINDING_STATUSES.find((s) => s === entry.status);
    const reason = NA_REASONS.find((r) => r === entry.na_reason);
    return [
      {
        host: entry.host,
        ...(status !== undefined ? { status } : {}),
        ...(reason !== undefined ? { na_reason: reason } : {}),
      },
    ];
  });
}

/** Only a recorded `true` reads as on; a missing or malformed value was never evaluated. */
export function readFollowState(value: unknown): FollowState {
  if (value === true) return 'on';
  if (value === false) return 'off';
  return 'not-evaluated';
}

/** The recorded trail, or null when none was recorded, which is not the same as an empty trail. */
export function readDeclaredHosts(value: unknown): DeclaredHostEntry[] | null {
  return Array.isArray(value) ? value.filter(isRecord) : null;
}

/** The recorded registry fingerprint prefix, or null when the registry version is unknown. */
export function readRegistryFingerprint(value: unknown): string | null {
  return isRegistryFingerprintPrefix(value) ? value : null;
}

/** The hosts a stored scorecard records as one site, bare first; empty when it records none. */
export function readSiteHosts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((host): host is string => typeof host === 'string' && host.length > 0)
    : [];
}

type HostFields = { hosts?: unknown; host?: unknown };

/** Worst first: the outcome a row keeps when two of its hosts read as one. */
const HOST_OUTCOME_RANK = ['broken', 'noncompliant', 'absent', 'error', 'pass', 'n_a', 'skip'];

function outcomeRank(entry: Record<string, unknown>): number {
  const rank = HOST_OUTCOME_RANK.indexOf(String(entry.status));
  return rank === -1 ? HOST_OUTCOME_RANK.length : rank;
}

/**
 * The row with every host of the site read as the audited host: a row whose
 * evidence came from the other host of a folded pair was read from the
 * audited site's own documents. Hosts outside the site are left as recorded;
 * when two of a row's hosts become one, the worse outcome stays.
 */
export function rowAtAuditedHost<R extends HostFields>(
  row: R,
  entryHost: string | null,
  siteHosts: readonly string[],
): R {
  if (entryHost === null || siteHosts.length === 0) return row;
  const onSite = (host: string): boolean => host !== entryHost && siteHosts.includes(host);
  let changed = false;
  let hosts: unknown = row.hosts;
  if (Array.isArray(row.hosts)) {
    const merged: unknown[] = [];
    for (const entry of row.hosts) {
      if (!isRecord(entry) || typeof entry.host !== 'string' || !onSite(entry.host)) {
        const at = merged.findIndex((kept) => isRecord(kept) && isRecord(entry) && kept.host === entry.host);
        if (at === -1 || !isRecord(entry)) merged.push(entry);
        else merged[at] = outcomeRank(entry) < outcomeRank(merged[at] as Record<string, unknown>) ? entry : merged[at];
        continue;
      }
      changed = true;
      const moved = { ...entry, host: entryHost };
      const at = merged.findIndex((kept) => isRecord(kept) && kept.host === entryHost);
      if (at === -1) merged.push(moved);
      else merged[at] = outcomeRank(moved) < outcomeRank(merged[at] as Record<string, unknown>) ? moved : merged[at];
    }
    hosts = merged;
  }
  let host: unknown = row.host;
  if (typeof row.host === 'string' && onSite(row.host)) {
    host = entryHost;
    changed = true;
  }
  if (!changed) return row;
  return { ...row, hosts, ...(host !== undefined ? { host } : {}) };
}
