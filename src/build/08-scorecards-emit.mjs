// Scorecard-surface emit. Section 8 of the build pipeline.
//
// Owns the entire scorecard + coverage + skill emit pipeline:
//   - Registry loading + corpus invariants
//   - Build-time indexes for the live-scoring path (registry-index.json,
//     discovery-hints-index.json)
//   - Leaderboard page (dist/scorecards.html + .md)
//   - Per-tool scorecard pages (dist/score/<name>.{html,md,json}); the JSON
//     is the committed scorecard wrapped in the shared result envelope
//   - Badge SVGs (dist/badge/<name>.svg)
//   - Stale-file reaping for removed registry entries
//   - Coverage matrix page (dist/coverage.{html,md})
//   - Skill manifest surfaces (dist/skill.json + dist/skill.{html,md})
//
// Returns the data downstream needs: leaderboard (for llms-full + sitemap
// extra paths), scorecardPaths (for sitemap), coverageMarkdown and skill
// artifacts (for llms-full).

import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRegistryEnvelope } from '../shared/audit-envelope';
import { scoreMarkdownPath, scorePath } from '../shared/audit-routes';
import { resultAlternateLinks } from '../shared/result-head';
import { CANONICAL_SITE_URL } from '../shared/site-url';
import { renderBadgeSvg } from './badge.mjs';
import { buildCoverageBody, buildCoverageMarkdown, loadCoverageMatrix } from './coverage.mjs';
import { emitBuildIndexes } from './registry-index.mjs';
import {
  computeLeaderboard,
  extractTopIssues,
  loadRegistry,
  loadScoredTools,
  runScorecardInvariants,
} from './scorecards.mjs';
import {
  buildLeaderboardBody,
  buildLeaderboardMarkdown,
  buildScorecardBody,
  buildScorecardMarkdown,
} from './scorecards-render.mjs';
import { emitShell } from './shell.mjs';
import { emitSkillJson, emitSkillMarkdown, loadSkillData, renderSkillPage } from './skill.mjs';
import { absolutifyMarkdownLinks } from './util.mjs';

/** The per-tool files this emit owns under dist/score/, keyed by slug; anything else there is left alone. */
export const REAPABLE_SCORE_FILE_RE = /^([a-z0-9-]+)\.(html|md|json)$/;

/**
 * The scored-build projection of one curated tool. The registry index
 * carries it so /api/score can answer a registry hit (spec_version +
 * anc_version + auditor_url, plus the score for the homepage form's
 * inline "Curated · N%" reward) without fetching the scorecard, and the
 * curated JSON envelope wraps the same object, so the two surfaces
 * cannot disagree about the URL, score, or versions.
 *
 * @param {object} args
 * @param {{ name: string, binary: string }} args.tool
 * @param {{ badge: { score_pct: number } }} args.scorecard
 * @param {string=} args.ancVersion — the anc release that produced the scorecard.
 * @param {string=} args.version — the tool version that was scored.
 * @returns {import('../shared/audit-envelope').RegistryEntryLike}
 */
export function curatedRegistryEntry({ tool, scorecard, ancVersion, version }) {
  const entry = {
    name: tool.name,
    binary: tool.binary,
    scorecard_url: scorePath(tool.name),
    score_pct: scorecard.badge.score_pct,
    version,
  };
  if (ancVersion) entry.anc_version = ancVersion;
  return entry;
}

/**
 * The envelope served as a curated tool's JSON representation: the
 * committed scorecard wrapped at build time so the read tools can serve
 * it through the assets binding as-is.
 *
 * @param {{ name: string, binary: string }} tool
 * @param {{ spec_version: string, badge: { score_pct: number } }} scorecard
 * @param {string=} ancVersion
 * @param {string=} version
 * @returns {import('../shared/audit-envelope').AuditEnvelope}
 */
export function curatedResultEnvelope(tool, scorecard, ancVersion, version) {
  return buildRegistryEnvelope({
    entry: curatedRegistryEntry({ tool, scorecard, ancVersion, version }),
    origin: CANONICAL_SITE_URL,
    specVersion: scorecard.spec_version,
    scorecard,
  });
}

/**
 * Emit the leaderboard, per-tool scorecards + badges, coverage page, and
 * skill manifest surfaces. Returns the data downstream (sitemap, llms)
 * needs.
 *
 * @param {object} args
 * @param {string} args.distDir
 * @param {string} args.registryPath
 * @param {string} args.hintsPath
 * @param {string} args.coverageMatrixPath
 * @param {string} args.skillDataPath
 * @param {string} args.scorecardsDir
 * @param {string} args.themeInit
 * @returns {Promise<{
 *   leaderboard: Array<object>,
 *   scorecardPaths: string[],
 *   badgePaths: string[],
 *   coverageMarkdown: string,
 *   skillData: object,
 *   skillMarkdown: string,
 * }>}
 */
