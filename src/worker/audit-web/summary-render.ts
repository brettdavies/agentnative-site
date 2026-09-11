// HTML body for a website result page.
//
// The page opens with the shared result spine and score head, then groups
// the checks under the registry's visible categories (carried on
// scorecard.categories[] in category_order) as C-rows: each row carries
// the category's passed-of-counted rollup as its status and nests the
// per-check Goal / Result / Fix / Resources details. The CLI renderer
// groups by the P1-P8 principles instead, which are a hidden tag here.
//
// The copy-paste prompt is never rendered: renderCheck emits it in a hidden
// `data-copy-text` carrier and the site-wide clipboard.js attaches a
// Copy-prompt button client-side, so a no-JS render shows the prose and
// resource links with no dead control. The markdown twin keeps the fenced
// prompt so fetch-only agents lose nothing.

import { escHtml } from '../../shared/esc-html';
import { bandOf } from '../../shared/meter';
import { renderBigScore, renderResultSpine, type SpineInput } from '../../shared/result-spine';
import type { WebAuditFreshness } from './cache';
import { WEB_CTA_NOTE_HTML } from './copy';
import { freshnessHtml } from './summary-freshness';
import { type WebSummaryInput, webSummaryView } from './summary-input';
import {
  RELATIVE_LABEL,
  RELATIVE_SUBLABEL,
  STATUS_ORDER,
  type SummaryCategory,
  type SummaryRow,
  statusLabel,
  statusMark,
  TIER_LABELS,
  type WebSummaryModel,
} from './summary-model';

function tierChip(keyword: string | undefined): string {
  if (!keyword || !(keyword in TIER_LABELS)) return '';
  return `<span class="tier tier-${keyword}">${TIER_LABELS[keyword]}</span> `;
}

/**
 * One hidden page-level record of what the page renders: both scores, the
 * complete per-status counts, and the freshness envelope. The counts come from
 * the same model the visible page renders, so a machine reader and a human
 * reader cannot disagree. A null instant omits its attribute rather than
 * emitting an empty string, so a reader gets null instead of "".
 */
function auditContextEl(model: WebSummaryModel, freshness: WebAuditFreshness): string {
  const attrs = [
    'data-web-audit-context',
    `data-site-score="${model.relative}"`,
    `data-global-score="${model.global}"`,
    `data-cached="${freshness.cached ? 'true' : 'false'}"`,
  ];
  if (freshness.scored_at) attrs.push(`data-scored-at="${escHtml(freshness.scored_at)}"`);
  if (freshness.refresh_after) attrs.push(`data-refresh-after="${escHtml(freshness.refresh_after)}"`);
  for (const status of STATUS_ORDER) attrs.push(`data-count-${status}="${model.counts[status]}"`);
  return `<div ${attrs.join(' ')} hidden></div>`;
}

type CategoryPill = { cls: 'pass' | 'warn' | 'fail' | 'na'; text: string };

/** A category's status from its rollup: every counted check passing is a pass, none is a fail. */
function categoryPill(category: SummaryCategory): CategoryPill {
  if (category.counted === 0) return { cls: 'na', text: 'n/a' };
  if (category.passed === category.counted) return { cls: 'pass', text: 'pass' };
  if (category.passed === 0) return { cls: 'fail', text: 'fail' };
  return { cls: 'warn', text: 'partial' };
}

