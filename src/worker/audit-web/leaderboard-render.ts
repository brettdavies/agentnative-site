// Runtime web-leaderboard renderer: the /web board, its markdown twin,
// and the homepage frontpage rows, all rendered at request time from the
// R2 board aggregate. Web entries carry the two-score pair (RELATIVE is the
// default sort; GLOBAL is the `?sort=global` toggle) and no tier/language/
// principle columns; the toggle behavior lives in src/client/web-leaderboard.ts
// and operates on the rendered rows. When the aggregate is absent or empty
// (cold start, or a SPEC_VERSION bump that rotated every key) the board
// renders a scoring-in-progress empty state rather than failing.

import { AUDIT_PATH, auditPath, leaderboardPath, SCORECARDS_PATH, scorePath } from '../../shared/audit-routes';
import { bandOf, escHtml, renderMeter } from '../../shared/scorecard-format.mjs';
import type { WebAggregateEntry } from './cache';

/** Board row: an aggregate entry plus whether it came from the curated seed. */
export type WebBoardEntry = WebAggregateEntry & { curated: boolean };

export type WebBoardView = 'all' | 'curated';

export type WebBoardRenderOpts = {
  view: WebBoardView;
  curatedCount: number;
  userCount: number;
  /** Explicit sort from `?sort=`; null/undefined means the Relative default. */
  sort?: 'global' | 'relative' | null;
};

/** Resolve the board sort key: Relative unless Global is explicitly requested. */
export function effectiveWebSort(sort: 'global' | 'relative' | null | undefined): 'global' | 'relative' {
  return sort === 'global' ? 'global' : 'relative';
}

/**
 * Rank entries by the given score key (RELATIVE by default), ties broken by
 * the other key then domain.
 */
