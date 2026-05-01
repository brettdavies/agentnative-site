#!/usr/bin/env bun
/**
 * Deterministic favicon PNG generator for anc.dev.
 *
 * Reads public/favicon.svg (the brand-authored source) and rasterizes
 * two PNG variants via Sharp:
 *
 *   - public/favicon-32.png       (32×32, rounded corners preserved)
 *       Fallback for browsers without SVG-favicon support (older Safari).
 *       Modern Chromium / Firefox / Safari 15+ use the SVG directly via
 *       `<link rel="icon" type="image/svg+xml">` in shell.mjs.
 *
 *   - public/apple-touch-icon-180.png  (180×180, solid square — no transparency)
 *       iOS Home Screen icon. Apple HIG requires opaque, full-bleed PNGs;
 *       iOS does not mask the icon, so we flatten the rounded-corner SVG
 *       onto the brand `--accent` fill to produce a square. iOS supplies
 *       its own corner rounding when the user pins the site.
 *
 * Determinism: same input SVG always produces byte-identical PNGs. Verify
 * by running `bun run favicon` twice and comparing each output's sha256.
 *
 * The SVG embeds a `prefers-color-scheme: dark` style override; that
 * branch is dropped during rasterization (Sharp renders the default
 * light-mode `--accent` fill). PNG fallbacks therefore track the
 * light-mode brand color, which is fine: dark-mode users on browsers
 * that support SVG favicons get the SVG anyway, and iOS Home Screen
 * is a single-light surface.
 *
 * Run: bun run favicon
 */

import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SVG_IN = `${REPO_ROOT}/public/favicon.svg`;
const PNG_FAVICON = `${REPO_ROOT}/public/favicon-32.png`;
const PNG_APPLE = `${REPO_ROOT}/public/apple-touch-icon-180.png`;
const FAVICON_SIZE = 32;
const APPLE_SIZE = 180;
// Light-mode `--accent` from src/styles/foundation.css, hex-equivalent of
// `oklch(46% 0.155 250)`. Kept in sync with public/favicon.svg's `.bg` fill.
const ACCENT_HEX = '#0058aa';

async function main(): Promise<number> {
  const svg = await readFile(SVG_IN);

  const favicon = await sharp(svg, { density: 384 })
    .resize(FAVICON_SIZE, FAVICON_SIZE, { kernel: 'lanczos3' })
    .png({ palette: true, quality: 100, effort: 10, colors: 64 })
    .toBuffer();
  await writeFile(PNG_FAVICON, favicon);
  process.stderr.write(
    `wrote public/favicon-32.png  (${FAVICON_SIZE}x${FAVICON_SIZE}, ${favicon.length} bytes)\n`,
  );

  const apple = await sharp(svg, { density: 1536 })
    .resize(APPLE_SIZE, APPLE_SIZE, { kernel: 'lanczos3' })
    .flatten({ background: ACCENT_HEX })
    .png({ palette: true, quality: 100, effort: 10, colors: 64 })
    .toBuffer();
  await writeFile(PNG_APPLE, apple);
  process.stderr.write(
    `wrote public/apple-touch-icon-180.png  (${APPLE_SIZE}x${APPLE_SIZE}, ${apple.length} bytes)\n`,
  );

  return 0;
}

const code = await main();
process.exit(code);
