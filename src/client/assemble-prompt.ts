// Read rendered result-page rows into the shared finding record, and
// apply the prompt-assembly widget's tier selection on top of the shared
// selector. Selection rules (which statuses are actionable, which tiers
// join) live in src/shared/web-audit-findings.ts so this widget and the
// WebMCP result tools cannot disagree; what stays here is the widget's
// own product behavior: MUST failures by default, SHOULD and MAY opt-in
// independently, and page order rather than priority order, because the
// copied text follows what the reader is looking at.

import { type FindingRow, matchFindings } from '../shared/web-audit-findings';

export type AssembleOpts = {
  includeShould: boolean;
  includeMay: boolean;
};

export function selectAssemblePrompts(rows: readonly FindingRow[], opts: AssembleOpts): string {
  const keywords = ['must'];
  if (opts.includeShould) keywords.push('should');
  if (opts.includeMay) keywords.push('may');
  const parts: string[] = [];
  for (const row of matchFindings(rows, { keywords }, { order: 'document' })) {
    if (row.prompt) parts.push(row.prompt);
  }
  return parts.join('\n\n');
}

/**
 * Read `.web-check[data-id]` roots in document order. The root is the
 * canonical record: keyword, tier, status, and unprobed ride there on
 * every row, while the prompt carrier is a child only actionable rows
 * emit.
 */
export function findingRowsFromElements(nodes: Iterable<Element>): FindingRow[] {
  const out: FindingRow[] = [];
  for (const el of nodes) {
    const id = el.getAttribute('data-id');
    if (!id) continue;
    out.push({
      id,
      keyword: el.getAttribute('data-keyword') ?? '',
      tier: el.getAttribute('data-tier') ?? '',
      status: el.getAttribute('data-status') ?? '',
      unprobed: el.getAttribute('data-unprobed') === 'true',
      prompt: el.querySelector('[data-copy-text]')?.getAttribute('data-copy-text') || null,
      order: out.length,
    });
  }
  return out;
}
