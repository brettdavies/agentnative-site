// Runtime web-leaderboard renderer: the /web board, its markdown twin,
// and the homepage frontpage rows, all rendered at request time from the
// R2 board aggregate. Web entries carry the two-score pair (GLOBAL is the
// default sort, RELATIVE the toggle) and no tier/language/principle
// columns; the toggle behavior lives in src/client/web-leaderboard.ts and
// operates on the rendered rows. When the aggregate is absent or empty
// (cold start, or a SPEC_VERSION bump that rotated every key) the board
// renders a scoring-in-progress empty state rather than failing.

import { bandOf, escHtml, renderMeter } from '../../shared/scorecard-format.mjs';
import type { WebAggregateEntry } from './cache';

export type RankedWebEntry = WebAggregateEntry & { rank: number };

/**
 * Rank entries by the given score key (GLOBAL by default), ties broken by
 * the other key then domain.
 */
export function rankWebEntries(
  entries: WebAggregateEntry[],
  sortKey: 'global' | 'relative' = 'global',
): RankedWebEntry[] {
  const otherKey = sortKey === 'global' ? 'relative' : 'global';
  return entries
    .slice()
    .sort((a, b) => {
      const byKey = b.score[sortKey] - a.score[sortKey];
      if (byKey !== 0) return byKey;
      const byOther = b.score[otherKey] - a.score[otherKey];
      if (byOther !== 0) return byOther;
      return a.domain.localeCompare(b.domain);
    })
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

const BOARD_HERO = `<section class="leaderboard-hero">
  <h1>Web Agent-Readiness Leaderboard</h1>
  <p class="leaderboard-hero__lede">Agent-readiness scores for websites and their MCP servers, scored against the same <a href="/">eight principles</a> as the CLI leaderboard. See the <a href="/methodology">methodology</a> for how the web audit probes MCP shape, discovery surfaces, and machine-readable content.</p>`;

/** Build the /web page body HTML from the aggregate entries. */
export function buildWebLeaderboardBody(entries: WebAggregateEntry[]): string {
  const ranked = rankWebEntries(entries);

  if (ranked.length === 0) {
    return `${BOARD_HERO}
</section>
<section class="leaderboard-empty">
  <p>Scoring in progress: board results land after the next rescore pass. <a href="/web-audit">Audit a website</a> to see how it scores.</p>
</section>`;
  }

  const rows = ranked
    .map((entry) => {
      const { relative, global: globalScore } = entry.score;
      const friendly =
        entry.name && entry.name !== entry.domain ? ` <span class="lb-tool__name">(${escHtml(entry.name)})</span>` : '';
      // Whole-row link: the domain anchor stretches over the row via
      // .lb-rowlink::after so a click anywhere in the row opens the detail
      // page, never the external site.
      return `      <tr class="lb-row" data-global="${globalScore}" data-relative="${relative}" data-domain="${escHtml(entry.domain)}">
        <td class="lb-rank">${entry.rank}</td>
        <td class="lb-tool"><a class="lb-rowlink" href="/web/${escHtml(entry.domain)}">${escHtml(entry.domain)}</a>${friendly}</td>
        <td class="lb-desc">${escHtml(entry.description)}</td>
        <td class="lb-score lb-score--global" data-sort="${globalScore}">${renderMeter(globalScore)}</td>
        <td class="lb-score lb-score--relative" data-sort="${relative}">${renderMeter(relative)}</td>
      </tr>`;
    })
    .join('\n');

  return `${BOARD_HERO}
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
</section>
<script defer src="/js/web-leaderboard.js"></script>`;
}

/**
 * Build the /web.md markdown twin (GLOBAL order, both columns). Links are
 * absolutized against the serving origin so staging and local previews
 * stay self-consistent.
 */
export function buildWebLeaderboardMarkdown(entries: WebAggregateEntry[], origin: string): string {
  const ranked = rankWebEntries(entries);
  const lines = [
    '# Web Agent-Readiness Leaderboard',
    '',
    `Agent-readiness scores for websites and their MCP servers, scored against the same [eight principles](${origin}/) as the CLI leaderboard.`,
    '',
    'Sorted by the Global score (absolute agent capability); Relative is the score for the checks that apply to each site.',
    '',
  ];
  if (ranked.length === 0) {
    lines.push(
      `Scoring in progress: board results land after the next rescore pass. Audit a website at [/web-audit](${origin}/web-audit).`,
      '',
    );
    return lines.join('\n');
  }
  lines.push('| # | Site | Global | Relative |', '|---|------|--------|----------|');
  for (const entry of ranked) {
    const label = entry.name && entry.name !== entry.domain ? `${entry.domain} (${entry.name})` : entry.domain;
    lines.push(
      `| ${entry.rank} | [${label}](${origin}/web/${entry.domain}) | ${entry.score.global}% | ${entry.score.relative}% |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Homepage web-board rows (top-N pane): compact link rows matching the
 * CLI board markup the homepage builds statically.
 */
export function buildFrontpageBoardRows(entries: WebAggregateEntry[]): string {
  // The homepage pane headlines the site score (RELATIVE) and ranks by it,
  // unlike /web which sorts by GLOBAL.
  return rankWebEntries(entries, 'relative')
    .map((entry) => {
      const pct = entry.score.relative;
      const domain = escHtml(entry.domain);
      const friendly = entry.name && entry.name !== entry.domain ? ` (${escHtml(entry.name)})` : '';
      const desc = escHtml(entry.description);
      return `        <a class="lrow ${bandOf(pct)}" href="/web/${domain}"><span class="rank">${String(entry.rank).padStart(2, '0')}</span><span class="name">${domain}${friendly} <span class="name-sub">${desc}</span></span>${renderMeter(pct)}</a>`;
    })
    .join('\n');
}

/** Homepage web-board empty state (aggregate absent or empty). */
export function buildFrontpageBoardEmptyState(): string {
  return `        <p class="board-rubric">Scoring in progress: web results land after the next rescore pass. <a href="/web">See the board</a> or <a href="/web-audit">audit a website</a>.</p>`;
}
