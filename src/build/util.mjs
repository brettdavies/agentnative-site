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

// Worker-safe primitives + constants live in `src/shared/scorecard-format.mjs`
// so both the build (Node) and the Worker (Cloudflare runtime) can import
// them without dragging in this file's fs.readFileSync calls. Re-exported
// here for backward compat with existing build-side callers.
export {
  BONUS_GROUPS,
  escHtml,
  PRINCIPLE_GROUPS,
  PRINCIPLE_NAMES,
} from '../shared/scorecard-format.mjs';

// =====================================================================
// Version constants — four distinct concepts, three files plus per-scorecard.
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
// 3. ANC_VERSION — the currently-published `anc` binary release
//    (src/data/anc/VERSION). Updated by `./scripts/sync-cli-version.sh`,
//    which fetches Cargo.toml [package].version from agentnative-cli's
//    latest v* tag. Read by test fixtures so they auto-track when anc
//    releases instead of hardcoding a stale literal. NOT used directly
//    by runtime response shape — production anc_version comes from
//    `anc --version` exec output in the sandbox at score time.
//
// 4. (Per-scorecard `spec_version` field) — what `anc` was compiled against
//    when it produced that scorecard. NOT a global constant; lives in each
//    scorecards/<name>-v<ver>.json. USED BY: per-tool badge SVGs (passed
//    explicitly into renderBadgeSvg) and the OG card (reads anc's own
//    self-scorecard's spec_version).
//
// All three files are read at module load, fail-fast on missing.
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
const ANC_VERSION_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'anc', 'VERSION');

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

export const ANC_VERSION = readVersionFile(
  ANC_VERSION_PATH,
  'Run ./scripts/sync-cli-version.sh to vendor the latest agentnative-cli release version, then retry.',
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
