// Markdown twin for /web/<domain>.md. Absolute links so a cross-origin fetch
// resolves them, and the fenced copy-paste prompt the HTML page withholds.

import { CANONICAL_SITE_URL } from '../../shared/site-url';
import { freshnessMarkdown } from './summary-freshness';
import { type WebSummaryInput, webSummaryView } from './summary-input';
import { GLOBAL_LABEL, RELATIVE_SUBLABEL, type SummaryRow, statusLabel, TIER_LABELS } from './summary-model';

// Evidence strings carry probed-server values (serverInfo names, Allow-Origin
// headers), so the target controls them. The HTML twin neutralizes them
// through escHtml; here a newline breaks out of the bullet and a backtick
// opens a code span, so inline text is flattened and fenced blocks lose any
// embedded fence.
function mdInline(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replaceAll('`', '\\`');
}

function mdFenced(text: string): string {
  return text.replaceAll('```', "'''");
}

function renderCheck(row: SummaryRow, lines: string[]): void {
  lines.push(`### ${statusLabel(row.status)} — ${row.label}`, '');
  if (row.keyword && row.keyword in TIER_LABELS) lines.push(`- Tier: ${TIER_LABELS[row.keyword]}`);
  lines.push(`- Goal: ${row.goal}.`);
  lines.push(`- Result: ${mdInline(row.result)}`);
  if (row.fixable) lines.push(`- Fix: ${row.fix.replace(/\s*\n\s*/g, ' ')}`);
  const resources = [...row.resources.map((r) => `[${r.label}](${r.url})`), `[Fix skill](${row.skillUrl})`];
  lines.push(`- Resources: ${resources.join(', ')}`);
  if (row.fixable) {
    lines.push('', '```text', mdFenced(row.prompt), '```');
  }
  lines.push('');
}

/** Markdown twin for /web/<domain>.md. */
export function buildWebSummaryMarkdown(input: WebSummaryInput): string {
  const { model, freshnessState } = webSummaryView(input);
  const origin = input.origin ?? CANONICAL_SITE_URL;

  const lines: string[] = [
    `# ${model.name} — Agent-Readiness Audit`,
    '',
    `Website: [${model.targetUrl}](${model.targetUrl})`,
    '',
    `**Score:** ${model.relative}% (${RELATIVE_SUBLABEL})`,
    `**Global:** ${model.global}% ${GLOBAL_LABEL}`,
    '',
    freshnessMarkdown(freshnessState),
    '',
  ];

  for (const category of model.categories) {
    lines.push(`## ${category.name} (${category.passed}/${category.counted})`, '');
    if (category.counted === 0) {
      lines.push('No checks in this category apply to this site.', '');
    }
    for (const row of category.rows) renderCheck(row, lines);
  }

  lines.push(
    '## Re-run this audit',
    '',
    `Re-run from [${origin}/web-audit](${origin}/web-audit), or call the \`audit_website\` MCP tool.`,
    '',
  );
  return lines.join('\n');
}
