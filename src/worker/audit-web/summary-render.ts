// HTML body for /web/<domain>.
//
// The web scorecard renders standalone: grouped by visible category in the
// registry's category_order (carried on scorecard.categories[]), with
// per-category passed/counted rollups and per-check Goal / Result / Fix /
// Resources. The shared scorecard-format renderer stays CLI-only, since it
// groups by the P1-P8 principles, which are a hidden tag on web surfaces.
//
// The copy-paste prompt is never rendered: renderCheck emits it in a hidden
// `data-copy-text` carrier and the site-wide clipboard.js attaches a
// Copy-prompt button client-side, so a no-JS render shows the prose and
// resource links with no dead control. The markdown twin keeps the fenced
// prompt so fetch-only agents lose nothing.

import { bandOf, escHtml, renderMeter } from '../../shared/scorecard-format.mjs';
import type { WebAuditFreshness } from './cache';
import { WEB_BREADCRUMB, WEB_CTA_NOTE_HTML } from './copy';
import { freshnessHtml } from './summary-freshness';
import { type WebSummaryInput, webSummaryView } from './summary-input';
import {
  RELATIVE_LABEL,
  RELATIVE_SUBLABEL,
  STATUS_ORDER,
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

function heroChips(counts: WebSummaryModel['counts']): string[] {
  const chips: string[] = [];
  if (counts.pass) chips.push(`<span class="chip chip--ok">${counts.pass} pass</span>`);
  if (counts.noncompliant) chips.push(`<span class="chip chip--warn">${counts.noncompliant} noncompliant</span>`);
  if (counts.absent) chips.push(`<span class="chip chip--warn">${counts.absent} missing</span>`);
  if (counts.broken) chips.push(`<span class="chip chip--fail">${counts.broken} broken</span>`);
  if (counts.error) {
    chips.push(`<span class="chip chip--fail">${counts.error} error${counts.error === 1 ? '' : 's'}</span>`);
  }
  const naCount = counts.n_a + counts.skip;
  if (naCount) chips.push(`<span class="chip chip--muted">${naCount} n/a</span>`);
  return chips;
}

/** HTML body for /web/<domain>. */
export function buildWebSummaryBody(input: WebSummaryInput): string {
  const { model, freshness, freshnessState } = webSummaryView(input);
  const chips = heroChips(model.counts);

  let html = `<article class="container scorecard-page" data-web-audit-result><nav class="crumb" aria-label="Breadcrumb">
  <a href="${escHtml(WEB_BREADCRUMB.href)}">${escHtml(WEB_BREADCRUMB.label)}</a><span class="sep" aria-hidden="true">/</span><span>${escHtml(model.name)}</span>
</nav>
<header class="scorecard-hero">
  <div class="scorecard-hero__id">
    <h1>${escHtml(model.name)}</h1>
    <p class="live-score-summary__meta">Website <a href="${escHtml(model.targetUrl)}">${escHtml(model.targetUrl)}</a> · agent-readiness audit</p>
${chips.length > 0 ? `    <div class="chiprow">${chips.join('')}</div>\n` : ''}    <p class="scorecard-hero__note">${escHtml(RELATIVE_SUBLABEL)}; global measures it against a maximally agent-ready site.</p>
    <p class="scorecard-hero__note" data-web-audit-freshness>${freshnessHtml(freshnessState)}</p>
  </div>
  <div class="scorecard-hero__scores">
    <div class="scorecell ${bandOf(model.relative)}"><span class="bigscore__n">${model.relative}</span><span class="bigscore__l">${escHtml(RELATIVE_LABEL)}</span>${renderMeter(model.relative, { num: null })}</div>
    <div class="scorecell ${bandOf(model.global)}"><span class="bigscore__n">${model.global}</span><span class="bigscore__l">global-ready</span>${renderMeter(model.global, { num: null })}</div>
  </div>
</header>
${auditContextEl(model, freshness)}
<section class="scorecard-audits" aria-label="Checks by category">
`;

  let catIndex = 0;
  for (const category of model.categories) {
    catIndex += 1;
    const empty = category.counted === 0;
    const rollupBand = empty ? '' : ` ${bandOf((category.passed / category.counted) * 100)}`;
    html += `  <div class="catcard${empty ? ' catcard--empty' : ''}">
    <div class="catcard__hd">
      <span class="spec__id">C${catIndex}</span>
      <h3 class="audit-group__title">${escHtml(category.name)}</h3>
      <span class="audit-group__rollup${rollupBand}">${category.passed} / ${category.counted}</span>
    </div>
`;
    if (empty) {
      html += `    <p class="audit-group__note">No checks in this category apply to this site.</p>\n`;
    }
    for (const row of category.rows) {
      html += renderCheck(row);
    }
    html += '  </div>\n';
  }

  html += `</section>
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
