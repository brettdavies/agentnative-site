// Web leaderboard rendering (plan U10). Separate from scorecards-render.mjs:
// web entries have domain / URL / score / principles columns and no
// tier/language columns and no "ANC 100" CLI hero. Per-domain result
// pages are Worker-rendered from the committed scorecard (via the
// /_internal/web-scorecards projection), so this file owns only the board
// table + its markdown twin.

import { computePrincipleScore, escHtml } from '../shared/scorecard-format.mjs';

/**
 * @typedef {object} WebLeaderboardEntry
 * @property {string} domain
 * @property {string} url
 * @property {string} name
 * @property {string} description
 * @property {object} scorecard — the committed web scorecard JSON
 */

/** Rank entries highest-score-first, ties broken by principles-met then domain. */
export function rankWebEntries(entries) {
  return entries
    .map((e) => ({ ...e, principleScore: computePrincipleScore(e.scorecard) }))
    .sort((a, b) => {
      const byScore = (b.scorecard.badge?.score_pct ?? 0) - (a.scorecard.badge?.score_pct ?? 0);
      if (byScore !== 0) return byScore;
      const byPrinciples = b.principleScore.met - a.principleScore.met;
      if (byPrinciples !== 0) return byPrinciples;
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
      const pct = entry.scorecard.badge?.score_pct ?? 0;
      const ps = entry.principleScore;
      return `      <tr>
        <td class="lb-rank">${entry.rank}</td>
        <td class="lb-tool"><a href="/web/${escHtml(entry.domain)}">${escHtml(entry.name)}</a></td>
        <td class="lb-desc">${escHtml(entry.description)}</td>
        <td class="lb-score" data-sort="${pct}">${pct}%</td>
        <td class="lb-principles" data-sort="${ps.met}">${ps.met}/${ps.total}</td>
      </tr>`;
    })
    .join('\n');

  return `<section class="leaderboard-hero">
  <h1>Web Agent-Readiness Leaderboard</h1>
  <p class="leaderboard-hero__lede">Agent-readiness scores for websites and their MCP servers, scored against the same <a href="/">eight principles</a> as the CLI leaderboard. See the <a href="/methodology">methodology</a> for how the web audit probes MCP shape, discovery surfaces, and machine-readable content.</p>
  <p class="leaderboard-hero__meta">${ranked.length} curated ${ranked.length === 1 ? 'site' : 'sites'} on the board. <a href="/web-audit">Audit your own</a>.</p>
</section>

<section class="leaderboard-table-wrap">
  <table class="leaderboard-table" aria-label="Website agent-readiness scores">
    <thead>
      <tr>
        <th class="lb-rank" data-sort-col="rank">#</th>
        <th class="lb-tool" data-sort-col="tool">Site</th>
        <th class="lb-desc">Description</th>
        <th class="lb-score" data-sort-col="score">Score</th>
        <th class="lb-principles" data-sort-col="principles">Principles</th>
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
  (llms.txt, OpenAPI, JSON Schemas), root-HTML affordances, and crawl policy. The <strong>score</strong> is
  credit-weighted over the MUST and SHOULD checks that apply; MAY checks are informational. The
  <strong>principles</strong> column counts how many of the eight principles have every applicable check passing.</p>
  <p>The board is curated. To score any public site on demand, use the <a href="/web-audit">web audit</a> or the
  <code>audit_website</code> MCP tool.</p>
</section>`;
}

/**
 * Build the web leaderboard markdown twin.
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
  ];
  if (ranked.length === 0) {
    lines.push('No websites are on the board yet. Audit a website at [/web-audit](/web-audit).', '');
    return lines.join('\n');
  }
  lines.push('| # | Site | Score | Principles |', '|---|------|-------|------------|');
  for (const entry of ranked) {
    const pct = `${entry.scorecard.badge?.score_pct ?? 0}%`;
    const ps = entry.principleScore;
    lines.push(`| ${entry.rank} | [${entry.name}](/web/${entry.domain}) | ${pct} | ${ps.met}/${ps.total} |`);
  }
  lines.push('');
  return lines.join('\n');
}
