// Chrome drops `@font-face src` when the format hint is the unquoted ident
// `woff2-variations` (Bun's CSS minify strips the quotes from the string
// form). The preloads then warn as unused and the page paints in system
// fonts. Both surfaces that declare these faces must keep a token Chrome
// accepts after minify: format("woff2") or format(woff2).

import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { minifyCssFile } from '../src/build/12-minify-dist.mjs';
import { distStylesheets, requireDistBuild } from './helpers/dist';

const ROOT = join(import.meta.dir, '..');
const SITE_CSS = join(ROOT, 'src/styles/site.css');
const OG_CSS = join(ROOT, 'scripts/og/og.css');
const SHELL_MJS = join(ROOT, 'src/build/shell.mjs');
const DIST = join(ROOT, 'dist');

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

function fontUrlRefs(css: string): string[] {
  return [...css.matchAll(/url\(\s*["']?(\/fonts\/[^"')\s]+)["']?\s*\)/g)].map((m) => m[1]);
}

async function distCssBundle(): Promise<string> {
  const sheets = await distStylesheets(DIST);
  expect(sheets.length).toBeGreaterThanOrEqual(1);
  return sheets.map((s) => s.css).join('\n');
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

describe('dist CSS @font-face (shipped bytes; run `bun run build` first)', () => {
  let distCss: string;
  let shippedFonts: Set<string>;

  beforeAll(async () => {
    requireDistBuild(DIST);
    distCss = await distCssBundle();
    shippedFonts = new Set(await readdir(join(DIST, 'fonts')));
  });

  test('shipped stylesheets keep both faces with src and a Chrome-valid format', () => {
    assertBothFaces(distCss, {
      sans: 'uncut-sans-variable.woff2',
      mono: 'monaspace-xenon-variable.woff2',
    });
  });

  test('every url(/fonts/...) in shipped CSS resolves to a file in dist/fonts/', () => {
    const refs = fontUrlRefs(distCss);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const ref of refs) {
      expect({ ref, shipped: shippedFonts.has(basename(ref)) }).toEqual({ ref, shipped: true });
    }
  });

  test('every shell.mjs preload href names a file in dist/fonts/ that a shipped face declares', async () => {
    const shell = await readFile(SHELL_MJS, 'utf8');
    const hrefs = [...shell.matchAll(/rel="preload"\s+href="(\/fonts\/[^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThanOrEqual(2);
    const declared = new Set(fontUrlRefs(distCss));
    for (const href of hrefs) {
      expect({
        href,
        shipped: shippedFonts.has(basename(href)),
        declared: declared.has(href),
      }).toEqual({ href, shipped: true, declared: true });
    }
  });
});
