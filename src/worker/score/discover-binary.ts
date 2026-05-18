// Live GitHub URL discovery chain. Called by the Worker when registry
// lookup misses on a github-url input.
//
// Plan U4 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md
// lines 1104-1156, with F1 tightening per gate findings).
//
// Step 0.5 — discovery-hints lookup (defense in depth; the orchestrator's
//             registry-lookup also checks hints, but a future caller that
//             skips registry-lookup still gets the hint short-circuit).
// Step 2   — GitHub Releases API (linux-x86_64 asset).
// Step 3   — Parallel distribution lookup (brew/cargo/npm/pypi/go) with
//             per-registry repository-field match + bin-target check
//             per gate F1. Without these the chain produces wrong-answer
//             failures via cross-registry name collisions.
// Step 4   — README first-fenced-block install-command parse, with
//             package-name-matches-repo guard.
//
// Step 1 (direct binary URL) is intentionally not implemented: validate.ts
// only routes repo-root URLs into this module, never release-asset URLs.
// If a future input shape needs direct-URL paste, that's a validate.ts
// + this module change.

import type { ParsedInstall } from './parse-install';
import { parseInstallCommand } from './parse-install';
import type { DiscoveryHintsIndex } from './registry-lookup';

export type DirectInstall = { pm: 'direct'; url: string; binary: string };
export type InstallSpec = ParsedInstall | DirectInstall;

export type DiscoveryResult =
  | { ok: true; spec: InstallSpec; resolved_step: ResolvedStep }
  | { ok: false; error: 'chain_no_resolve'; exhausted: ExhaustedSteps };

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

const LINUX_X64_ASSET_RE =
  /(linux[-_]x86[-_]?64|x86[-_]64[-_]unknown[-_]linux|linux[-_]amd64|amd64[-_]linux|linux64|linux[-_]gnu|linux[-_]musl)/i;

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

  // Step 0.5 — hints
  const hint = lookupHint(ctx.hintsIndex, ownerRepo);
  if (hint) {
    return {
      ok: true,
      spec: { pm: hint.pm, package: hint.package, binary: hint.binary },
      resolved_step: '0.5-hints',
    };
  }

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

  // Step 2 — GitHub Releases asset
  const releases = await step2_releasesAsset(ctx, fetcher, deadline);
  if (releases.hit) {
    return {
      ok: true,
      spec: { pm: 'direct', url: releases.url, binary: ctx.repo },
      resolved_step: '2-releases-asset',
    };
  }

  // Step 3 — distributions (F1-tightened, parallel)
  const distributions = await step3_distributions(ctx, fetcher, deadline);
  if (distributions.hit) {
    return {
      ok: true,
      spec: { pm: distributions.pm, package: ctx.repo, binary: ctx.repo },
      resolved_step: distributions.step,
    };
  }

  // Step 4 — README parse
  const readme = await step4_readmeParse(ctx, fetcher, deadline);
  if (readme.hit) {
    return { ok: true, spec: readme.spec, resolved_step: '4-readme-parse' };
  }

  return {
    ok: false,
    error: 'chain_no_resolve',
    exhausted: {
      hints: { hit: false },
      releases: { hit: false, reason: releases.reason },
      distributions: { hit: false, per_registry: distributions.per_registry },
      readme: { hit: false, reason: readme.reason },
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
  const match = assets.find((a) => a.name && LINUX_X64_ASSET_RE.test(a.name));
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

  // Priority order: U6-supported PMs first (crates / npm / pypi / go),
  // brew last. Original plan said brew first, but the U6 install table
  // bounces brew as install_unsupported (Linuxbrew is non-viable on
  // musl, Finding F3). If a tool has both a brew formula AND a working
  // alternative (e.g. csvlens is in brew AND on crates.io), picking
  // brew sends the user to a guaranteed bounce when scoring was
  // possible. Brew is kept as the last resort so brew-only tools still
  // bounce honestly rather than degrading to chain_no_resolve and
  // hitting Step 4 README parse — the bounce message at least names
  // the brew formula. Bug J fix (2026-05-18).
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
      // Per plan: only the first non-comment line of each fenced block.
      break;
    }
  }
  return { hit: false, reason: 'no_install_block_matching_repo' };
}
