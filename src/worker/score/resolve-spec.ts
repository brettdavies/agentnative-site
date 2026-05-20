// Resolution layer: turn a `ValidatedInput` into an `InstallSpec` the
// sandbox can act on. Lives in the Worker tier (NOT the DO) so that
// requests which fail to resolve a spec (`chain_no_resolve`) bounce
// without spinning up a container — same answer, no DO compute billed.
// Pre-2026-05-20 this lived inside the DO's `resolveSpec()`; the move
// keeps the DO's surface tightly scoped to "given a spec, install +
// score" and collapses the duplicate `loadHintsIndex` that used to fan
// out across both tiers.
//
// What this module owns:
//
//   - Install-command inputs with pm=brew → `resolveBrewFallback`:
//     fetch formula metadata, find the GitHub homepage, hand off to
//     `discoverBinary`, accept any non-brew resolution. Linuxbrew on
//     the sandbox image is too slow for the 60 s budget; treating
//     `brew install <pkg>` as a hint for "find me an alternative PM"
//     is the workaround the 2026-05-18 image rework formalized.
//   - Install-command inputs with pm=go → `resolveGoFallback`: the
//     parallel rework for `go install <module>@latest`. The sandbox
//     ships no Go toolchain by design (binary-only premise), so a Go
//     module path that resolves to a GitHub repo gets redirected
//     through the discovery chain in search of a release binary.
//   - GitHub-URL inputs WITHOUT a branch → run the full discovery chain.
//   - GitHub-URL inputs WITH a branch → bypass discovery (release
//     artifacts aren't the right scoring target for an arbitrary ref)
//     and synthesize a `git-clone` spec. Branch name re-validated here
//     even though validate.ts already did so at the Worker boundary —
//     defense in depth so a future caller that bypasses validate.ts
//     can't smuggle shell metacharacters through.
//   - install-command inputs for any other PM → pass-through.
//   - slug inputs that didn't hit the registry tier → `chain_no_resolve`
//     (live-scoring bare slugs is deferred).
//
// Trust boundary: this module produces an `InstallSpec`. The DO's
// sandbox-exec layer shell-quotes every value it interpolates from the
// spec, so the move from "DO does discovery" to "Worker does discovery"
// doesn't change the input-sanitization story. The user-pasted string
// is still validated by validate.ts at the Worker boundary; what flows
// across the DO request boundary now is a typed, narrowed InstallSpec
// rather than a raw `ValidatedInput`.

import { discoverBinary, type InstallSpec } from './discover-binary';
import type { DiscoveryHintsIndex } from './registry-lookup';
import { type ValidatedInput, validBranchName } from './validate';

export type ResolveResult =
  | { ok: true; spec: InstallSpec }
  | { ok: false; error: 'chain_no_resolve' | 'install_unsupported' | 'invalid_url_path'; details?: string };

export type BrewFallbackResult =
  | { ok: true; value: InstallSpec }
  | { ok: false; error: 'install_unsupported'; details: 'pm=brew_only' };

export type GoFallbackResult =
  | { ok: true; value: InstallSpec }
  | { ok: false; error: 'install_unsupported'; details: 'pm=go_no_binary' };

export type ResolveOptions = {
  // Injectable for tests; defaults to globalThis.fetch. Threaded through
  // the brew/go fallbacks and the discovery chain so a single override
  // covers every outbound call this module makes.
  fetcher?: typeof fetch;
};

/**
 * Resolve a validated user input into an InstallSpec. The Worker calls
 * this AFTER the cache + accessibility tiers; the DO never sees a
 * `ValidatedInput` after the 2026-05-20 move, only the InstallSpec
 * produced here.
 */
export async function resolveSpec(
  input: ValidatedInput,
  hintsIndex: DiscoveryHintsIndex,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  if (input.kind === 'install-command') {
    if (input.spec.pm === 'brew') {
      const result = await resolveBrewFallback(input.spec.package, hintsIndex, opts.fetcher);
      return result.ok ? { ok: true, spec: result.value } : { ok: false, error: result.error, details: result.details };
    }
    if (input.spec.pm === 'go') {
      const result = await resolveGoFallback(input.spec.package, hintsIndex, opts.fetcher);
      return result.ok ? { ok: true, spec: result.value } : { ok: false, error: result.error, details: result.details };
    }
    return { ok: true, spec: input.spec };
  }
  if (input.kind === 'github-url') {
    // Branch-scoped paste: skip discovery entirely. Release artifacts
    // are scored against a release, not against an arbitrary ref, so a
    // branch-scoped paste needs the source at THAT branch. validBranchName
    // is checked at validate.ts at the Worker boundary; the re-check
    // here is defense in depth for any future caller that constructs a
    // github-url ValidatedInput directly without re-running validate.ts.
    if (typeof input.branch === 'string') {
      if (!validBranchName(input.branch)) {
        return { ok: false, error: 'invalid_url_path' };
      }
      const spec: InstallSpec = {
        pm: 'git-clone',
        owner: input.owner,
        repo: input.repo,
        branch: input.branch,
        binary: input.repo,
      };
      return { ok: true, spec };
    }
    const result = await discoverBinary({
      owner: input.owner,
      repo: input.repo,
      hintsIndex,
      fetcher: opts.fetcher,
    });
    if (result.ok) return { ok: true, spec: result.spec };
    return { ok: false, error: result.error };
  }
  // slug input that didn't hit the registry tier: we don't live-score
  // bare slugs (deferred). Same error code GET requests use so the
  // front-end renders the same CTA panel.
  return { ok: false, error: 'chain_no_resolve' };
}

