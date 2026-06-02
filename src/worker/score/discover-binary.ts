// Live GitHub URL discovery chain. Called by the Worker when registry
// lookup misses on a github-url input.
//
// Step 0.5 — discovery-hints lookup (zero-cost, in-memory; runs first
//             so a hint hit short-circuits the network fan-out).
// Step 2   — GitHub Releases API (linux-x86_64 asset).
// Step 3   — Parallel distribution lookup (brew/cargo/npm/pypi/go) with
//             per-registry repository-field match + bin-target check.
//             Without these the chain produces wrong-answer failures via
//             cross-registry name collisions.
// Step 4   — README first-fenced-block install-command parse, with
//             package-name-matches-repo guard.
//
// Step 1 (direct binary URL) is intentionally not implemented: validate.ts
// only routes repo-root URLs into this module, never release-asset URLs.
// If a future input shape needs direct-URL paste, that's a validate.ts
// + this module change.
//
// Concurrency model (Fix 2): Steps 2, 3, and 4 fan out in parallel via
// Promise.allSettled. The wall-clock cost of one slow upstream (e.g.
// proxy.golang.org occasionally takes 3 s for a cache-cold lookup) no
// longer blocks the rest. After fan-in, a priority order
// (hint > release-asset > registry > README-parse) picks the winner.
// When MULTIPLE sources resolve, the higher-priority spec wins AND the
// disagreement surfaces as a `discovery_disagreement` event in the
// returned diagnostics — telemetry for cases where (e.g.) brew formula
// names binary X but the release artifact ships binary Y. Cross-source
// AGREEMENT is also surfaced as a `discovery_agreement` event so
// operations can spot high-confidence resolutions in the field. None of
// these events affect the API response shape; they're observability for
// future log queries / regression detection.
//
// Why parallel beats serial here: each upstream is a single round-trip
// against a public registry index (release API, brew formula JSON,
// crates.io crate JSON, npm registry, pypi JSON, go proxy, raw
// github.com README). Each is cheap on its own (~100-300 ms warm,
// occasionally up to 2 s). Serial fan-out makes the chain pay the sum
// of all the latencies for misses that should bounce in max(latencies).
// Parallel fan-out + priority pick also gives us cross-validation:
// when two sources concur, our confidence is higher; when they
// disagree, we'd rather see it in logs than silently degrade.

import type { ParsedInstall } from './parse-install';
import { parseInstallCommand } from './parse-install';
import type { DiscoveryHintsIndex } from './registry-lookup';

export type DirectInstall = { pm: 'direct'; url: string; binary: string };
// Branch-scoped source clone. When a user pastes a github URL with a
// `/tree/<branch>` path, the DO routes the request through this install
// spec instead of the discovery chain: discovery targets release
// artifacts (which are scored against the release, not a branch), so a
// branch-scoped paste needs the source at THAT branch. The orchestration
// in sandbox-exec.ts clones the repo at the specified branch with
// `--depth 1` (shallow) and runs `anc audit` against the cloned
// directory rather than `anc audit --command <binary>`.
export type GitCloneInstall = {
  pm: 'git-clone';
  owner: string;
  repo: string;
  branch: string;
  // The "binary" is the repo name by convention — used as the share-url
  // slug and the cache key. Branch-scoped scores skip the cache write
  // (handler.ts), so the binary here is purely a display label.
  binary: string;
};
export type InstallSpec = ParsedInstall | DirectInstall | GitCloneInstall;

export type DiscoveryResult =
  | { ok: true; spec: InstallSpec; resolved_step: ResolvedStep; diagnostics?: DiscoveryDiagnostics }
  | { ok: false; error: 'chain_no_resolve'; exhausted: ExhaustedSteps };

// Telemetry surface: agreement/disagreement across parallel-fan-out
// steps. Not user-visible; populated for Workers Logs aggregation so we
// can see when two registries disagree about a tool's install path.
// `winners` is the resolved step that won the priority pick. `losers`
// lists the steps that ALSO produced a hit but lost to priority.
// `agreed_binary` is true iff every winning + losing source picked the
// same install path (binary name match). False when (e.g.) brew formula
// `foo` resolves to a different artifact than the release tarball.
export type DiscoveryDiagnostics = {
  winner: ResolvedStep;
  losers: ResolvedStep[];
  agreed_binary: boolean;
};

