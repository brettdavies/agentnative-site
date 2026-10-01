// Two-score web-audit scorer (plan-003 U4, KTD-3). Mirrors the
// scripts/scoring/score_model.py formula exactly; a committed fixture +
// parity test (tests/web-audit-two-score.test.ts) fails on divergence.
//
// RELATIVE ("for sites like yours") is the headline: earned points over
// the max achievable for THIS site's applicable set. GLOBAL is context:
// earned over the most a single site could earn, so a bigger correct
// routine outscores a small perfect one. Outcome scale: pass = +weight;
// noncompliant = +noncompliantCredit x weight (a surface an agent can
// use that violates a spec detail); broken = -brokenFactor x weight at
// every tier (a present-but-invalid surface misleads agents, so it costs
// more than absence); MUST absent is a full-weight zero; SHOULD absent is
// a zero occupying half its weight in the relative denominator; MAY
// absent arrives as n_a and is excluded from RELATIVE. Both scores floor
// at 0, and GLOBAL caps at 100.
//
// Per-tier point values are deliberately UNLOCKED config pending real
// anc100 audit data (n=1 today); the registry's per-check `weight` field
// is not consulted here.

import { NA_REASON_ONLY_WHEN_APPLICABLE } from '../../shared/web-audit-findings';
import type { WebAlternativeGroup, WebCheck } from './registry';
import type { EngineResult } from './scorecard';

export interface ScoreWeights {
  must: number;
  should: number;
  may: number;
}

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = { must: 5, should: 3, may: 1 };
export const DEFAULT_BROKEN_FACTOR = 0.75;

/**
 * Credit for a surface that serves an agent while violating a spec
 * detail. It is positive so that showing an imperfect capability beats
 * withdrawing it: a withheld surface and an absent one emit identical
 * bytes, so the auditor cannot tell them apart and the only lever against
 * withdrawal is to stop paying for it. It stays well below `pass` so
 * conformance still buys the difference.
 */
export const NONCOMPLIANT_CREDIT = 0.25;

/**
 * Statuses that carry an observation, so they occupy a slot in the
 * relative score and the category rollups. Everything else (n_a, skip,
 * error) carries none: it earns nothing and takes no relative slot or
 * rollup count, though the global denominator still counts its check.
 */
export const SCORED_STATUSES: ReadonlySet<string> = new Set(['pass', 'noncompliant', 'broken', 'absent']);

export interface ScoreConfig {
  weights?: ScoreWeights;
  brokenFactor?: number;
  noncompliantCredit?: number;
}

export interface WebScore {
  relative: number;
  global: number;
  earned: number;
}

/** Half-up rounding; Math.round for non-negative operands, made explicit
 * because score_model.py mirrors it (Python's round() is banker's). */
function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/** The registry fields the global universe reads. */
export interface UniverseRegistry {
  checks: ReadonlyArray<Pick<WebCheck, 'id' | 'keyword' | 'antecedent'>>;
  alternatives?: ReadonlyArray<WebAlternativeGroup>;
}

/** The row fields the global universe reads; a stored scorecard row carries every one. */
export type UniverseRow = Pick<EngineResult, 'id' | 'status' | 'na_reason'>;

function rowApplied(row: UniverseRow): boolean {
  return row.status !== 'n_a' || (row.na_reason !== undefined && NA_REASON_ONLY_WHEN_APPLICABLE[row.na_reason]);
}

/**
 * GLOBAL denominator: the most a single site could earn. Every registry
 * check counts at its tier weight whatever status the site's row reads, so
 * an n_a, skip, or error row costs global what an absent one does. A group
 * of alternatives is the exception: it counts each variant the site
 * presents, meaning one of the variant's rows shows its check applied, or
 * its largest variant when the site presents none. Presentation is read
 * from the rows alone so a stored scorecard recomputes the denominator it
 * was scored under.
 */
