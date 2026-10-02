// Provenance on a web scorecard: the hosts each row's evidence came from,
// and the tolerant reads every surface applies to a stored scorecard that
// may predate the provenance, follow-state, trail, or registry fields.

import { type FindingStatus, NA_REASONS, type NaReason } from '../../shared/web-audit-findings';
import { worstTargetStatus } from './handlers/shared';
import type { EvidenceItem, ProbeStatus } from './handlers/types';

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

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

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

/** A row's hosts, or the audited host for a row that recorded none. */
function readRowHosts(row: { hosts?: unknown; host?: unknown }, entryHost: string | null): string[] {
  if (Array.isArray(row.hosts)) {
    return row.hosts.flatMap((entry) => (isRecord(entry) && typeof entry.host === 'string' ? [entry.host] : []));
  }
  if (typeof row.host === 'string') return [row.host];
  return entryHost === null ? [] : [entryHost];
}

/** The host a row's result line names: its first host, else the audited host, else empty. */
export function rowHostOf(row: { hosts?: unknown; host?: unknown }, entryHost: string | null): string {
  return readRowHosts(row, entryHost)[0] ?? entryHost ?? '';
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
  return typeof value === 'string' && value.length > 0 ? value : null;
}