export type ResolvedStep =
  | '0.5-hints'
  | '2-releases-asset'
  | '3-brew'
  | '3-crates'
  | '3-npm'
  | '3-pypi'
  | '3-go'
  | '4-readme-parse';

export type ExhaustedSteps = {
  hints: { hit: false };
  releases: { hit: false; reason: string };
  distributions: { hit: false; per_registry: Record<string, { loose: boolean; tight: boolean; reason?: string }> };
  readme: { hit: false; reason: string };
};

// Asset must satisfy BOTH conditions:
//   1. Linux + x86_64/amd64 — the loose substring match below excludes
//      aarch64 / armhf / i686 by REQUIRING an x86_64 / amd64 token AND a
//      linux marker in the same name. The legacy regex matched
//      `aarch64-unknown-linux-gnu` via the `linux-gnu` substring, which
//      cross-architected installs onto our x86_64 sandbox.
//   2. A real archive extension. .deb / .rpm / .sha256 / .pkg drop here
//      because directInstallCommand only knows how to extract tar/zip.
//      Before this filter, bat releases (which ship .deb files BEFORE
//      .tar.gz files in the asset list) resolved to a .deb and failed
//      with `gzip: stdin: not in gzip format`.
const LINUX_X64_ASSET_RE = /(?=.*(?:x86[-_]?64|amd64))(?=.*linux)/i;
const LINUX_X64_ARCHIVE_RE = /\.(?:tar\.gz|tar\.xz|tar\.bz2|tgz|txz|tbz2|zip)$/i;

const INSTALL_CMD_RE =
  /^\s*\$?\s*(brew|cargo|bun|uv|pip|pip3|pipx|npm|yarn|pnpm|go)\s+(install|add|i|tool|global|binstall)/i;

const STEP_TIMEOUT_MS = 2_000;
const TOTAL_TIMEOUT_MS = 8_000;
const USER_AGENT = 'anc-discovery/1.0 (+https://anc.dev)';

export type DiscoverContext = {
  owner: string;
  repo: string;
  hintsIndex: DiscoveryHintsIndex;
  // Injectable for tests; defaults to globalThis.fetch.
  fetcher?: typeof fetch;
  // Optional GitHub token for releases API to avoid 60/hr unauth limit.
  githubToken?: string;
};

