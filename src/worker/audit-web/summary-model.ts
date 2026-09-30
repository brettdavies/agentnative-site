// The derived record both web result-page renderers read.
//
// The HTML page and its markdown twin present the same audit, so every fact
// they share is computed once here and consumed twice, rather than derived
// independently on each side where the two can drift. That drift is not
// hypothetical on this surface: the page's status chips and its
// machine-readable context element were each counting the rows themselves,
// so a change to one had no way of reaching the other.
//
// This module also owns the display vocabulary. STATUS_LABELS is the single
// enumeration of the seven schema 0.4 statuses; STATUS_ORDER derives from it
// rather than repeating the list, so a status added there reaches the labels,
// the marks, the counts, and the machine context together.

import type { McpLaneSpec } from './registry';
import type { WebRemediationResource } from './remediation';
import { assembleRemediation, isFixableStatus, resultLine, type WebRemediationCatalog } from './remediation';
import { categoryRollups } from './score';
import type { NaReason, ScorecardStatus } from './scorecard';

export type WebScorecardRow = {
  id: string;
  label: string;
  category?: string;
  keyword?: string;
  tier?: string;
  status: ScorecardStatus;
  na_reason?: NaReason;
  unprobed?: true;
  evidence: string | null;
};

export type WebScorecardShape = {
  spec_version?: string;
  target_url?: string;
  tool?: { name?: string; url?: string };
  score_pct?: number;
  score?: { relative?: number; global?: number };
  categories?: Array<{ id: string; name: string; passed: number; counted: number }>;
  results?: WebScorecardRow[];
};

// Locked label strings for the two scores: the RELATIVE headline reads as the
// site's own score; GLOBAL is explicitly framed against the maximal site so
// the two percentages do not compete.
export const RELATIVE_LABEL = 'site score';
export const RELATIVE_SUBLABEL = 'relative to the checks that apply to this site';
export const GLOBAL_LABEL = 'of a maximally agent-ready site';

export const STATUS_LABELS: Record<ScorecardStatus, string> = {
  pass: 'PASS',
  noncompliant: 'NONCOMPLIANT',
  broken: 'BROKEN',
  absent: 'MISSING',
  n_a: 'N/A',
  skip: 'SKIP',
  error: 'ERROR',
};

// Check-row marks: pass ✓, noncompliant ~, absent (missing) !, broken/error ✕,
// n_a/skip –. Broken outranks absent in severity (a present-but-broken surface
// misleads agents) so it carries the fail mark, while a noncompliant surface
// works and reads as a partial.
const STATUS_MARKS: Record<ScorecardStatus, string> = {
  pass: '✓',
  noncompliant: '~',
  broken: '✕',
  absent: '!',
  n_a: '–',
  skip: '–',
  error: '✕',
};

/** The seven statuses in documented order, derived from the one enumeration. */
export const STATUS_ORDER = Object.keys(STATUS_LABELS) as ScorecardStatus[];

// The RFC-2119 keyword is a per-check obligation, so it renders on each check
// row and never on a category header: a category holds a mix of keywords, and
// the scorer weighs each check by its own, never by its group.
export const TIER_LABELS: Record<string, string> = { must: 'MUST', should: 'SHOULD', may: 'MAY' };

export function statusLabel(status: ScorecardStatus): string {
  return STATUS_LABELS[status] ?? String(status).toUpperCase();
}

export function statusMark(status: ScorecardStatus): string {
  return STATUS_MARKS[status] ?? '–';
}

/** One check row with its remediation already resolved. */
export type SummaryRow = {
  id: string;
  label: string;
  keyword?: string;
  tier?: string;
  status: ScorecardStatus;
  unprobed: boolean;
  /** The run observed the surface and its status warrants a fix prompt. */
  fixable: boolean;
  result: string;
  goal: string;
  /** Raw catalog text: HTML escapes it, markdown flattens it. */
  fix: string;
  prompt: string;
  skillUrl: string;
  resources: WebRemediationResource[];
};

/** One protocol lane's rows inside a category, with its own rollup. */
export type SummaryLane = {
  id: string;
  label: string;
  note: string;
  passed: number;
  counted: number;
  rows: SummaryRow[];
};

export type SummaryCategory = {
  id: string;
  name: string;
  passed: number;
  counted: number;
  rows: SummaryRow[];
  /** Present when the registry files this category's checks under lanes; rows then render by lane. */
  lanes?: SummaryLane[];
};

/** The registry fields lane grouping reads; a full registry satisfies it. */
export interface SummaryRegistry {
  mcp_lanes?: Record<string, McpLaneSpec>;
  checks: ReadonlyArray<{ id: string; lane?: string }>;
}

