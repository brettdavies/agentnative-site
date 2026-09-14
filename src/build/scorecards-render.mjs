// Leaderboard-page rendering for the build pipeline. Per-tool body +
// markdown twin live in src/shared/scorecard-format.mjs (single renderer
// shared with the Worker live-score route). This file owns only the
// pieces that depend on registry-aggregate data: leaderboard table, tier
// counts, badge-floor callout.

import { scoreJsonPath, scoreMarkdownPath, scorePath } from '../shared/audit-routes.ts';
import {
  BADGE_ELIGIBILITY_FLOOR_PCT,
  bandOf,
  escHtml,
  renderMeter,
  buildScorecardBody as sharedBuildScorecardBody,
  buildScorecardMarkdown as sharedBuildScorecardMarkdown,
  renderAudienceBanner as sharedRenderAudienceBanner,
} from '../shared/scorecard-format.mjs';
import { CANONICAL_SITE_URL } from '../shared/site-url';
import { renderSurfaceSeg } from '../shared/surface-seg.mjs';

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
  // Both panes carry one row shape: rank, name with a sub-label, one meter.
  // The filter attributes ride each row, so the controls above the board keep
  // working with no table to scope them to. Every entry has a scorecard;
  // registry entries without one are excluded by loadScoredTools. The binary
  // is the scorecard's, which is canonical for it; the tool name stands in
  // when a scorecard predates the field.
  const rows = leaderboard
    .map((entry) => {
      const pct = entry.scorecard.badge.score_pct;
      const name = escHtml(entry.tool.name);
      const binary = escHtml(entry.scorecard?.tool?.binary ?? entry.tool.name);
      const audience = escHtml(entry.scorecard?.audience ?? '');
      const auditProfile = escHtml(entry.scorecard?.audit_profile ?? '');
      // Without a name of its own the row announces as its own contents, which
      // read as a number salad: rank digits, tool, binary, bare score.
      const label = escHtml(`${entry.tool.name}, score ${pct} percent, rank ${entry.rank}`);
      return `        <a class="lrow ${bandOf(pct)}" aria-label="${label}" href="/score/${name}" data-tier="${escHtml(entry.tool.tier)}" data-audience="${audience}" data-audit-profile="${auditProfile}"><span class="rank" aria-hidden="true">${String(entry.rank).padStart(2, '0')}</span><span class="name">${name} <span class="name-sub">${binary}</span></span>${renderMeter(pct)}</a>`;
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

  // The page-scope ids, not the board-probe ids: both boards live here now, so
  // the segment swaps the panes in place through the shared [data-s] rules and
  // writes the visitor's surface, rather than navigating to a second page.
  const boardSurfaceSeg = renderSurfaceSeg({
    dataAttr: 'data-surface-board-seg',
    radioName: 'board-surface',
    cliId: 's-cli',
    webId: 's-web',
    checked: 'cli',
    ariaLabel: 'Leaderboard surface',
  });

  return `<div class="scope">
<section class="leaderboard-hero">
  <h1>ANC 100 — Agent-Native CLI Leaderboard</h1>
  <p class="leaderboard-hero__lede">Automated agent-readiness scores for real CLI tools, scored against the <a href="/">eight principles</a>. See the <a href="/methodology">methodology</a> for how scores, audience signals, and audit profiles work.</p>
</section>

<div class="board-head">
  <div>
    <p data-s="cli">Curated CLIs, ranked by credit-weighted agent-readiness.</p>
    <p data-s="web">Public sites, ranked by global agent-readiness.</p>
    <p class="leaderboard-hero__meta" data-s="cli">${leaderboard.length} audited tools in the corpus.</p>
  </div>
  <div class="board-controls">
${boardSurfaceSeg}
  </div>
</div>

<div class="leaderboard-controls" data-s="cli" role="group" aria-label="Filters">
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
</div>

<div class="board" data-s="cli" role="group" aria-label="CLI tool agent-readiness scores">
${rows}
</div>

<div class="board" data-s="web" role="group" aria-label="Website agent-readiness scores">
{{WEB_BOARD_ROWS}}
</div>

<p class="board-rubric" data-s="cli">Scored against the <strong>eight principles</strong>. Run <code>anc audit &lt;tool&gt;</code> locally for source + project depth.</p>
<div class="board-view" data-s="web">
  <p class="board-rubric">Scored against the emerging agent-web standards: <code>MCP</code>, <code>llms.txt</code>, <code>OpenAPI</code>, JSON Schema, discovery. anc audits; it doesn't own them.</p>
{{WEB_BOARD_VIEW}}
</div>

<section class="leaderboard-badge-callout" data-s="cli" aria-label="Agent-native badge">
  <h2>Claim the badge</h2>
  <p>Tools at or above ${floorPct}% can embed the <a href="/badge">agent-native badge</a> on their README — a live link to their scorecard, not a static stamp. ${eligibleCount} of ${leaderboard.length} listed tools currently qualify.</p>
</section>

<section class="leaderboard-methodology" data-s="cli">
  <h2>Methodology</h2>
${methodology}
</section>
</div>`;
}

// Re-exported from shared for back-compat with existing callers (build,
// tests). Definitions live in src/shared/scorecard-format.mjs.
export const renderAudienceBanner = sharedRenderAudienceBanner;

// -------------------------------------------------------------------
// Per-tool scorecard body + markdown twin.
//
// The actual rendering lives in `src/shared/scorecard-format.mjs` so the
// build-time curated page and the Worker's live page emit the same shape.
// This file keeps the positional signature its callers in
// 08-scorecards-emit.mjs and tests/build.test.ts use, and supplies the
// curated page's twin links.
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

/** The three absolute URLs a curated result's twin names in its front matter. */
function curatedLinks(tool) {
  return {
    scorecard: `${CANONICAL_SITE_URL}${scorePath(tool.name)}`,
    markdown: `${CANONICAL_SITE_URL}${scoreMarkdownPath(tool.name)}`,
    json: `${CANONICAL_SITE_URL}${scoreJsonPath(tool.name)}`,
  };
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

  // The twin carries both boards in full. The HTML panes trade columns for a
  // compact row; the markdown keeps every column, which is the representation
  // an agent reads.
  lines.push('', '## Web leaderboard', '', '{{WEB_BOARD_ROWS}}', '');
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
    links: curatedLinks(tool),
    lane: 'cli',
    tier: 'registry',
  });
}
