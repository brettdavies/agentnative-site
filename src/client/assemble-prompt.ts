// Assemble failed-check prompts by RFC-2119 tier. Pure selection so the
// result-page widget and its tests share one join rule: MUST failures
// (broken ∪ noncompliant ∪ absent) by default; SHOULD and MAY are opt-in
// independently. Pass / n_a / skip / error rows never join.

export type AssembleCarrier = {
  keyword: string;
  status: string;
  prompt: string;
};

export type AssembleOpts = {
  includeShould: boolean;
  includeMay: boolean;
};

const FIXABLE = new Set(['broken', 'noncompliant', 'absent']);

export function selectAssemblePrompts(rows: readonly AssembleCarrier[], opts: AssembleOpts): string {
  const allowed = new Set<string>(['must']);
  if (opts.includeShould) allowed.add('should');
  if (opts.includeMay) allowed.add('may');
  const parts: string[] = [];
  for (const row of rows) {
    if (!FIXABLE.has(row.status)) continue;
    if (!allowed.has(row.keyword)) continue;
    if (row.prompt.length === 0) continue;
    parts.push(row.prompt);
  }
  return parts.join('\n\n');
}

/** Read carriers in document order (category then check, matching the page). */
export function carriersFromElements(nodes: Iterable<Element>): AssembleCarrier[] {
  const out: AssembleCarrier[] = [];
  for (const el of nodes) {
    out.push({
      keyword: el.getAttribute('data-keyword') ?? '',
      status: el.getAttribute('data-status') ?? '',
      prompt: el.getAttribute('data-copy-text') ?? '',
    });
  }
  return out;
}