// ---------------------------------------------------------------------------
// Brew discovery-fallback
//
// `brew install <pkg>` user input is translated to an alternative PM
// via the discovery chain. brew_only bounces happen when:
//   - the formula isn't on formulae.brew.sh (404 or fetch error), OR
//   - the formula's homepage isn't a github.com URL, OR
//   - the discovery chain misses every distribution OR loops back to
//     brew (the chain's brew-last priority should prevent the loop,
//     but the guard catches a regression there).
//
// Fetcher injection lets tests pin behavior without touching
// globalThis.fetch.
// ---------------------------------------------------------------------------

export async function resolveBrewFallback(
  pkg: string,
  hintsIndex: DiscoveryHintsIndex,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<BrewFallbackResult> {
  const formula = await fetchBrewFormula(pkg, fetcher);
  if (!formula) {
    return { ok: false, error: 'install_unsupported', details: 'pm=brew_only' };
  }
  const ownerRepo = parseGithubOwnerRepo(formula.homepage);
  if (!ownerRepo) {
    return { ok: false, error: 'install_unsupported', details: 'pm=brew_only' };
  }
  const result = await discoverBinary({
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    hintsIndex,
    fetcher,
  });
  if (result.ok && result.spec.pm !== 'brew') {
    return { ok: true, value: result.spec };
  }
  return { ok: false, error: 'install_unsupported', details: 'pm=brew_only' };
}

// ---------------------------------------------------------------------------
// Go discovery-fallback
//
// `go install <module>@latest` is source-compilation by design — Go
// modules don't ship binaries. Running it on the sandbox would either
// require a Go toolchain capable of compiling within the 60 s budget
// (impossible on CF Containers basic — see 2026-05-18 staging matrix)
// OR violate U2's binary-only premise. We redirect through the
// discovery chain: a module path of the form
// `github.com/<owner>/<repo>/...` is treated as a GitHub-URL input,
// and discoverBinary picks the GitHub Releases asset (Step 2) for
// tools that ship binaries (glow, lazygit, gh, fzf, etc.). Modules
// outside github.com OR github.com repos without release binaries
// bounce as install_unsupported pm=go_no_binary — fast-fail UX rather
// than a long compile that times out.
// ---------------------------------------------------------------------------

export async function resolveGoFallback(
  modulePath: string,
  hintsIndex: DiscoveryHintsIndex,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<GoFallbackResult> {
  const ownerRepo = parseGoModuleOwnerRepo(modulePath);
  if (!ownerRepo) {
    return { ok: false, error: 'install_unsupported', details: 'pm=go_no_binary' };
  }
  const result = await discoverBinary({
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    hintsIndex,
    fetcher,
  });
  // Only accept a `direct` resolution (Step 2 GitHub Releases asset)
  // or a non-go cross-PM resolution. If discovery looped back to
  // `go` somehow (shouldn't — Step 3 picks brew last among PMs,
  // and Step 4 README parse won't return pm=go for a `go install`
  // input), bounce honestly to avoid infinite indirection.
  if (result.ok && result.spec.pm !== 'go') {
    return { ok: true, value: result.spec };
  }
  return { ok: false, error: 'install_unsupported', details: 'pm=go_no_binary' };
}

// Parse a Go module path of the form `github.com/<owner>/<repo>[/...]`
// into { owner, repo }. Subpath segments (e.g. `cmd/humanize`) are
// stripped — the GitHub release for the repo applies, regardless of
// which subpackage the module declares. Returns null for non-github
// module paths (rsc.io/quote, golang.org/x/..., etc.) — those have no
// GitHub release equivalent and bounce as go_no_binary.
function parseGoModuleOwnerRepo(modulePath: string): { owner: string; repo: string } | null {
  // Strip any @ version suffix the parser might have left in place,
  // defensively (parse-install already does this, but the fallback
  // shouldn't depend on the caller's hygiene).
  const cleaned = modulePath.split('@')[0];
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length < 3) return null;
  if (segments[0] !== 'github.com') return null;
  const owner = segments[1];
  const repo = segments[2];
  if (!owner || !repo) return null;
  return { owner, repo };
}

// ---------------------------------------------------------------------------
// Brew formula fetcher (discovery-fallback support)
// ---------------------------------------------------------------------------

type BrewFormulaShape = {
  homepage?: string;
};

// Short 2 s timeout: discovery already runs against 5+ registries with
// their own deadlines; stacking another long timeout here would hurt
// the worst-case latency more than the bounce itself.
async function fetchBrewFormula(pkg: string, fetcher: typeof fetch): Promise<BrewFormulaShape | null> {
  const url = `https://formulae.brew.sh/api/formula/${encodeURIComponent(pkg.toLowerCase())}.json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2_000);
  try {
    const res = await fetcher(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'anc-discovery/1.0 (+https://anc.dev)' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as BrewFormulaShape;
    return data ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Mirrors validate.ts's GITHUB_URL_RE shape so the same repo-root
// constraints apply — `tree/branch` paths in a formula's homepage
// field don't drift into resolveSpec.
export function parseGithubOwnerRepo(url: string | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'github.com') return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, '');
  if (!owner || !repo) return null;
  return { owner, repo };
}
