// Clip motion: the frame states one pure function yields, and the card each one draws.

import { describe, expect, test } from 'bun:test';
import { renderScoreOgSvg, type ScoreOgCard } from '../src/shared/score-og';
import { SCORE_OG_MOTION, type ScoreOgMotion, scoreOgFrames } from '../src/shared/score-og-motion';

const CARD: ScoreOgCard = {
  name: 'Railway',
  subtitle: 'railway.com',
  lane: 'web',
  scorePct: 80,
  pending: false,
  specVersion: '0.6.0',
  edition: { token: 'd20261026', label: '2026-10-26' },
  logo: null,
};

const LIVE: ScoreOgMotion = { ...SCORE_OG_MOTION, color: 'live' };
const PROPORTIONAL: ScoreOgMotion = { ...SCORE_OG_MOTION, digits: 'proportional' };

function total(motion: ScoreOgMotion): number {
  return motion.holdStart + motion.drain + motion.climb + motion.holdEnd;
}

function climbMeters(card: ScoreOgCard, motion: ScoreOgMotion): number[] {
  const start = motion.holdStart + motion.drain;
  return scoreOgFrames(card, motion)
    .slice(start - 1, start + motion.climb)
    .map((frame) => frame.meter);
}

/** Fill colors of the score number's glyphs, in document order. */
function scoreFills(svg: string): string[] {
  return [...svg.matchAll(/<text [^>]*fill="(#[0-9a-f]{6})"[^>]*font-weight="700" font-size="112"/g)].map((m) => m[1]);
}

describe('scoreOgFrames', () => {
  test('the default motion is the 105-frame clip at 30 fps', () => {
    expect(SCORE_OG_MOTION.fps).toBe(30);
    expect(total(SCORE_OG_MOTION)).toBe(105);
    expect(scoreOgFrames(CARD, SCORE_OG_MOTION)).toHaveLength(105);
  });

  test('the frame count equals the motion total for any frame counts', () => {
    const short: ScoreOgMotion = { ...SCORE_OG_MOTION, holdStart: 2, drain: 3, climb: 5, holdEnd: 1 };
    expect(scoreOgFrames(CARD, short)).toHaveLength(11);
  });

  test('the first and the last frame draw the final card, byte for byte', () => {
    const still = renderScoreOgSvg(CARD);
    for (const motion of [SCORE_OG_MOTION, LIVE, PROPORTIONAL]) {
      const frames = scoreOgFrames(CARD, motion);
      expect(renderScoreOgSvg(CARD, frames[0])).toBe(still);
      expect(renderScoreOgSvg(CARD, frames[frames.length - 1])).toBe(still);
    }
  });

  test('a fractional score lands on the rounded card', () => {
    const card = { ...CARD, scorePct: 79.6 };
    const frames = scoreOgFrames(card, SCORE_OG_MOTION);
    expect(renderScoreOgSvg(card, frames[frames.length - 1])).toBe(renderScoreOgSvg(card));
    expect(frames[frames.length - 1].shown).toBe(80);
  });

  test('the drain reaches zero before the climb starts', () => {
    const frames = scoreOgFrames(CARD, SCORE_OG_MOTION);
    const lastDrain = frames[SCORE_OG_MOTION.holdStart + SCORE_OG_MOTION.drain - 1];
    expect(lastDrain.shown).toBe(0);
    expect(lastDrain.meter).toBe(0);
  });

  test('the climb rises monotonically and decelerates: no step is larger than the one before', () => {
    const meters = climbMeters(CARD, SCORE_OG_MOTION);
    expect(meters[0]).toBe(0);
    expect(meters[meters.length - 1]).toBe(80);
    const steps = meters.slice(1).map((value, i) => value - meters[i]);
    for (const [i, step] of steps.entries()) {
      expect(step).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(step).toBeLessThanOrEqual(steps[i - 1] + 1e-9);
    }
    const shown = scoreOgFrames(CARD, SCORE_OG_MOTION).map((frame) => frame.shown);
    const climb = shown.slice(SCORE_OG_MOTION.holdStart + SCORE_OG_MOTION.drain);
    for (const [i, value] of climb.entries()) if (i > 0) expect(value).toBeGreaterThanOrEqual(climb[i - 1]);
  });

  test('with color locked, every frame draws the final band color', () => {
    const fills = scoreOgFrames(CARD, SCORE_OG_MOTION).flatMap((frame) => scoreFills(renderScoreOgSvg(CARD, frame)));
    expect(new Set(fills)).toEqual(new Set(['#5ac576']));
  });

  test('with color live, the band follows the number shown', () => {
    const fills = scoreOgFrames(CARD, LIVE).flatMap((frame) => scoreFills(renderScoreOgSvg(CARD, frame)));
    expect(new Set(fills)).toEqual(new Set(['#5ac576', '#f3ae58', '#f9776e']));
  });

  test('pending and unscored cards yield no frames', () => {
    expect(scoreOgFrames({ ...CARD, scorePct: null, pending: true }, SCORE_OG_MOTION)).toEqual([]);
    expect(scoreOgFrames({ ...CARD, scorePct: null }, SCORE_OG_MOTION)).toEqual([]);
    expect(scoreOgFrames({ ...CARD, scorePct: 140 }, SCORE_OG_MOTION)).toEqual([]);
  });

  test('a 0% card holds at zero for the whole clip, with no drain', () => {
    const zero = { ...CARD, scorePct: 0 };
    const frames = scoreOgFrames(zero, SCORE_OG_MOTION);
    expect(frames).toHaveLength(105);
    expect(frames.every((frame) => frame.shown === 0 && frame.meter === 0)).toBe(true);
    const still = renderScoreOgSvg(zero);
    expect(frames.every((frame) => renderScoreOgSvg(zero, frame) === still)).toBe(true);
  });
});

describe('fixed digit slots', () => {
  /** x of each glyph the number draws, keyed by its place (ones, tens, hundreds). */
  function digitXs(svg: string): Map<number, string> {
    const glyphs = [...svg.matchAll(/<text x="([\d.]+)" y="168" text-anchor="middle"[^>]*>(\d)<\/text>/g)];
    return new Map(glyphs.reverse().map((m, place) => [place, m[1]]));
  }

  test('every in-between frame draws each place at one fixed x', () => {
    const frames = scoreOgFrames(CARD, SCORE_OG_MOTION).filter((frame) => frame.shown !== 80);
    const seen = new Map<number, Set<string>>();
    for (const frame of frames) {
      for (const [place, x] of digitXs(renderScoreOgSvg(CARD, frame))) {
        const xs = seen.get(place) ?? new Set();
        xs.add(x);
        seen.set(place, xs);
      }
    }
    expect([...seen.keys()].sort()).toEqual([0, 1]);
    for (const xs of seen.values()) expect(xs.size).toBe(1);
  });

  test('the percent sign stays anchored at the right edge on every frame', () => {
    for (const frame of scoreOgFrames(CARD, SCORE_OG_MOTION)) {
      expect(renderScoreOgSvg(CARD, frame)).toMatch(/<text x="1136" y="168" text-anchor="end"[^>]*>[^<]*%<\/text>/);
    }
  });

  test('proportional digits draw the number as one right-aligned run', () => {
    const frame = scoreOgFrames(CARD, PROPORTIONAL).find((f) => f.shown >= 10 && f.shown < 80);
    if (!frame) throw new Error('expected a two-digit frame below the final score');
    const svg = renderScoreOgSvg(CARD, frame);
    expect(svg).toContain(`>${frame.shown}%</text>`);
    expect(digitXs(svg).size).toBe(0);
  });
});
