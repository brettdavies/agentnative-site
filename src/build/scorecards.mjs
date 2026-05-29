// Scorecard data module — reads registry.yaml + scorecards/*.json,
// produces data structures and scoring computations. HTML/markdown
// rendering lives in scorecards-render.mjs.
//
// Pure functions: data-in, data-out. No side effects, no filesystem
// writes. The build orchestrator (build.mjs) handles I/O.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { PRINCIPLE_GROUPS } from './util.mjs';

const TOOL_NAME_RE = /^[a-z0-9-]+$/;

// Schema versions a committed scorecard may declare. The site reads derived
// fields directly from `scorecard.badge.{score_pct, eligible, embed_markdown}`
// and assumes their presence; 0.6 adds the 7-status taxonomy (opt_out / n_a)
// and per-row results, both of which render additively over the 0.5 path. The
// set is intentionally plural for the migration window: the live corpus is 0.5
// until the registry rescores against the 0.6 CLI, so both must load
// side by side. Drop 0.5 once the full rescore lands. Adding a version here
// without a corpus able to satisfy it still fails the build at load.
const SUPPORTED_SCHEMA_VERSIONS = new Set(['0.5', '0.6']);

// Mirrors `ExceptionCategory::to_kebab_str()` in
// agentnative/src/principles/registry.rs (CLI v0.1.3). Adding a new variant
// upstream means adding it here too — the CLI flag rejects anything not in
// its enum, so a typo or stale value here would silently invalidate the
// regen pipeline. Kept as an exported constant so tests and the future
// regen script can share it.
export const KNOWN_AUDIT_PROFILES = ['human-tui', 'file-traversal', 'posix-utility', 'diagnostic-only'];

// Default version-extraction pipeline used by scripts/regen-scorecards.sh.
// Most CLIs print `<name> <version>` on the first --version line; this
// regex picks the first SemVer-shaped token (2 or 3 components) on that
// line. Tools whose --version output doesn't yield to this regex MUST
// declare a `version_extract` shell snippet in registry.yaml.
export const DEFAULT_VERSION_EXTRACT_REGEX = '[0-9]+\\.[0-9]+(\\.[0-9]+)?';

// -------------------------------------------------------------------
// Data loading
// -------------------------------------------------------------------

/**
 * Parse registry.yaml, validate required fields and name format,
 * enforce uniqueness. Returns array of tool entries.
 *
 * @param {string} registryPath — absolute path to registry.yaml
 * @returns {Promise<Array<object>>}
 */
export async function loadRegistry(registryPath) {
  const raw = await readFile(registryPath, 'utf8');
  const doc = yaml.load(raw);
  const tools = doc?.tools;
  if (!Array.isArray(tools)) {
    throw new Error('registry.yaml: expected top-level "tools" array');
  }

  // Binary-name collision guard for `/score/<binary>` redirects: for tools
  // where binary !== name, the binary slug must not appear as ANY other
  // tool's `name`.
  // Without this, a future registry addition `name: rg, binary: rg` would
  // silently overwrite the `/score/rg` redirect page that ripgrep emits, or
  // vice versa. Build the binary set first so we can detect collisions in
  // either direction during the per-entry validation loop below.
  const binaryRedirectSlugs = new Set();
  for (const t of tools) {
    if (t.binary && t.name && t.binary !== t.name) {
      binaryRedirectSlugs.add(t.binary);
    }
  }

  const seen = new Set();
  for (const t of tools) {
    if (!t.name || typeof t.name !== 'string') {
      throw new Error('registry.yaml: every tool must have a "name" string');
    }
    if (!TOOL_NAME_RE.test(t.name)) {
      throw new Error(`registry.yaml: name "${t.name}" must match /^[a-z0-9-]+$/ (lowercase, alphanumeric, hyphens)`);
    }
    if (t.name === 'scorecards') {
      throw new Error('registry.yaml: "scorecards" is reserved — slug collision with the leaderboard page');
    }
    if (t.name === 'live') {
      throw new Error(
        'registry.yaml: "live" is reserved — slug collision with the /score/live/<binary> dynamic share-URL namespace',
      );
    }
    if (seen.has(t.name)) {
      throw new Error(`registry.yaml: duplicate name "${t.name}"`);
    }
    seen.add(t.name);
    if (binaryRedirectSlugs.has(t.name)) {
      throw new Error(
        `registry.yaml: name "${t.name}" collides with another tool's binary slug. ` +
          `The /score/${t.name} URL would be ambiguous between the canonical page and the binary-name redirect. ` +
          `Rename one of the entries.`,
      );
    }

    for (const field of ['binary', 'language', 'tier', 'creator', 'description']) {
      if (!t[field]) {
        throw new Error(`registry.yaml: tool "${t.name}" missing required field "${field}"`);
      }
    }
    if (!t.repo && !t.url) {
      throw new Error(
        `registry.yaml: tool "${t.name}" must have at least one of "repo" (GitHub owner/repo) or "url" (canonical project URL)`,
      );
    }
    if (!['workhorse', 'agent', 'notable'].includes(t.tier)) {
      throw new Error(`registry.yaml: tool "${t.name}" has invalid tier "${t.tier}"`);
    }
    if (t.audit_profile != null && !KNOWN_AUDIT_PROFILES.includes(t.audit_profile)) {
      throw new Error(
        `registry.yaml: tool "${t.name}" has unknown audit_profile "${t.audit_profile}". ` +
          `Valid values: ${KNOWN_AUDIT_PROFILES.join(', ')}. See ExceptionCategory in agentnative/src/principles/registry.rs.`,
      );
    }
  }

  return tools;
}

