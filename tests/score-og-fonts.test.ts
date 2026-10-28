// resvg matches a font-family against the families the loaded fonts declare
// and silently draws the default face when none matches, so a misnamed
// family passes every other test and still ships the wrong type.

import { beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-wasm';
import { renderScoreOgSvg, SCORE_OG_FONT, scoreOgEdition } from '../src/shared/score-og';
import { ensureScoreOgWasm } from '../src/worker/og/render';

const FONT_DIR = new URL('../src/worker/og/fonts/', import.meta.url);
const UNKNOWN_FAMILY = 'No Such Family';

let fonts: Uint8Array[] = [];

beforeAll(async () => {
  await ensureScoreOgWasm();
  fonts = await Promise.all(
    ['uncut-sans-600.ttf', 'uncut-sans-700.ttf', 'monaspace-xenon-500.otf'].map(
      async (file) => new Uint8Array(await readFile(new URL(file, FONT_DIR))),
    ),
  );
});

function drawText(family: string, fallback: string): Uint8Array {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="64"><text x="8" y="44" font-family="${family}" font-size="32">anc.dev 0123 SCORE</text></svg>`;
  const resvg = new Resvg(svg, {
    font: { fontBuffers: fonts, defaultFontFamily: fallback },
    fitTo: { mode: 'original' },
  });
  try {
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

describe('card fonts', () => {
  test('the card names only the two card families', () => {
    const svg = renderScoreOgSvg({
      name: 'ripgrep',
      subtitle: 'rg',
      lane: 'cli',
      scorePct: 92,
      pending: false,
      specVersion: '0.6.0',
      edition: scoreOgEdition({ lane: 'cli', toolVersion: '15.2.0' }),
      logo: null,
    });
    const named = new Set([...svg.matchAll(/font-family="([^"]+)"/g)].map((match) => match[1]));
    expect(named).toEqual(new Set([SCORE_OG_FONT.sans, SCORE_OG_FONT.mono]));
  });

  test.each([
    ['sans', SCORE_OG_FONT.sans, SCORE_OG_FONT.mono],
    ['mono', SCORE_OG_FONT.mono, SCORE_OG_FONT.sans],
  ])('the %s family resolves to a bundled font instead of the fallback face', (_label, family, fallback) => {
    expect(drawText(family, fallback)).not.toEqual(drawText(UNKNOWN_FAMILY, fallback));
  });
});
