#!/usr/bin/env node
/**
 * Pre-Implementation Validation gate for the live-scoring plan
 * (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md, lines 782-819).
 *
 * Samples trending CLI repos per language, runs a paper version of the U4
 * 4-step discovery chain, classifies each as registry-fast-path-hit,
 * discovery-resolves-to-binary (with the resolving step), or
 * bounce-out-no-binary, and emits aggregate hit-rate stats.
 *
 * Local-only. Not deployed. Run via `bun scripts/measure-discovery-hit-rate.mjs`.
 * Results JSON lands at .context/discovery-hit-rate-results.json (gitignored).
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const LANGUAGES = [
  { gh: 'rust', label: 'Rust', quota: 13 },
  { gh: 'python', label: 'Python', quota: 12 },
  { gh: 'go', label: 'Go', quota: 13 },
  { gh: 'javascript', label: 'JavaScript', quota: 12 },
];

const UPDATED_SINCE = '2026-03-04'; // 60-day window relative to today (2026-05-04)
const SEARCH_LIMIT = 30; // per language; filtered down to quota
const HTTP_TIMEOUT_MS = 10_000;

// Asset-name patterns that indicate a Linux x86_64 prebuilt — broad enough to
// catch the common variants emitted by goreleaser, cargo-dist, and ad-hoc CI.
const LINUX_X64_ASSET_RE =
  /(linux[-_]x86[-_]?64|x86[-_]64[-_]unknown[-_]linux|linux[-_]amd64|amd64[-_]linux|linux64|linux[-_]gnu|linux[-_]musl)/i;

// Install-command shapes mirrored from U4's parse-install.ts table.
const INSTALL_CMD_RE =
  /^\s*\$?\s*(brew|cargo|bun|uv|pip|pip3|pipx|npm|yarn|pnpm|go)\s+(install|add|i|tool|global|binstall)/i;

function ghJSON(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

const USER_AGENT = 'anc-discovery-hit-rate-probe/1.0 (+https://anc.dev)';

async function timedFetch(url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function timedFetchJSON(url) {
  const r = await timedFetch(url);
  if (!r || !r.ok) return null;
  try {
    return await r.json();
  } catch {
    return null;
  }
}

async function timedFetchText(url) {
  const r = await timedFetch(url);
  if (!r || !r.ok) return null;
  try {
    return await r.text();
  } catch {
    return null;
  }
}

async function loadRegistry() {
  const text = await readFile(resolve(ROOT, 'registry.yaml'), 'utf8');
  const data = yaml.load(text);
  const byOwnerRepo = new Set();
  for (const tool of data.tools) {
    if (tool.repo) byOwnerRepo.add(tool.repo.toLowerCase());
  }
  return byOwnerRepo;
}

function searchTrendingCLI(language) {
  return ghJSON([
    'search',
    'repos',
    '--topic',
    'cli',
    '--language',
    language,
    '--sort',
    'stars',
    '--order',
    'desc',
    `--limit=${SEARCH_LIMIT}`,
    '--updated',
    `>=${UPDATED_SINCE}`,
    '--json',
    'fullName,description,stargazersCount,language,updatedAt,url',
  ]);
}

// ── Discovery chain (paper version of U4) ────────────────────────────────────

async function step2_releasesAsset(owner, repo) {
  // gh inherits OAuth — keeps us under the 5000/hr authenticated rate ceiling.
  const r = spawnSync('gh', ['api', `repos/${owner}/${repo}/releases/latest`, '-H', 'Accept: application/vnd.github+json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    // 404 = no releases. Treat as miss, not error.
    return { hit: false, reason: 'no_release_or_404' };
  }
  let release;
  try {
    release = JSON.parse(r.stdout);
  } catch {
    return { hit: false, reason: 'unparseable_release' };
  }
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const matches = assets.filter((a) => LINUX_X64_ASSET_RE.test(a.name || ''));
  if (matches.length > 0) {
    return { hit: true, asset: matches[0].name, url: matches[0].browser_download_url, asset_count: assets.length };
  }
  return { hit: false, reason: 'no_linux_x64_asset', asset_count: assets.length };
}

async function step3_distributions(owner, repo) {
  const lower = repo.toLowerCase();
  const ownerLower = owner.toLowerCase();
  const ownerRepo = `${ownerLower}/${lower}`;
  const matchesRepo = (s) => typeof s === 'string' && s.toLowerCase().includes(ownerRepo);

  const [brew, crates, npm, pypi, goRes] = await Promise.all([
    timedFetchJSON(`https://formulae.brew.sh/api/formula/${lower}.json`),
    timedFetchJSON(`https://crates.io/api/v1/crates/${lower}`),
    timedFetchJSON(`https://registry.npmjs.org/${lower}/latest`),
    timedFetchJSON(`https://pypi.org/pypi/${lower}/json`),
    timedFetch(`https://proxy.golang.org/${ownerLower}/${lower}/@latest`),
  ]);

  // brew — formula must point back at the same GitHub repo we started from.
  const brewLoose = !!brew;
  const brewHomepage = brew?.homepage;
  const brewSrc = brew?.urls?.stable?.url;
  const brewTight = brewLoose && (matchesRepo(brewHomepage) || matchesRepo(brewSrc));

  // crates — repository field must match AND latest version must declare bin_names.
  const cratesLoose = !!crates?.crate;
  let cratesTight = false;
  let cratesBinNames = null;
  if (cratesLoose && matchesRepo(crates.crate.repository)) {
    const maxVer = crates.crate.max_stable_version || crates.crate.max_version;
    if (maxVer) {
      const verData = await timedFetchJSON(`https://crates.io/api/v1/crates/${lower}/${maxVer}`);
      cratesBinNames = verData?.version?.bin_names || null;
      cratesTight = Array.isArray(cratesBinNames) && cratesBinNames.length > 0;
    }
  }

  // npm — package must declare a bin field AND repo URL must match.
  const npmHasBin = !!(npm?.bin && (typeof npm.bin === 'string' || Object.keys(npm.bin).length > 0));
  const npmLoose = npmHasBin;
  const npmRepoUrl = npm?.repository?.url || npm?.repository;
  const npmTight = npmLoose && matchesRepo(npmRepoUrl);

  // pypi — wheel must be present AND home_page or project_urls must match.
  const pypiLoose = !!pypi?.urls?.some((u) => u.packagetype === 'bdist_wheel');
  const pypiHomePage = pypi?.info?.home_page;
  const pypiProjectUrls = Object.values(pypi?.info?.project_urls || {});
  const pypiTight = pypiLoose && (matchesRepo(pypiHomePage) || pypiProjectUrls.some(matchesRepo));

  // go — proxy.golang.org is owner/repo-keyed by construction; loose==tight.
  const goLoose = !!(goRes && goRes.ok);
  const goTight = goLoose;

  // Tight result (production-realistic) — priority brew → crates → npm → pypi → go.
  const tightRegistry = brewTight
    ? 'brew'
    : cratesTight
      ? 'crates'
      : npmTight
        ? 'npm'
        : pypiTight
          ? 'pypi'
          : goTight
            ? 'go'
            : null;

  // Loose result (U4-spec-as-written) — same priority, only the 200 + has-bin/wheel checks.
  const looseRegistry = brewLoose
    ? 'brew'
    : cratesLoose
      ? 'crates'
      : npmLoose
        ? 'npm'
        : pypiLoose
          ? 'pypi'
          : goLoose
            ? 'go'
            : null;

  return {
    hit: tightRegistry !== null,
    registry: tightRegistry,
    loose_hit: looseRegistry !== null,
    loose_registry: looseRegistry,
    detail: {
      brew: { loose: brewLoose, tight: brewTight, homepage: brewHomepage, src: brewSrc },
      crates: {
        loose: cratesLoose,
        tight: cratesTight,
        repository: crates?.crate?.repository,
        bin_names: cratesBinNames,
      },
      npm: { loose: npmLoose, tight: npmTight, repository: npmRepoUrl, bin: npm?.bin },
      pypi: { loose: pypiLoose, tight: pypiTight, home_page: pypiHomePage, project_urls: pypi?.info?.project_urls },
      go: { loose: goLoose, tight: goTight },
    },
  };
}

async function step4_readmeParse(owner, repo) {
  const candidates = [
    `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`,
    `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`,
    `https://raw.githubusercontent.com/${owner}/${repo}/master/README.md`,
  ];
  let text = null;
  for (const url of candidates) {
    text = await timedFetchText(url);
    if (text) break;
  }
  if (!text) return { hit: false, reason: 'no_readme' };

  const fenceRe = /```(?:[\w-]+)?\n([\s\S]*?)\n```/g;
  const normalize = (s) => s.toLowerCase().replace(/_/g, '-');
  const repoNorm = normalize(repo);
  let m;
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
          return { hit: true, command: candidate };
        }
        return { hit: false, reason: 'install_command_name_mismatch', command: candidate, package: pkgRaw };
      }
      // Per U4 spec: only the first non-comment line of each fenced block.
      break;
    }
  }
  return { hit: false, reason: 'no_install_block' };
}

async function classifyRepo(fullName, registrySet) {
  const [owner, repo] = fullName.split('/');
  const result = { fullName, owner, repo };

  if (registrySet.has(fullName.toLowerCase())) {
    result.classification = 'registry-fast-path-hit';
    result.loose_classification = 'registry-fast-path-hit';
    return result;
  }

  // Run steps 2-4 unconditionally so we can capture both tight + loose
  // classifications without re-fetching.
  const s2 = await step2_releasesAsset(owner, repo);
  const s3 = await step3_distributions(owner, repo);
  const s4 = await step4_readmeParse(owner, repo);

  // Tight (production-realistic) classification — first hit wins.
  if (s2.hit) {
    result.classification = 'discovery-resolves-to-binary';
    result.resolved_step = '2-releases-asset';
    result.detail = s2;
  } else if (s3.hit) {
    result.classification = 'discovery-resolves-to-binary';
    result.resolved_step = `3-${s3.registry}`;
    result.detail = s3;
  } else if (s4.hit) {
    result.classification = 'discovery-resolves-to-binary';
    result.resolved_step = '4-readme-parse';
    result.detail = s4;
  } else {
    result.classification = 'bounce-out-no-binary';
    result.exhausted = { step2: s2, step3: s3, step4: s4 };
  }

  // Loose (U4-spec-as-written) classification — same chain but step 3 uses
  // looser predicates. Lets us quantify how much the spec needs tightening.
  if (s2.hit) {
    result.loose_classification = 'discovery-resolves-to-binary';
    result.loose_resolved_step = '2-releases-asset';
  } else if (s3.loose_hit) {
    result.loose_classification = 'discovery-resolves-to-binary';
    result.loose_resolved_step = `3-${s3.loose_registry}`;
  } else if (s4.hit) {
    result.loose_classification = 'discovery-resolves-to-binary';
    result.loose_resolved_step = '4-readme-parse';
  } else {
    result.loose_classification = 'bounce-out-no-binary';
  }

  return result;
}

// ── Orchestration ────────────────────────────────────────────────────────────

async function main() {
  console.log('Loading registry…');
  const registrySet = await loadRegistry();
  console.log(`  registry has ${registrySet.size} owner/repo entries\n`);

  console.log(`Searching trending CLI repos (topic:cli, updated >= ${UPDATED_SINCE})…`);
  const samples = [];
  for (const lang of LANGUAGES) {
    const hits = searchTrendingCLI(lang.gh);
    const filtered = hits.slice(0, lang.quota);
    console.log(`  ${lang.label.padEnd(12)} ${filtered.length}/${lang.quota} (raw ${hits.length})`);
    for (const r of filtered) {
      samples.push({
        language: lang.label,
        fullName: r.fullName,
        description: r.description,
        stars: r.stargazersCount,
        updatedAt: r.updatedAt,
      });
    }
  }
  console.log(`  → ${samples.length} samples total\n`);

  console.log('Classifying samples…');
  const results = [];
  for (const s of samples) {
    process.stdout.write(`  ${s.language.padEnd(12)} ${s.fullName.padEnd(50)} … `);
    try {
      const r = await classifyRepo(s.fullName, registrySet);
      results.push({ ...s, ...r });
      console.log(r.classification + (r.resolved_step ? ` [${r.resolved_step}]` : ''));
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      results.push({ ...s, classification: 'error', error: e.message });
    }
  }

  // ── Aggregate ──
  const summary = {
    total: results.length,
    tight: { by_class: {}, by_step: {} },
    loose: { by_class: {}, by_step: {} },
    by_language: {},
  };
  for (const r of results) {
    // Tight (production-realistic) tallies
    summary.tight.by_class[r.classification] = (summary.tight.by_class[r.classification] || 0) + 1;
    if (r.resolved_step) summary.tight.by_step[r.resolved_step] = (summary.tight.by_step[r.resolved_step] || 0) + 1;
    // Loose (U4-spec-as-written) tallies
    summary.loose.by_class[r.loose_classification] = (summary.loose.by_class[r.loose_classification] || 0) + 1;
    if (r.loose_resolved_step) {
      summary.loose.by_step[r.loose_resolved_step] = (summary.loose.by_step[r.loose_resolved_step] || 0) + 1;
    }
    // Per-language tally uses tight classification.
    summary.by_language[r.language] ??= { total: 0, registry: 0, discovery: 0, bounce: 0, error: 0 };
    const lang = summary.by_language[r.language];
    lang.total++;
    if (r.classification === 'registry-fast-path-hit') lang.registry++;
    else if (r.classification === 'discovery-resolves-to-binary') lang.discovery++;
    else if (r.classification === 'bounce-out-no-binary') lang.bounce++;
    else lang.error++;
  }

  function hitRate(byClass) {
    const errors = byClass.error || 0;
    const valid = summary.total - errors;
    const hits = (byClass['registry-fast-path-hit'] || 0) + (byClass['discovery-resolves-to-binary'] || 0);
    return valid > 0 ? Math.round((1000 * hits) / valid) / 10 : 0;
  }
  summary.tight.hit_rate_pct = hitRate(summary.tight.by_class);
  summary.loose.hit_rate_pct = hitRate(summary.loose.by_class);

  // Gate decision (uses tight rate — production-realistic).
  let gate;
  if (summary.tight.hit_rate_pct >= 70) gate = 'pass-ship-as-written';
  else if (summary.tight.hit_rate_pct >= 50) gate = 'pass-with-flag-bounce-cta-emphasis';
  else gate = 'fail-rework-required';
  summary.gate_decision = gate;

  console.log('\n=== Aggregate ===');
  console.log(JSON.stringify(summary, null, 2));

  // ── Persist ──
  const outDir = resolve(ROOT, '.context');
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, 'discovery-hit-rate-results.json');
  await writeFile(
    outPath,
    JSON.stringify(
      {
        methodology: {
          updated_since: UPDATED_SINCE,
          search_limit: SEARCH_LIMIT,
          languages: LANGUAGES,
          generated_at: new Date().toISOString(),
        },
        summary,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nResults: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
