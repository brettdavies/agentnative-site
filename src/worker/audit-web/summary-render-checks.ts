// The check rows inside a website result category: lanes, not-run groups,
// and the rows themselves.
//
// The copy-paste prompt is never rendered: a row emits it in a hidden
// `data-copy-text` carrier and the site-wide clipboard.js attaches a
// Copy-prompt button client-side, so a no-JS render shows the prose and
// resource links with no dead control.

import { escHtml } from '../../shared/esc-html';
import { notRunCount } from './provenance-copy';
import { type Rich, richHtml } from './rich-text';
import { statusLabel, statusMark, TIER_LABELS } from './summary-labels';
import type { SummaryGroup, SummaryItem, SummaryLane, SummaryRow } from './summary-types';

function tierChip(keyword: string | undefined): string {
  if (!keyword || !(keyword in TIER_LABELS)) return '';
  return `<span class="tier tier-${keyword}">${TIER_LABELS[keyword]}</span> `;
}

function note(rich: Rich | null): string {
  return rich === null ? '' : `      <p class="web-check__note">${richHtml(rich)}</p>\n`;
}

/** A rollup as "n / n pass · N not run", either half dropped when it has nothing to say. */
function countText(counts: { passed: number; counted: number; notRun: number }, unit: string): string {
  const parts: string[] = [];
  if (counts.counted > 0) parts.push(`${counts.passed} / ${counts.counted}${unit}`);
  if (counts.notRun > 0) parts.push(notRunCount(counts.notRun));
  return parts.join(' · ');
}

/**
 * A row's notes sit at the top of its body, under its label. A row inside a
 * not-run group shows neither its host nor its remedy: the group's summary
 * names its host, and the group's body states the remedy once for every
 * row. The advisory and retired notes are the row's own and always show; an
 * advisory carries the fix skill link, since the row it sits on passed.
 */
function renderCheck(row: SummaryRow, grouped: boolean): string {
  const skillLink = { text: 'Fix skill', href: row.skillUrl };
  const resourceLinks = [
    ...row.resources.map((r) => `<a href="${escHtml(r.url)}" rel="noopener">${escHtml(r.label)}</a>`),
    richHtml([skillLink]),
  ].join(' · ');

  let body = grouped ? '' : `${note(row.hostNote)}${note(row.remedy)}`;
  if (row.advisoryNote !== null) body += note([...row.advisoryNote, ' ', skillLink]);
  body += note(row.retiredNote);
  body += `      <p class="web-check__goal"><strong>Goal:</strong> ${escHtml(row.goal)}.</p>
      <p class="web-check__result"><strong>Result:</strong> ${escHtml(row.result)}</p>
`;
  if (row.fixable) {
    body += `      <p class="web-check__fix"><strong>Fix:</strong> ${escHtml(row.fix)}</p>\n`;
  }
  body += `      <p class="web-check__resources"><strong>Resources:</strong> ${resourceLinks}</p>\n`;
  if (row.fixable) {
    body += `      <span class="web-check__prompt" data-copy-text="${escHtml(row.prompt)}" data-keyword="${escHtml(row.keyword ?? '')}" data-status="${escHtml(row.status)}" hidden></span>\n`;
  }

  // The row root is the canonical record: keyword, tier, status, unprobed, and
  // host ride here on every row, including the ones that carry no prompt, so a
  // reader never has to infer them from a conditional child that only
  // actionable rows emit.
  const rootMeta = ` data-keyword="${escHtml(row.keyword ?? '')}" data-tier="${escHtml(row.tier ?? '')}" data-status="${escHtml(row.status)}" data-unprobed="${row.unprobed ? 'true' : 'false'}" data-host="${escHtml(row.host)}"${row.retiredNote !== null ? ' data-retired="true"' : ''}`;
  // An advisory opens its row like a failure does, so the note shows without a click.
  const open = row.fixable || row.advisoryNote !== null;

  return `    <details class="web-check web-check--${row.status}"${open ? ' open' : ''} data-id="${escHtml(row.id)}"${rootMeta}>
      <summary><span class="web-check__mark" aria-hidden="true">${statusMark(row.status)}</span> <span class="web-check__label">${escHtml(row.label)}</span> ${tierChip(row.keyword)}<span class="audit__status">${escHtml(statusLabel(row.status))}</span></summary>
${body}    </details>
`;
}

/**
 * Rows the audit could not run for one reason at one host, as one closed
 * group. The group carries no `data-id`, so every reader of the rows still
 * finds each nested row, and none finds the group.
 */
function renderGroup(group: SummaryGroup): string {
  return `    <details class="web-check web-check--n_a web-check--group">
      <summary aria-label="${escHtml(group.name)}"><span class="web-check__mark" aria-hidden="true">${statusMark('n_a')}</span> <span class="web-check__label">${escHtml(group.label)}</span> <span class="audit__status">${escHtml(statusLabel('n_a'))}</span></summary>
${note(group.remedy)}      <div class="web-check__group">
${group.rows.map((row) => renderCheck(row, true)).join('')}      </div>
    </details>
`;
}

export function renderItems(items: readonly SummaryItem[]): string {
  return items.map((item) => (item.kind === 'group' ? renderGroup(item) : renderCheck(item.row, false))).join('');
}

/**
 * One protocol lane: its heading, its own rollup, the line saying what the
 * lane covers, then its rows. A lane with nothing counted shows no pass
 * count, since "0 / 0" would read as a lane that failed.
 */
export function renderLane(lane: SummaryLane): string {
  const counts = countText(lane, ' pass');
  const count = counts === '' ? '' : `<span class="web-lane__count">${escHtml(counts)}</span>`;
  return `    <div class="web-lane" data-mcp-lane="${escHtml(lane.id)}">
      <div class="web-lane__head"><h4 class="web-lane__title">${escHtml(lane.label)}</h4>${count}</div>
      <p class="web-lane__note">${escHtml(lane.note)}</p>
${renderItems(lane.items)}    </div>
`;
}
