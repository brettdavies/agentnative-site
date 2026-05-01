// Small build helpers: sorted principle glob, filename parsing, HTML escaping.
// Kept separate from build.mjs so tests/build.test.ts can import directly.

import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// =====================================================================
// Spec version constants — three distinct concepts, three distinct files.
// =====================================================================
//
// 1. SPEC_VERSION  — the spec version we last *vendored* (src/data/spec/VERSION).
//    Updated by `./scripts/sync-spec.sh`. Kept around as a reference / diff
//    target. NOT used for any user-visible surface — the moment of vendoring
//    and the moment of site reconciliation are different events.
//
// 2. SITE_SPEC_VERSION — the spec version this site's principle prose has
//    been *reconciled to* (content/principles/VERSION). Bumped MANUALLY by
//    the contributor who reconciles content/principles/p*-*.md after a
//    sync-spec.sh run. Always ≤ SPEC_VERSION; lag during the manual
//    reconciliation window is honest (footer correctly says the site hasn't
//    caught up yet). USED BY: site footer.
//
// 3. (Per-scorecard `spec_version` field) — what `anc` was compiled against
//    when it produced that scorecard. NOT a global constant; lives in each
//    scorecards/<name>-v<ver>.json. USED BY: per-tool badge SVGs (passed
//    explicitly into renderBadgeSvg) and the OG card (reads anc's own
//    self-scorecard's spec_version).
//
// Both files are read at module load, fail-fast on missing.
// =====================================================================

const SPEC_VERSION_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'spec', 'VERSION');
const SITE_SPEC_VERSION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'content',
  'principles',
  'VERSION',
);

function readVersionFile(path, remediation) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (err) {
    throw new Error(`Could not read ${path}: ${err.message}\n${remediation}`);
  }
}

export const SPEC_VERSION = readVersionFile(
  SPEC_VERSION_PATH,
  'Run ./scripts/sync-spec.sh to vendor the latest spec, then retry.',
);

export const SITE_SPEC_VERSION = readVersionFile(
  SITE_SPEC_VERSION_PATH,
  'Create content/principles/VERSION with the spec version this site is reconciled to (one-line semver).',
);

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
