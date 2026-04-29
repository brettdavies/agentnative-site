// Skill-distribution build emitter — vendors src/data/skill.json into
// dist/skill.json (canonical machine surface), dist/skill.html (human
// page), and dist/skill.md (markdown twin for content-negotiated agents).
//
// Contract (docs/plans/2026-04-24-001-feat-skill-distribution-endpoint-plan.md
// §"/install.json shape", relocated to /skill.json by 2026-04-28-003):
//
//   - skill.json IS the source of truth. The emitter validates and copies;
//     it does not synthesize fields. verify.expected and source.commit are
//     hand-co-edited at release time.
//   - dist/skill.json is byte-stable across runs: keys sorted, two-space
//     indent, trailing newline.
//   - Per-host commands MUST start with `git clone --depth 1` and terminate
//     with an explicit destination path — defense for the agentnative-skill /
//     agent-native-cli repo-name asymmetry. A bare clone would land on the
//     repo name, not the skill name; agents loading SKILL.md would miss.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderMarkdown } from './render.mjs';

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
  'skill_page_html',
];
const REQUIRED_SOURCE = ['type', 'url', 'commit'];
const REQUIRED_VERIFY = ['command', 'expected', 'semantics'];

/**
 * Read + validate src/data/skill.json. Fail-fast on missing/malformed
 * fields — this is the canonical machine surface and a typo here ships to
 * every agent that hits /skill.json.
 *
 * @param {string} dataPath absolute path to src/data/skill.json
 * @returns {Promise<object>} parsed manifest
 */
export async function loadSkillData(dataPath) {
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
 * Emit dist/skill.json with stable byte output. Sorted keys + two-space
 * indent + trailing newline so two builds against the same input produce
 * byte-identical artifacts (regression hashes don't move on a no-op rebuild).
 *
 * @param {object} data validated manifest from loadSkillData()
 * @param {string} distDir absolute path to dist/
 */
export async function emitSkillJson(data, distDir) {
  const serialized = `${JSON.stringify(sortKeys(data), null, 2)}\n`;
  await writeFile(join(distDir, 'skill.json'), serialized);
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

// -------------------------------------------------------------------
// HTML + markdown twin — templated from the same skill.json
// -------------------------------------------------------------------

const HOST_LABELS = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};

function hostLabel(host) {
  return HOST_LABELS[host] ?? host;
}

/**
 * Build the markdown body for /skill. The same body is written to
 * dist/skill.md (twin for `Accept: text/markdown` agents) AND fed through
 * the unified+rehype pipeline to produce dist/skill.html. Drift between
 * the JSON manifest, the HTML page, and the markdown twin is structurally
 * impossible because all three derive from data.install.
 *
 * Voice: trust-model paragraph is VOICE.md Register 1 (third-person, failure
 * mode first). Command sections are Register 2 imperative.
 *
 * @param {object} data validated skill manifest
 * @returns {string} markdown body
 */
export function buildSkillMarkdown(data) {
  const hosts = Object.keys(data.install);
  const lines = [];

  lines.push('# Install agent-native-cli');
  lines.push('');
  lines.push(`> ${data.description}`);
  lines.push('');
  lines.push(
    'One skill, one repo. Choose your host below, run the command, the agent picks up `SKILL.md` on next launch. The same machine-readable manifest is at [`/skill.json`](/skill.json).',
  );
  lines.push('');

  lines.push('## Choose your host');
  lines.push('');
  for (const host of hosts) {
    lines.push(`### ${hostLabel(host)}`);
    lines.push('');
    lines.push('```bash');
    lines.push(data.install[host]);
    lines.push('```');
    lines.push('');
  }

  lines.push('## What this does');
  lines.push('');
  lines.push(
    `Clones \`${data.source.url}\` (pinned at commit \`${data.source.commit}\`) into your host's skills directory. \`.git/\` is preserved so future updates are a \`git pull\`.`,
  );
  lines.push('');

  lines.push('## Already installed?');
  lines.push('');
  lines.push('If the destination directory already holds this skill (origin matches), update in place:');
  lines.push('');
  lines.push('```bash');
  lines.push(data.update);
  lines.push('```');
  lines.push('');
  lines.push('If it holds something else, remove it first, then re-run the install command:');
  lines.push('');
  lines.push('```bash');
  lines.push(data.uninstall);
  lines.push('```');
  lines.push('');

  lines.push('## Update');
  lines.push('');
  lines.push('```bash');
  lines.push(data.update);
  lines.push('```');
  lines.push('');
  lines.push('To pin a specific release: `git checkout <tag>` after pulling. Tags follow `vX.Y.Z` semver.');
  lines.push('');

  lines.push('## Uninstall');
  lines.push('');
  lines.push('```bash');
  lines.push(data.uninstall);
  lines.push('```');
  lines.push('');

  lines.push('## Trust model');
  lines.push('');
  lines.push(
    "Piping a remote shell script into the local shell is the failure mode this install path rejects. Installation runs `git clone` against a content-addressed commit on a specific repository — the scripts are open-source and visible at the producer repo before they execute on the user's machine. The site advertises a single upstream commit SHA in `/skill.json`; agents that care about provenance can verify it.",
  );
  lines.push('');

  lines.push('## Verify');
  lines.push('');
  lines.push("After install, confirm the local checkout matches the site's advertised pin:");
  lines.push('');
  lines.push('```bash');
  lines.push(data.verify.command);
  lines.push('```');
  lines.push('');
  lines.push(
    `Expected: \`${data.verify.expected}\`. ${data.verify.semantics.charAt(0).toUpperCase()}${data.verify.semantics.slice(1)}.`,
  );
  lines.push('');

  lines.push('## Programmatic');
  lines.push('');
  lines.push(
    'Agents fetch [`/skill.json`](/skill.json) for the canonical manifest — `Content-Type: application/json`, `Accept: text/markdown` returns the JSON unchanged.',
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * Render the skill markdown to HTML via the existing unified+rehype pipeline.
 *
 * @param {object} data validated skill manifest
 * @returns {Promise<{ markdown: string, html: string }>}
 */
export async function renderSkillPage(data) {
  const markdown = buildSkillMarkdown(data);
  const html = await renderMarkdown(markdown);
  return { markdown, html };
}

/**
 * Write dist/skill.md from a prebuilt markdown body.
 *
 * @param {string} markdown
 * @param {string} distDir
 */
export async function emitSkillMarkdown(markdown, distDir) {
  await writeFile(join(distDir, 'skill.md'), markdown);
}
