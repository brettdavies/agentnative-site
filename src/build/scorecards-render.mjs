// Leaderboard-page rendering for the build pipeline. Per-tool body +
// markdown twin live in src/shared/scorecard-format.mjs (single renderer
// shared with the Worker live-score route). This file owns only the
// pieces that depend on registry-aggregate data: leaderboard table, tier
// counts, badge-floor callout.

import {
  BADGE_ELIGIBILITY_FLOOR_PCT,
  escHtml,
  renderMeter,
  buildScorecardBody as sharedBuildScorecardBody,
  buildScorecardMarkdown as sharedBuildScorecardMarkdown,
  renderAudienceBanner as sharedRenderAudienceBanner,
} from '../shared/scorecard-format.mjs';

const BADGE_FLOOR_DISPLAY_PCT = BADGE_ELIGIBILITY_FLOOR_PCT;

// -------------------------------------------------------------------
// HTML builders
// -------------------------------------------------------------------

/**
 * Build the leaderboard page body HTML.
 *
 * @param {Array} leaderboard — from computeLeaderboard()
 * @param {string} methodology — methodology prose HTML
 * @returns {string} HTML body
 */
export function buildLeaderboardBody(leaderboard, methodology) {
  const tierBadge = (tier) => `<span class="tier-badge tier-badge--${escHtml(tier)}">${escHtml(tier)}</span>`;

  // Every leaderboard entry has a scorecard (registry entries without
  // scorecards are excluded by loadScoredTools). The em-dash "—" / "—/7"
  // cells the pre-inversion code carried for unscored rows are gone with
  // the unscored row itself. Score read directly from schema 0.5
  // `badge.score_pct` — the CLI is canonical for the integer.
  const scoreCell = (entry) => {
    const pct = entry.scorecard.badge.score_pct;
    return `<td class="lb-score" data-sort="${pct}">${renderMeter(pct)}</td>`;
  };

  const principleCell = (entry) => {
    const ps = entry.principleScore;
    return `<td class="lb-principles" data-sort="${ps.met}">${ps.met}/${ps.total}</td>`;
  };

  const rows = leaderboard
    .map((entry) => {
      const audience = entry.scorecard?.audience ?? '';
      const auditProfile = entry.scorecard?.audit_profile ?? '';
      return `      <tr data-tier="${escHtml(entry.tool.tier)}" data-lang="${escHtml(entry.tool.language)}" data-audience="${escHtml(audience)}" data-audit-profile="${escHtml(auditProfile)}">
        <td class="lb-rank">${entry.rank}</td>
        <td class="lb-tool"><a href="/score/${escHtml(entry.tool.name)}">${escHtml(entry.tool.name)}</a></td>
        <td class="lb-desc">${escHtml(entry.tool.description)}</td>
        <td class="lb-tier">${tierBadge(entry.tool.tier)}</td>
        <td class="lb-lang">${escHtml(entry.tool.language)}</td>
        ${scoreCell(entry)}
        ${principleCell(entry)}
      </tr>`;
    })
    .join('\n');

  const tierCounts = {};
  for (const e of leaderboard) {
    tierCounts[e.tool.tier] = (tierCounts[e.tool.tier] || 0) + 1;
  }

  // Eligible-tool count for the badge callout. Reads scorecard.badge.eligible
  // (schema 0.5) — the CLI is canonical for what eligibility means. Lets the
  // callout cite a real number ("24 tools currently qualify") instead of a
  // vague "tools that qualify." Every leaderboard entry has a scorecard,
  // so no null guard needed.
  const eligibleCount = leaderboard.filter((e) => e.scorecard.badge.eligible).length;
  const floorPct = BADGE_FLOOR_DISPLAY_PCT;

  return `<section class="leaderboard-hero">
  <h1>ANC 100 — Agent-Native CLI Leaderboard</h1>
  <p class="leaderboard-hero__lede">Automated agent-readiness scores for real CLI tools, scored against the <a href="/">eight principles</a>. See the <a href="/methodology">methodology</a> for how scores, audience signals, and audit profiles work.</p>
  <p class="leaderboard-hero__meta">${leaderboard.length} audited tools in the corpus.</p>
</section>

<section class="leaderboard-controls" aria-label="Filters">
  <div class="tier-filters" role="group" aria-label="Filter by tier">
    <button type="button" class="tier-filter tier-filter--active" data-tier="all">All</button>
    <button type="button" class="tier-filter" data-tier="workhorse">Workhorse (${tierCounts.workhorse || 0})</button>
    <button type="button" class="tier-filter" data-tier="agent">Agent (${tierCounts.agent || 0})</button>
    <button type="button" class="tier-filter" data-tier="notable">Notable (${tierCounts.notable || 0})</button>
  </div>
  <label class="audience-filter">
    <input type="checkbox" class="audience-filter__input" data-filter="agent-optimized-only">
    <span class="audience-filter__label">Agent-optimized only</span>
  </label>
</section>

<section class="leaderboard-table-wrap">
  <table class="leaderboard-table" aria-label="CLI tool agent-readiness scores">
    <thead>
      <tr>
        <th class="lb-rank" data-sort-col="rank">#</th>
        <th class="lb-tool" data-sort-col="tool">Tool</th>
        <th class="lb-desc">Description</th>
        <th class="lb-tier">Tier</th>
        <th class="lb-lang">Lang</th>
        <th class="lb-score" data-sort-col="score">Score</th>
        <th class="lb-principles" data-sort-col="principles">Principles</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</section>

<section class="leaderboard-badge-callout" aria-label="Agent-native badge">
  <h2>Claim the badge</h2>
  <p>Tools at or above ${floorPct}% can embed the <a href="/badge">agent-native badge</a> on their README — a live link to their scorecard, not a static stamp. ${eligibleCount} of ${leaderboard.length} listed tools currently qualify.</p>
</section>

<section class="leaderboard-methodology">
  <h2>Methodology</h2>
${methodology}
</section>`;
}