export function universeMaxOf(
  registry: UniverseRegistry,
  rows: ReadonlyArray<UniverseRow>,
  config: ScoreConfig = {},
): number {
  const weights = config.weights ?? DEFAULT_SCORE_WEIGHTS;
  const applied = new Set(rows.filter(rowApplied).map((row) => row.id));
  const groups = (registry.alternatives ?? []).map((group) =>
    Object.values(group.variants).map((tokens) => ({ tokens, size: 0, presented: false })),
  );
  const variantOf = new Map<string, { size: number; presented: boolean }>();
  for (const variants of groups) {
    for (const variant of variants) for (const token of variant.tokens) variantOf.set(token, variant);
  }
  let total = 0;
  for (const check of registry.checks) {
    const weight = weights[check.keyword];
    const variant = variantOf.get(check.antecedent);
    if (variant === undefined) {
      total += weight;
      continue;
    }
    variant.size += weight;
    if (applied.has(check.id)) variant.presented = true;
  }
  for (const variants of groups) {
    const shown = variants.filter((variant) => variant.presented);
    total +=
      shown.length > 0
        ? shown.reduce((sum, variant) => sum + variant.size, 0)
        : Math.max(0, ...variants.map((variant) => variant.size));
  }
  return total;
}

const CREDIT: Record<string, number | null> = { pass: 1, absent: 0 };

function creditFor(status: string, brokenFactor: number, noncompliantCredit: number): number | null | undefined {
  if (status === 'broken') return -brokenFactor;
  if (status === 'noncompliant') return noncompliantCredit;
  return CREDIT[status];
}

export function scoreWebAudit(
  results: ReadonlyArray<Pick<EngineResult, 'keyword' | 'status'>>,
  universeMax: number,
  config: ScoreConfig = {},
): WebScore {
  const weights = config.weights ?? DEFAULT_SCORE_WEIGHTS;
  const brokenFactor = config.brokenFactor ?? DEFAULT_BROKEN_FACTOR;
  const noncompliantCredit = config.noncompliantCredit ?? NONCOMPLIANT_CREDIT;

  let earned = 0;
  let applicableMax = 0;
  for (const r of results) {
    const credit = creditFor(r.status, brokenFactor, noncompliantCredit);
    if (credit === null || credit === undefined) continue; // n_a / skip / error: no credit, no relative slot
    const w = weights[r.keyword];
    earned += w * credit;
    // An absent SHOULD hurts less than an absent MUST: it occupies only
    // half its weight in the relative denominator (0 numerator either way).
    // The discount is keyed on absence alone: a noncompliant row carries a
    // real observation, so it occupies its full weight like any other
    // surface the audit actually reached.
    applicableMax += r.status === 'absent' && r.keyword === 'should' ? 0.5 * w : w;
  }

  const relative = applicableMax > 0 ? Math.max(0, roundHalfUp((100 * earned) / applicableMax)) : 0;
  const globalScore = universeMax > 0 ? Math.min(100, Math.max(0, roundHalfUp((100 * earned) / universeMax))) : 0;
  return { relative, global: globalScore, earned: Math.round(earned * 10) / 10 };
}

export interface CategoryRollup {
  id: string;
  name: string;
  passed: number;
  counted: number;
}

/**
 * Per-category `passed/counted` rollups in category_order. `counted`
 * counts the scored statuses, so it excludes n_a / skip / error rows
 * (R12: a category of only-n_a rows reports 0/0).
 */
export function categoryRollups(
  results: ReadonlyArray<Pick<EngineResult, 'category' | 'status'>>,
  categoryOrder: readonly string[],
  categories: Record<string, string>,
): CategoryRollup[] {
  return categoryOrder.map((id) => {
    let passed = 0;
    let counted = 0;
    for (const r of results) {
      if (r.category !== id) continue;
      if (SCORED_STATUSES.has(r.status)) {
        counted += 1;
        if (r.status === 'pass') passed += 1;
      }
    }
    return { id, name: categories[id] ?? id, passed, counted };
  });
}
