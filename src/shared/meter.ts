// The graded score meter and its band cutoffs, shared by every meter
// emitter (homepage boards, leaderboards, scorecards, Worker renders) so
// the cutoffs never drift between surfaces.

import { escHtml } from './esc-html';

export type Band = 'band-low' | 'band-mid' | 'band-high';

/** Score-band class for a 0-100 score: under 50 low, 50 to 79 mid, 80 and above high. */
export function bandOf(pct: number): Band {
  return pct >= 80 ? 'band-high' : pct >= 50 ? 'band-mid' : 'band-low';
}

export type MeterOptions = {
  /** Numeral text; `null` omits it. Defaults to the rounded percentage. */
  num?: string | null;
  /** Extra class on the meter root. */
  className?: string;
};

/** A score meter: band-colored fill on a track, with an optional numeral. */
export function renderMeter(pct: number, opts: MeterOptions = {}): string {
  const num = opts.num === undefined ? String(Math.round(pct)) : opts.num;
  const numHtml = num === null ? '' : `<span class="meter__num">${escHtml(num)}</span>`;
  const className = opts.className ? ` ${opts.className}` : '';
  const width = Math.max(0, Math.min(100, pct));
  return `<span class="meter ${bandOf(pct)}${className}"><span class="meter__track"><span class="meter__fill" style="width:${width}%"></span></span>${numHtml}</span>`;
}
