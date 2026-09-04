// How a result page states when it was scored and when a refresh becomes
// eligible.
//
// Both renderers phrase the same three states from one decision, so the page
// and its markdown twin cannot disagree about whether a refresh is available.
// The decision is resolved once against a single clock: reading `Date.now()`
// separately per surface could put the two on opposite sides of the boundary
// within one render.

import { escHtml } from '../../shared/scorecard-format.mjs';
import { type WebAuditFreshness, webAuditFreshness } from './cache';

// Refresh eligibility is the moment the entry leaves the cache-reuse window,
// never a promise that a fresh audit will run: the kill switch, the limiters,
// and Turnstile still apply, so the copy says so.
const FRESHNESS_UNKNOWN = 'Scoring time unavailable; a fresh audit may still be subject to service limits.';
const FRESHNESS_QUALIFIER = 'This is cache-reuse eligibility; a fresh audit is still subject to service limits.';

export type FreshnessState =
  | { state: 'unknown' }
  | { state: 'future' | 'expired'; scoredAt: string; refreshAfter: string };

/** A render without freshness reports an unknown instant, never a fabricated one. */
export function resolveFreshness(freshness: WebAuditFreshness | undefined): WebAuditFreshness {
  return freshness ?? webAuditFreshness(true, null);
}

export function freshnessState(freshness: WebAuditFreshness, now: number): FreshnessState {
  if (!freshness.scored_at || !freshness.refresh_after) return { state: 'unknown' };
  const at = Date.parse(freshness.refresh_after);
  if (Number.isNaN(at)) return { state: 'unknown' };
  return {
    state: at > now ? 'future' : 'expired',
    scoredAt: freshness.scored_at,
    refreshAfter: freshness.refresh_after,
  };
}

/** Minute-precision UTC, so the visible text reads aloud while `datetime` stays exact. */
function humanInstant(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function timeEl(iso: string): string {
  return `<time datetime="${escHtml(iso)}">${escHtml(humanInstant(iso))}</time>`;
}

export function freshnessHtml(state: FreshnessState): string {
  if (state.state === 'unknown') return escHtml(FRESHNESS_UNKNOWN);
  const refresh =
    state.state === 'future' ? `Refresh available after ${timeEl(state.refreshAfter)}.` : 'Refresh available now.';
  return `Scored ${timeEl(state.scoredAt)}. ${refresh} ${escHtml(FRESHNESS_QUALIFIER)}`;
}

export function freshnessMarkdown(state: FreshnessState): string {
  if (state.state === 'unknown') return FRESHNESS_UNKNOWN;
  const refresh =
    state.state === 'future' ? `Refresh available after ${state.refreshAfter}.` : 'Refresh available now.';
  return `Scored ${state.scoredAt}. ${refresh} ${FRESHNESS_QUALIFIER}`;
}
