// Small build helpers: sorted principle glob, filename parsing, HTML escaping.
// Kept separate from build.mjs so tests/build.test.ts can import directly.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const PRINCIPLE_FILENAME_RE = /^p(\d+)-([a-z0-9-]+)\.md$/;

/**
 * Return principle markdown files, sorted by their leading `p<n>-` numeric
 * prefix (not lexicographic — `p10` should follow `p9`, not `p1`).
 *
 * @param {string} dir Directory containing `p<n>-<slug>.md` files.
 * @returns {Promise<string[]>} Absolute file paths in numeric order.
 */
export async function sortedGlob(dir) {
  const entries = await readdir(dir);
  const matched = entries
    .map((name) => ({ name, match: name.match(PRINCIPLE_FILENAME_RE) }))
    .filter((e) => e.match !== null)
    .map((e) => ({ name: e.name, n: Number(e.match[1]) }))
    .sort((a, b) => a.n - b.n);

  return matched.map((e) => join(dir, e.name));
}

/**
 * Extract `{n, slug}` from a principle filename (or full path).
 * Throws if the name does not match `p<n>-<slug>.md`.
 *
 * @param {string} filename Either `p3-progressive-help-discovery.md` or an
 *                          absolute path ending in such a filename.
 * @returns {{ n: number, slug: string }}
 */
export function parseFilename(filename) {
  const base = filename.includes('/') ? filename.slice(filename.lastIndexOf('/') + 1) : filename;
  const match = base.match(PRINCIPLE_FILENAME_RE);
  if (!match) {
    throw new Error(`parseFilename: "${base}" does not match p<n>-<slug>.md`);
  }
  return { n: Number(match[1]), slug: match[2] };
}

/**
 * Escape HTML special characters in a string.
 * @param {string} s
 * @returns {string}
 */
export function escHtml(s) {
  return String(s).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