export async function discoverBinary(ctx: DiscoverContext): Promise<DiscoveryResult> {
  const fetcher = ctx.fetcher ?? globalThis.fetch.bind(globalThis);
  const ownerRepo = `${ctx.owner}/${ctx.repo}`;

  // Step 0.5 — hints. Zero-cost, in-memory lookup. Runs synchronously
  // BEFORE the network fan-out so a hint hit short-circuits before we
  // pay for the parallel network round-trips.
  const hint = lookupHint(ctx.hintsIndex, ownerRepo);
  if (hint) {
    return {
      ok: true,
      spec: { pm: hint.pm, package: hint.package, binary: hint.binary },
      resolved_step: '0.5-hints',
    };
  }

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

  // Parallel fan-out (Fix 2): Steps 2, 3, 4 fire concurrently. Each
  // step carries its own internal timeout via the shared deadline so
  // one slow upstream can't blow the total budget. allSettled keeps
  // one step's rejection from cancelling the others.
  const [releasesResult, distributionsResult, readmeResult] = await Promise.allSettled([
    step2_releasesAsset(ctx, fetcher, deadline),
    step3_distributions(ctx, fetcher, deadline),
    step4_readmeParse(ctx, fetcher, deadline),
  ]);

  // Settled-to-value normalization. A rejected promise (network
  // exception we didn't catch internally) becomes a synthetic "miss"
  // so downstream priority logic doesn't have to wrangle the union
  // type discriminant from allSettled.
  const releases: Step2Hit | Step2Miss =
    releasesResult.status === 'fulfilled' ? releasesResult.value : { hit: false, reason: 'fetch_threw' };
  const distributions: Step3Hit | Step3Miss =
    distributionsResult.status === 'fulfilled' ? distributionsResult.value : { hit: false, per_registry: {} };
  const readme: Step4Hit | Step4Miss =
    readmeResult.status === 'fulfilled' ? readmeResult.value : { hit: false, reason: 'fetch_threw' };

  // Priority pick: release-asset > registry > README-parse. Collect
  // every winning + losing step into the diagnostics record so
  // disagreement is observable in logs without changing the API.
  type Candidate = { step: ResolvedStep; spec: InstallSpec; binaryName: string };
  const candidates: Candidate[] = [];
  if (releases.hit) {
    candidates.push({
      step: '2-releases-asset',
      // Binary name is the repo by default — Fix 1's auto-detect path
      // in directInstallCommand corrects it post-extract if the
      // archive ships a differently-named executable (gogcli → gog).
      spec: { pm: 'direct', url: releases.url, binary: ctx.repo },
      binaryName: ctx.repo,
    });
  }
  if (distributions.hit) {
    candidates.push({
      step: distributions.step,
      spec: { pm: distributions.pm, package: ctx.repo, binary: ctx.repo },
      binaryName: ctx.repo,
    });
  }
  if (readme.hit) {
    candidates.push({
      step: '4-readme-parse',
      spec: readme.spec,
      binaryName: readme.spec.binary,
    });
  }

  if (candidates.length > 0) {
    const winner = candidates[0];
    const losers = candidates.slice(1).map((c) => c.step);
    const agreed_binary = candidates.every((c) => c.binaryName === winner.binaryName);
    return {
      ok: true,
      spec: winner.spec,
      resolved_step: winner.step,
      diagnostics: { winner: winner.step, losers, agreed_binary },
    };
  }

  return {
    ok: false,
    error: 'chain_no_resolve',
    exhausted: {
      hints: { hit: false },
      releases: { hit: false, reason: releases.hit ? '' : (releases as Step2Miss).reason },
      distributions: {
        hit: false,
        per_registry: distributions.hit ? {} : (distributions as Step3Miss).per_registry,
      },
      readme: { hit: false, reason: readme.hit ? '' : (readme as Step4Miss).reason },
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────

function lookupHint(hintsIndex: DiscoveryHintsIndex, ownerRepo: string) {
  const direct = hintsIndex.by_owner_repo[ownerRepo];
  if (direct) return direct;
  const lower = ownerRepo.toLowerCase();
  for (const k of Object.keys(hintsIndex.by_owner_repo)) {
    if (k.toLowerCase() === lower) return hintsIndex.by_owner_repo[k];
  }
  return undefined;
}

async function timedFetch(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit & { timeoutMs?: number; deadline?: number } = {},
): Promise<Response | null> {
  const remaining = init.deadline ? init.deadline - Date.now() : STEP_TIMEOUT_MS;
  const timeout = Math.min(init.timeoutMs ?? STEP_TIMEOUT_MS, Math.max(remaining, 0));
  if (timeout <= 0) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetcher(url, {
      ...init,
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function timedFetchJSON<T = unknown>(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit & { deadline?: number } = {},
): Promise<T | null> {
  const r = await timedFetch(fetcher, url, init);
  if (!r?.ok) return null;
  try {
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function timedFetchText(fetcher: typeof fetch, url: string, deadline: number): Promise<string | null> {
  const r = await timedFetch(fetcher, url, { deadline });
  if (!r?.ok) return null;
  try {
    return await r.text();
  } catch {
    return null;
  }
}

// ── steps ───────────────────────────────────────────────────────────────

type Step2Hit = { hit: true; url: string };
type Step2Miss = { hit: false; reason: string };

async function step2_releasesAsset(
  ctx: DiscoverContext,
  fetcher: typeof fetch,
  deadline: number,
): Promise<Step2Hit | Step2Miss> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (ctx.githubToken) headers.Authorization = `Bearer ${ctx.githubToken}`;
  const release = await timedFetchJSON<{ assets?: Array<{ name?: string; browser_download_url?: string }> }>(
    fetcher,
    `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/releases/latest`,
    { deadline, headers },
  );
  if (!release) return { hit: false, reason: 'no_release_or_404' };
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const match = assets.find((a) => a.name && LINUX_X64_ASSET_RE.test(a.name) && LINUX_X64_ARCHIVE_RE.test(a.name));
  if (match?.browser_download_url) return { hit: true, url: match.browser_download_url };
  return { hit: false, reason: assets.length > 0 ? 'no_linux_x64_asset' : 'release_has_no_assets' };
}

type Step3Hit = {
  hit: true;
  pm: 'brew' | 'cargo-binstall' | 'npm' | 'pip' | 'go';
  step: ResolvedStep;
};
type Step3Miss = {
  hit: false;
  per_registry: Record<string, { loose: boolean; tight: boolean; reason?: string }>;
};

// F1-tightened: each registry requires repository-field match against the
// input GitHub repo (case-insensitive substring), AND where available a
// binary-target check (crates.io bin_names; npm bin field; pypi
// bdist_wheel + matching project URL; brew homepage/src URL).
async function step3_distributions(
  ctx: DiscoverContext,
  fetcher: typeof fetch,
  deadline: number,
): Promise<Step3Hit | Step3Miss> {
  const lower = ctx.repo.toLowerCase();
  const ownerLower = ctx.owner.toLowerCase();
  const ownerRepo = `${ownerLower}/${lower}`;
  const matchesRepo = (s: unknown): boolean => typeof s === 'string' && s.toLowerCase().includes(ownerRepo);

  const [brew, crates, npm, pypi, goRes] = await Promise.all([
    timedFetchJSON<{ homepage?: string; urls?: { stable?: { url?: string } } }>(
      fetcher,
      `https://formulae.brew.sh/api/formula/${lower}.json`,
      { deadline },
    ),
    timedFetchJSON<{
      crate?: { repository?: string; max_stable_version?: string; max_version?: string };
    }>(fetcher, `https://crates.io/api/v1/crates/${lower}`, { deadline }),
    timedFetchJSON<{ bin?: string | Record<string, string>; repository?: string | { url?: string } }>(
      fetcher,
      `https://registry.npmjs.org/${lower}/latest`,
      { deadline },
    ),
    timedFetchJSON<{
      info?: { home_page?: string | null; project_urls?: Record<string, string> | null };
      urls?: Array<{ packagetype?: string }>;
    }>(fetcher, `https://pypi.org/pypi/${lower}/json`, { deadline }),
    timedFetch(fetcher, `https://proxy.golang.org/${ownerLower}/${lower}/@latest`, { deadline }),
  ]);

  // brew — formula must point back at the same GitHub repo we started from.
  const brewLoose = !!brew;
  const brewHomepage = brew?.homepage;
  const brewSrc = brew?.urls?.stable?.url;
  const brewTight = brewLoose && (matchesRepo(brewHomepage) || matchesRepo(brewSrc));

  // crates — repository field match AND latest version declares bin_names.
  const cratesLoose = !!crates?.crate;
  let cratesTight = false;
  let cratesReason: string | undefined;
  if (cratesLoose && matchesRepo(crates.crate?.repository)) {
    const maxVer = crates.crate?.max_stable_version || crates.crate?.max_version;
    if (maxVer) {
      const verData = await timedFetchJSON<{ version?: { bin_names?: string[] | null } }>(
        fetcher,
        `https://crates.io/api/v1/crates/${lower}/${maxVer}`,
        { deadline },
      );
      const binNames = verData?.version?.bin_names;
      cratesTight = Array.isArray(binNames) && binNames.length > 0;
      if (!cratesTight) cratesReason = 'crate_is_library_only';
    } else {
      cratesReason = 'no_max_version';
    }
  } else if (cratesLoose) {
    cratesReason = 'crate_repository_does_not_match';
  }

  // npm — package must declare a bin field AND repo URL matches.
  const npmHasBin = !!(npm?.bin && (typeof npm.bin === 'string' || Object.keys(npm.bin).length > 0));
  const npmLoose = npmHasBin;
  const npmRepoUrl = typeof npm?.repository === 'string' ? npm.repository : npm?.repository?.url;
  const npmTight = npmLoose && matchesRepo(npmRepoUrl);

  // pypi — wheel exists AND home_page or project_urls matches.
  const pypiLoose = !!pypi?.urls?.some((u) => u.packagetype === 'bdist_wheel');
  const pypiHomePage = pypi?.info?.home_page ?? undefined;
  const pypiProjectUrls = Object.values(pypi?.info?.project_urls ?? {});
  const pypiTight = pypiLoose && (matchesRepo(pypiHomePage) || pypiProjectUrls.some(matchesRepo));

  // go — proxy.golang.org is owner/repo-keyed by construction.
  const goLoose = !!goRes?.ok;
  const goTight = goLoose;

  // Priority order: sandbox-installable PMs first (crates / npm / pypi /
  // go), brew last. Brew is unconditionally bounced as install_unsupported
  // inside the sandbox image (Linuxbrew is non-viable on musl). If a tool
  // has both a brew formula AND a working
  // alternative (e.g. csvlens is in brew AND on crates.io), picking
  // brew sends the user to a guaranteed bounce when scoring was
  // possible. Brew is kept as the last resort so brew-only tools still
  // bounce honestly rather than degrading to chain_no_resolve and
  // hitting Step 4 README parse — the bounce message at least names
  // the brew formula.
  if (cratesTight) return { hit: true, pm: 'cargo-binstall', step: '3-crates' };
  if (npmTight) return { hit: true, pm: 'npm', step: '3-npm' };
  if (pypiTight) return { hit: true, pm: 'pip', step: '3-pypi' };
  if (goTight) return { hit: true, pm: 'go', step: '3-go' };
  if (brewTight) return { hit: true, pm: 'brew', step: '3-brew' };

  return {
    hit: false,
    per_registry: {
      brew: { loose: brewLoose, tight: brewTight },
      crates: { loose: cratesLoose, tight: cratesTight, reason: cratesReason },
      npm: { loose: npmLoose, tight: npmTight },
      pypi: { loose: pypiLoose, tight: pypiTight },
      go: { loose: goLoose, tight: goTight },
    },
  };
}

type Step4Hit = { hit: true; spec: ParsedInstall };
type Step4Miss = { hit: false; reason: string };

async function step4_readmeParse(
  ctx: DiscoverContext,
  fetcher: typeof fetch,
  deadline: number,
): Promise<Step4Hit | Step4Miss> {
  const candidates = [
    `https://raw.githubusercontent.com/${ctx.owner}/${ctx.repo}/HEAD/README.md`,
    `https://raw.githubusercontent.com/${ctx.owner}/${ctx.repo}/main/README.md`,
    `https://raw.githubusercontent.com/${ctx.owner}/${ctx.repo}/master/README.md`,
  ];
  let text: string | null = null;
  for (const url of candidates) {
    text = await timedFetchText(fetcher, url, deadline);
    if (text) break;
  }
  if (!text) return { hit: false, reason: 'no_readme' };

  const fenceRe = /```(?:[\w-]+)?\n([\s\S]*?)\n```/g;
  const normalize = (s: string) => s.toLowerCase().replace(/_/g, '-');
  const repoNorm = normalize(ctx.repo);
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = fenceRe.exec(text)) !== null) {
    const lines = m[1].split(/\r?\n/);
    for (const rawLine of lines) {
      const stripped = rawLine.replace(/^\s*#.*/, '').trim();
      if (!stripped) continue;
      const candidate = stripped.replace(/^\$\s*/, '');
      if (INSTALL_CMD_RE.test(candidate)) {
        const tokens = candidate.split(/\s+/);
        const pkgRaw = tokens[tokens.length - 1].split(/[@:]/)[0];
        const pkgNorm = normalize(pkgRaw);
        if (pkgNorm.includes(repoNorm) || repoNorm.includes(pkgNorm)) {
          const parsed = parseInstallCommand(candidate);
          if (parsed.ok) return { hit: true, spec: parsed.value };
        }
      }
      // Only the first non-comment line of each fenced block — most
      // READMEs lead with the canonical install command and follow with
      // alternatives we'd otherwise mis-resolve to.
      break;
    }
  }
  return { hit: false, reason: 'no_install_block_matching_repo' };
}
