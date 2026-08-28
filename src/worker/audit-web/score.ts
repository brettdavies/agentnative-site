// Two-score web-audit scorer (plan-003 U4, KTD-3). Mirrors the
// scripts/scoring/score_model.py formula exactly; a committed fixture +
// parity test (tests/web-audit-two-score.test.ts) fails on divergence.
//
// RELATIVE ("for sites like yours") is the headline: earned points over
// the max achievable for THIS site's applicable set. GLOBAL is context:
// earned over a maximally agent-ready site's max, so a bigger correct
// routine outranks a small perfect one. Outcome scale: pass = +weight;
// noncompliant = +noncompliantCredit x weight (a surface an agent can
// use that violates a spec detail); broken = -brokenFactor x weight at
// every tier (a present-but-invalid surface misleads agents, so it costs
// more than absence); MUST absent is a full-weight zero; SHOULD absent is
// a zero occupying half its weight in the relative denominator; MAY
// absent arrives as n_a and is excluded. Both scores floor at 0.
//
// Per-tier point values are deliberately UNLOCKED config pending real
// anc100 audit data (n=1 today); the registry's per-check `weight` field
// is not consulted here.

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
 * Statuses that occupy a slot in either score. Everything else (n_a,
 * skip, error) carries no observation and is excluded from both.
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

/** GLOBAL denominator: every check in the registry at its tier weight. */
export function universeMaxOf(
  checks: ReadonlyArray<{ keyword: keyof ScoreWeights }>,
  config: ScoreConfig = {},
): number {
  const weights = config.weights ?? DEFAULT_SCORE_WEIGHTS;
  return checks.reduce((sum, check) => sum + weights[check.keyword], 0);
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
    if (credit === null || credit === undefined) continue; // n_a / skip / error excluded from both scores
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
  const globalScore = universeMax > 0 ? Math.max(0, roundHalfUp((100 * earned) / universeMax)) : 0;
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
