// Web result-page renderers (plan U9, reworked per plan-003 U14/KTD-8).
// The web scorecard renders standalone: grouped by visible category in
// the registry's category_order (carried on scorecard.categories[]),
// with per-category passed/counted rollups and per-check
// Goal / Result / Fix / Resources plus the copy-paste prompt. The
// shared scorecard-format renderer stays CLI-only (it groups by the
// P1-P8 principles, which are a hidden tag on web surfaces).
//
// The copy-paste prompt is not rendered in the HTML: renderCheck emits it
// in a hidden `data-copy-text` carrier and the site-wide clipboard.js
// attaches a Copy-prompt button client-side. The markdown twin keeps the
// fenced prompt so fetch-only agents lose nothing.

import { bandOf, escHtml, renderMeter } from '../../shared/scorecard-format.mjs';
import { WEB_BREADCRUMB, WEB_CTA_NOTE_HTML } from './copy';
import { assembleRemediation, resultLine, type WebRemediationCatalog } from './remediation';
import type { NaReason, ScorecardStatus } from './scorecard';

type WebScorecardRow = {
  id: string;
  label: string;
  category?: string;
  keyword?: string;
  status: ScorecardStatus;
  na_reason?: NaReason;
  evidence: string | null;
};

type WebScorecardShape = {
  spec_version?: string;
  target_url?: string;
  tool?: { name?: string; url?: string };
  score_pct?: number;
  score?: { relative?: number; global?: number };
  categories?: Array<{ id: string; name: string; passed: number; counted: number }>;
  results?: WebScorecardRow[];
};

export interface WebSummaryInput {
  scorecard: WebScorecardShape;
  domain: string;
  targetUrl: string;
  /** Static remediation catalog; absent entries degrade to generic prompts. */
  remediation?: WebRemediationCatalog;
  /** Origin for skill links in prompts; defaults to the canonical site. */
  origin?: string;
}

// Locked label strings for the two scores (U14 open question): the
// RELATIVE headline reads as the site's own score; GLOBAL is explicitly
// framed against the maximal site so the two percentages don't compete.
const RELATIVE_LABEL = 'site score';
const RELATIVE_SUBLABEL = 'relative to the checks that apply to this site';
const GLOBAL_LABEL = 'of a maximally agent-ready site';

const STATUS_LABELS: Record<ScorecardStatus, string> = {
  pass: 'PASS',
  broken: 'BROKEN',
  absent: 'MISSING',
  n_a: 'N/A',
  skip: 'SKIP',
  error: 'ERROR',
};

function statusLabel(status: ScorecardStatus): string {
  return STATUS_LABELS[status] ?? String(status).toUpperCase();
}

// Check-row marks: pass ✓, absent (missing) !, broken/error ✕, n_a/skip –.
// Broken outranks absent in severity — a present-but-broken surface
// misleads agents — so it carries the fail mark.
const STATUS_MARKS: Record<ScorecardStatus, string> = {
  pass: '✓',
  broken: '✕',
  absent: '!',
  n_a: '–',
  skip: '–',
  error: '✕',
};

function statusMark(status: ScorecardStatus): string {
  return STATUS_MARKS[status] ?? '–';
}

// Display tier per registry category id — mirrors the homepage's five
// web-check rows (src/build/06-homepage.mjs WEB_CHECKS).
const CATEGORY_TIERS: Record<string, string> = {
  discoverability: 'MUST',
  'content-for-agents': 'MUST',
  'bot-crawl-policy': 'SHOULD',
  'mcp-api': 'MUST',
  'agent-discovery-auth': 'MAY',
};

function isFixable(status: ScorecardStatus): boolean {
  return status === 'broken' || status === 'absent';
}

function scoresOf(scorecard: WebScorecardShape): { relative: number; global: number } {
  return {
    relative: scorecard.score?.relative ?? scorecard.score_pct ?? 0,
    global: scorecard.score?.global ?? 0,
  };
}

function rowsByCategory(scorecard: WebScorecardShape): Map<string, WebScorecardRow[]> {
  const byCategory = new Map<string, WebScorecardRow[]>();
  for (const row of scorecard.results ?? []) {
    const key = row.category ?? '';
    const bucket = byCategory.get(key) ?? [];
    bucket.push(row);
    byCategory.set(key, bucket);
  }
  return byCategory;
}