// Re-exported from shared for back-compat with existing callers (build,
// tests). Definitions live in src/shared/scorecard-format.mjs.
export const renderAudienceBanner = sharedRenderAudienceBanner;

// -------------------------------------------------------------------
// Per-tool scorecard body + markdown twin.
//
// The actual rendering lives in `src/shared/scorecard-format.mjs` so the
// build-time `/score/<slug>` and the Worker `/score/live/<binary>` route
// emit byte-for-byte the same shape. This file keeps the legacy
// positional signature so existing callers in 08-scorecards-emit.mjs and
// tests/build.test.ts don't need to change.
// -------------------------------------------------------------------

/**
 * Build a per-tool scorecard page body HTML. Thin wrapper over
 * `buildScorecardBody` in shared — translates the build's legacy
 * positional args into the shared opts shape. The static path passes a
 * full registry-editorial `tool` (tier, description, install, repo/url,
 * language); shared renders the badge SVG preview because the static
 * build emits a matching `/badge/<name>.svg`.
 */
export function buildScorecardBody(tool, scorecard, topIssues, principleScore, resolvedVersion, metadata) {
  return sharedBuildScorecardBody(tool, scorecard, {
    topIssues,
    principleScore,
    version: resolvedVersion,
    metadata,
    showBadgePreview: true,
  });
}

// -------------------------------------------------------------------
// Markdown builders
// -------------------------------------------------------------------

/**
 * Build leaderboard markdown twin — a readable markdown table.
 *
 * @param {Array} leaderboard — from computeLeaderboard()
 * @returns {string} markdown
 */
export function buildLeaderboardMarkdown(leaderboard) {
  const lines = [
    '# ANC 100 — Agent-Native CLI Leaderboard',
    '',
    'Automated agent-readiness scores for real CLI tools, scored against the [eight principles](/).',
    '',
    '| # | Tool | Tier | Lang | Score | Principles |',
    '|---|------|------|------|-------|------------|',
  ];

  for (const entry of leaderboard) {
    // Every leaderboard entry has a scorecard at this point.
    const score = `${entry.scorecard.badge.score_pct}%`;
    const ps = entry.principleScore;
    const principles = `${ps.met}/${ps.total}`;
    lines.push(
      `| ${entry.rank} | [${entry.tool.name}](/score/${entry.tool.name}) | ${entry.tool.tier} | ${entry.tool.language} | ${score} | ${principles} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Build per-tool scorecard markdown twin. Thin wrapper over the shared
 * `buildScorecardMarkdown` — same single-source-of-truth pattern as the
 * HTML body above.
 */
export function buildScorecardMarkdown(tool, scorecard, _topIssues, principleScore, resolvedVersion, metadata) {
  return sharedBuildScorecardMarkdown(tool, scorecard, {
    principleScore,
    version: resolvedVersion,
    metadata,
  });
}
