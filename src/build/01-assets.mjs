// Asset pipeline: copy committed static files into dist/, bundle client JS.
// No transforms on foundation.css or fonts — byte-equivalent copies only,
// as C3 demands. site.css lives in src/styles/site.css (a real CSS file).

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function copyBinary(src, dest) {
  await mkdir(join(dest, '..'), { recursive: true });
  await copyFile(src, dest);
}

/**
 * Bundle a TypeScript entry with Bun.build. Returns the bundled source
 * text. If `outPath` is provided, also writes to disk; omit it for
 * inline-only bundles (e.g. theme-init).
 */
async function bundleClient(entryPath, outPath) {
  const result = await Bun.build({
    entrypoints: [entryPath],
    target: 'browser',
    format: 'iife',
    minify: true,
  });
  if (!result.success) {
    throw new Error(`bundle failed: ${result.logs.map((l) => String(l)).join('\n')}`);
  }
  const [artifact] = result.outputs;
  const source = await artifact.text();
  if (outPath) {
    await mkdir(join(outPath, '..'), { recursive: true });
    await writeFile(outPath, source);
  }
  return source;
}

/**
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.distDir
 */
export async function copyAssets({ repoRoot, distDir }) {
  // 1. foundation.css — byte-for-byte copy (C3 DRY contract).
  const foundationSrc = join(repoRoot, 'src/styles/foundation.css');
  const foundationDest = join(distDir, 'css/foundation.css');
  await copyBinary(foundationSrc, foundationDest);

  // Verify byte-equivalence.
  const srcBuf = await readFile(foundationSrc);
  const destBuf = await readFile(foundationDest);
  if (!srcBuf.equals(destBuf)) {
    throw new Error('foundation.css copy is not byte-equivalent');
  }

  // 2. site.css — Bun.build minifies. external: ['/*'] preserves url()
  // references to runtime assets (/fonts/*, etc.) instead of trying to
  // resolve them at build time. Foundation.css stays byte-equivalent per
  // the C3 DRY contract; site.css is rendered output so minification is
  // safe and shaves the page weight Lighthouse flags as unminified-css.
  await mkdir(join(distDir, 'css'), { recursive: true });
  const siteResult = await Bun.build({
    entrypoints: [join(repoRoot, 'src/styles/site.css')],
    minify: true,
    external: ['/*'],
  });
  if (!siteResult.success) {
    throw new Error(`site.css minify failed: ${siteResult.logs.map((l) => String(l)).join('\n')}`);
  }
  const siteCss = await siteResult.outputs[0].text();
  await writeFile(join(distDir, 'css/site.css'), siteCss);

  // 3. Fonts.
  const fonts = ['uncut-sans-variable.woff2', 'monaspace-xenon-variable.woff2'];
  await mkdir(join(distDir, 'fonts'), { recursive: true });
  for (const name of fonts) {
    await copyBinary(join(repoRoot, 'public/fonts', name), join(distDir, 'fonts', name));
  }

  // 4. og-image.png.
  await copyBinary(join(repoRoot, 'public/og-image.png'), join(distDir, 'og-image.png'));

  // 5. Favicon set. SVG is the primary surface (modern browsers); the
  // 32×32 PNG is a fallback for older Safari, and apple-touch-icon-180
  // covers iOS Home Screen pinning. See scripts/favicon/generate.ts.
  await copyBinary(join(repoRoot, 'public/favicon.svg'), join(distDir, 'favicon.svg'));
  await copyBinary(join(repoRoot, 'public/favicon-32.png'), join(distDir, 'favicon-32.png'));
  await copyBinary(join(repoRoot, 'public/apple-touch-icon-180.png'), join(distDir, 'apple-touch-icon-180.png'));

  // 6. robots.txt.
  await copyBinary(join(repoRoot, 'public/robots.txt'), join(distDir, 'robots.txt'));

  // 7. Client JS.
  const themeJs = await bundleClient(join(repoRoot, 'src/client/theme.ts'), join(distDir, 'js/theme.js'));
  const clipboardJs = await bundleClient(join(repoRoot, 'src/client/clipboard.ts'), join(distDir, 'js/clipboard.js'));
  const leaderboardJs = await bundleClient(
    join(repoRoot, 'src/client/leaderboard.ts'),
    join(distDir, 'js/leaderboard.js'),
  );
  // Homepage live-scoring form (Turnstile lazy-load + 2 s theater +
  // redirect to /live-score/<binary>). Loaded with defer from the
  // homepage shell only.
  const liveScoreJs = await bundleClient(join(repoRoot, 'src/client/live-score.ts'), join(distDir, 'js/live-score.js'));
  // theme-init is inlined into every HTML head — no file emitted.
  const themeInit = await bundleClient(join(repoRoot, 'src/client/theme-init.ts'));

  return { themeInit, themeJs, clipboardJs, leaderboardJs, liveScoreJs };
}
