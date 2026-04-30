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

// -------------------------------------------------------------------
// Shared constants (STAR — single authoritative source)
// -------------------------------------------------------------------

export const PRINCIPLE_NAMES = {
  P1: 'Non-Interactive by Default',
  P2: 'Structured, Parseable Output',
  P3: 'Progressive Help Discovery',
  P4: 'Fail-Fast, Actionable Errors',
  P5: 'Safe Retries & Mutation Boundaries',
  P6: 'Composable, Predictable Command Structure',
  P7: 'Bounded, High-Signal Responses',
};

export const PRINCIPLE_GROUPS = Object.keys(PRINCIPLE_NAMES);

export const BONUS_GROUPS = ['CodeQuality', 'ProjectStructure'];

// Spec version cited on the badge label and in the /badge convention prose.
// The spec sync-plan (docs/plans/2026-04-23-001-feat-sync-spec-plan.md)
// will replace this with a build-time read from src/data/spec/VERSION when
// it lands. Until then, this is a manually-tracked copy of the
// agentnative-spec VERSION file. The shell footer carries a separate stub
// (v0.1.0) tracked by the same plan; both should converge to the real
// version once the sync script is wired.
export const SPEC_VERSION = '0.3.0';

const DEFAULT_BASE = 'https://anc.dev';

/**
 * Resolve the site base URL from an explicit value, env, or fallback.
 * Always strips trailing slashes.
 *
 * @param {string=} baseUrl — explicit override (optional)
 * @returns {string}
 */
export function resolveBaseUrl(baseUrl) {
  return (baseUrl ?? process.env.PUBLIC_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, '');
}

/**
 * Rewrite site-root-relative markdown links to absolute URLs.
 *
 * Source markdown authors site-internal links as `[text](/p3)` so HTML pages
 * stay portable across hosts (anc.dev, staging, local dev). The `.md` twin —
 * fetched directly by agents — must self-resolve, so we absolutify those
 * targets at emit time. Idempotent: links that are already absolute pass
 * through unchanged.
 *
 * Targets: standard links `[text](/path)`, optional reference titles
 * `[text](/path "title")`, and image links `![alt](/path)`. Skips
 * protocol-relative `//host/path` and intra-document fragments `(#anchor)`.
 *
 * @param {string} markdown
 * @param {string=} baseUrl — explicit override; defaults via resolveBaseUrl
 * @returns {string}
 */
export function absolutifyMarkdownLinks(markdown, baseUrl) {
  const base = resolveBaseUrl(baseUrl);
  return markdown.replace(/(!?\])\(\s*(\/[^)\s]*)(\s+"[^"]*")?\s*\)/g, (match, bracket, path, title) => {
    if (path.startsWith('//')) return match;
    return `${bracket}(${base}${path}${title ?? ''})`;
  });
}
