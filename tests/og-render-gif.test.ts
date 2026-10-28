// The clip's GIF: every frame of the default motion, each with its own palette,
// opening on the still card's pixels.

import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { encodeClipGif, frameDelayMs } from '../src/og-render/gif';
import { renderScoreOgPixels } from '../src/og-render/render';
import type { ScoreOgCard } from '../src/shared/score-og';
import { SCORE_OG_MOTION, scoreOgFrames } from '../src/shared/score-og-motion';
import { cardFonts } from './helpers/og-render-fakes';

const CARD: ScoreOgCard = {
  name: 'Railway',
  subtitle: 'railway.com',
  lane: 'web',
  scorePct: 64,
  pending: false,
  specVersion: '0.6.0',
  edition: { token: 'd20261026', label: '2026-10-26' },
  logo: null,
};

type GifFrame = { localPalette: boolean; delayCs: number };

/** Walk the GIF's blocks: one entry per image, with whether it carries a local color table and its delay. */
function gifFrames(bytes: Uint8Array): GifFrame[] {
  const tableBytes = (packed: number) => 3 * 2 ** ((packed & 0x07) + 1);
  let at = 13;
  if (bytes[10] & 0x80) at += tableBytes(bytes[10]);
  const frames: GifFrame[] = [];
  let delayCs = 0;
  const skipSubBlocks = () => {
    while (bytes[at] !== 0) at += bytes[at] + 1;
    at += 1;
  };
  while (at < bytes.length) {
    const block = bytes[at];
    if (block === 0x3b) break;
    if (block === 0x21) {
      if (bytes[at + 1] === 0xf9) delayCs = bytes[at + 4] | (bytes[at + 5] << 8);
      at += 2;
      skipSubBlocks();
    } else if (block === 0x2c) {
      const packed = bytes[at + 9];
      const localPalette = (packed & 0x80) !== 0;
      at += 10;
      if (localPalette) at += tableBytes(packed);
      at += 1;
      skipSubBlocks();
      frames.push({ localPalette, delayCs });
    } else {
      throw new Error(`unexpected GIF block 0x${block.toString(16)} at ${at}`);
    }
  }
  return frames;
}

describe('encodeClipGif', () => {
  test('the default motion encodes 105 frames, every one after the first with its own palette', async () => {
    const fonts = await cardFonts();
    let yields = 0;
    const gif = await encodeClipGif(CARD, fonts, SCORE_OG_MOTION, async () => {
      yields += 1;
    });
    const frames = gifFrames(gif);
    expect(frames).toHaveLength(105);
    expect(yields).toBe(105);
    expect(gif[10] & 0x80).toBe(0x80);
    expect(frames.slice(1).every((frame) => frame.localPalette)).toBe(true);
    expect(frames.reduce((sum, frame) => sum + frame.delayCs, 0)).toBe(350);

    const first = await sharp(gif, { page: 0 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(first.info).toMatchObject({ width: 1200, height: 630 });
    const still = await renderScoreOgPixels(CARD, fonts, scoreOgFrames(CARD, SCORE_OG_MOTION)[0]);
    let diff = 0;
    for (let i = 0; i < still.length; i++) diff += Math.abs(still[i] - first.data[i]);
    expect(diff / still.length).toBeLessThan(1);
  }, 60_000);
});

describe('frameDelayMs', () => {
  test('30 fps runs 30 and 40 ms delays that add up to the clip length', () => {
    const delays = Array.from({ length: 105 }, (_, i) => frameDelayMs(i, 30));
    expect(new Set(delays)).toEqual(new Set([30, 40]));
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(3500);
  });
});
