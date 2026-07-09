// Web result-page renderers (plan U9, reworked per plan-003 U14/KTD-8).
// The web scorecard renders standalone: grouped by visible category in
// the registry's category_order (carried on scorecard.categories[]),
// with per-category passed/counted rollups and per-check
// Goal / Result / Fix / Resources plus the copy-paste prompt. The
// shared scorecard-format renderer stays CLI-only (it groups by the
// P1-P8 principles, which are a hidden tag on web surfaces).
//
// The prompt renders as a <pre> block inside <main>, so the site-wide
// clipboard.js attaches its Copy button (idle / Copied / fallback
// states) with no page-specific JS.

import { escHtml } from '../../shared/scorecard-format.mjs';
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

  let html = `<nav class="scorecard-breadcrumb" aria-label="Breadcrumb">
  <a href="${escHtml(WEB_BREADCRUMB.href)}">${escHtml(WEB_BREADCRUMB.label)}</a>
</nav>
<header class="scorecard-header">
  <h1>${escHtml(name)}</h1>
  <p class="live-score-summary__meta">Website <a href="${escHtml(targetUrl)}">${escHtml(targetUrl)}</a> · agent-readiness audit</p>
</header>
<section class="scorecard-summary">
  <div class="scorecard-score-badge">
    <span class="scorecard-score-badge__pct">${relative}%</span>
    <span class="scorecard-score-badge__label">${escHtml(RELATIVE_LABEL)}</span>
  </div>
  <p class="scorecard-summary__note">${escHtml(RELATIVE_SUBLABEL)}. <strong>Global:</strong> ${globalScore}% ${escHtml(GLOBAL_LABEL)}.</p>
</section>
<section class="scorecard-audits">
  <h2>Checks by category</h2>
`;

  for (const category of sc.categories ?? []) {
    const rows = byCategory.get(category.id) ?? [];
    const empty = category.counted === 0;
    html += `  <div class="audit-group${empty ? ' audit-group--empty' : ''}">
    <h3 class="audit-group__title">${escHtml(category.name)} <span class="audit-group__rollup">${category.passed}/${category.counted}</span></h3>
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
</section>`;
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
    body += `      <p class="web-check__prompt-label">Copy-paste prompt for your coding agent:</p>
      <pre><code>${escHtml(assembled.prompt)}</code></pre>
`;
  }

  return `    <details class="web-check web-check--${row.status}"${fixable ? ' open' : ''}>
      <summary><span class="audit__status">${escHtml(statusLabel(row.status))}</span> <span class="web-check__label">${escHtml(row.label)}</span></summary>
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
