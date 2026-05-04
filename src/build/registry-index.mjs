// Build-time indexes for the live-scoring path (plan U1):
//
// - dist/registry-index.json: dual-keyed (slug, owner/repo) lookup of every
//   committed-scorecard tool. Powers U4's registry-fast-path so the Worker
//   does O(1) lookups whether the input was a slug or a GitHub URL.
// - dist/discovery-hints-index.json: owner/repo -> {pm, package, binary}
//   hints for tools the discovery chain would otherwise bounce due to
//   incomplete or non-canonical ecosystem metadata. Powers U4's step 0.5
//   (per Pre-Implementation Validation gate finding F1).
//
// Pure data emit; no network, no side effects beyond writeFile.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';

// Mirrors U4's parse-install.ts table (plan lines 1092-1103). Adding a new
// pm here requires a matching parser entry; keeping these in sync is the
// typo guard. `direct` is reserved for URL-paste paths (step 1 of U4) and
// is not a valid hint pm — hints always name an ecosystem package.
export const KNOWN_PM = new Set(['brew', 'cargo-binstall', 'bun', 'pip', 'npm', 'go']);

const OWNER_REPO_RE = /^[^/]+\/[^/]+$/;

export function deriveOwnerRepo(tool) {
  if (tool.repo && OWNER_REPO_RE.test(tool.repo)) return tool.repo;
  if (tool.url) {
    const m = tool.url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?(?:[#?].*)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

function projectRegistryEntry(tool) {
  const out = {
    name: tool.name,
    binary: tool.binary,
    install: tool.install,
  };
  if (tool.audit_profile) out.audit_profile = tool.audit_profile;
  if (tool.repo) out.repo = tool.repo;
  return out;
}

export function buildRegistryIndex(registry) {
  const by_slug = {};
  const by_owner_repo = {};
  const warnings = [];
  for (const tool of registry) {
    const projected = projectRegistryEntry(tool);
    by_slug[tool.name] = projected;
    const ownerRepo = deriveOwnerRepo(tool);
    if (!ownerRepo) {
      warnings.push(
        `registry-index: tool "${tool.name}" has no parseable owner/repo (no repo, no github url) — owner/repo entry skipped`,
      );
      continue;
    }
    if (by_owner_repo[ownerRepo]) {
      warnings.push(
        `registry-index: duplicate owner/repo "${ownerRepo}" — "${by_owner_repo[ownerRepo].name}" overwritten by "${tool.name}"`,
      );
    }
    by_owner_repo[ownerRepo] = projected;
  }
  return { index: { by_slug, by_owner_repo }, warnings };
}

export function buildDiscoveryHintsIndex(hints, registryIndex) {
  const by_owner_repo = {};
  const warnings = [];
  for (const hint of hints) {
    const k = hint.owner_repo;
    if (!k || !OWNER_REPO_RE.test(k)) {
      throw new Error(
        `discovery-hints: every hint must declare owner_repo as "<owner>/<repo>" (got ${JSON.stringify(k)})`,
      );
    }
    if (!hint.pm || !KNOWN_PM.has(hint.pm)) {
      throw new Error(`discovery-hints: hint "${k}" has unknown pm "${hint.pm}"; valid: ${[...KNOWN_PM].join(', ')}`);
    }
    if (!hint.package || !hint.binary) {
      throw new Error(`discovery-hints: hint "${k}" missing required field "package" or "binary"`);
    }
    if (registryIndex.by_owner_repo[k]) {
      warnings.push(`discovery-hints: hint "${k}" collides with registry entry — registry wins, hint dropped`);
      continue;
    }
    if (by_owner_repo[k]) {
      warnings.push(`discovery-hints: duplicate hint "${k}" — second wins`);
    }
    by_owner_repo[k] = {
      pm: hint.pm,
      package: hint.package,
      binary: hint.binary,
      ...(hint.note ? { note: hint.note } : {}),
    };
  }
  return { index: { by_owner_repo }, warnings };
}

export async function loadDiscoveryHints(hintsPath) {
  const raw = await readFile(hintsPath, 'utf8');
  const doc = yaml.load(raw);
  const hints = doc?.hints;
  if (!Array.isArray(hints)) {
    throw new Error('discovery-hints.yaml: expected top-level "hints" array');
  }
  return hints;
}

export async function emitBuildIndexes({ registry, hintsPath, distDir }) {
  const { index: registryIndex, warnings: rWarnings } = buildRegistryIndex(registry);
  const hints = await loadDiscoveryHints(hintsPath);
  const { index: hintsIndex, warnings: hWarnings } = buildDiscoveryHintsIndex(hints, registryIndex);

  await writeFile(join(distDir, 'registry-index.json'), `${JSON.stringify(registryIndex, null, 2)}\n`);
  await writeFile(join(distDir, 'discovery-hints-index.json'), `${JSON.stringify(hintsIndex, null, 2)}\n`);

  return { warnings: [...rWarnings, ...hWarnings] };
}
