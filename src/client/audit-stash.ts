// The single-use sessionStorage stash that carries a transact click's
// Turnstile token, listing choice, follow choice, entered lane, and refresh
// intent to the progress page, keyed by the normalized target. sessionStorage is per tab
// and per origin, so a copied stash fails siteverify on second use and the
// page shows Start instead.
//
// Four keys per target:
//
//   audit-stash:<target>   the click's record, taken once, dead after the TTL
//   audit-lane:<target>    the lane the visitor had selected, kept under the
//                          same TTL so a refreshed progress page can still
//                          name the reclassification
//   audit-follow:<target>  the follow choice of the run the tab last started,
//                          kept under the same TTL so a progress page
//                          refreshed mid-run repeats it on every request
//   audit-inline:<target>  a result body with no URL of its own and the
//                          follow choice that produced it, kept so a same-tab
//                          refresh restores it instead of Start and Run again
//                          repeats the choice; the next click drops it
//
// No in-flight marker lives in the tab: the server's in-flight pointer is
// the one place a running audit is recorded.

import type { Lane } from '../shared/audit-routes';

const STASH_PREFIX = 'audit-stash:';
const LANE_PREFIX = 'audit-lane:';
const FOLLOW_PREFIX = 'audit-follow:';
const INLINE_PREFIX = 'audit-inline:';

// A carried token must reach the progress page's POST inside Turnstile's
// 300 s token lifetime; anything older is discarded so a stale tab never
// spends a dead one.
export const STASH_TTL_MS = 240_000;

export type StashRecord = {
  token: string;
  /** The visitor's explicit listing choice; null when the lane has no checkbox. */
  listing: boolean | null;
  /** False when the visitor chose not to follow the hosts the site declares. */
  follow: boolean;
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

/**
 * Stash a click's record for the progress page, keyed by the normalized
 * target. The click supersedes any result kept for the target, which may
 * have been produced under a different follow choice.
 */
export function stash(target: string, record: StashRecord, now: number = Date.now()): void {
  const stored: StoredRecord = { ...record, ts: now };
  write(STASH_PREFIX + target, JSON.stringify(stored));
  write(LANE_PREFIX + target, JSON.stringify({ lane: record.entered_lane, ts: now }));
  rememberFollow(target, record.follow, now);
  remove(INLINE_PREFIX + target);
}

/** Keep the follow choice of the run this tab is starting, so a refresh mid-run repeats it. */
export function rememberFollow(target: string, follow: boolean, now: number = Date.now()): void {
  write(FOLLOW_PREFIX + target, JSON.stringify({ follow, ts: now }));
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
      follow: parsed.follow !== false,
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

type KeptRecord = { [field: string]: unknown };

/** A value kept beside the stash under its TTL; an absent, stale, corrupt, or invalid entry is null and removed. */
function readKept<T>(key: string, now: number, pick: (record: KeptRecord) => T | null): T | null {
  const raw = read(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as KeptRecord | null;
    if (parsed && typeof parsed.ts === 'number' && now - parsed.ts < STASH_TTL_MS) {
      const value = pick(parsed);
      if (value !== null) return value;
    }
  } catch {
    // Corrupt entry: treated as absent and removed below.
  }
  remove(key);
  return null;
}

/** The lane the visitor had selected for this target, if a click recorded one inside the TTL. */
export function enteredLaneOf(target: string, now: number = Date.now()): Lane | null {
  return readKept(LANE_PREFIX + target, now, (record) => (isLane(record.lane) ? record.lane : null));
}

/** The follow choice of the run this tab last started for the target inside the TTL; null when none. */
export function followOf(target: string, now: number = Date.now()): boolean | null {
  return readKept(FOLLOW_PREFIX + target, now, (record) => (typeof record.follow === 'boolean' ? record.follow : null));
}

/** A result body with no URL of its own, and the follow choice of the run that produced it. */
export type InlineResult = { html: string; follow: boolean };

/** Keep a result body that has no URL of its own so a same-tab refresh can restore it. */
export function stashInlineResult(target: string, result: InlineResult): void {
  write(INLINE_PREFIX + target, JSON.stringify(result));
}

/** Read and remove the kept result (single-use); null when absent or corrupt. */
export function takeInlineResult(target: string): InlineResult | null {
  const key = INLINE_PREFIX + target;
  const raw = read(key);
  remove(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<InlineResult>;
    return typeof parsed.html === 'string' ? { html: parsed.html, follow: parsed.follow !== false } : null;
  } catch {
    return null;
  }
}

/** Drop the kept result body; every terminal event calls this. */
export function clearInlineResult(target: string): void {
  remove(INLINE_PREFIX + target);
}

export type ProbeRequestBody = { target: string; follow_declarations?: false };

/**
 * The tokenless probe body. An opt-out rides on it as on a click, so the
 * server answers the probe as the run the visitor chose: an opted-out probe
 * is never served a stored followed result or joined to a followed run.
 */
export function buildProbeBody(target: string, follow: boolean): ProbeRequestBody {
  return follow ? { target } : { target, follow_declarations: false };
}

export type ScoreRequestBody = {
  target: string;
  turnstile_token: string;
  public_listing?: boolean;
  follow_declarations?: false;
  refresh?: true;
};

/**
 * The transact POST body. An explicit listing choice rides as the boolean;
 * null omits the field, because the server treats an omitted flag as
 * "preserve the stored choice" while an explicit false erases an opt-in.
 * `follow_declarations` rides only when the visitor opted out, and
 * `refresh` only when set: both default on the server.
 */
export function buildScoreBody(
  target: string,
  token: string,
  choice: { listing: boolean | null; refresh: boolean; follow: boolean },
): ScoreRequestBody {
  const body: ScoreRequestBody = { target, turnstile_token: token };
  if (choice.listing !== null) body.public_listing = choice.listing;
  if (!choice.follow) body.follow_declarations = false;
  if (choice.refresh) body.refresh = true;
  return body;
}