/** HTML body for /web/<domain>. */
export function buildWebSummaryBody(input: WebSummaryInput): string {
  const sc = input.scorecard;
  const origin = input.origin ?? 'https://anc.dev';
  const catalog = input.remediation ?? {};
  const { relative, global: globalScore } = scoresOf(sc);
  const name = sc.tool?.name ?? input.domain;
  const targetUrl = sc.tool?.url ?? input.targetUrl;
  const byCategory = rowsByCategory(sc);

  // Status-count chips for the hero.
  const counts: Record<string, number> = {};
  for (const row of sc.results ?? []) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const chips: string[] = [];
  if (counts.pass) chips.push(`<span class="chip chip--ok">${counts.pass} pass</span>`);
  if (counts.absent) chips.push(`<span class="chip chip--warn">${counts.absent} missing</span>`);
  if (counts.broken) chips.push(`<span class="chip chip--fail">${counts.broken} broken</span>`);
  if (counts.error)
    chips.push(`<span class="chip chip--fail">${counts.error} error${counts.error === 1 ? '' : 's'}</span>`);
  const naCount = (counts.n_a ?? 0) + (counts.skip ?? 0);
  if (naCount) chips.push(`<span class="chip chip--muted">${naCount} n/a</span>`);

  let html = `<article class="container scorecard-page"><nav class="crumb" aria-label="Breadcrumb">
  <a href="${escHtml(WEB_BREADCRUMB.href)}">${escHtml(WEB_BREADCRUMB.label)}</a><span class="sep" aria-hidden="true">/</span><span>${escHtml(name)}</span>
</nav>
<header class="scorecard-hero">
  <div class="scorecard-hero__id">
    <h1>${escHtml(name)}</h1>
    <p class="live-score-summary__meta">Website <a href="${escHtml(targetUrl)}">${escHtml(targetUrl)}</a> · agent-readiness audit</p>
${chips.length > 0 ? `    <div class="chiprow">${chips.join('')}</div>\n` : ''}    <p class="scorecard-hero__note">${escHtml(RELATIVE_SUBLABEL)}; global measures it against a maximally agent-ready site.</p>
  </div>
  <div class="scorecard-hero__scores">
    <div class="scorecell ${bandOf(relative)}"><span class="bigscore__n">${relative}</span><span class="bigscore__l">${escHtml(RELATIVE_LABEL)}</span>${renderMeter(relative, { num: null })}</div>
    <div class="scorecell ${bandOf(globalScore)}"><span class="bigscore__n">${globalScore}</span><span class="bigscore__l">global-ready</span>${renderMeter(globalScore, { num: null })}</div>
  </div>
</header>
<section class="scorecard-audits" aria-label="Checks by category">
`;

  let catIndex = 0;
  for (const category of sc.categories ?? []) {
    catIndex += 1;
    const rows = byCategory.get(category.id) ?? [];
    const empty = category.counted === 0;
    const tier = CATEGORY_TIERS[category.id] ?? 'MUST';
    const rollupBand = empty ? '' : ` ${bandOf((category.passed / category.counted) * 100)}`;
    html += `  <div class="catcard${empty ? ' catcard--empty' : ''}">
    <div class="catcard__hd tier-${tier.toLowerCase()}">
      <span class="spec__id">C${catIndex}</span>
      <h3 class="audit-group__title">${escHtml(category.name)}</h3>
      <span class="tier">${tier}</span>
      <span class="audit-group__rollup${rollupBand}">${category.passed} / ${category.counted}</span>
    </div>
`;
    if (empty) {
      html += `    <p class="audit-group__note">No checks in this category apply to this site.</p>\n`;
    }
    for (const row of rows) {
      html += renderCheck(row, catalog, origin);
    }
    html += '  </div>\n';
  }

  html += `</section>
<section class="scorecard-cta">
  <p class="scorecard-cta__note">${WEB_CTA_NOTE_HTML}</p>
</section></article>`;
  return html;
}

