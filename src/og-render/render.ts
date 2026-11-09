/// <reference path="./bundled-modules.ts" />
// Rasterize a scorecard OG card to a 1200×630 PNG, or one clip frame to RGBA.
//
// resvg-wasm is the same rasterizer the workers-og style of Worker image
// uses, without Satori: the card is one fixed layout, so an SVG string is
// the whole template. Playwright (the site-wide `public/og-image.png`
// generator) cannot run inside a Worker. The wasm module is initialized
// once per isolate.

import { type InitInput, initWasm, Resvg } from '@resvg/resvg-wasm';
import wasm from '@resvg/resvg-wasm/index_bg.wasm';
import {
  renderScoreOgSvg,
  SCORE_OG_FONT,
  type ScoreOgCard,
  type ScoreOgFrameState,
  type ScoreOgLogo,
} from '../shared/score-og';

const LOGO_PX = 256;

let wasmReady: Promise<void> | null = null;

type BunFile = { file(path: string): { arrayBuffer(): Promise<ArrayBuffer> } };

/** Load resvg once. A Bun test sees the wasm import as a file path; workerd sees a module. */
export function ensureScoreOgWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = loadWasm(wasm as unknown).catch((err: unknown) => {
      wasmReady = null;
      throw err;
    });
  }
  return wasmReady;
}

async function loadWasm(source: unknown): Promise<void> {
  await initWasm(typeof source === 'string' ? await bundledBytes(source) : (source as InitInput));
}

/** A bundled module's bytes: workerd hands over the data, Bun its file path. */
export async function bundledBytes(source: ArrayBuffer | string): Promise<Uint8Array> {
  if (typeof source !== 'string') return new Uint8Array(source);
  const bun = (globalThis as { Bun?: BunFile }).Bun;
  if (!bun) throw new Error(`bundled module did not resolve to bytes: ${source}`);
  return new Uint8Array(await bun.file(source).arrayBuffer());
}

export type ScoreOgFonts = readonly [Uint8Array, Uint8Array, Uint8Array];

/** PNG bytes. Throws when resvg rejects the SVG. */
export function renderScoreOgPng(card: ScoreOgCard, fonts: ScoreOgFonts): Promise<Uint8Array> {
  return rasterize(renderScoreOgSvg(card), fonts, (image) => image.asPng());
}

/** One clip frame as 1200×630 RGBA pixels. */
export function renderScoreOgPixels(
  card: ScoreOgCard,
  fonts: ScoreOgFonts,
  frame: ScoreOgFrameState,
): Promise<Uint8Array> {
  return rasterize(renderScoreOgSvg(card, frame), fonts, (image) => image.pixels);
}

type RenderedImage = ReturnType<InstanceType<typeof Resvg>['render']>;

async function rasterize(
  svg: string,
  fonts: ScoreOgFonts,
  read: (image: RenderedImage) => Uint8Array,
): Promise<Uint8Array> {
  await ensureScoreOgWasm();
  const resvg = new Resvg(svg, {
    font: {
      fontBuffers: [...fonts],
      defaultFontFamily: SCORE_OG_FONT.sans,
      sansSerifFamily: SCORE_OG_FONT.sans,
      monospaceFamily: SCORE_OG_FONT.mono,
    },
    fitTo: { mode: 'original' },
    background: '#060a0e',
  });
  try {
    resolveEmbeddedImages(resvg);
    const image = resvg.render();
    try {
      return read(image);
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}

/** Rasterize an SVG logo to a PNG the card can embed. Null when the SVG will not draw. */
export async function rasterizeSvgLogo(svg: string, fonts: ScoreOgFonts): Promise<ScoreOgLogo | null> {
  await ensureScoreOgWasm();
  try {
    const resvg = new Resvg(svg, {
      font: { fontBuffers: [...fonts], sansSerifFamily: SCORE_OG_FONT.sans },
      fitTo: { mode: 'width', value: LOGO_PX },
      background: '#00000000',
    });
    try {
      const image = resvg.render();
      try {
        return { mime: 'image/png', bytes: image.asPng() };
      } finally {
        image.free();
      }
    } finally {
      resvg.free();
    }
  } catch {
    return null;
  }
}

function resolveEmbeddedImages(resvg: InstanceType<typeof Resvg>): void {
  const pending = resvg.imagesToResolve() as unknown;
  if (!Array.isArray(pending)) return;
  for (const href of pending) {
    if (typeof href !== 'string') continue;
    const bytes = decodeDataImage(href);
    if (bytes) resvg.resolveImage(href, bytes);
  }
}

function decodeDataImage(href: string): Uint8Array | null {
  const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/.exec(href);
  if (!match) return null;
  const binary = atob(match[1].replace(/\s/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
