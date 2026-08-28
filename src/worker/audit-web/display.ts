// Read-time display enrichment for a stored web scorecard. Storage keeps
// the raw scorecard (the category shape at audit time, no remediation);
// presentation is derived on read so every render of a cached scorecard
// reflects the current registry and remediation catalog regardless of
// when it was cached.
//
// Two enrichments compose here and are the single source of truth the
// full-result surfaces share:
//   - normalizeScorecardCategories re-derives each row's display category,
//     normative keyword, and tier from the current registry (by check id)
//     and rebuilds categories[], without recomputing the stored score — a
//     category split earns no points, so re-grouping cannot desync display
//     from the stored score, and keyword/tier are presentation facts the
//     registry owns rather than values the run computed.
//   - attachInlineRemediation adds a derived result line to every row and
//     an inline remediation object to every non-passing row.
// Both degrade gracefully: a payload without a results[] array passes
// through unchanged, and a row whose id is absent from the registry keeps
// its stored category, keyword, and tier.

import { assembleRemediation, isFixableStatus, resultLine, type WebRemediationCatalog } from './remediation';
import { categoryRollups } from './score';
import type { NaReason, ScorecardStatus } from './scorecard';

/** The registry fields the enrichment reads; a full registry satisfies it. */
export interface DisplayRegistry {
  category_order: readonly string[];
  categories: Record<string, string>;
  checks: ReadonlyArray<{ id: string; category: string; keyword?: string; tier?: string }>;
}

type EnrichableRow = {
  id: string;
  status: ScorecardStatus;
  category?: string;
  keyword?: string;
  tier?: string;
  evidence?: string | null;
  na_reason?: NaReason;
  unprobed?: true;
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
 * Re-derive each row's display category, normative keyword, and tier from
 * the current registry and rebuild categories[]; the stored score and
 * summaries are untouched. A registry entry that omits keyword or tier
 * (a partial projection) leaves the stored value in place rather than
 * blanking it.
 */
export function normalizeScorecardCategories(stored: unknown, registry: DisplayRegistry): unknown {
  if (!hasResults(stored)) return stored;
  const checkById = new Map(registry.checks.map((check) => [check.id, check]));
  const rows = stored.results.map((row) => {
    const check = checkById.get(row.id);
    if (!check) return { ...row };
    const next: EnrichableRow = { ...row, category: check.category };
    if (check.keyword) next.keyword = check.keyword;
    if (check.tier) next.tier = check.tier;
    return next;
  });
  const rollupInput = rows.map((row) => ({ category: row.category ?? '', status: row.status }));
  const order = displayCategoryOrder(rollupInput, registry.category_order);
  const categories = categoryRollups(rollupInput, order, registry.categories);
  return { ...stored, categories, results: rows };
}

/**
 * Add a derived result line to every row and an inline remediation object
 * to each non-passing (broken / noncompliant / absent) row. Passing,
 * n_a / skip, and unprobed rows carry a result line but no remediation: a
 * fix prompt derived from a request the run never sent names work the
 * audit never established was needed. `origin` targets the skill link.
 */
export function attachInlineRemediation(scorecard: unknown, catalog: WebRemediationCatalog, origin: string): unknown {
  if (!hasResults(scorecard)) return scorecard;
  return {
    ...scorecard,
    results: scorecard.results.map((row) => {
      const result = resultLine(row.status, row.evidence ?? null, row.na_reason);
      if (row.unprobed !== true && isFixableStatus(row.status)) {
        const remediation = assembleRemediation(catalog[row.id], { checkId: row.id, origin });
        return { ...row, result, remediation };
      }
      return { ...row, result };
    }),
  };
}

/**
 * Full read-time enrichment for the MCP JSON surfaces: split categories
 * then per-row remediation. A null registry skips the category split (the
 * stored shape stands) but remediation is still attached, so a failed
 * registry load degrades the read rather than failing it.
 */
export function enrichWebScorecardForDisplay(
  stored: unknown,
  opts: { registry: DisplayRegistry | null; catalog: WebRemediationCatalog; origin: string },
): unknown {
  const normalized = opts.registry ? normalizeScorecardCategories(stored, opts.registry) : stored;
  return attachInlineRemediation(normalized, opts.catalog, opts.origin);
}
