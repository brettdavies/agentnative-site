/// <reference path="./gifenc-module.ts" />
// The clip as an animated GIF, the input the Media binding turns into an
// MP4. Each frame gets its own palette: one palette taken from the final card
// has no entries for the bands the count passes through, so the climb draws
// them grey. gifenc writes the first frame's palette as the file's global
// table and every later one as that frame's local table.
//
// A frame takes tens of milliseconds of CPU to draw and quantize, so the loop
// yields after each one: a status call to the same RenderJob, or an on-demand
// card in the same isolate, waits about one frame instead of the whole clip.

import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import { SCORE_OG_HEIGHT, SCORE_OG_WIDTH, type ScoreOgCard } from '../shared/score-og';
import { type ScoreOgMotion, scoreOgFrames } from '../shared/score-og-motion';
import { renderScoreOgPixels, type ScoreOgFonts } from './render';

export type YieldFrame = () => Promise<void>;

const yieldToEventLoop: YieldFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function encodeClipGif(
  card: ScoreOgCard,
  fonts: ScoreOgFonts,
  motion: ScoreOgMotion,
  yieldFrame: YieldFrame = yieldToEventLoop,
): Promise<Uint8Array> {
  const gif = GIFEncoder();
  for (const [index, frame] of scoreOgFrames(card, motion).entries()) {
    const rgba = await renderScoreOgPixels(card, fonts, frame);
    const palette = quantize(rgba, 256);
    gif.writeFrame(applyPalette(rgba, palette), SCORE_OG_WIDTH, SCORE_OG_HEIGHT, {
      palette,
      delay: frameDelayMs(index, motion.fps),
    });
    await yieldFrame();
  }
  gif.finish();
  return gif.bytes();
}

/**
 * A GIF stores delays in hundredths of a second, which 30 fps does not divide. Each frame ends at its exact time
 * rounded to the hundredth, so the delays run 30, 40, 30 ms and average the frame rate over the clip.
 */
export function frameDelayMs(index: number, fps: number): number {
  const endsAt = (frame: number) => Math.round((frame * 100) / fps) * 10;
  return endsAt(index + 1) - endsAt(index);
}
