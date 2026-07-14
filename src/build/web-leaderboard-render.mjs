// Web leaderboard rendering (plan U10, reworked per plan-003 U15/KTD-9).
// Separate from scorecards-render.mjs: web entries carry the two-score
// pair (GLOBAL is the default board sort, RELATIVE is the toggle) and no
// tier/language/principle columns — the P1-P8 principles are a hidden
// internal tag on web surfaces. Per-domain result pages are
// Worker-rendered from the committed scorecard (via the
// /_internal/web-scorecards projection), so this file owns only the
// board table + its markdown twin; the toggle behavior lives in
// src/client/web-leaderboard.ts.

import { escHtml, renderMeter } from '../shared/scorecard-format.mjs';

/**
 * @typedef {object} WebLeaderboardEntry
 * @property {string} domain
 * @property {string} url
 * @property {string} name
 * @property {string} description
 * @property {object} scorecard — the committed web scorecard JSON
 */

/** The scorecard's two-score pair. */
export function scoresOf(scorecard) {
  return {
    relative: scorecard?.score?.relative ?? scorecard?.score_pct ?? 0,
    global: scorecard?.score?.global ?? 0,
  };
}

/**
 * Rank entries by the given score key (GLOBAL by default per KTD-9),
 * ties broken by the other key then domain.
 *
 * @param {WebLeaderboardEntry[]} entries
 * @param {'global' | 'relative'} sortKey
 */
export function rankWebEntries(entries, sortKey = 'global') {
  const otherKey = sortKey === 'global' ? 'relative' : 'global';
  return entries
    .map((e) => ({ ...e, scores: scoresOf(e.scorecard) }))
    .sort((a, b) => {
      const byKey = b.scores[sortKey] - a.scores[sortKey];
      if (byKey !== 0) return byKey;
      const byOther = b.scores[otherKey] - a.scores[otherKey];
      if (byOther !== 0) return byOther;
      return a.domain.localeCompare(b.domain);
    })
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

/**
 * Build the web leaderboard page body HTML.
 * @param {WebLeaderboardEntry[]} entries
 * @returns {string}
 */
export function buildWebLeaderboardBody(entries) {
  const ranked = rankWebEntries(entries);

  if (ranked.length === 0) {
    return `<section class="leaderboard-hero">
  <h1>Web Agent-Readiness Leaderboard</h1>
  <p class="leaderboard-hero__lede">Agent-readiness scores for websites and their MCP servers, scored against the <a href="/">eight principles</a>.</p>
</section>
<section class="leaderboard-empty">
  <p>No websites are on the board yet. <a href="/web-audit">Audit a website</a> to see how it scores.</p>
</section>`;
  }

  const rows = ranked
    .map((entry) => {
      const { relative, global: globalScore } = entry.scores;
      return `      <tr data-global="${globalScore}" data-relative="${relative}" data-domain="${escHtml(entry.domain)}">
        <td class="lb-rank">${entry.rank}</td>
        <td class="lb-tool"><a href="/web/${escHtml(entry.domain)}">${escHtml(entry.name)}</a></td>
        <td class="lb-desc">${escHtml(entry.description)}</td>
        <td class="lb-score lb-score--global" data-sort="${globalScore}">${renderMeter(globalScore)}</td>
        <td class="lb-score lb-score--relative" data-sort="${relative}">${renderMeter(relative)}</td>
      </tr>`;
    })
    .join('\n');

  return `<section class="leaderboard-hero">
  <h1>Web Agent-Readiness Leaderboard</h1>
  <p class="leaderboard-hero__lede">Agent-readiness scores for websites and their MCP servers, scored against the same <a href="/">eight principles</a> as the CLI leaderboard. See the <a href="/methodology">methodology</a> for how the web audit probes MCP shape, discovery surfaces, and machine-readable content.</p>
  <p class="leaderboard-hero__meta">${ranked.length} curated ${ranked.length === 1 ? 'site' : 'sites'} on the board. <a href="/web-audit">Audit your own</a>.</p>
</section>

<section class="leaderboard-filters" aria-label="Sort">
  <div class="tier-filters" role="group" aria-label="Sort the board by">
    <button type="button" class="tier-filter tier-filter--active" data-web-sort="global">Global</button>
    <button type="button" class="tier-filter" data-web-sort="relative">Relative</button>
  </div>
</section>

<section class="leaderboard-table-wrap">
  <table class="leaderboard-table" aria-label="Website agent-readiness scores">
    <thead>
      <tr>
        <th class="lb-rank">#</th>
        <th class="lb-tool">Site</th>
        <th class="lb-desc">Description</th>
        <th class="lb-score">Global</th>
        <th class="lb-score">Relative</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</section>

<section class="leaderboard-methodology">
  <h2>How web scoring works</h2>
  <p>Each website is probed for its MCP server shape, MCP and agent discovery surfaces, machine-readable content
  (llms.txt, OpenAPI, JSON Schemas), root-HTML affordances, and crawl policy. Checks that do not apply to a site
  (no MCP server, no API surface, a different declared site type) are excluded rather than counted against it.
  <strong>Global</strong> measures absolute agent capability against a maximally agent-ready site, so exposing and
  nailing more surfaces ranks higher; <strong>Relative</strong> measures how agent-ready a site is for the checks
  that apply to it, so a site perfect for its type approaches 100%. The board sorts by Global; each result page
  headlines Relative.</p>
  <p>The board is curated. To score any public site on demand, use the <a href="/web-audit">web audit</a> or the
  <code>audit_website</code> MCP tool.</p>
</section>`;
}

/**
 * Build the web leaderboard markdown twin (GLOBAL order, both columns).
 * @param {WebLeaderboardEntry[]} entries
 * @returns {string}
 */
export function buildWebLeaderboardMarkdown(entries) {
  const ranked = rankWebEntries(entries);
  const lines = [
    '# Web Agent-Readiness Leaderboard',
    '',
    'Agent-readiness scores for websites and their MCP servers, scored against the same [eight principles](/) as the CLI leaderboard.',
    '',
    'Sorted by the Global score (absolute agent capability); Relative is the score for the checks that apply to each site.',
    '',
  ];
  if (ranked.length === 0) {
    lines.push('No websites are on the board yet. Audit a website at [/web-audit](/web-audit).', '');
    return lines.join('\n');
  }
  lines.push('| # | Site | Global | Relative |', '|---|------|--------|----------|');
  for (const entry of ranked) {
    lines.push(
      `| ${entry.rank} | [${entry.name}](/web/${entry.domain}) | ${entry.scores.global}% | ${entry.scores.relative}% |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
