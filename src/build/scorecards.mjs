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
    if (seen.has(t.name)) {
      throw new Error(`registry.yaml: duplicate name "${t.name}"`);
    }
    seen.add(t.name);

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

/**
 * Construct the scorecard filename for a tool.
 *
 * Convention (documented in registry.yaml header):
 *   Behavioral + project: {name}-v{version}.json
 *   Source checks (future): {name}-src-{YYYYMMDD}-{branch}-{commit7}.json
 *
 * Tools without a `version` field in the registry are definitionally
 * unscored — no filename can be constructed.
 *
 * @param {object} tool — registry entry
 * @returns {string | null}
 */
export function scorecardFilename(tool) {
  if (!tool.version) return null;
  return `${tool.name}-v${tool.version}.json`;
}

/**
 * For each registry entry, read scorecards/{name}-v{version}.json if it
 * exists. Tools without a version or without a matching scorecard file
 * are included but marked unscored.
 *
 * @param {string} scorecardsDir — absolute path to scorecards/
 * @param {Array<object>} registry — from loadRegistry()
 * @returns {Promise<Array<{ tool: object, scorecard: object | null }>>}
 */
export async function loadScorecards(scorecardsDir, registry) {
  let files;
  try {
    files = new Set(await readdir(scorecardsDir));
  } catch {
    files = new Set();
  }

  const result = [];
  for (const tool of registry) {
    const filename = scorecardFilename(tool);
    if (filename && files.has(filename)) {
      const raw = await readFile(join(scorecardsDir, filename), 'utf8');
      result.push({ tool, scorecard: JSON.parse(raw) });
    } else {
      result.push({ tool, scorecard: null });
    }
  }
  return result;
}

// -------------------------------------------------------------------
// Scoring
// -------------------------------------------------------------------

/**
 * Compute primary score: pass / (pass + warn + fail).
 * Skip and error are excluded from the denominator.
 * If denominator is 0, score is 0.
 *
 * @param {object | null} scorecard
 * @returns {number} 0–1
 */
export function computeScore(scorecard) {
  if (!scorecard) return 0;
  const { pass = 0, warn = 0, fail = 0 } = scorecard.summary;
  const denom = pass + warn + fail;
  return denom === 0 ? 0 : pass / denom;
}

/**
 * Map P1–P7 groups to pass/partial/fail and return "N/7 principles met".
 * CodeQuality and ProjectStructure are excluded from the N/7 count.
 *
 * @param {object | null} scorecard
 * @returns {{ met: number, total: 7, details: Array<{ group: string, status: string }> }}
 */
export function computePrincipleScore(scorecard) {
  if (!scorecard) return { met: 0, total: 7, details: [] };

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
  return { met, total: 7, details };
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
 * Sort tools by primary score descending. Unscored tools sort to bottom.
 *
 * @param {Array<{ tool: object, scorecard: object | null }>} tools
 * @returns {Array<{ tool: object, scorecard: object | null, score: number, rank: number, principleScore: object }>}
 */
export function computeLeaderboard(tools) {
  const scored = tools.map((entry) => ({
    ...entry,
    score: computeScore(entry.scorecard),
    principleScore: computePrincipleScore(entry.scorecard),
  }));

  // Scored tools first (descending), then unscored
  scored.sort((a, b) => {
    const aScored = a.scorecard !== null;
    const bScored = b.scorecard !== null;
    if (aScored !== bScored) return aScored ? -1 : 1;
    return b.score - a.score;
  });

  return scored.map((entry, i) => ({ ...entry, rank: i + 1 }));
}