export type WebSummaryModel = {
  name: string;
  targetUrl: string;
  relative: number;
  global: number;
  counts: Record<ScorecardStatus, number>;
  categories: SummaryCategory[];
};

export interface WebSummaryModelInput {
  scorecard: WebScorecardShape;
  domain: string;
  targetUrl: string;
  name?: string;
  remediation?: WebRemediationCatalog;
  /** The live registry, whose lanes group stored rows regardless of when they were scored. */
  registry?: SummaryRegistry;
  origin: string;
}

function scoresOf(scorecard: WebScorecardShape): { relative: number; global: number } {
  return {
    relative: scorecard.score?.relative ?? scorecard.score_pct ?? 0,
    global: scorecard.score?.global ?? 0,
  };
}

function countsOf(rows: readonly WebScorecardRow[]): Record<ScorecardStatus, number> {
  const counts = {} as Record<ScorecardStatus, number>;
  for (const status of STATUS_ORDER) counts[status] = 0;
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}

/** A row earns a fix prompt only when the run actually observed the surface. */
function isFixable(row: WebScorecardRow): boolean {
  return row.unprobed !== true && isFixableStatus(row.status);
}

function summaryRow(row: WebScorecardRow, catalog: WebRemediationCatalog, origin: string): SummaryRow {
  const entry = catalog[row.id];
  const assembled = assembleRemediation(entry, { checkId: row.id, origin, evidence: row.evidence });
  return {
    id: row.id,
    label: row.label,
    keyword: row.keyword,
    tier: row.tier,
    status: row.status,
    unprobed: row.unprobed === true,
    fixable: isFixable(row),
    result: resultLine(row.status, row.evidence, row.na_reason),
    goal: entry?.goal ?? assembled.goal,
    fix: assembled.fix,
    prompt: assembled.prompt,
    skillUrl: assembled.skill_url,
    resources: assembled.resources,
  };
}

/**
 * Split a category's rows into the registry's lanes, in lane-map order, with
 * rows in registry order inside each lane. Stored rows sit in the order their
 * probes completed, which says nothing a reader can use. A row whose id the
 * registry no longer carries lands in the first lane, after the known rows. A
 * category none of whose rows the registry files under a lane gets none.
 */
function laneBlocks(rows: readonly SummaryRow[], registry: SummaryRegistry | undefined): SummaryLane[] | undefined {
  const lanes = registry?.mcp_lanes ?? {};
  const laneIds = Object.keys(lanes);
  if (laneIds.length === 0) return undefined;
  const position = new Map<string, { lane: string; index: number }>();
  registry?.checks.forEach((check, index) => {
    if (check.lane && Object.hasOwn(lanes, check.lane)) position.set(check.id, { lane: check.lane, index });
  });
  if (!rows.some((row) => position.has(row.id))) return undefined;

  const laneOf = (row: SummaryRow) => position.get(row.id)?.lane ?? laneIds[0];
  const ordered = [...rows].sort(
    (a, b) =>
      (position.get(a.id)?.index ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id)?.index ?? Number.MAX_SAFE_INTEGER),
  );
  const rollups = categoryRollups(
    ordered.map((row) => ({ category: laneOf(row), status: row.status })),
    laneIds,
    {},
  );
  return rollups
    .map(({ id, passed, counted }) => ({
      id,
      label: lanes[id].label,
      note: lanes[id].note,
      passed,
      counted,
      rows: ordered.filter((row) => laneOf(row) === id),
    }))
    .filter((lane) => lane.rows.length > 0);
}

/**
 * Resolve one stored scorecard into the record both renderers read. Rows are
 * grouped by the category order the scorecard carries; a category with no
 * matching rows still appears, because an empty category is a rendered state
 * rather than an omission.
 */
export function webSummaryModel(input: WebSummaryModelInput): WebSummaryModel {
  const sc = input.scorecard;
  const catalog = input.remediation ?? {};
  const rows = sc.results ?? [];
  const { relative, global: globalScore } = scoresOf(sc);

  const byCategory = new Map<string, SummaryRow[]>();
  for (const row of rows) {
    const key = row.category ?? '';
    const bucket = byCategory.get(key) ?? [];
    bucket.push(summaryRow(row, catalog, input.origin));
    byCategory.set(key, bucket);
  }

  return {
    name: input.name ?? sc.tool?.name ?? input.domain,
    targetUrl: sc.tool?.url ?? input.targetUrl,
    relative,
    global: globalScore,
    counts: countsOf(rows),
    categories: (sc.categories ?? []).map((category) => {
      const categoryRows = byCategory.get(category.id) ?? [];
      const lanes = laneBlocks(categoryRows, input.registry);
      return { ...category, rows: categoryRows, ...(lanes ? { lanes } : {}) };
    }),
  };
}
