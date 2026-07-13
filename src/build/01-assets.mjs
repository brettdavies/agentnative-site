// Asset pipeline: copy committed static files into dist/, bundle client JS.
// CSS files are copied verbatim here; step 12 (minifyDist) shrinks them
// alongside HTML and JSON so the source-control versions stay readable
// and the wire format is consolidated in one place.

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
  // 1. foundation.css and site.css copied verbatim. Minification happens
  // in step 12 (minifyDist) so the source-control versions stay readable
  // and the pipeline has one place to look when audit-trailing wire bytes.
  const foundationSrc = join(repoRoot, 'src/styles/foundation.css');
  const foundationDest = join(distDir, 'css/foundation.css');
  await copyBinary(foundationSrc, foundationDest);

  await mkdir(join(distDir, 'css'), { recursive: true });
  const siteCss = await readFile(join(repoRoot, 'src/styles/site.css'), 'utf8');
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
  // Web-audit form (POST /api/audit-web, render the NDJSON stream). Loaded
  // with defer from the /web-audit page shell only.
  const webAuditJs = await bundleClient(join(repoRoot, 'src/client/web-audit.ts'), join(distDir, 'js/web-audit.js'));
  // Web leaderboard sort toggle (GLOBAL default, RELATIVE via ?sort=).
  // Loaded with defer from the /web page shell only.
  const webLeaderboardJs = await bundleClient(
    join(repoRoot, 'src/client/web-leaderboard.ts'),
    join(distDir, 'js/web-leaderboard.js'),
  );
  const webmcpJs = await bundleClient(join(repoRoot, 'src/client/webmcp.ts'), join(distDir, 'js/webmcp.js'));
  // theme-init is inlined into every HTML head — no file emitted.
  const themeInit = await bundleClient(join(repoRoot, 'src/client/theme-init.ts'));

  return { themeInit, themeJs, clipboardJs, leaderboardJs, liveScoreJs, webAuditJs, webLeaderboardJs, webmcpJs };
}
