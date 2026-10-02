// HTML body for a website result page.
//
// The page opens with the shared result spine and score head, then groups
// the checks under the registry's visible categories (carried on
// scorecard.categories[] in category_order) as C-rows: each row carries
// the category's passed-of-counted rollup as its status and nests the
// per-check Goal / Result / Fix / Resources details. The CLI renderer
// groups by the P1-P8 principles instead, which are a hidden tag here.
//
// Between the score note and the checks sits the Declared hosts slot, the
// hosts the site points agents to and what the audit did with each. The
// markdown twin keeps the fenced prompt the page withholds, so fetch-only
// agents lose nothing.

import { escHtml } from '../../shared/esc-html';
import { bandOf } from '../../shared/meter';
import { renderBigScore, renderResultSpine, type SpineInput } from '../../shared/result-spine';
import type { WebAuditFreshness } from './cache';
import { WEB_CTA_NOTE_HOSTS_HTML, WEB_CTA_NOTE_HTML } from './copy';
import { notRunCategoryNote, notRunCount } from './provenance-copy';
import { richHtml } from './rich-text';
import { freshnessHtml } from './summary-freshness';
import { type WebSummaryInput, webSummaryView } from './summary-input';
import { RELATIVE_LABEL, RELATIVE_SUBLABEL, STATUS_ORDER } from './summary-labels';
import { renderItems, renderLane } from './summary-render-checks';
import { declaredHostsHtml } from './summary-render-hosts';
import { transientReasonHtml } from './summary-transient';
import type { SummaryCategory, WebSummaryModel } from './summary-types';

/**
 * One hidden page-level record of what the page renders: both scores, the
 * complete per-status counts, the freshness envelope, and the follow state
 * and declared-hosts trail as stored. The counts come from the same model the
 * visible page renders, so a machine reader and a human reader cannot
 * disagree. A value the scorecard never recorded omits its attribute rather
 * than emitting an empty string, so a reader gets null instead of "".
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
  if (model.followDeclarations !== 'not-evaluated') {
    attrs.push(`data-follow-declarations="${model.followDeclarations === 'on' ? 'true' : 'false'}"`);
  }
  if (model.declaredHosts !== null) attrs.push(`data-declared-hosts="${escHtml(JSON.stringify(model.declaredHosts))}"`);
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

function scoreNoteHtml(model: WebSummaryModel): string {
  const clause = model.hostsClause === null ? '' : richHtml(model.hostsClause);
  const notRun = model.notRunNote === null ? '' : ` ${richHtml(model.notRunNote)}`;
  return `<p class="result-score__note">${escHtml(RELATIVE_SUBLABEL)}${clause}; global measures it against a maximally agent-ready site. Website <a href="${escHtml(model.targetUrl)}">${escHtml(model.targetUrl)}</a>.${notRun}</p>`;
}

function categoryHtml(category: SummaryCategory, index: number): string {
  const empty = category.counted === 0;
  const pill = categoryPill(category);
  const rollupBand = empty ? '' : ` ${bandOf((category.passed / category.counted) * 100)}`;
  const notRun = category.notRun > 0 ? ` · ${notRunCount(category.notRun)}` : '';
  let html = `    <li class="pscore__row pscore__row--category${empty ? ' pscore__row--empty' : ''}" data-category="${escHtml(category.id)}">
      <span class="spec__id">C${index}</span>
      <div class="pscore__body">
        <h3 class="spec__title audit-group__title">${escHtml(category.name)}</h3>
        <p class="pscore__evidence"><span class="audit-group__rollup${rollupBand}">${category.passed} / ${category.counted}</span> checks pass${notRun}</p>
`;
  if (category.hostLine !== null) {
    html += `        <p class="pscore__evidence pscore__evidence--host">${richHtml(category.hostLine)}</p>\n`;
  }
  if (empty) {
    const note =
      category.emptyReason === null
        ? 'No checks in this category apply to this site.'
        : richHtml(notRunCategoryNote(category.emptyReason));
    html += `        <p class="audit-group__note">${note}</p>\n`;
  }
  if (category.rows.length > 0) {
    const rows = category.lanes ? category.lanes.map(renderLane).join('') : renderItems(category.items);
    html += `        <div class="pscore__checks">\n${rows}        </div>\n`;
  }
  return `${html}      </div>
      <span class="stpill stpill--${pill.cls}">${pill.text}</span>
    </li>
`;
}

/** HTML body for a website result page. */
export function buildWebSummaryBody(input: WebSummaryInput): string {
  const { model, freshness, freshnessState } = webSummaryView(input);
  const spine: SpineInput = input.transient
    ? {
        target: input.domain,
        lane: 'web',
        tier: 'live',
        freshnessHtml: `<span data-web-audit-transient>${transientReasonHtml(input.transient)}</span>`,
        linked: false,
        control: null,
      }
    : (input.spine ?? {
        target: input.domain,
        lane: 'web',
        tier: 'cache',
        freshnessHtml: `<span data-web-audit-freshness>${freshnessHtml(freshnessState)}</span>`,
        linked: true,
        control: null,
      });

  let html = `<article class="container scorecard-page" data-web-audit-result>${renderResultSpine(spine)}${renderBigScore(
    {
      pct: model.relative,
      label: RELATIVE_LABEL,
      secondary: { value: String(model.global), label: 'global-ready' },
    },
  )}${scoreNoteHtml(model)}
${auditContextEl(model, freshness)}
${declaredHostsHtml(model.declaredHostsView)}<section class="pscore scorecard-audits" aria-labelledby="pscore-heading">
  <h2 id="pscore-heading">Checks by category</h2>
  <ol class="pscore__list">
${model.categories.map((category, i) => categoryHtml(category, i + 1)).join('')}  </ol>
</section>
`;
  // A result rendered in place has no page to re-audit from and runs on a
  // page that loads no in-page tools.
  if (!input.transient) {
    html += `<section class="scorecard-cta">
  <p class="scorecard-cta__note">${model.hostsClause === null ? WEB_CTA_NOTE_HTML : WEB_CTA_NOTE_HOSTS_HTML}</p>
</section>
<script defer src="/js/webmcp.js"></script>
`;
  }
  html += '</article>';
  return html;
}
