// Skill-distribution build emitter — vendors src/data/install.json into
// dist/install.json (canonical machine surface). Unit 3 adds dist/install.html
// (human page) and dist/install.md (markdown twin) to this module.
//
// Contract (docs/plans/2026-04-24-001-feat-skill-distribution-endpoint-plan.md
// §"/install.json shape"):
//
//   - install.json IS the source of truth. The emitter validates and copies;
//     it does not synthesize fields. verify.expected and source.commit are
//     hand-co-edited at release time.
//   - dist/install.json is byte-stable across runs: keys sorted, two-space
//     indent, trailing newline.
//   - Per-host commands MUST start with `git clone --depth 1` and terminate
//     with an explicit destination path — defense for the agentnative-skill /
//     agent-native-cli repo-name asymmetry. A bare clone would land on the
//     repo name, not the skill name; agents loading SKILL.md would miss.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const COMMIT_RE = /^[0-9a-f]{40}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REQUIRED_TOP_LEVEL = [
  'schema_version',
  'type',
  'name',
  'version',
  'description',
  'principles_url',
  'license',
  'source',
  'install',
  'verify',
  'update',
  'uninstall',
  'install_page_html',
];
const REQUIRED_SOURCE = ['type', 'url', 'commit'];
const REQUIRED_VERIFY = ['command', 'expected', 'semantics'];

/**
 * Read + validate src/data/install.json. Fail-fast on missing/malformed
 * fields — this is the canonical machine surface and a typo here ships to
 * every agent that hits /install.json.
 *
 * @param {string} dataPath absolute path to src/data/install.json
 * @returns {Promise<object>} parsed manifest
 */
export async function loadInstallData(dataPath) {
  const raw = await readFile(dataPath, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${dataPath}: invalid JSON: ${err.message}`);
  }

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in data)) {
      throw new Error(`${dataPath}: missing required key "${key}"`);
    }
  }

  if (!SEMVER_RE.test(data.version)) {
    throw new Error(`${dataPath}: "version" must be semver, got "${data.version}"`);
  }

  for (const key of REQUIRED_SOURCE) {
    if (!data.source[key]) {
      throw new Error(`${dataPath}: missing required key "source.${key}"`);
    }
  }
  if (!COMMIT_RE.test(data.source.commit)) {
    throw new Error(`${dataPath}: "source.commit" must be a 40-char lowercase hex SHA, got "${data.source.commit}"`);
  }

  for (const key of REQUIRED_VERIFY) {
    if (!data.verify[key]) {
      throw new Error(`${dataPath}: missing required key "verify.${key}"`);
    }
  }

  if (!data.install || typeof data.install !== 'object' || Array.isArray(data.install)) {
    throw new Error(`${dataPath}: "install" must be a non-empty object mapping host → command`);
  }
  const hosts = Object.keys(data.install);
  if (hosts.length === 0) {
    throw new Error(`${dataPath}: "install" map must advertise at least one host (R5)`);
  }
  for (const host of hosts) {
    const cmd = data.install[host];
    if (typeof cmd !== 'string' || cmd.trim() === '') {
      throw new Error(`${dataPath}: install."${host}" must be a non-empty string`);
    }
    if (!cmd.startsWith('git clone --depth 1 ')) {
      throw new Error(
        `${dataPath}: install."${host}" must start with "git clone --depth 1 " (got: ${cmd.slice(0, 40)}…)`,
      );
    }
    // Defense for the repo-name / skill-name asymmetry: a bare clone lands
    // on the repo name, not the skill name. Every host MUST advertise an
    // explicit destination path.
    const tokens = cmd.trim().split(/\s+/);
    const dest = tokens[tokens.length - 1];
    if (!dest || dest.endsWith('.git')) {
      throw new Error(
        `${dataPath}: install."${host}" must terminate with an explicit destination path (no bare clone)`,
      );
    }
  }

  return data;
}

/**
 * Emit dist/install.json with stable byte output. Sorted keys + two-space
 * indent + trailing newline so two builds against the same input produce
 * byte-identical artifacts (regression hashes don't move on a no-op rebuild).
 *
 * @param {object} data validated manifest from loadInstallData()
 * @param {string} distDir absolute path to dist/
 */
export async function emitInstallJson(data, distDir) {
  const serialized = `${JSON.stringify(sortKeys(data), null, 2)}\n`;
  await writeFile(join(distDir, 'install.json'), serialized);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys(value[key]);
    }
    return sorted;
  }
  return value;
}
