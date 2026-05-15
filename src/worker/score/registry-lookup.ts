// Registry + discovery-hints hit-test for the live-scoring path.
//
// Plan U4 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md,
// "registry-lookup.ts" bullet at the end of the U4 Approach block).
//
// Order matters: registry-fast-path > hint > miss. Committed scorecards
// always win over hints (avoids drift); hints always win over live
// discovery (we curated them because live discovery was wrong).
//
// Lookup is case-insensitive on owner/repo because GitHub URLs are
// case-preserving but case-insensitive at resolution. A user pasting
// `github.com/aider-ai/aider` should hit the `Aider-AI/aider` hint.

import type { ParsedInstall } from './parse-install';
import type { ValidatedInput } from './validate';

export type RegistryEntry = {
  name: string;
  binary: string;
  install: string;
  audit_profile?: string;
  repo?: string;
  // Plan U5 — present when the tool has a committed scorecard. The Worker
  // uses these to build the R11 triad and route to /score/<slug> without
  // fetching the scorecard JSON. Tools without a scorecard ship the
  // metadata-only entry; the registry-fast-path treats them as a miss.
  version?: string;
  anc_version?: string;
  scorecard_url?: string;
};

export type RegistryIndex = {
  by_slug: Record<string, RegistryEntry>;
  by_owner_repo: Record<string, RegistryEntry>;
};

export type DiscoveryHint = ParsedInstall & { note?: string };

export type DiscoveryHintsIndex = {
  by_owner_repo: Record<string, DiscoveryHint>;
};

export type RegistryLookupResult =
  | { kind: 'registry'; entry: RegistryEntry }
  | { kind: 'hint'; hint: DiscoveryHint }
  | { kind: 'miss' };

// Case-insensitive owner/repo lookup over a record. The entry-count is
// small (<200) so an O(n) fallback after a direct-hit miss is negligible.
function lookupOwnerRepo<T>(map: Record<string, T>, key: string): T | undefined {
  const direct = map[key];
  if (direct) return direct;
  const keyLower = key.toLowerCase();
  for (const k of Object.keys(map)) {
    if (k.toLowerCase() === keyLower) return map[k];
  }
  return undefined;
}

export function lookupRegistry(
  input: ValidatedInput,
  registryIndex: RegistryIndex,
  hintsIndex: DiscoveryHintsIndex,
): RegistryLookupResult {
  if (input.kind === 'slug') {
    const entry = registryIndex.by_slug[input.slug];
    return entry ? { kind: 'registry', entry } : { kind: 'miss' };
  }
  if (input.kind === 'github-url') {
    const ownerRepo = `${input.owner}/${input.repo}`;
    const entry = lookupOwnerRepo(registryIndex.by_owner_repo, ownerRepo);
    if (entry) return { kind: 'registry', entry };
    const hint = lookupOwnerRepo(hintsIndex.by_owner_repo, ownerRepo);
    if (hint) return { kind: 'hint', hint };
    return { kind: 'miss' };
  }
  // install-command and unknown don't trigger lookups; the caller passes
  // them through directly (install-command -> U6 with the parsed spec;
  // unknown -> 400 to user).
  return { kind: 'miss' };
}
