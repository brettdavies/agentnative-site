// The scorecard clip's motion: hold the final card, drain the score to zero,
// climb back to it, hold again. A motion is plain values (frame counts, the
// climb's easing, the color and digit treatment), so a design change swaps
// values rather than code. The clip's first and last frames draw the still
// card, which is what lets the PNG and the clip share one card key.

import { roundedScore, type ScoreOgCard, type ScoreOgFrameState } from './score-og';

export type ScoreOgMotion = {
  fps: number;
  holdStart: number;
  /** The drain runs linearly from the final score to zero. */
  drain: number;
  climb: number;
  holdEnd: number;
  easing: 'linear' | 'ease-out-cubic';
  /** `locked` draws every frame in the final score's band; `live` colors each frame by the number it shows. */
  color: 'locked' | 'live';
  digits: ScoreOgFrameState['digits'];
};

/** 105 frames at 30 fps, about 3.5 s. */
export const SCORE_OG_MOTION: ScoreOgMotion = {
  fps: 30,
  holdStart: 15,
  drain: 9,
  climb: 66,
  holdEnd: 15,
  easing: 'ease-out-cubic',
  color: 'locked',
  digits: 'fixed',
};

const EASE: Record<ScoreOgMotion['easing'], (t: number) => number> = {
  linear: (t) => t,
  'ease-out-cubic': (t) => 1 - (1 - t) ** 3,
};

/** Every frame's state, in order. A pending or unscored card has no number to count, so it has no clip. */
export function scoreOgFrames(card: ScoreOgCard, motion: ScoreOgMotion): ScoreOgFrameState[] {
  const final = card.pending ? null : roundedScore(card.scorePct);
  if (final === null) return [];
  const ease = EASE[motion.easing];
  const values = [
    ...repeat(final, motion.holdStart),
    ...steps(motion.drain, (t) => final * (1 - t)),
    ...steps(motion.climb, (t) => final * ease(t)),
    ...repeat(final, motion.holdEnd),
  ];
  return values.map((value) => {
    const shown = Math.round(value);
    return { shown, meter: value, band: motion.color === 'locked' ? final : shown, digits: motion.digits };
  });
}

function repeat(value: number, count: number): number[] {
  return Array.from({ length: count }, () => value);
}

/** `count` values at t = 1/count … 1, so each phase ends exactly on its target. */
function steps(count: number, at: (t: number) => number): number[] {
  return Array.from({ length: count }, (_, i) => at((i + 1) / count));
}