export function rankWebEntries<T extends WebAggregateEntry>(
  entries: T[],
  sortKey: 'global' | 'relative' = 'relative',
): (T & { rank: number })[] {
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

/**
 * Shareable URL for a board view. The toggle is plain server-rendered
 * navigation (zero JS); a non-default Global sort rides along on the HTML
 * links so switching view keeps that order. Relative (the default) omits
 * `?sort=` so `/web` stays the clean share URL.
 */
function viewHref(
  target: WebBoardView,
  sort: 'global' | 'relative' | null | undefined,
  markdown: boolean,
  base = SCORECARDS_PATH,
  extraParams: readonly string[] = [],
): string {
  const path = markdown ? `${base}.md` : base;
  // The extras come first and the base carries no query of its own: this joins
  // with `?`, so a base like `/scorecards?lane=web` would produce two.
  const params: string[] = [...extraParams];
  if (target === 'curated') params.push('view=curated');
  if (!markdown && sort === 'global') params.push('sort=global');
  return params.length > 0 ? `${path}?${params.join('&')}` : path;
}

/**
 * The board's view switch. The base is a parameter because the same control
 * renders on the website board and on the merged leaderboard, and a forked
 * copy would be free to drift on which view is active or where it points.
 */
export function buildBoardViewNav(
  opts: WebBoardRenderOpts,
  base = SCORECARDS_PATH,
  extraParams: readonly string[] = [],
): string {
  const link = (target: WebBoardView, label: string): string => {
    const active = target === opts.view;
    const cls = active ? 'tier-filter tier-filter--active' : 'tier-filter';
    const current = active ? ' aria-current="page"' : '';
    const href = escHtml(viewHref(target, opts.sort, false, base, extraParams));
    return `<a class="${cls}"${current} href="${href}">${label}</a>`;
  };
  return `<nav class="tier-filters" aria-label="Board view">
    ${link('all', 'All')}
    ${link('curated', `Curated (${opts.curatedCount})`)}
  </nav>`;
}

/**
 * Escape the characters that carry structure inside a markdown table cell. A
 * row's label is an audited site's own title, so an unescaped `]` closes the
 * link text early and forges a link, and a bare `|` shifts every column after
 * it. Parens are left alone: only `]` ends link text, and escaping them would
 * litter every legitimate `(Name)` in a table an agent reads.
 */
function escMdCell(value: string): string {
  return value.replace(/[\\|[\]]/g, (ch) => `\\${ch}`);
}

/**
 * The board's markdown table, without the document around it: the heading,
 * the view switch, and the counts belong to whichever page hosts it. Both the
 * website board's twin and the merged leaderboard's twin render these rows, so
 * the two can never list a row differently.
 */
export function buildBoardMarkdownRows(entries: WebBoardEntry[], origin: string): string {
  const ranked = rankWebEntries(entries, 'relative');
  if (ranked.length === 0) {
    return `Scoring in progress: board results land after the next rescore pass. Audit a website at [${AUDIT_PATH}](${origin}${auditPath({ lane: 'web' })}).\n`;
  }
  const lines = ['| # | Site | Global | Relative | Source |', '|---|------|--------|----------|--------|'];
  for (const entry of ranked) {
    const label = escMdCell(
      entry.name && entry.name !== entry.domain ? `${entry.domain} (${entry.name})` : entry.domain,
    );
    const source = entry.curated ? 'curated' : 'on-demand';
    lines.push(
      `| ${entry.rank} | [${label}](${origin}${scorePath(entry.domain)}) | ${entry.score.global}% | ${entry.score.relative}% | ${source} |`,
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
  // matching /web's default sort.
  return rankWebEntries(entries, 'relative')
    .map((entry) => {
      const pct = entry.score.relative;
      const domain = escHtml(entry.domain);
      const named = entry.name && entry.name !== entry.domain;
      const friendly = named ? ` (${escHtml(entry.name)})` : '';
      const desc = escHtml(entry.description);
      // Without a name of its own the row announces as its own contents, which
      // read as a number salad: rank digits, domain, description, bare score.
      const label = escHtml(
        `${named ? `${entry.domain} (${entry.name})` : entry.domain}, score ${pct} percent, rank ${entry.rank}`,
      );
      return `        <a class="lrow ${bandOf(pct)}" aria-label="${label}" href="${scorePath(domain)}"><span class="rank" aria-hidden="true">${String(entry.rank).padStart(2, '0')}</span><span class="name">${domain}${friendly} <span class="name-sub">${desc}</span></span>${renderMeter(pct)}</a>`;
    })
    .join('\n');
}

/** Homepage web-board empty state (aggregate absent or empty). */
export function buildFrontpageBoardEmptyState(): string {
  return `        <p class="board-rubric">Scoring in progress: web results land after the next rescore pass. <a href="${leaderboardPath({ lane: 'web' })}">See the board</a> or <a href="${auditPath({ lane: 'web' })}">audit a website</a>.</p>`;
}

/**
 * Homepage markdown web-board slice: a compact table like /web.md, never
 * HTML `lrow` markup (R6). Ranked by RELATIVE, matching the HTML pane.
 */
export function buildFrontpageBoardMarkdown(entries: WebAggregateEntry[]): string {
  const ranked = rankWebEntries(entries, 'relative');
  const lines = ['| # | Site | Score |', '|---|------|-------|'];
  for (const entry of ranked) {
    const label = entry.name && entry.name !== entry.domain ? `${entry.domain} (${entry.name})` : entry.domain;
    lines.push(`| ${entry.rank} | [${label}](${scorePath(entry.domain)}) | ${entry.score.relative}% |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Homepage markdown empty state when the frontpage aggregate is missing. */
export function buildFrontpageBoardMarkdownEmptyState(): string {
  return `Scoring in progress: web results land after the next rescore pass. [See the board](${leaderboardPath({ lane: 'web' })}) or [audit a website](${auditPath({ lane: 'web' })}).\n`;
}

/**
 * The website pane of the merged leaderboard: the same row shape the CLI pane
 * carries, ranked by relative score with global as the tie-break. The meter is
 * the relative score, which is the headline; the sub-label carries the global
 * score, so a row states both without a second column.
 */
export function buildBoardRows(entries: WebBoardEntry[]): string {
  return rankWebEntries(entries, 'relative')
    .map((entry) => {
      const relative = entry.score.relative;
      const domain = escHtml(entry.domain);
      const named = entry.name && entry.name !== entry.domain;
      const friendly = named ? ` (${escHtml(entry.name)})` : '';
      // Without a name of its own the row announces as its own contents, which
      // read as a number salad: rank digits, domain, two bare percentages.
      const label = escHtml(
        `${named ? `${entry.domain} (${entry.name})` : entry.domain}, relative score ${relative} percent, global score ${entry.score.global} percent, rank ${entry.rank}`,
      );
      return `        <a class="lrow ${bandOf(relative)}" aria-label="${label}" href="${scorePath(domain)}"><span class="rank" aria-hidden="true">${String(entry.rank).padStart(2, '0')}</span><span class="name">${domain}${friendly} <span class="name-sub">${entry.score.global}% global</span></span>${renderMeter(relative)}</a>`;
    })
    .join('\n');
}