// Compares two SemVer-shaped version strings (`X.Y` or `X.Y.Z`, optionally
// with a numeric or `pre`/`rc.N`-style suffix) for sorting. Returns >0 if
// `a > b`, <0 if `a < b`, 0 if equal. Falls back to lexical compare for
// anything not recognizable as a numeric tuple.
export function compareVersions(a, b) {
  const parse = (v) =>
    v.split('.').map((seg) => {
      const n = Number.parseInt(seg, 10);
      return Number.isFinite(n) ? n : seg;
    });
  const ap = parse(a);
  const bp = parse(b);
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const ai = ap[i] ?? 0;
    const bi = bp[i] ?? 0;
    if (typeof ai === 'number' && typeof bi === 'number') {
      if (ai !== bi) return ai - bi;
    } else {
      // Mixed types — defer to lexical.
      const cmp = String(ai).localeCompare(String(bi));
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

// Build a map: tool name → array of {filename, version} pairs for every
// scorecard file matching `<name>-v<version>.json` in the scorecards/ dir.
// Used by loadScorecards for auto-discovery when registry has no version pin.
function indexScorecardsByName(filenames) {
  const idx = new Map();
  for (const file of filenames) {
    const m = file.match(/^([a-z0-9-]+)-v([^/]+?)\.json$/);
    if (!m) continue;
    const [, name, version] = m;
    if (!idx.has(name)) idx.set(name, []);
    idx.get(name).push({ filename: file, version });
  }
  // Sort each tool's scorecards highest-version-first.
  for (const list of idx.values()) {
    list.sort((a, b) => compareVersions(b.version, a.version));
  }
  return idx;
}

/**
 * Discover scorecards on disk and join each to its registry editorial entry.
 *
 * Iteration is **scorecard-driven**: the build reads
 * `<name>-v*.json` from the scorecards/ directory, picks the highest version
 * per slug, and joins to `registry.tools[name=slug]` for editorial fields
 * (tier, language, creator, description, install, repo/url).
 *
 * Both directions of join failure surface as **warnings**, not errors:
 *
 *   - **scorecardOrphans** — a `<name>-v*.json` file whose slug has no
 *     matching registry entry. Excluded from the leaderboard. Supports
 *     rename/retire flows where the scorecard arrives before (or after)
 *     the editorial PR.
 *   - **registryOrphans** — a registry entry with no scorecard for its
 *     `name` on disk. Excluded from the leaderboard. Supports
 *     editorial-PR-first contribution flow.
 *
 * The orchestrator logs both lists; CI surfaces them as a PR comment.
 * The structural invariant — "every scorecard's filename slug must match
 * a registry entry" — is intentionally NOT enforced here; it lives in
 * `runScorecardInvariants()`. Splitting the contracts lets a contributor
 * land a scorecard PR + editorial PR in either order without the build
 * blowing up mid-merge.
 *
 * @param {string} scorecardsDir — absolute path to scorecards/
 * @param {Array<object>} registry — from loadRegistry()
 * @returns {Promise<{
 *   tools: Array<{ tool: object, scorecard: object, version: string, metadata: object, scorecardFilename: string }>,
 *   warnings: { scorecardOrphans: string[], registryOrphans: string[] }
 * }>}
 */
export async function loadScoredTools(scorecardsDir, registry) {
  const registryByName = new Map(registry.map((t) => [t.name, t]));
  let files;
  try {
    files = await readdir(scorecardsDir);
  } catch {
    files = [];
  }

  // indexScorecardsByName already returns a name → [{filename, version}, …]
  // map sorted highest-version-first per slug. The inverted iteration starts
  // here: the scorecards on disk are the source of truth for inclusion.
  const byName = indexScorecardsByName(files);

  const tools = [];
  const scorecardOrphans = [];

  for (const [slug, candidates] of byName) {
    if (candidates.length === 0) continue;
    const { filename, version } = candidates[0];
    const registryEntry = registryByName.get(slug);
    if (!registryEntry) {
      scorecardOrphans.push(filename);
      continue;
    }

    const raw = await readFile(join(scorecardsDir, filename), 'utf8');
    const scorecard = JSON.parse(raw);
    // Schema invariant: every committed scorecard must declare a supported version.
    // Non-conforming corpus → fail the build immediately rather than silently render
    // wrong data via a synthesized fallback. Regenerate the full corpus together
    // (`bash docker/score/build.sh --run`); never leave a mixed corpus drifting
    // outside the supported set.
    if (!SUPPORTED_SCHEMA_VERSIONS.has(scorecard.schema_version)) {
      throw new Error(
        `${filename}: schema_version "${scorecard.schema_version}" not supported. ` +
          `Site supports schema ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}. Regenerate via ` +
          `\`bash docker/score/build.sh --run\` then trash any superseded older-version files.`,
      );
    }
    // v0.4 metadata blocks lifted to top-level fields for direct read access.
    const metadata = {
      tool: scorecard.tool,
      anc: scorecard.anc,
      run: scorecard.run,
      target: scorecard.target,
    };
    tools.push({ tool: registryEntry, scorecard, version, metadata, scorecardFilename: filename });
  }

  const registryOrphans = [];
  for (const entry of registry) {
    if (!byName.has(entry.name)) {
      registryOrphans.push(entry.name);
    }
  }

  return { tools, warnings: { scorecardOrphans, registryOrphans } };
}

// -------------------------------------------------------------------
// Build-time corpus invariants (schema 0.4)
// -------------------------------------------------------------------

// Path-based grandfather. anc-v0.1.3.json predates the v0.4 metadata
// contract (it's at schema_version 1.1, an older anc-specific schema with no
// tool/anc/run/target blocks). Keeping it on the leaderboard is a product
// decision: anc must always render at the most-recent public version, and
// regenerating against the current dev-branch CLI would produce a lower
// version (anc-v0.1.0.json) than the released 0.1.3. The next CLI release
// (v0.2.1+, post PR #34) replaces this file organically and the grandfather
// drops out.
export const GRANDFATHERED_SCORECARDS = new Set(['anc-v0.1.3.json']);

const SCORECARD_FILENAME_RE = /^([a-z0-9-]+)-v([^/]+?)\.json$/;
const SEMVER_TOKEN_RE = /[0-9]+\.[0-9]+(?:\.[0-9]+)?/;

/**
 * Run the v0.4 corpus invariants over every scorecard on disk. Throws on
 * the first violation with the offending filename and the contract that
 * failed. Designed to fail-fast in `bun run build` so CI catches drift
 * before merge.
 *
 * Invariants:
 *   (a) schema_version >= "0.4" (compareVersions floor)
 *   (b) filename slug matches a registry entry (the editorial join)
 *   (c) scorecard.tool.name === registry[joined].binary (the regen scored
 *       the right binary; accommodates name ≠ binary tools where filename
 *       slug = registry name but tool.name = registry binary)
 *   (d) run.started_at parses as RFC 3339
 *   (e) when tool.version contains a SemVer token, it must equal the
 *       filename version (catches parser-asymmetry between the regen
 *       script's version_extract and the CLI's --version probe)
 *
 * Grandfathered files (GRANDFATHERED_SCORECARDS) skip (c), (d), and (e) —
 * they predate the v0.4 metadata blocks. (a) and (b) still apply: an
 * orphan grandfather without a registry entry is a structural error
 * regardless of schema vintage.
 *
 * @param {string} scorecardsDir — absolute path to scorecards/
 * @param {Array<object>} registry — from loadRegistry()
 */
export async function runScorecardInvariants(scorecardsDir, registry) {
  const registryByName = new Map(registry.map((t) => [t.name, t]));
  let filenames;
  try {
    filenames = await readdir(scorecardsDir);
  } catch {
    filenames = [];
  }

  for (const filename of filenames) {
    const m = filename.match(SCORECARD_FILENAME_RE);
    if (!m) continue;
    const [, slug, filenameVersion] = m;

    const registryEntry = registryByName.get(slug);
    if (!registryEntry) {
      throw new Error(
        `invariant: scorecard ${filename} has no matching registry entry (slug "${slug}" is not a registry.tools[].name).`,
      );
    }

    const raw = await readFile(join(scorecardsDir, filename), 'utf8');
    let sc;
    try {
      sc = JSON.parse(raw);
    } catch (err) {
      throw new Error(`invariant: scorecard ${filename} is not valid JSON: ${err.message}`);
    }

    const grandfathered = GRANDFATHERED_SCORECARDS.has(filename);

    if (!grandfathered) {
      if (typeof sc.schema_version !== 'string' || compareVersions(sc.schema_version, '0.4') < 0) {
        throw new Error(
          `invariant: scorecard ${filename} has schema_version "${sc.schema_version}" — below floor "0.4". ` +
            `Regenerate with anc PR #34 or later.`,
        );
      }

      const toolName = sc.tool?.name;
      if (toolName !== registryEntry.binary) {
        throw new Error(
          `invariant: scorecard ${filename} tool.name "${toolName}" !== registry[${slug}].binary "${registryEntry.binary}". ` +
            `The regen scored the wrong binary, or the registry's binary field drifted.`,
        );
      }

      const startedAt = sc.run?.started_at;
      if (typeof startedAt !== 'string' || Number.isNaN(new Date(startedAt).getTime())) {
        throw new Error(
          `invariant: scorecard ${filename} run.started_at "${startedAt}" is not a valid RFC 3339 timestamp.`,
        );
      }

      const toolVersion = sc.tool?.version;
      if (typeof toolVersion === 'string' && toolVersion.length > 0) {
        const semver = toolVersion.match(SEMVER_TOKEN_RE);
        if (semver && semver[0] !== filenameVersion) {
          throw new Error(
            `invariant: scorecard ${filename} tool.version "${toolVersion}" extracts SemVer "${semver[0]}" — ` +
              `does not match filename version "${filenameVersion}". Parser-asymmetry between regen-script ` +
              `version_extract and CLI internal probe; align both before re-regen.`,
          );
        }
      }
    }
  }
}

// -------------------------------------------------------------------
// Scoring
// -------------------------------------------------------------------

/**
 * Map the principle groups (P1–P8) to pass/partial/fail and return
 * "N/total principles met". CodeQuality and ProjectStructure are bonus
 * groups, excluded from the count. `total` tracks PRINCIPLE_GROUPS so the
 * count follows the standard as principles are added.
 *
 * @param {object | null} scorecard
 * @returns {{ met: number, total: number, details: Array<{ group: string, status: string }> }}
 */
export function computePrincipleScore(scorecard) {
  if (!scorecard) return { met: 0, total: PRINCIPLE_GROUPS.length, details: [] };

  const details = [];
  for (const group of PRINCIPLE_GROUPS) {
    const checks = scorecard.results.filter((r) => r.group === group);
    if (checks.length === 0) {
      details.push({ group, status: 'skip' });
      continue;
    }
    const hasFail = checks.some((r) => r.status === 'fail');
    const hasWarn = checks.some((r) => r.status === 'warn');
    if (hasFail) details.push({ group, status: 'fail' });
    else if (hasWarn) details.push({ group, status: 'partial' });
    else details.push({ group, status: 'pass' });
  }

  const met = details.filter((d) => d.status === 'pass').length;
  return { met, total: PRINCIPLE_GROUPS.length, details };
}

/**
 * Compute layer scores: primary (behavioral + project) vs source.
 *
 * @param {object | null} scorecard
 * @returns {{ primary: number, source: number | null }}
 */
export function computeLayerScore(scorecard) {
  if (!scorecard) return { primary: 0, source: null };

  const primary = scorecard.results.filter((r) => r.layer === 'behavioral' || r.layer === 'project');
  const source = scorecard.results.filter((r) => r.layer === 'source');

  const ratio = (checks) => {
    const p = checks.filter((c) => c.status === 'pass').length;
    const w = checks.filter((c) => c.status === 'warn').length;
    const f = checks.filter((c) => c.status === 'fail').length;
    const d = p + w + f;
    return d === 0 ? 0 : p / d;
  };

  return {
    primary: ratio(primary),
    source: source.length === 0 ? null : ratio(source),
  };
}

/**
 * Extract top N failing/warning checks sorted by severity (FAIL > WARN).
 *
 * @param {object | null} scorecard
 * @param {number} limit
 * @returns {Array<{ id: string, label: string, group: string, status: string, evidence: string | null }>}
 */
export function extractTopIssues(scorecard, limit = 3) {
  if (!scorecard) return [];

  const issues = scorecard.results.filter((r) => r.status === 'fail' || r.status === 'warn');
  const order = { fail: 0, warn: 1 };
  issues.sort((a, b) => order[a.status] - order[b.status]);
  return issues.slice(0, limit);
}

/**
 * Sort tools by primary score descending. Every tool has a scorecard, so
 * the unscored-tools-sort-to-bottom branch is gone with the pre-inversion
 * code path that allowed null scorecards.
 *
 * @param {Array<{ tool: object, scorecard: object }>} tools
 * @returns {Array<{ tool: object, scorecard: object, rank: number, principleScore: object }>}
 */
export function computeLeaderboard(tools) {
  const scored = tools.map((entry) => ({
    ...entry,
    principleScore: computePrincipleScore(entry.scorecard),
  }));

  scored.sort((a, b) => b.scorecard.badge.score_pct - a.scorecard.badge.score_pct);

  return scored.map((entry, i) => ({ ...entry, rank: i + 1 }));
}
