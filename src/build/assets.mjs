// Asset pipeline: copy committed static files into dist/, emit site.css,
// and bundle the client JS. No transforms on foundation.css or fonts —
// byte-equivalent copies only, as C3 demands.

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SITE_CSS = `/* site.css — additive layer on top of foundation.css (docs/DESIGN.md §4 + A2). */

@font-face {
  font-family: 'Uncut Sans';
  src: url('/fonts/uncut-sans-variable.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'Monaspace Xenon';
  src: url('/fonts/monaspace-xenon-variable.woff2') format('woff2-variations');
  font-weight: 200 800;
  font-style: normal;
  font-display: swap;
}

html {
  font-family: var(--font-sans, 'Uncut Sans', system-ui, sans-serif);
  font-size: var(--text-base, 1.0625rem);
  color: var(--fg-body, #1a2026);
  background: var(--bg, #fafbfd);
  line-height: 1.6;
}

body {
  margin: 0;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}

code, pre, kbd, samp {
  font-family: var(--font-mono, 'Monaspace Xenon', ui-monospace, monospace);
  font-feature-settings: var(--ff-mono, 'kern' 1, 'liga' 0, 'clig' 0, 'calt' 0);
}

main {
  flex: 1;
  width: 100%;
  max-width: 74ch;
  margin-inline: auto;
  padding: clamp(1.5rem, 4vw, 3rem) clamp(1rem, 4vw, 2rem);
  box-sizing: border-box;
}

main h1 { font-size: clamp(1.75rem, 2.5vw + 1rem, 2.5rem); margin-top: 0; line-height: 1.15; }
main h2 { font-size: 1.5rem; margin-top: 2.5rem; }
main h3 { font-size: 1.15rem; margin-top: 1.75rem; }

main p, main li { max-width: 70ch; }
main pre { overflow-x: auto; padding: 1rem 1.25rem; border-radius: 0.5rem; position: relative; background: var(--bg-code, #f0f4f7); border: 1px solid var(--border, #cfd5db); }
main :not(pre) > code { background: var(--bg-code, #f0f4f7); padding: 0.15rem 0.4rem; border-radius: 0.3rem; font-size: 0.95em; }

/* Anchor permalinks (rehype-autolink-headings). Hidden until heading hover / focus. */
main a.anchor { color: var(--fg-muted, #525960); margin-left: 0.35rem; opacity: 0; transition: opacity 120ms linear; text-decoration: none; }
main h1:hover .anchor, main h1:focus-within .anchor,
main h2:hover .anchor, main h2:focus-within .anchor,
main h3:hover .anchor, main h3:focus-within .anchor,
main h4:hover .anchor, main h4:focus-within .anchor,
main a.anchor:focus-visible { opacity: 1; }
main .anchor-icon { vertical-align: -2px; }

/* RFC-keyword color pairs (A7 colors live in foundation.css). */
.rfc-must   { color: var(--must,   #af2b25); }
.rfc-should { color: var(--should, #a16100); }
.rfc-may    { color: var(--may,    #007980); }

/* Shiki dual-theme CSS bridge (docs/DESIGN.md §4.6 A7). */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) .shiki,
  :root:not([data-theme='light']) .shiki span { color: var(--shiki-dark) !important; background-color: var(--shiki-dark-bg) !important; font-style: var(--shiki-dark-font-style) !important; font-weight: var(--shiki-dark-font-weight) !important; text-decoration: var(--shiki-dark-text-decoration) !important; }
}
:root[data-theme='dark'] .shiki,
:root[data-theme='dark'] .shiki span { color: var(--shiki-dark) !important; background-color: var(--shiki-dark-bg) !important; font-style: var(--shiki-dark-font-style) !important; font-weight: var(--shiki-dark-font-weight) !important; text-decoration: var(--shiki-dark-text-decoration) !important; }

/* Skip link — only visible to keyboard users (§4.12 a11y). */
.skip-link {
  position: absolute; left: -9999px;
  background: var(--accent, #0058aa); color: #fff;
  padding: 0.6rem 0.9rem; z-index: 100;
  text-decoration: none; border-radius: 0 0 0.4rem 0;
}
.skip-link:focus { left: 0; top: 0; }

/* Header / brand / nav */
.site-header {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem;
  padding: 1rem clamp(1rem, 4vw, 2rem);
  border-bottom: 1px solid var(--border, #cfd5db);
}
.site-brand { display: flex; flex-direction: column; gap: 0.1rem; text-decoration: none; color: inherit; }
.site-brand__name { font-weight: 600; letter-spacing: -0.01em; }
.site-brand__tag { color: var(--fg-secondary, #6a7278); font-size: 0.9rem; }
.site-nav { display: flex; gap: 1rem; font-size: 0.95rem; }
.site-nav a { color: inherit; }

/* Theme toggle — hidden when JS is off (C6). */
.theme-toggle { display: none; gap: 0; border: 1px solid var(--border, #cfd5db); border-radius: 999px; overflow: hidden; font-size: 0.85rem; }
:root.js .theme-toggle { display: inline-flex; }
.theme-toggle button { background: transparent; color: inherit; padding: 0.25rem 0.7rem; border: 0; cursor: pointer; font: inherit; }
.theme-toggle button[aria-pressed='true'] { background: var(--bg-code, #eef2f5); font-weight: 600; }
.theme-toggle button + button { border-left: 1px solid var(--border, #cfd5db); }

/* Copy buttons — hidden when JS is off (C6). */
.copy-button { display: none; position: absolute; top: 0.5rem; right: 0.5rem; background: var(--bg, #fff); color: inherit; border: 1px solid var(--border, #cfd5db); border-radius: 0.3rem; padding: 0.2rem 0.6rem; font-size: 0.75rem; cursor: pointer; }
:root.js main pre .copy-button { display: inline-block; }
.copy-button[data-copy-state='copied'] { background: var(--accent, #0058aa); color: #fff; border-color: var(--accent, #0058aa); }

/* ================================================================
 * Homepage — hero + principle listing
 * ================================================================ */

/* Hero section — title + lede. The H1 breaks out of the default heading
   scale to create a clear "this is the landing page" signal. */
.hero {
  padding-top: clamp(2rem, 5vw, 4rem);
  padding-bottom: clamp(1.5rem, 3vw, 2.5rem);
}

.hero__title {
  font-size: clamp(2.25rem, 3vw + 1.25rem, 3.5rem);
  line-height: 1.08;
  letter-spacing: -0.025em;
  font-weight: 650;
  color: var(--fg-heading, #0f1419);
  margin: 0;
  animation: hero-enter 500ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.hero__lede {
  font-size: clamp(1.05rem, 0.9rem + 0.45vw, 1.2rem);
  line-height: 1.6;
  color: var(--fg-secondary, #6a7278);
  max-width: 62ch;
  margin: 1.25rem 0 0;
  animation: hero-enter 500ms cubic-bezier(0.16, 1, 0.3, 1) 80ms both;
}

@keyframes hero-enter {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Principle listing — numbered entries linking to /p{N} pages. */
.principles-index {
  padding-bottom: clamp(1.5rem, 3vw, 2.5rem);
}

.principles-index__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.principle-entry {
  border-top: 1px solid var(--border-subtle, #e5e8eb);
  animation: principle-enter 400ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.principle-entry:last-child {
  border-bottom: 1px solid var(--border-subtle, #e5e8eb);
}

.principle-entry:nth-child(1) { animation-delay: 120ms; }
.principle-entry:nth-child(2) { animation-delay: 170ms; }
.principle-entry:nth-child(3) { animation-delay: 220ms; }
.principle-entry:nth-child(4) { animation-delay: 270ms; }
.principle-entry:nth-child(5) { animation-delay: 320ms; }
.principle-entry:nth-child(6) { animation-delay: 370ms; }
.principle-entry:nth-child(7) { animation-delay: 420ms; }

@keyframes principle-enter {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

.principle-entry__link {
  display: grid;
  grid-template-columns: 3rem 1fr;
  grid-template-rows: auto auto;
  column-gap: 1.25rem;
  row-gap: 0.15rem;
  padding: 1.15rem 0.75rem;
  margin: 0 -0.75rem;
  text-decoration: none;
  color: inherit;
  border-radius: 0.375rem;
  transition: background-color 120ms ease;
}

.principle-entry__link:hover,
.principle-entry__link:focus-visible {
  background: var(--bg-raised, #f4f5f7);
}

.principle-entry__num {
  grid-row: 1 / -1;
  font-family: var(--font-mono, 'Monaspace Xenon', ui-monospace, monospace);
  font-size: 1.4rem;
  font-weight: 350;
  color: var(--accent, #0058aa);
  line-height: 1.15;
  font-feature-settings: var(--ff-tabular, 'tnum' 1, 'kern' 1);
  align-self: center;
}

.principle-entry__title {
  font-size: 1.08rem;
  font-weight: 600;
  color: var(--fg-heading, #0f1419);
  line-height: 1.35;
}

.principle-entry__desc {
  font-size: 0.92rem;
  color: var(--fg-muted, #525960);
  line-height: 1.45;
  max-width: 55ch;
}

/* Footer */
.site-footer { border-top: 1px solid var(--border, #cfd5db); padding: 1.25rem clamp(1rem, 4vw, 2rem); color: var(--fg-secondary, #6a7278); font-size: 0.9rem; }
.site-footer__meta { margin: 0; display: flex; flex-wrap: wrap; gap: 0.3rem; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
`;

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
    throw new Error('bundle failed: ' + result.logs.map((l) => String(l)).join('\n'));
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
  const foundationSrc = join(repoRoot, 'docs/design/foundation.css');
  const foundationDest = join(distDir, 'css/foundation.css');
  await copyBinary(foundationSrc, foundationDest);

  // Verify byte-equivalence.
  const srcBuf = await readFile(foundationSrc);
  const destBuf = await readFile(foundationDest);
  if (!srcBuf.equals(destBuf)) {
    throw new Error('foundation.css copy is not byte-equivalent');
  }

  // 2. site.css — additive rules (this layer, not in foundation.css).
  await mkdir(join(distDir, 'css'), { recursive: true });
  await writeFile(join(distDir, 'css/site.css'), SITE_CSS);

  // 3. Fonts.
  const fonts = ['uncut-sans-variable.woff2', 'monaspace-xenon-variable.woff2'];
  await mkdir(join(distDir, 'fonts'), { recursive: true });
  for (const name of fonts) {
    await copyBinary(join(repoRoot, 'public/fonts', name), join(distDir, 'fonts', name));
  }

  // 4. og-image.png.
  await copyBinary(join(repoRoot, 'public/og-image.png'), join(distDir, 'og-image.png'));

  // 5. robots.txt.
  await copyBinary(join(repoRoot, 'public/robots.txt'), join(distDir, 'robots.txt'));

  // 6. Client JS.
  const themeJs = await bundleClient(join(repoRoot, 'src/client/theme.ts'), join(distDir, 'js/theme.js'));
  const clipboardJs = await bundleClient(join(repoRoot, 'src/client/clipboard.ts'), join(distDir, 'js/clipboard.js'));
  // theme-init is inlined into every HTML head — no file emitted.
  const themeInit = await bundleClient(join(repoRoot, 'src/client/theme-init.ts'));

  return { themeInit, themeJs, clipboardJs };
}
