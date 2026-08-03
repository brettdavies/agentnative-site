// Read-time display enrichment for a stored web scorecard. Storage keeps
// the raw scorecard (the category shape at audit time, no remediation);
// presentation is derived on read so every render of a cached scorecard
// reflects the current registry and remediation catalog regardless of
// when it was cached.
//
// Two enrichments compose here and are the single source of truth the
// full-result surfaces share:
//   - normalizeScorecardCategories re-derives each row's display category
//     from the current registry (by check id) and rebuilds categories[],
//     without recomputing the stored score — a category split earns no
//     points, so re-grouping cannot desync display from the stored score.
//   - attachInlineRemediation adds a derived result line to every row and
//     an inline remediation object to every non-passing row.
// Both degrade gracefully: a payload without a results[] array passes
// through unchanged, and a row whose id is absent from the registry keeps
// its stored category.

import { assembleRemediation, resultLine, type WebRemediationCatalog } from './remediation';
import { categoryRollups } from './score';
import type { NaReason, ScorecardStatus } from './scorecard';

/** The registry fields the enrichment reads; a full registry satisfies it. */
export interface DisplayRegistry {
  category_order: readonly string[];
  categories: Record<string, string>;
  checks: ReadonlyArray<{ id: string; category: string }>;
}

type EnrichableRow = {
  id: string;
  status: ScorecardStatus;
  category?: string;
  evidence?: string | null;
  na_reason?: NaReason;
};

/**
 * Loose structural guard mirroring the stored-scorecard contract: a hit
 * carries a results[] array. A minimal or malformed payload (no array)
 * passes through the enrichers unchanged.
 */
function hasResults(value: unknown): value is { results: EnrichableRow[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { results?: unknown }).results);
}

/**
 * The display order: the registry's category_order, then any categories
 * referenced by rows but absent from it (order-preserving), so a row in a
 * removed-check category still renders instead of vanishing.
 */
function displayCategoryOrder(rows: ReadonlyArray<{ category: string }>, registryOrder: readonly string[]): string[] {
  const order = [...registryOrder];
  const known = new Set(registryOrder);
  for (const row of rows) {
    if (row.category && !known.has(row.category)) {
      known.add(row.category);
      order.push(row.category);
    }
  }
  return order;
}

/**
 * Re-derive each row's display category from the current registry and
 * rebuild categories[]; the stored score and summaries are untouched.
 */
export function normalizeScorecardCategories(stored: unknown, registry: DisplayRegistry): unknown {
  if (!hasResults(stored)) return stored;
  const categoryById = new Map(registry.checks.map((check) => [check.id, check.category]));
  const rows = stored.results.map((row) => {
    const category = categoryById.get(row.id) ?? row.category;
    return { ...row, category };
  });
  const rollupInput = rows.map((row) => ({ category: row.category ?? '', status: row.status }));
  const order = displayCategoryOrder(rollupInput, registry.category_order);
  const categories = categoryRollups(rollupInput, order, registry.categories);
  return { ...stored, categories, results: rows };
}

/**
 * Add a derived result line to every row and an inline remediation object
 * to each non-passing (broken / absent) row. Passing and n_a / skip rows
 * carry a result line but no remediation. `origin` targets the skill link.
 */
export function attachInlineRemediation(scorecard: unknown, catalog: WebRemediationCatalog, origin: string): unknown {
  if (!hasResults(scorecard)) return scorecard;
  return {
    ...scorecard,
    results: scorecard.results.map((row) => {
      const result = resultLine(row.status, row.evidence ?? null, row.na_reason);
      if (row.status === 'broken' || row.status === 'absent') {
        const remediation = assembleRemediation(catalog[row.id], {
          checkId: row.id,
          origin,
          evidence: row.evidence ?? null,
        });
        return { ...row, result, remediation };
      }
      return { ...row, result };
    }),
  };
}

/** Full read-time enrichment for the MCP JSON surfaces: split categories then per-row remediation. */
export function enrichWebScorecardForDisplay(
  stored: unknown,
  opts: { registry: DisplayRegistry; catalog: WebRemediationCatalog; origin: string },
): unknown {
  return attachInlineRemediation(normalizeScorecardCategories(stored, opts.registry), opts.catalog, opts.origin);
}
