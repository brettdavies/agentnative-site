/// <reference path="./resvg-wasm-module.ts" />
// Rasterize a scorecard OG card to a 1200×630 PNG.
//
// resvg-wasm is the same rasterizer the workers-og style of Worker image
// uses, without Satori: the card is one fixed layout, so an SVG string is
// the whole template. Playwright (the site-wide `public/og-image.png`
// generator) cannot run inside a Worker. The wasm module is initialized
// once per isolate.

import { type InitInput, initWasm, Resvg } from '@resvg/resvg-wasm';
import wasm from '@resvg/resvg-wasm/index_bg.wasm';
import { renderScoreOgSvg, type ScoreOgCard, type ScoreOgLogo } from '../../shared/score-og';

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
  let input: InitInput;
  if (typeof source === 'string') {
    const bun = (globalThis as { Bun?: BunFile }).Bun;
    if (!bun) throw new Error('scorecard OG wasm import did not resolve to bytes');
    input = new Uint8Array(await bun.file(source).arrayBuffer());
  } else {
    input = source as InitInput;
  }
  await initWasm(input);
}

export type ScoreOgFonts = readonly [Uint8Array, Uint8Array, Uint8Array];

/** PNG bytes. Throws when resvg rejects the SVG; the route turns that into a 500. */
export async function renderScoreOgPng(card: ScoreOgCard, fonts: ScoreOgFonts): Promise<Uint8Array> {
  await ensureScoreOgWasm();
  const svg = renderScoreOgSvg(card);
  const resvg = new Resvg(svg, {
    font: {
      fontBuffers: [...fonts],
      defaultFontFamily: 'Uncut Sans',
      sansSerifFamily: 'Uncut Sans',
      monospaceFamily: 'Monaspace Xenon',
    },
    fitTo: { mode: 'original' },
    background: '#060a0e',
  });
  try {
    resolveEmbeddedImages(resvg);
    const image = resvg.render();
    try {
      return image.asPng();
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
      font: { fontBuffers: [...fonts], sansSerifFamily: 'Uncut Sans' },
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