function renderCheck(row: WebScorecardRow, catalog: WebRemediationCatalog, origin: string): string {
  const entry = catalog[row.id];
  const result = resultLine(row.status, row.evidence, row.na_reason);
  const fixable = isFixable(row.status);
  const assembled = assembleRemediation(entry, { checkId: row.id, origin, evidence: row.evidence });
  const goal = entry?.goal ?? assembled.goal;

  const resourceLinks = [
    ...assembled.resources.map((r) => `<a href="${escHtml(r.url)}" rel="noopener">${escHtml(r.label)}</a>`),
    `<a href="${escHtml(assembled.skill_url)}">Fix skill</a>`,
  ].join(' · ');

  let body = `      <p class="web-check__goal"><strong>Goal:</strong> ${escHtml(goal)}.</p>
      <p class="web-check__result"><strong>Result:</strong> ${escHtml(result)}</p>
`;
  if (fixable) {
    body += `      <p class="web-check__fix"><strong>Fix:</strong> ${escHtml(assembled.fix)}</p>\n`;
  }
  body += `      <p class="web-check__resources"><strong>Resources:</strong> ${resourceLinks}</p>\n`;
  if (fixable) {
    // The prompt is never rendered in HTML; clipboard.js reads it from the
    // data attribute and attaches a Copy-prompt button client-side, so a
    // no-JS render shows the prose + resource links with no dead control.
    // The .md twin keeps the fenced prompt for fetch-only agents.
    body += `      <span class="web-check__prompt" data-copy-text="${escHtml(assembled.prompt)}" hidden></span>\n`;
  }

  return `    <details class="web-check web-check--${row.status}"${fixable ? ' open' : ''}>
      <summary><span class="web-check__mark" aria-hidden="true">${statusMark(row.status)}</span> <span class="web-check__label">${escHtml(row.label)}</span> <span class="audit__status">${escHtml(statusLabel(row.status))}</span></summary>
${body}    </details>
`;
}

/** Markdown twin for /web/<domain>.md. Absolute links for cross-origin fetch. */
export function buildWebSummaryMarkdown(input: WebSummaryInput): string {
  const sc = input.scorecard;
  const origin = input.origin ?? 'https://anc.dev';
  const catalog = input.remediation ?? {};
  const { relative, global: globalScore } = scoresOf(sc);
  const name = sc.tool?.name ?? input.domain;
  const targetUrl = sc.tool?.url ?? input.targetUrl;
  const byCategory = rowsByCategory(sc);

  const lines: string[] = [
    `# ${name} — Agent-Readiness Audit`,
    '',
    `Website: [${targetUrl}](${targetUrl})`,
    '',
    `**Score:** ${relative}% (${RELATIVE_SUBLABEL})`,
    `**Global:** ${globalScore}% ${GLOBAL_LABEL}`,
    '',
  ];

  for (const category of sc.categories ?? []) {
    const rows = byCategory.get(category.id) ?? [];
    lines.push(`## ${category.name} (${category.passed}/${category.counted})`, '');
    if (category.counted === 0) {
      lines.push('No checks in this category apply to this site.', '');
    }
    for (const row of rows) {
      const entry = catalog[row.id];
      const result = resultLine(row.status, row.evidence, row.na_reason);
      const fixable = isFixable(row.status);
      const assembled = assembleRemediation(entry, { checkId: row.id, origin, evidence: row.evidence });
      lines.push(`### ${statusLabel(row.status)} — ${row.label}`, '');
      lines.push(`- Goal: ${entry?.goal ?? assembled.goal}.`);
      lines.push(`- Result: ${result}`);
      if (fixable) lines.push(`- Fix: ${assembled.fix.replace(/\s*\n\s*/g, ' ')}`);
      const resources = [
        ...assembled.resources.map((r) => `[${r.label}](${r.url})`),
        `[Fix skill](${assembled.skill_url})`,
      ];
      lines.push(`- Resources: ${resources.join(', ')}`);
      if (fixable) {
        lines.push('', '```text', assembled.prompt, '```');
      }
      lines.push('');
    }
  }

  lines.push(
    '## Re-run this audit',
    '',
    'Re-run from [anc.dev/web-audit](https://anc.dev/web-audit), or call the `audit_website` MCP tool.',
    '',
  );
  return lines.join('\n');
}
