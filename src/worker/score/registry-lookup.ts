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
//
// Plan U7 extends this module with `lookupScorecard()`, an async unified
// resolution that consults registry first and then falls through to the
// R2 cache when the binary is cheaply derivable. Both `curated` and
// `cached` results bypass the metered gates (Turnstile, rate-limit, DO)
// per R6 — cached scorecards are functionally identical to curated ones
// (no sandbox cost). The legacy sync `lookupRegistry()` stays exported
// for callers that don't need the cache layer (registry-lookup tests,
// future callers that want just the registry tier).

import * as cache from './cache';
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
  // U8+ — score_pct surfaces into the registry_hit envelope so the
  // homepage form can show a curated-tool reward (e.g., "Curated · 92%
  // pass rate · Opening the audited scorecard…") inline before redirect,
  // without a second round-trip to fetch the scorecard JSON.
  score_pct?: number;
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
  if (input.kind === 'install-command') {
    // Cross-check the parser's binary against curated by_slug. Catches
    // inputs like `cargo install bat` (binary='bat', curated as
    // by_slug['bat']) and `npm i -g typescript` (binary='typescript',
    // curated as by_slug['typescript']). Without this, install-commands
    // that resolve to a curated tool fall through to the R2 cache (empty
    // on first request) and then to the live path — paying sandbox cost
    // for a tool the site already has a curated audit for. Per-binary
    // alias edge case (e.g., `cargo install rg` typing the binary name
    // not the package name) still falls through; an explicit by_binary
    // map would catch that but isn't worth the index churn for the
    // current corpus.
    const entry = registryIndex.by_slug[input.spec.binary];
    if (entry) return { kind: 'registry', entry };
    return { kind: 'miss' };
  }
  // unknown — passed through to a 400 by the caller.
  return { kind: 'miss' };
}

// ---------------------------------------------------------------------------
// Unified scorecard lookup (plan U7)
// ---------------------------------------------------------------------------

// Resolution covers BOTH the curated registry tier (in-memory hashmap,
// no I/O) and the R2 cache tier (one R2 GET on hit, cheap). Resolution
// order:
//
//   1. Registry first. Slug or github-url with a curated entry whose
//      scorecard_url+anc_version are populated → `curated`. Done.
//   2. R2 cache fallback when the binary is cheaply known:
//      - install-command: `spec.binary` from the parser
//      - github-url with a hint: `hint.binary`
//      - github-url without hint: skipped (no binary derivable upfront;
//        discovery is part of the live path)
//      - slug-without-curated-scorecard: skipped (slugs without a
//        scorecard_url have no install spec to derive a binary from)
//   3. `miss` otherwise. The handler proceeds to the metered live path.
//
// `cached` results carry the cached payload's anc_version (NOT the
// build-time SPEC_VERSION constant used to build the lookup key), so the
// response triad reflects which anc the scorecard was actually scored by.
//
// `skipCache` short-circuits the R2 read tier — registry still consults
// freely. Callers pass `skipCache: true` to honor the `?fromCache=false`
// operator escape hatch ("did the registry version just update?").

export type ScorecardLookupResult =
  | { kind: 'curated'; entry: RegistryEntry; scorecard_url: string; anc_version: string }
  | { kind: 'cached'; scorecard: unknown; anc_version: string; tool_version: string }
  | { kind: 'miss' };

export type ScorecardLookupOptions = {
  // Build-time spec version, used as the partition slot in the cache key
  // (handoff Decision 2 + gotcha 3). All readers and writers must pass
  // the same value to avoid key drift.
  specVersion: string;
  // When true, skip the R2 read tier. Registry is still consulted.
  skipCache?: boolean;
};

export async function lookupScorecard(
  input: ValidatedInput,
  env: cache.CacheEnv,
  registryIndex: RegistryIndex,
  hintsIndex: DiscoveryHintsIndex,
  opts: ScorecardLookupOptions,
): Promise<ScorecardLookupResult> {
  // Tier 1: registry. Curated scorecards always win over the cache.
  const registry = lookupRegistry(input, registryIndex, hintsIndex);
  if (registry.kind === 'registry' && registry.entry.scorecard_url && registry.entry.anc_version) {
    return {
      kind: 'curated',
      entry: registry.entry,
      scorecard_url: registry.entry.scorecard_url,
      anc_version: registry.entry.anc_version,
    };
  }

  // Tier 2: R2 cache. Derive the binary from whatever is cheaply
  // available; bail out otherwise (no I/O speculation).
  if (opts.skipCache) return { kind: 'miss' };

  const binary = deriveCacheBinary(input, registry);
  if (!binary) return { kind: 'miss' };

  const cached = await cache.get(env, cache.keyFor(binary, opts.specVersion));
  if (cached) {
    return {
      kind: 'cached',
      scorecard: cached.scorecard,
      anc_version: cached.anc_version,
      tool_version: cached.tool_version,
    };
  }

  return { kind: 'miss' };
}

// Returns the binary slug usable as a cache key, or null when the input
// can't be resolved without running discovery. Lifted out of
// lookupScorecard so the derivation is independently testable and so the
// "where does the binary come from?" decision lives in one place.
function deriveCacheBinary(input: ValidatedInput, registry: RegistryLookupResult): string | null {
  if (input.kind === 'install-command') return input.spec.binary;
  if (registry.kind === 'hint') return registry.hint.binary;
  // github-url without a hint, or slug without a curated scorecard:
  // no upfront binary. The live path will run discovery and write to
  // the cache afterward, so the NEXT request benefits.
  return null;
}

/**
 * Public form of the cache-key binary derivation, used by the handler to
 * compute the `share_url` (`/live-score/<binary>`) for cached + live
 * inline-scorecard responses. Same logic as the internal cache-tier
 * derivation, exported so the handler can reuse it without re-running a
 * full lookup. Returns null when no binary is derivable upfront (the only
 * case is github-url without a hint; the user's response carries no
 * share_url and they can re-paste to re-score).
 */
export function deriveShareBinary(input: ValidatedInput, hintsIndex: DiscoveryHintsIndex): string | null {
  if (input.kind === 'install-command') return input.spec.binary;
  if (input.kind === 'github-url') {
    // Branch-scoped pastes don't get a share URL. The /score/live/<binary>
    // surface is keyed by binary alone; reusing it for a branch-scoped
    // score would clobber the default-branch scorecard. The user still
    // gets the scorecard inline in the response — they just can't bookmark
    // it. A branch-aware share URL is a future enhancement.
    if (input.branch) return null;
    const key = `${input.owner}/${input.repo}`;
    const hint = lookupOwnerRepo(hintsIndex.by_owner_repo, key);
    return hint?.binary ?? null;
  }
  // slug: registry-fast-path catches curated slugs into the `registry_hit`
  // branch (which uses scorecard_url, not share_url). A slug without a
  // curated scorecard isn't valid input — validateInput rejects it.
  return null;
}