export async function emitScorecardSurface({
  distDir,
  registryPath,
  hintsPath,
  coverageMatrixPath,
  skillDataPath,
  scorecardsDir,
  themeInit,
}) {
  const registry = await loadRegistry(registryPath);

  // v0.4 corpus invariants run before rendering: any scorecard below the
  // schema floor, missing a registry entry, scoring the wrong binary, or
  // carrying a non-RFC-3339 timestamp aborts the build before producing
  // bad output.
  await runScorecardInvariants(scorecardsDir, registry);
  // Scorecard-driven discovery + registry editorial join. Both directions
  // of mismatch are warnings, not errors: a scorecard with no registry
  // entry → excluded; a registry entry with no scorecard → excluded. The
  // build emits a stable WARNINGS_JSON line so CI can parse it into a
  // PR-comment annotation.
  const { tools: toolsWithScorecards, warnings: scorecardWarnings } = await loadScoredTools(scorecardsDir, registry);
  for (const filename of scorecardWarnings.scorecardOrphans) {
    console.warn(`warning: scorecard ${filename} has no matching registry entry — excluded from leaderboard.`);
  }
  for (const name of scorecardWarnings.registryOrphans) {
    console.warn(`warning: registry entry "${name}" has no matching scorecard — excluded from leaderboard.`);
  }
  console.log(`WARNINGS_JSON: ${JSON.stringify(scorecardWarnings)}`);

  // 8a. Build-time indexes for the live-scoring path:
  //     - dist/registry-index.json (powers /api/score registry-fast-path)
  //     - dist/discovery-hints-index.json (powers discovery's hint
  //       short-circuit)
  //
  // Each registry-index entry is augmented with the latest scorecard's
  // version, the anc binary version that produced it, and the public URL
  // of the per-tool scorecard page, so /api/score can return the
  // spec_version + anc_version + auditor_url triad without fetching the
  // full scorecard payload.
  const enrichments = {};
  for (const t of toolsWithScorecards) {
    enrichments[t.tool.name] = curatedRegistryEntry({
      tool: t.tool,
      scorecard: t.scorecard,
      ancVersion: t.metadata?.anc?.version,
      version: t.version,
    });
  }
  const { warnings: indexWarnings } = await emitBuildIndexes({
    registry,
    hintsPath,
    distDir,
    enrichments,
  });
  for (const w of indexWarnings) console.warn(`warning: ${w}`);
  const leaderboard = computeLeaderboard(toolsWithScorecards);

  const methodologyHtml = `  <p>Every score is the output of <code>anc audit &lt;binary&gt;</code> against a real CLI tool.
  The <strong>score</strong> column is the behavioral-layer compliance score: requirement checks,
  credit-weighted by outcome (a met requirement counts full, a missed SHOULD or MAY counts half);
  the <strong>principles met</strong> column counts how many of the eight principles have every
  check passing. The <strong>audience</strong> classification — when present — is informational,
  not authoritative; the per-tool page's evidence list is the ground truth.</p>
  <p>For the full explanation of scoring, audience classification, audit profiles, and how to
  request a re-score, see the <a href="/methodology">methodology page</a>.</p>
  <p>To reproduce any row locally, <a href="/install">install <code>anc</code></a> and run
  <code>anc audit &lt;binary&gt;</code>.</p>`;

  const leaderboardBody = buildLeaderboardBody(leaderboard, methodologyHtml);
  await writeFile(
    join(distDir, 'scorecards.html'),
    emitShell({
      title: 'ANC 100 — Agent-Native CLI Leaderboard',
      description:
        'Automated agent-readiness scores for real CLI tools, scored against the seven agent-native principles.',
      canonicalPath: '/scorecards',
      bodyHtml: leaderboardBody,
      themeInitJs: themeInit,
      extraScripts: ['/js/leaderboard.js'],
    }),
  );
  await writeFile(join(distDir, 'scorecards.md'), absolutifyMarkdownLinks(buildLeaderboardMarkdown(leaderboard)));

  // Per-tool scorecard pages → dist/score/<tool-name>.html + .md + .json
  // Badge SVGs               → dist/badge/<tool-name>.svg
  // A binary alias (/score/rg) is a Worker redirect to the canonical slug;
  // nothing is emitted under the alias, for any representation.
  await mkdir(join(distDir, 'score'), { recursive: true });
  await mkdir(join(distDir, 'badge'), { recursive: true });
  // Drop stale per-tool files and badge SVGs from prior builds, so a tool
  // removed from the registry does not linger in dist/ as a broken page,
  // twin, JSON body, or orphaned badge the leaderboard no longer knows
  // about. Only canonical slugs are expected: an alias file from an
  // earlier build is stale by definition and is reaped here.
  const expectedNames = new Set(leaderboard.map((e) => e.tool.name));
  for (const file of await readdir(join(distDir, 'score')).catch(() => [])) {
    const m = file.match(REAPABLE_SCORE_FILE_RE);
    if (m && !expectedNames.has(m[1])) {
      await unlink(join(distDir, 'score', file));
    }
  }
  // Badge SVGs are emitted for the canonical name only (no binary-slug
  // SVG). A reader following /score/rg → /score/ripgrep ends up on the
  // canonical page, where /badge/ripgrep.svg renders correctly.
  for (const file of await readdir(join(distDir, 'badge')).catch(() => [])) {
    const m = file.match(/^([a-z0-9-]+)\.svg$/);
    if (m && !expectedNames.has(m[1])) {
      await unlink(join(distDir, 'badge', file));
    }
  }
  const scorecardPaths = [];
  const badgePaths = [];
  for (const entry of leaderboard) {
    const { tool, scorecard, principleScore, version, metadata } = entry;
    const topIssues = extractTopIssues(scorecard);

    const scorecardBody = buildScorecardBody(tool, scorecard, topIssues, principleScore, version, metadata);
    const canonicalPath = scorePath(tool.name);
    await writeFile(
      join(distDir, 'score', `${tool.name}.html`),
      emitShell({
        title: `${tool.name} — Agent-Native Scorecard`,
        description: `Agent-readiness scorecard for ${tool.name}: ${tool.description}`,
        canonicalPath,
        markdownTwinPath: scoreMarkdownPath(tool.name),
        alternatesHtml: resultAlternateLinks(tool.name),
        bodyHtml: scorecardBody,
        themeInitJs: themeInit,
      }),
    );
    await writeFile(
      join(distDir, 'score', `${tool.name}.md`),
      absolutifyMarkdownLinks(buildScorecardMarkdown(tool, scorecard, topIssues, principleScore, version, metadata)),
    );
    await writeFile(
      join(distDir, 'score', `${tool.name}.json`),
      `${JSON.stringify(curatedResultEnvelope(tool, scorecard, metadata?.anc?.version, version), null, 2)}\n`,
    );
    scorecardPaths.push(canonicalPath);

    // Badge SVG — emitted for every scored tool, even those below the
    // eligibility floor. The /score/<tool> page gates the embed snippet
    // (above-floor only); the SVG itself stays available so a tool's
    // existing embed continues to render the current score after a
    // regression. Score derived from schema 0.5 `badge.score_pct` (0–100
    // int) → 0–1 for badge-maker's color thresholds.
    // spec_version is per-scorecard (the spec the CLI was compiled against
    // when it produced this scorecard) — pass it explicitly so the badge
    // label tracks the actual scoring context, not a global default.
    const svg = renderBadgeSvg(scorecard.badge.score_pct / 100, scorecard.spec_version);
    await writeFile(join(distDir, 'badge', `${tool.name}.svg`), svg);
    badgePaths.push(`/badge/${tool.name}.svg`);
  }

  // 8b. Coverage matrix page — /coverage.
  const coverageMatrix = await loadCoverageMatrix(coverageMatrixPath);
  const coverageBody = buildCoverageBody(coverageMatrix);
  const coverageMarkdown = buildCoverageMarkdown(coverageMatrix);
  await writeFile(
    join(distDir, 'coverage.html'),
    emitShell({
      title: 'Spec Coverage Matrix — anc.dev',
      description: 'Which agent-native CLI requirements have automated audits and which remain uncovered.',
      canonicalPath: '/coverage',
      bodyHtml: `<article class="container doc">${coverageBody}</article>`,
      themeInitJs: themeInit,
    }),
  );
  await writeFile(join(distDir, 'coverage.md'), absolutifyMarkdownLinks(coverageMarkdown));

  // 8c. /skill.json + /skill + /skill.md — skill-distribution surface.
  // The same manifest is emitted as canonical JSON, rendered HTML (via the
  // shared unified pipeline), and a markdown twin. Drift is structurally
  // impossible because all three derive from the same data file.
  const skillData = await loadSkillData(skillDataPath);
  await emitSkillJson(skillData, distDir);
  const { markdown: skillMarkdown, html: skillBodyHtml } = await renderSkillPage(skillData);
  await writeFile(
    join(distDir, 'skill.html'),
    emitShell({
      title: `Install ${skillData.name}`,
      description: skillData.description,
      canonicalPath: '/skill',
      bodyHtml: `<article class="container doc">${skillBodyHtml}</article>`,
      themeInitJs: themeInit,
    }),
  );
  await emitSkillMarkdown(absolutifyMarkdownLinks(skillMarkdown), distDir);

  return {
    leaderboard,
    scorecardPaths,
    badgePaths,
    coverageMarkdown,
    skillData,
    skillMarkdown,
  };
}
