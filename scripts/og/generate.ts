#!/usr/bin/env bun
/**
 * Deterministic OG image generator for anc.dev.
 *
 * Reads scripts/og/og.html (the production source-of-truth for the
 * social card), launches Chromium headless via Playwright at 1200×630
 * deviceScaleFactor 2, screenshots to a 2400×1260 buffer, then resizes
 * + palette-quantizes via Sharp to a ≤150 KB PNG at public/og-image.png.
 *
 * Determinism: same inputs (og.html, og.css, foundation.css, the woff2
 * fonts on disk) always produce byte-identical output. Verify by
 * running `bun run og` twice and comparing `sha256sum public/og-image.png`.
 *
 * Replaces scripts/og/generate.py (Gemini 3 Pro image generation, deleted
 * in the same PR). See docs/plans/2026-04-29-001-feat-brand-og-and-block-
 * normative-plan.md Unit 4.
 *
 * Run: bun run og
 */

import { chromium } from 'playwright';
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OG_HTML = `${REPO_ROOT}/scripts/og/og.html`;
const OG_OUT = `${REPO_ROOT}/public/og-image.png`;
const SITE_SPEC_VERSION_PATH = `${REPO_ROOT}/content/principles/VERSION`;

const OG_W = 1200;
const OG_H = 630;
const SCALE = 2;
const SIZE_BUDGET_KB = 150;

/**
 * Read the spec version the site's principle prose has been reconciled to
 * (content/principles/VERSION, the same source build/util.mjs exports as
 * SITE_SPEC_VERSION and the footer renders). The OG card is a public-facing
 * social-share surface; tying its version label to the site's reconciled
 * content keeps the social signal honest about what visitors will actually
 * see when they click through.
 *
 * Previously read from the anc self-scorecard's spec_version, but that
 * coupled OG releases to anc binary releases and made the social card
 * lag spec releases until anc shipped a matching binary. Per-tool badges
 * (build.mjs:377) still use each scorecard's own spec_version — the OG is
 * the only surface that needed decoupling.
 */
async function readSiteSpecVersion(): Promise<string> {
  const raw = await readFile(SITE_SPEC_VERSION_PATH, 'utf8');
  const v = raw.trim();
  if (!v) {
    throw new Error(`${SITE_SPEC_VERSION_PATH} is empty`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`${SITE_SPEC_VERSION_PATH} contains non-semver value: ${v}`);
  }
  process.stderr.write(`OG version source: content/principles/VERSION → ${v}\n`);
  return v;
}

async function main(): Promise<number> {
  const specVersion = await readSiteSpecVersion();
  const version = `v${specVersion}`;
  process.stderr.write(`reading og.html, injecting version=${version}\n`);

  const browser = await chromium.launch();
  let pngBuffer: Buffer;
  try {
    const ctx = await browser.newContext({
      viewport: { width: OG_W, height: OG_H },
      deviceScaleFactor: SCALE,
    });
    const page = await ctx.newPage();
    await page.goto('file://' + OG_HTML);
    // Inject the version into the footer's data-version slot. The HTML
    // ships with a default literal so opening the file in a browser
    // standalone still shows something sensible; the renderer overwrites
    // at generation time with the real source-of-truth value.
    await page.evaluate((v: string) => {
      const slot = document.querySelector('[data-version]');
      if (slot) slot.textContent = v;
    }, version);
    // Block on the actual woff2 fonts loading. font-display: block in
    // og.css ensures we don't ship a fallback render; this assert
    // catches the failure mode where the woff2 paths are wrong.
    await page.evaluate(() => document.fonts.ready);
    const fontCount = await page.evaluate(() => document.fonts.size);
    if (fontCount < 2) {
      throw new Error(`expected >=2 fonts loaded (Uncut Sans + Monaspace Xenon), got ${fontCount}`);
    }
    // Defensive check: the brand line must use U+002D hyphens, not
    // en-dashes or em-dashes. The string "agent-native" appears on
    // the card; Chromium font shaping should not auto-convert.
    const brandText = await page.textContent('.brand__tag');
    if (brandText && /[‐-―]/.test(brandText)) {
      throw new Error(`brand tag contains a non-ASCII hyphen variant: ${JSON.stringify(brandText)}`);
    }
    const screenshot = await page.screenshot({
      clip: { x: 0, y: 0, width: OG_W, height: OG_H },
      omitBackground: false,
      type: 'png',
    });
    pngBuffer = screenshot;
  } finally {
    await browser.close();
  }
  process.stderr.write(`captured ${pngBuffer.length} bytes from Chromium (2x)\n`);

  // Resize from 2x back to 1x and palette-quantize. Sharp's PNG palette
  // mode picks an adaptive palette; for our small color count (dark bg,
  // body text, three keyword colors, one accent, plus antialias), 256
  // colors is plenty and gets us well under the 150 KB budget.
  // If it overshoots, retry with a stricter palette ceiling.
  let out = await sharp(pngBuffer, { density: 144 })
    .resize(OG_W, OG_H, { kernel: 'lanczos3' })
    .png({ palette: true, quality: 100, effort: 10, colors: 256 })
    .toBuffer();

  let sizeKb = out.length / 1024;
  if (sizeKb > SIZE_BUDGET_KB) {
    process.stderr.write(`size ${sizeKb.toFixed(1)} KB > ${SIZE_BUDGET_KB} KB budget — retrying with colors=128\n`);
    out = await sharp(pngBuffer, { density: 144 })
      .resize(OG_W, OG_H, { kernel: 'lanczos3' })
      .png({ palette: true, quality: 100, effort: 10, colors: 128 })
      .toBuffer();
    sizeKb = out.length / 1024;
  }

  await writeFile(OG_OUT, out);
  process.stderr.write(
    `wrote ${OG_OUT.replace(REPO_ROOT + '/', '')}  (${OG_W}x${OG_H}, ${sizeKb.toFixed(0)} KB)\n`,
  );
  if (sizeKb > SIZE_BUDGET_KB) {
    process.stderr.write(`WARNING: still over budget (${sizeKb.toFixed(0)} KB). Consider pngquant or further palette tuning.\n`);
    return 2;
  }
  return 0;
}

const code = await main();
process.exit(code);
