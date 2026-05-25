// Build-time indexes for the live-scoring path:
//
// - dist/registry-index.json: dual-keyed (slug, owner/repo) lookup of
//   every committed-scorecard tool. Powers the Worker's registry-fast-
//   path with O(1) lookups whether the input was a slug or a GitHub URL.
// - dist/discovery-hints-index.json: owner/repo -> {pm, package, binary}
//   hints for tools the discovery chain would otherwise bounce due to
//   incomplete or non-canonical ecosystem metadata. Powers the hint
//   short-circuit at the front of the discovery chain.
//
// Pure data emit; no network, no side effects beyond writeFile.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';

// Mirrors parse-install.ts's pm table. Adding a new pm here requires a
// matching parser entry; keeping these in sync is the typo guard.
// `direct` is reserved for URL-paste paths and is not a valid hint pm —
// hints always name an ecosystem package.
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

function projectRegistryEntry(tool, enrichment) {
  const out = {
    name: tool.name,
    binary: tool.binary,
    install: tool.install,
  };
  if (tool.audit_profile) out.audit_profile = tool.audit_profile;
  if (tool.repo) out.repo = tool.repo;
  // The registry-fast-path response carries the latest scorecard's
  // version + anc_version + URL so the Worker can build the response
  // triad (spec_version + anc_version + checker_url) and route the user
  // to /score/<slug> without fetching the scorecard JSON. Also carry
  // score_pct so the registry_hit envelope can show a "Curated - N% pass
  // rate" reward inline on the homepage form without a second round-trip.
  if (enrichment) {
    if (enrichment.version) out.version = enrichment.version;
    if (enrichment.anc_version) out.anc_version = enrichment.anc_version;
    if (enrichment.scorecard_url) out.scorecard_url = enrichment.scorecard_url;
    if (typeof enrichment.score_pct === 'number') out.score_pct = enrichment.score_pct;
  }
  return out;
}

/**
 * @param {Array<object>} registry
 * @param {Record<string, { version?: string, anc_version?: string, scorecard_url?: string }>} [enrichments]
 *   Per-tool-name lookup of scored-build metadata. Tools without an entry
 *   here still appear in the index (no scorecard committed yet).
 */
export function buildRegistryIndex(registry, enrichments = {}) {
  const by_slug = {};
  const by_owner_repo = {};
  const warnings = [];
  for (const tool of registry) {
    const projected = projectRegistryEntry(tool, enrichments[tool.name]);
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

export async function emitBuildIndexes({ registry, hintsPath, distDir, enrichments }) {
  const { index: registryIndex, warnings: rWarnings } = buildRegistryIndex(registry, enrichments);
  const hints = await loadDiscoveryHints(hintsPath);
  const { index: hintsIndex, warnings: hWarnings } = buildDiscoveryHintsIndex(hints, registryIndex);

  await writeFile(join(distDir, 'registry-index.json'), `${JSON.stringify(registryIndex, null, 2)}\n`);
  await writeFile(join(distDir, 'discovery-hints-index.json'), `${JSON.stringify(hintsIndex, null, 2)}\n`);

  return { warnings: [...rWarnings, ...hWarnings] };
}
