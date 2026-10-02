// Markdown twin for /web/<domain>.md. Absolute links so a cross-origin fetch
// resolves them, and the fenced copy-paste prompt the HTML page withholds.

import { auditPath } from '../../shared/audit-routes';
import { resultFrontMatter } from '../../shared/result-spine';
import { CANONICAL_SITE_URL } from '../../shared/site-url';
import { WEB_SURFACE_NOTE_HOSTS } from './copy';
import { DECLARED_HOSTS_HEADING, notRunCategoryNote, notRunCount } from './provenance-copy';
import { type Rich, richMarkdown } from './rich-text';
import { freshnessMarkdown } from './summary-freshness';
import { type WebSummaryInput, webSummaryView } from './summary-input';
import { GLOBAL_LABEL, RELATIVE_SUBLABEL, statusLabel, TIER_LABELS } from './summary-labels';
import type { DeclaredHostsView, TrailEntryView } from './summary-trail';
import type { SummaryCategory, SummaryItem, SummaryRow } from './summary-types';

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

function renderCheck(row: SummaryRow, lines: string[], heading: string, grouped: boolean): void {
  lines.push(`${heading} ${statusLabel(row.status)} — ${row.label}`, '');
  if (row.keyword && row.keyword in TIER_LABELS) lines.push(`- Tier: ${TIER_LABELS[row.keyword]}`);
  if (!grouped && row.hostNote !== null) lines.push(`- Host: ${richMarkdown([{ code: row.recordedHosts[0] }])}`);
  if (!grouped && row.remedy !== null) lines.push(`- Note: ${richMarkdown(row.remedy)}`);
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

function renderItems(items: readonly SummaryItem[], lines: string[], heading: string): void {
  for (const item of items) {
    if (item.kind === 'row') renderCheck(item.row, lines, heading, false);
    else for (const row of item.rows) renderCheck(row, lines, heading, true);
  }
}

/** "(n/n)" with ", N not run" when the audit could not run some rows, or "(N not run)" when it counted none. */
function countSuffix(counts: { passed: number; counted: number; notRun: number }, always: boolean): string {
  const parts: string[] = [];
  if (always || counts.counted > 0) parts.push(`${counts.passed}/${counts.counted}`);
  if (counts.notRun > 0) parts.push(notRunCount(counts.notRun));
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

function renderCategory(category: SummaryCategory, lines: string[]): void {
  lines.push(`## ${category.name}${countSuffix(category, true)}`, '');
  if (category.hostLine !== null) lines.push(`${richMarkdown(category.hostLine)}.`, '');
  for (const sentence of category.notRunSentences) {
    lines.push(`${mdInline(sentence.text)} ${richMarkdown(sentence.remedy)}`, '');
  }
  if (category.counted === 0) {
    const note: Rich =
      category.emptyReason === null
        ? ['No checks in this category apply to this site.']
        : notRunCategoryNote(category.emptyReason);
    lines.push(richMarkdown(note), '');
  }
  if (!category.lanes) {
    renderItems(category.items, lines, '###');
    return;
  }
  for (const lane of category.lanes) {
    lines.push(`### ${lane.label}${countSuffix(lane, false)}`, '', `${lane.note}.`, '');
    renderItems(lane.items, lines, '####');
  }
}

function entryMarkdown(entry: TrailEntryView): string[] {
  const parts = [`${richMarkdown(entry.surface)}: ${richMarkdown([{ code: entry.host }])}`];
  if (entry.url !== null) parts[0] += ` (${richMarkdown([{ code: entry.url }])})`;
  if (entry.redirectedTo !== null) parts.push(`redirected to ${richMarkdown([{ code: entry.redirectedTo }])}`);
  parts.push(richMarkdown([entry.outcome]));
  if (entry.why !== null) parts.push(richMarkdown(entry.why));
  const lines = [`- ${parts.join(', ')}`];
  if (entry.guidance !== null) lines.push(`  ${richMarkdown(entry.guidance)}`);
  return lines;
}

function renderDeclaredHosts(view: DeclaredHostsView, lines: string[]): void {
  if (view.kind === 'line') {
    lines.push(view.line, '');
    return;
  }
  lines.push(`## ${DECLARED_HOSTS_HEADING}`, '', mdInline(view.lede), '');
  for (const entry of view.entries) lines.push(...entryMarkdown(entry));
  lines.push('');
}

/** Markdown twin for /web/<domain>.md. */
export function buildWebSummaryMarkdown(input: WebSummaryInput): string {
  const { model, freshnessState } = webSummaryView(input);
  const origin = input.origin ?? CANONICAL_SITE_URL;

  const lines: string[] = [];
  if (input.links) {
    lines.push(
      resultFrontMatter({ target: input.domain, lane: 'web', tier: input.spine?.tier ?? 'cache', links: input.links }),
    );
  }
  const clause = model.hostsClause === null ? '' : richMarkdown(model.hostsClause);
  lines.push(
    `# ${model.name} — Agent-Readiness Audit`,
    '',
    `Website: [${model.targetUrl}](${model.targetUrl})`,
    '',
    `**Score:** ${model.relative}% (${RELATIVE_SUBLABEL}${clause})`,
    `**Global:** ${model.global}% ${GLOBAL_LABEL}`,
    '',
  );
  if (model.notRunNote !== null) lines.push(richMarkdown(model.notRunNote), '');
  lines.push(freshnessMarkdown(freshnessState, model.registryFingerprint), '');
  renderDeclaredHosts(model.declaredHostsView, lines);
  for (const category of model.categories) renderCategory(category, lines);

  const reaudit = `${origin}${auditPath({ lane: 'web', target: input.domain })}`;
  const surface = model.hostsClause === null ? '' : `${WEB_SURFACE_NOTE_HOSTS} `;
  lines.push(
    '## Re-run this audit',
    '',
    `${surface}Re-audit from [${reaudit}](${reaudit}), or call the \`audit_website\` MCP tool.`,
    '',
  );
  return lines.join('\n');
}
