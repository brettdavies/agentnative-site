// Read-time display enrichment for a stored web scorecard. Storage keeps
// the raw scorecard (the category shape at audit time, no remediation);
// presentation is derived on read so every render of a cached scorecard
// reflects the current registry and remediation catalog regardless of
// when it was cached.
//
// Three enrichments compose here and are the single source of truth the
// full-result surfaces share:
//   - normalizeScorecardCategories re-derives each row's display category,
//     normative keyword, and tier from the current registry (by check id)
//     and rebuilds categories[], without recomputing the stored score — a
//     category split earns no points, so re-grouping cannot desync display
//     from the stored score, and keyword/tier are presentation facts the
//     registry owns rather than values the run computed.
//   - attachDefaultRowHosts gives a row stored without provenance the
//     audited host, so every surface reads that row the same way.
//   - attachInlineRemediation adds a derived result line to every row, an
//     inline remediation object to every non-passing row, and the sentences
//     the result page shows for rows the audit could not run.
// All degrade gracefully: a payload without a results[] array passes
// through unchanged, and a row whose id is absent from the registry keeps
// its stored category, keyword, and tier. Top-level fields pass through as
// stored, so a scorecard without a follow state, trail, or registry
// fingerprint still reads as not evaluated rather than as an empty record.

import { isNotRunReason } from '../../shared/web-audit-findings';
import { resultLine } from '../../shared/web-audit-result-line';
import { entryHostOf, type RowHost, recordedHostOf, recordsRowHosts, rowHostOf, rowHostOutcomes } from './provenance';
import { notRunRemedy, notRunScoreNote } from './provenance-copy';
import { assembleRemediation, isFixableStatus, type WebRemediationCatalog } from './remediation';
import { richMarkdown } from './rich-text';
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
  hosts?: RowHost[];
  host?: string;
};

/**
 * Loose structural guard mirroring the stored-scorecard contract: a hit
 * carries a results[] array. A minimal or malformed payload (no array)
 * passes through the enrichers unchanged.
 */
function hasResults(value: unknown): value is { results: EnrichableRow[]; target_url?: unknown } {
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
 * Give each row that recorded no hosts the audited host, the reading every
 * surface applies to a row stored before provenance. A payload without a
 * parseable target URL passes through unchanged.
 */
export function attachDefaultRowHosts(scorecard: unknown): unknown {
  if (!hasResults(scorecard)) return scorecard;
  const entryHost = entryHostOf(scorecard.target_url);
  if (entryHost === null) return scorecard;
  return {
    ...scorecard,
    results: scorecard.results.map((row) =>
      recordsRowHosts(row) ? row : { ...row, hosts: [{ host: entryHost }], host: entryHost },
    ),
  };
}

/**
 * Add a derived result line to every row and an inline remediation object
 * to each non-passing (broken / noncompliant / absent) row. Passing,
 * n_a / skip, and unprobed rows carry a result line but no remediation: a
 * fix prompt derived from a request the run never sent names work the
 * audit never established was needed. A row the audit could not run from
 * where it ran carries `access_remedy`, the sentence the result page shows
 * for it, and the scorecard carries `access_note`, the score note's
 * sentence about every such row. `origin` targets the skill link.
 */
export function attachInlineRemediation(scorecard: unknown, catalog: WebRemediationCatalog, origin: string): unknown {
  if (!hasResults(scorecard)) return scorecard;
  const entryHost = entryHostOf(scorecard.target_url);
  const domain = entryHost ?? '';
  let notRun = 0;
  let signIn = false;
  const results = scorecard.results.map((row) => {
    const host = rowHostOf(row, entryHost);
    const result = resultLine(row.status, row.evidence ?? null, row.na_reason, host, rowHostOutcomes(row));
    if (row.status === 'n_a' && isNotRunReason(row.na_reason)) {
      notRun += 1;
      signIn ||= row.na_reason === 'auth-required';
      return { ...row, result, access_remedy: richMarkdown(notRunRemedy(row.na_reason, host, domain, 1)) };
    }
    if (row.unprobed !== true && isFixableStatus(row.status)) {
      const remediation = assembleRemediation(catalog[row.id], {
        checkId: row.id,
        origin,
        evidence: row.evidence ?? null,
        host: recordedHostOf(row),
      });
      return { ...row, result, remediation };
    }
    return { ...row, result };
  });
  return {
    ...scorecard,
    ...(notRun > 0 ? { access_note: richMarkdown(notRunScoreNote(notRun, domain, signIn)) } : {}),
    results,
  };
}

/**
 * Full read-time enrichment for the MCP JSON surfaces: split categories,
 * per-row remediation built from the hosts each row recorded, then default
 * row hosts for the rows that recorded none. A null registry skips the
 * category split (the stored shape stands) but the rest still applies, so a
 * failed registry load degrades the read rather than failing it.
 */
export function enrichWebScorecardForDisplay(
  stored: unknown,
  opts: { registry: DisplayRegistry | null; catalog: WebRemediationCatalog; origin: string },
): unknown {
  const normalized = opts.registry ? normalizeScorecardCategories(stored, opts.registry) : stored;
  return attachDefaultRowHosts(attachInlineRemediation(normalized, opts.catalog, opts.origin));
}
