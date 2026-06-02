// Post-build minification. Source files stay readable in the repo; dist/
// is the wire format that ships to Cloudflare. Runs after invariant
// checks so the validators see pristine output, then this step shrinks
// bytes.
//
// Exclusion: dist/skill.json is a documented byte-stable agent contract
// (src/build/skill.mjs header) consumed verbatim by downstream repos
// vendoring agentnative-skill, with a regression test enforcing keys
// sorted + two-space indent + trailing newline.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { minify as minifyHtml } from 'html-minifier-terser';

const PRESERVE_PRETTY = new Set(['skill.json']);

const HTML_OPTIONS = {
  collapseWhitespace: true,
  collapseInlineTagWhitespace: false,
  removeComments: true,
  removeRedundantAttributes: true,
  removeEmptyAttributes: false,
  removeAttributeQuotes: false,
  // CSS and JS are already minified upstream (Bun.build for site.css,
  // Bun.build for client bundles, inline theme-init via bundleClient).
  // Asking html-minifier-terser to re-process them adds work without
  // saving bytes.
  minifyCSS: false,
  minifyJS: false,
  // Default behavior preserves <pre>, <code>, <textarea>, <script>,
  // <style> content verbatim, which is the contract code blocks rely on.
};

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function minifyCssFile(filePath) {
  const result = await Bun.build({
    entrypoints: [filePath],
    minify: true,
    // url() references to runtime assets (/fonts/*, etc.) are absolute
    // and must survive — Bun.build would otherwise try to resolve them
    // against the build context and fail.
    external: ['/*'],
  });
  if (!result.success) {
    throw new Error(`css minify failed for ${filePath}: ${result.logs.map((l) => String(l)).join('\n')}`);
  }
  return result.outputs[0].text();
}

/**
 * Walk distDir and minify HTML, JSON, and CSS files in place. Markdown
 * twins, sitemap.xml, fonts, images, and any other extensions are left
 * untouched. Returns a summary of files touched and byte savings.
 *
 * @param {string} distDir
 */
export async function minifyDist(distDir) {
  const files = await walk(distDir);
  const counts = { html: 0, json: 0, css: 0 };
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (const file of files) {
    const relPath = relative(distDir, file);
    if (PRESERVE_PRETTY.has(relPath)) continue;
    const ext = extname(file);
    if (ext === '.html') {
      const original = await readFile(file, 'utf8');
      const minified = await minifyHtml(original, HTML_OPTIONS);
      await writeFile(file, minified);
      counts.html++;
      bytesBefore += original.length;
      bytesAfter += minified.length;
    } else if (ext === '.json') {
      const original = await readFile(file, 'utf8');
      const minified = JSON.stringify(JSON.parse(original));
      await writeFile(file, minified);
      counts.json++;
      bytesBefore += original.length;
      bytesAfter += minified.length;
    } else if (ext === '.css') {
      const original = await readFile(file, 'utf8');
      const minified = await minifyCssFile(file);
      await writeFile(file, minified);
      counts.css++;
      bytesBefore += original.length;
      bytesAfter += minified.length;
    }
  }

  const savedPct = bytesBefore > 0 ? (((bytesBefore - bytesAfter) / bytesBefore) * 100).toFixed(1) : '0.0';
  return { ...counts, bytesBefore, bytesAfter, savedPct };
}
