// The single-use sessionStorage stash that carries a transact click's
// Turnstile token, listing choice, entered lane, and refresh intent to the
// progress page, keyed by the normalized target. sessionStorage is per tab
// and per origin, so a copied stash fails siteverify on second use and the
// page shows Start instead.
//
// Three keys per target:
//
//   audit-stash:<target>   the click's record, taken once, dead after the TTL
//   audit-lane:<target>    the lane the visitor had selected, kept under the
//                          same TTL so a refreshed progress page can still
//                          name the reclassification
//   audit-inline:<target>  a result body with no URL of its own, kept so a
//                          same-tab refresh restores it instead of Start
//
// No in-flight marker lives in the tab: the server's in-flight pointer is
// the one place a running audit is recorded.

import type { Lane } from '../shared/audit-routes';

const STASH_PREFIX = 'audit-stash:';
const LANE_PREFIX = 'audit-lane:';
const INLINE_PREFIX = 'audit-inline:';

// A carried token must reach the progress page's POST inside Turnstile's
// 300 s token lifetime; anything older is discarded so a stale tab never
// spends a dead one.
export const STASH_TTL_MS = 240_000;

export type StashRecord = {
  token: string;
  /** The visitor's explicit listing choice; null when the lane has no checkbox. */
  listing: boolean | null;
  entered_lane: Lane;
  refresh: boolean;
};

type StoredRecord = StashRecord & { ts: number };

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Private-mode or disabled storage: the progress page renders Start.
  }
}

function remove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing to remove when storage is unavailable.
  }
}

/** Stash a click's record for the progress page, keyed by the normalized target. */
export function stash(target: string, record: StashRecord, now: number = Date.now()): void {
  const stored: StoredRecord = { ...record, ts: now };
  write(STASH_PREFIX + target, JSON.stringify(stored));
  write(LANE_PREFIX + target, JSON.stringify({ lane: record.entered_lane, ts: now }));
}

function isLane(value: unknown): value is Lane {
  return value === 'cli' || value === 'web';
}

function parseRecord(raw: string, now: number): StashRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredRecord>;
    if (typeof parsed.token !== 'string' || typeof parsed.ts !== 'number') return null;
    if (now - parsed.ts >= STASH_TTL_MS) return null;
    if (!isLane(parsed.entered_lane)) return null;
    return {
      token: parsed.token,
      listing: typeof parsed.listing === 'boolean' ? parsed.listing : null,
      entered_lane: parsed.entered_lane,
      refresh: parsed.refresh === true,
    };
  } catch {
    return null;
  }
}

/** Read and remove the stashed record (single-use); null when absent, stale, or corrupt. */
export function take(target: string, now: number = Date.now()): StashRecord | null {
  const key = STASH_PREFIX + target;
  const raw = read(key);
  remove(key);
  return raw ? parseRecord(raw, now) : null;
}

/** The lane the visitor had selected for this target, if a click recorded one inside the TTL. */
export function enteredLaneOf(target: string, now: number = Date.now()): Lane | null {
  const key = LANE_PREFIX + target;
  const raw = read(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { lane?: unknown; ts?: unknown };
    if (isLane(parsed.lane) && typeof parsed.ts === 'number' && now - parsed.ts < STASH_TTL_MS) return parsed.lane;
  } catch {
    // Corrupt entry: treated as absent and removed below.
  }
  remove(key);
  return null;
}

/** Keep a result body that has no URL of its own so a same-tab refresh can restore it. */
export function stashInlineResult(target: string, html: string): void {
  write(INLINE_PREFIX + target, html);
}

/** Read and remove the kept result body (single-use); null when absent. */
export function takeInlineResult(target: string): string | null {
  const key = INLINE_PREFIX + target;
  const raw = read(key);
  remove(key);
  return raw;
}

/** Drop the kept result body; every terminal event calls this. */
export function clearInlineResult(target: string): void {
  remove(INLINE_PREFIX + target);
}

export type ScoreRequestBody = {
  target: string;
  turnstile_token: string;
  public_listing?: boolean;
  refresh?: true;
};

/**
 * The transact POST body. An explicit listing choice rides as the boolean;
 * null omits the field, because the server treats an omitted flag as
 * "preserve the stored choice" while an explicit false erases an opt-in.
 * `refresh` rides only when set.
 */
export function buildScoreBody(
  target: string,
  token: string,
  choice: { listing: boolean | null; refresh: boolean },
): ScoreRequestBody {
  const body: ScoreRequestBody = { target, turnstile_token: token };
  if (choice.listing !== null) body.public_listing = choice.listing;
  if (choice.refresh) body.refresh = true;
  return body;
}
