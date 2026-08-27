// Chrome drops `@font-face src` when the format hint is the unquoted ident
// `woff2-variations` (Bun's CSS minify strips the quotes from the string
// form). The preloads then warn as unused and the page paints in system
// fonts. Both surfaces that declare these faces must keep a token Chrome
// accepts after minify: format("woff2") or format(woff2).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { minifyCssFile } from '../src/build/12-minify-dist.mjs';

const ROOT = join(import.meta.dir, '..');
const SITE_CSS = join(ROOT, 'src/styles/site.css');
const OG_CSS = join(ROOT, 'scripts/og/og.css');

const FACE_BLOCK = /@font-face\s*\{[^}]*\}/g;
const UNQUOTED_VARIATIONS = /format\(\s*woff2-variations\s*\)/;
const WOFF2_FORMAT = /format\(\s*(?:"woff2"|woff2)\s*\)/;

function faceBlocks(css: string): string[] {
  return [...css.matchAll(FACE_BLOCK)].map((m) => m[0]);
}

function blockFor(css: string, family: string): string {
  const block = faceBlocks(css).find((b) => b.includes(family));
  expect(block, `missing @font-face for ${family}`).toBeDefined();
  return block ?? '';
}

function assertChromeKeepsSrc(block: string, file: string): void {
  expect(block).toContain(file);
  expect(block).toMatch(/src\s*:/);
  expect(block).toMatch(/url\(/);
  expect(block).not.toMatch(UNQUOTED_VARIATIONS);
  expect(block).toMatch(WOFF2_FORMAT);
}

function assertBothFaces(css: string, files: { sans: string; mono: string }): void {
  expect(faceBlocks(css).length).toBeGreaterThanOrEqual(2);
  assertChromeKeepsSrc(blockFor(css, 'Uncut Sans'), files.sans);
  assertChromeKeepsSrc(blockFor(css, 'Monaspace Xenon'), files.mono);
}

describe('site.css @font-face (live pages)', () => {
  const files = {
    sans: 'uncut-sans-variable.woff2',
    mono: 'monaspace-xenon-variable.woff2',
  };

  test('source keeps a Chrome-valid format("woff2") on both faces', async () => {
    const css = await readFile(SITE_CSS, 'utf8');
    assertBothFaces(css, files);
  });

  test('minified CSS still keeps src — the form Chrome actually parses', async () => {
    const css = await minifyCssFile(SITE_CSS);
    assertBothFaces(css, files);
  });
});

describe('og.css @font-face (OG PNG renderer)', () => {
  const files = {
    sans: 'uncut-sans-variable.woff2',
    mono: 'monaspace-xenon-variable.woff2',
  };

  test('source keeps a Chrome-valid format("woff2") on both faces', async () => {
    const css = await readFile(OG_CSS, 'utf8');
    assertBothFaces(css, files);
  });
});
