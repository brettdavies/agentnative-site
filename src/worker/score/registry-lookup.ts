// Registry + discovery-hints hit-test for the live-scoring path.
//
// Order matters: registry-fast-path > hint > miss. Committed scorecards
// always win over hints (avoids drift); hints always win over live
// discovery (we curated them because live discovery was wrong).
//
// Lookup is case-insensitive on owner/repo because GitHub URLs are
// case-preserving but case-insensitive at resolution. A user pasting
// `github.com/aider-ai/aider` should hit the `Aider-AI/aider` hint.
//
// `lookupScorecard()` is the async unified resolution that consults
// registry first and then falls through to the R2 cache when the binary
// is cheaply derivable. Both `curated` and `cached` results bypass the
// metered gates (Turnstile, rate-limit, DO) — cached scorecards
// are functionally identical to curated ones (no sandbox cost). The sync
// `lookupRegistry()` stays exported for callers that don't need the
// cache layer (registry-lookup tests, future callers that want just the
// registry tier).

import * as cache from './cache';
import type { InstallSpec } from './discover-binary';
import type { ParsedInstall } from './parse-install';
import type { ValidatedInput } from './validate';

// Public-facing slug shape for /score/live/<binary>. MUST stay in lockstep
// with summary-render.ts's BINARY_SLUG_RE — the handler validates here so a
// share_url it mints can never miss the route. Kept as a top-level const so
// the derivation site and the route share the same source of truth via the
// same regex literal (regex equality enforced by a unit test).
export const SHARE_URL_BINARY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type RegistryEntry = {
  name: string;
  binary: string;
  install: string;
  audit_profile?: string;
  repo?: string;
  // Present when the tool has a committed scorecard. The Worker uses
  // these to build the spec_version + anc_version + auditor_url triad
  // and route to /score/<slug> without fetching the scorecard JSON.
  // Tools without a scorecard ship the
  // metadata-only entry; the registry-fast-path treats them as a miss.
  version?: string;
  anc_version?: string;
  scorecard_url?: string;
  // score_pct surfaces into the registry_hit envelope so the homepage
  // form can show a curated-tool reward (e.g., "Curated · 92% pass rate
  // · Opening the audited scorecard…") inline before redirect, without
  // a second round-trip to fetch the scorecard JSON.
  score_pct?: number;
};

export type RegistryIndex = {
  by_slug: Record<string, RegistryEntry>;
  by_owner_repo: Record<string, RegistryEntry>;
};

// Module-scope promise cache. Workers re-instantiate isolates frequently
// so the staleness window is bounded; the singleton avoids re-parsing the
// JSON on every request inside the same isolate. Shared with handler.ts
// (was duplicated there) so /api/score and /score/live/<binary> read from
// the same in-memory copy.
let registryIndexPromise: Promise<RegistryIndex> | null = null;

type AssetEnv = { ASSETS: Fetcher };

/**
 * Fetch + cache `/registry-index.json` for the lifetime of the isolate.
 * Resets to null on fetch failure so the next request retries.
 */
export function loadRegistryIndex(env: AssetEnv): Promise<RegistryIndex> {
  if (!registryIndexPromise) {
    registryIndexPromise = (async () => {
      const res = await env.ASSETS.fetch(new Request('https://assets.internal/registry-index.json'));
      if (!res.ok) throw new Error(`registry-index fetch failed (status ${res.status})`);
      return (await res.json()) as RegistryIndex;
    })().catch((err) => {
      registryIndexPromise = null;
      throw err;
    });
  }
  return registryIndexPromise;
}

/** Test-only — drop the cached registry-index promise. */
export function _resetRegistryIndexCache(): void {
  registryIndexPromise = null;
}