/** HTML body for a website result page. */
export function buildWebSummaryBody(input: WebSummaryInput): string {
  const { model, freshness, freshnessState } = webSummaryView(input);
  const spine: SpineInput = input.spine ?? {
    target: input.domain,
    lane: 'web',
    tier: 'cache',
    freshnessHtml: `<span data-web-audit-freshness>${freshnessHtml(freshnessState)}</span>`,
    linked: true,
    control: null,
  };

  let html = `<article class="container scorecard-page" data-web-audit-result>${renderResultSpine(spine)}${renderBigScore(
    {
      pct: model.relative,
      label: RELATIVE_LABEL,
      secondary: { value: String(model.global), label: 'global-ready' },
    },
  )}<p class="result-score__note">${escHtml(RELATIVE_SUBLABEL)}; global measures it against a maximally agent-ready site. Website <a href="${escHtml(model.targetUrl)}">${escHtml(model.targetUrl)}</a>.</p>
${auditContextEl(model, freshness)}
<section class="pscore scorecard-audits" aria-labelledby="pscore-heading">
  <h2 id="pscore-heading">Checks by category</h2>
  <ol class="pscore__list">
`;

  let catIndex = 0;
  for (const category of model.categories) {
    catIndex += 1;
    const empty = category.counted === 0;
    const pill = categoryPill(category);
    const rollupBand = empty ? '' : ` ${bandOf((category.passed / category.counted) * 100)}`;
    html += `    <li class="pscore__row pscore__row--category${empty ? ' pscore__row--empty' : ''}" data-category="${escHtml(category.id)}">
      <span class="spec__id">C${catIndex}</span>
      <div class="pscore__body">
        <h3 class="spec__title audit-group__title">${escHtml(category.name)}</h3>
        <p class="pscore__evidence"><span class="audit-group__rollup${rollupBand}">${category.passed} / ${category.counted}</span> checks pass</p>
`;
    if (empty) html += `        <p class="audit-group__note">No checks in this category apply to this site.</p>\n`;
    if (category.rows.length > 0) {
      html += `        <div class="pscore__checks">\n`;
      for (const row of category.rows) html += renderCheck(row);
      html += `        </div>\n`;
    }
    html += `      </div>
      <span class="stpill stpill--${pill.cls}">${pill.text}</span>
    </li>
`;
  }

  html += `  </ol>
</section>
<section class="scorecard-cta">
  <p class="scorecard-cta__note">${WEB_CTA_NOTE_HTML}</p>
</section>
<script defer src="/js/webmcp.js"></script>
</article>`;
  return html;
}

function renderCheck(row: SummaryRow): string {
  const resourceLinks = [
    ...row.resources.map((r) => `<a href="${escHtml(r.url)}" rel="noopener">${escHtml(r.label)}</a>`),
    `<a href="${escHtml(row.skillUrl)}">Fix skill</a>`,
  ].join(' · ');

  let body = `      <p class="web-check__goal"><strong>Goal:</strong> ${escHtml(row.goal)}.</p>
      <p class="web-check__result"><strong>Result:</strong> ${escHtml(row.result)}</p>
`;
  if (row.fixable) {
    body += `      <p class="web-check__fix"><strong>Fix:</strong> ${escHtml(row.fix)}</p>\n`;
  }
  body += `      <p class="web-check__resources"><strong>Resources:</strong> ${resourceLinks}</p>\n`;
  if (row.fixable) {
    body += `      <span class="web-check__prompt" data-copy-text="${escHtml(row.prompt)}" data-keyword="${escHtml(row.keyword ?? '')}" data-status="${escHtml(row.status)}" hidden></span>\n`;
  }

  // The row root is the canonical record: keyword, tier, status, and unprobed
  // ride here on every row, including the ones that carry no prompt, so a
  // reader never has to infer priority from a conditional child that only
  // actionable rows emit.
  const rootMeta = ` data-keyword="${escHtml(row.keyword ?? '')}" data-tier="${escHtml(row.tier ?? '')}" data-status="${escHtml(row.status)}" data-unprobed="${row.unprobed ? 'true' : 'false'}"`;

  return `    <details class="web-check web-check--${row.status}"${row.fixable ? ' open' : ''} data-id="${escHtml(row.id)}"${rootMeta}>
      <summary><span class="web-check__mark" aria-hidden="true">${statusMark(row.status)}</span> <span class="web-check__label">${escHtml(row.label)}</span> ${tierChip(row.keyword)}<span class="audit__status">${escHtml(statusLabel(row.status))}</span></summary>
${body}    </details>
`;
}
