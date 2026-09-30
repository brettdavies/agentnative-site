// Provenance on a web scorecard: the hosts each row's evidence came from,
// and the tolerant reads every surface applies to a stored scorecard that
// may predate the provenance, follow-state, trail, or registry fields.

import type { EvidenceItem } from './handlers/types';

/** One host a row's evidence was requested from. */
export interface RowHost {
  host: string;
}

/** One entry of the declared-hosts trail. */
export type DeclaredHostEntry = Record<string, unknown>;

/** Whether an audit followed the hosts its target declares, as a reader sees it. */
export type FollowState = 'on' | 'off' | 'not-evaluated';

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The distinct hosts a row's evidence was requested from, in evidence
 * order, plus `host` when there is exactly one. An item the SSRF guard
 * refused never reached its host, so it names none.
 */
export function rowHostFields(evidence: readonly EvidenceItem[]): { hosts: RowHost[]; host?: string } {
  const hosts: string[] = [];
  for (const item of evidence) {
    if (typeof item.url !== 'string' || item.blocked !== undefined) continue;
    const host = hostOf(item.url);
    if (host !== null && !hosts.includes(host)) hosts.push(host);
  }
  return { hosts: hosts.map((host) => ({ host })), ...(hosts.length === 1 ? { host: hosts[0] } : {}) };
}

/** The audited host of a stored scorecard, read from its target URL. */
export function entryHostOf(targetUrl: unknown): string | null {
  return typeof targetUrl === 'string' ? hostOf(targetUrl) : null;
}

/** A row's hosts. A row carrying neither `hosts` nor `host` reads as evaluated at the audited host. */
export function readRowHosts(row: { hosts?: unknown; host?: unknown }, entryHost: string | null): string[] {
  if (Array.isArray(row.hosts)) {
    return row.hosts.flatMap((entry) => (isRecord(entry) && typeof entry.host === 'string' ? [entry.host] : []));
  }
  if (typeof row.host === 'string') return [row.host];
  return entryHost === null ? [] : [entryHost];
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