/**
 * Map a binary slug to its canonical registry name, or null when no
 * curated entry matches. Tries the fast `by_slug[binary]` path first
 * (catches tools where binary === name, the common case), then scans
 * for tools where the registry-entry's `binary` field matches (handles
 * ripgrep/rg, ast-grep/sg, bottom/btm, and similar alias cases).
 *
 * Used by /score/live/<binary> to refuse rendering at the live path
 * when the binary maps to a registry-curated tool — that tool has a
 * canonical /score/<slug> page, which is what the user should see.
 */
export function resolveCuratedSlug(binary: string, registryIndex: RegistryIndex): string | null {
  const direct = registryIndex.by_slug[binary];
  if (direct) return direct.name;
  for (const entry of Object.values(registryIndex.by_slug)) {
    if (entry.binary === binary) return entry.name;
  }
  return null;
}

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
// Unified scorecard lookup
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
  // Build-time spec version, used as the partition slot in the cache key.
  // All readers and writers must pass the same value to avoid key drift.
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
 * compute the `share_url` (`/score/live/<binary>`) for cached + live
 * inline-scorecard responses BEFORE discovery has run. Same logic as the
 * internal cache-tier derivation, exported so the handler can reuse it
 * without re-running a full lookup. Returns null when no binary is
 * derivable upfront (github-url without a hint, or branch-scoped paste).
 *
 * For paths where discovery HAS resolved the spec (live success + cache_post
 * hit), the handler uses `deriveShareBinaryFromSpec()` instead, which can
 * surface the discovered binary even when no hint matched upfront.
 *
 * Both helpers gate on `SHARE_URL_BINARY_RE` so a share_url the handler
 * mints can never miss the /score/live/<binary> route.
 */
export function deriveShareBinary(input: ValidatedInput, hintsIndex: DiscoveryHintsIndex): string | null {
  if (input.kind === 'install-command') return safeShareBinary(input.spec.binary);
  if (input.kind === 'github-url') {
    // Branch-scoped pastes don't get a share URL. The /score/live/<binary>
    // surface is keyed by binary alone; reusing it for a branch-scoped
    // score would clobber the default-branch scorecard. The user still
    // gets the scorecard inline in the response — they just can't bookmark
    // it. A branch-aware share URL is a future enhancement.
    if (input.branch) return null;
    const key = `${input.owner}/${input.repo}`;
    const hint = lookupOwnerRepo(hintsIndex.by_owner_repo, key);
    return safeShareBinary(hint?.binary);
  }
  // slug: registry-fast-path catches curated slugs into the `registry_hit`
  // branch (which uses scorecard_url, not share_url). A slug without a
  // curated scorecard isn't valid input — validateInput rejects it.
  return null;
}

/**
 * Post-discovery share-URL derivation. Called by the handler on the live
 * success branch and the post-discovery cache-hit branch (step 6.5), when
 * `resolveSpec()` has produced an `InstallSpec` whose `binary` is the same
 * value the DO writes the R2 cache under and the /score/live/<binary>
 * route reads from.
 *
 * Branch-scoped scores (pm='git-clone') stay null — their cache write is
 * skipped (handler.ts step 6.5 + do.ts), so the share surface has nothing
 * to point at and reusing the bare-binary key would clobber the
 * default-branch scorecard.
 *
 * The binary is validated against `SHARE_URL_BINARY_RE` before being
 * folded into a URL. Discovery's `ctx.repo` passes through to spec.binary
 * for most github-url paths, and GitHub repo names can legally contain
 * characters the slug regex rejects (uppercase, `_`, `.`). The cache write
 * itself uses spec.binary unmodified — a future re-paste still benefits
 * from the cache via the binary key, but the public share surface only
 * exposes binaries the route can serve.
 */
export function deriveShareBinaryFromSpec(spec: InstallSpec): string | null {
  if (spec.pm === 'git-clone') return null;
  return safeShareBinary(spec.binary);
}

function safeShareBinary(binary: string | undefined | null): string | null {
  if (!binary) return null;
  return SHARE_URL_BINARY_RE.test(binary) ? binary : null;
}
