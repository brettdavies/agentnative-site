// Selection over web-audit findings, shared by the Worker's remediation
// eligibility, the result page's prompt-assembly widget, and the WebMCP
// result tools. Pure data logic on plain records: this module is
// typechecked under both tsconfig.client.json (no Workers types) and
// tsconfig.worker.json (no DOM lib), so it can name neither environment.
// Callers map their own surface (a DOM row, a scorecard row) onto
// `FindingRow` and read the selection back.

/** Scorecard schema 0.4 statuses, in documented order. */
export const FINDING_STATUSES = ['pass', 'noncompliant', 'broken', 'absent', 'n_a', 'skip', 'error'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** RFC-2119 normative keywords carried per check. */
export const FINDING_KEYWORDS = ['must', 'should', 'may'] as const;
export type FindingKeyword = (typeof FINDING_KEYWORDS)[number];

/**
 * The statuses a fix prompt addresses. `noncompliant` joins `broken` and
 * `absent`: the surface works, and the spec detail it violates is
 * precisely what the fix addresses. This is the one definition — the
 * Worker's remediation eligibility and every browser surface read it
 * from here rather than restating the set.
 */
export const REMEDIABLE_STATUSES: readonly FindingStatus[] = ['broken', 'noncompliant', 'absent'];

/** A rendered finding, reduced to the facts selection needs. */
export type FindingRow = {
  id: string;
  keyword: string;
  tier: string;
  status: string;
  /** The run never observed the surface, so it holds nothing to fix. */
  unprobed: boolean;
  prompt: string | null;
  /** Rendered document order, the last ordering tie-break. */
  order: number;
};

export function isRemediableStatus(status: string): boolean {
  return (REMEDIABLE_STATUSES as readonly string[]).includes(status);
}

/** A row earns a fix prompt only when the run actually observed it. */
export function isRemediable(row: Pick<FindingRow, 'status' | 'unprobed'>): boolean {
  return row.unprobed !== true && isRemediableStatus(row.status);
}

export type FindingFilters = {
  ids?: readonly string[] | null;
  keywords?: readonly string[] | null;
  statuses?: readonly string[] | null;
};

export const FINDING_LIMIT_DEFAULT = 10;
export const FINDING_LIMIT_MAX = 25;

export type FindingValidationError = {
  code: 'invalid_input';
  field: string;
  message: string;
  allowed?: readonly string[];
};

export type NormalizedQuery = {
  ids: string[] | null;
  keywords: string[] | null;
  statuses: string[] | null;
  offset: number;
  limit: number;
};

export type QueryResult = { ok: true; query: NormalizedQuery } | { ok: false; error: FindingValidationError };

type Invalid = { ok: false; error: FindingValidationError };

/** Bound an echoed caller value: a message under an output cap must not
 * be the thing that overruns it. */
export const FINDING_VALUE_MAX = 60;

function preview(value: string): string {
  return value.length <= FINDING_VALUE_MAX ? value : `${value.slice(0, FINDING_VALUE_MAX)}…`;
}

function invalid(field: string, message: string, allowed?: readonly string[]): Invalid {
  return {
    ok: false,
    error: allowed ? { code: 'invalid_input', field, message, allowed } : { code: 'invalid_input', field, message },
  };
}

/**
 * A present filter is an exact-value array; an omitted one is "all".
 * Duplicates collapse before selection, so `["must","must"]` and
 * `["must"]` select the same rows.
 */
function normalizeFilter(
  value: unknown,
  field: string,
  allowed: readonly string[] | null,
): { ok: true; value: string[] | null } | Invalid {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) return invalid(field, `${field} must be an array of strings`);
  if (value.length === 0) return invalid(field, `${field} must not be empty; omit it to select every value`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return invalid(field, `${field} must contain only non-empty strings`);
    }
    if (allowed && !allowed.includes(entry)) {
      return invalid(field, `${field} contains an unknown value: ${preview(entry)}`, allowed);
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return { ok: true, value: out };
}

function normalizeBound(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number | null,
): { ok: true; value: number } | Invalid {
  if (value === undefined || value === null) return { ok: true, value: fallback };
  const bound = max === null ? `${min} or more` : `between ${min} and ${max}`;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || (max !== null && value > max)) {
    return invalid(field, `${field} must be an integer ${bound}`);
  }
  return { ok: true, value };
}

/**
 * Validate one tool input into a normalized query. Invalid input names
 * the offending field and selects nothing; nothing here throws, and
 * unrecognized keys are ignored so a caller's extra argument never
 * becomes an error.
 */
export function normalizeFindingQuery(input: Record<string, unknown>): QueryResult {
  const ids = normalizeFilter(input.ids, 'ids', null);
  if (!ids.ok) return ids;
  const keywords = normalizeFilter(input.keywords, 'keywords', FINDING_KEYWORDS);
  if (!keywords.ok) return keywords;
  const statuses = normalizeFilter(input.statuses, 'statuses', FINDING_STATUSES);
  if (!statuses.ok) return statuses;
  const offset = normalizeBound(input.offset, 'offset', 0, 0, null);
  if (!offset.ok) return offset;
  const limit = normalizeBound(input.limit, 'limit', FINDING_LIMIT_DEFAULT, 1, FINDING_LIMIT_MAX);
  if (!limit.ok) return limit;
  return {
    ok: true,
    query: {
      ids: ids.value,
      keywords: keywords.value,
      statuses: statuses.value,
      offset: offset.value,
      limit: limit.value,
    },
  };
}

const KEYWORD_RANK: Record<string, number> = { must: 0, should: 1, may: 2 };
const STATUS_RANK: Record<string, number> = {
  broken: 0,
  absent: 1,
  noncompliant: 2,
  error: 3,
  pass: 4,
  n_a: 5,
  skip: 6,
};

function rankOf(table: Record<string, number>, value: string, fallback: number): number {
  return value in table ? table[value] : fallback;
}

/**
 * R20 priority order: normative keyword, then how badly the check
 * failed, then observed before unprobed, then rendered document order.
 * Unknown keywords and statuses sort after the known ones rather than
 * disappearing.
 */
export function orderFindings(rows: readonly FindingRow[]): FindingRow[] {
  return [...rows].sort((a, b) => {
    const keyword = rankOf(KEYWORD_RANK, a.keyword, 3) - rankOf(KEYWORD_RANK, b.keyword, 3);
    if (keyword !== 0) return keyword;
    const status = rankOf(STATUS_RANK, a.status, 7) - rankOf(STATUS_RANK, b.status, 7);
    if (status !== 0) return status;
    const probed = Number(a.unprobed) - Number(b.unprobed);
    if (probed !== 0) return probed;
    return a.order - b.order;
  });
}

/**
 * Filters are independent: values OR within a dimension, dimensions AND
 * across. An omitted `ids` or `keywords` selects every value. An omitted
 * `statuses` selects the observed remediable rows — the actionable
 * default — because an agent asking for findings with no status in mind
 * wants what it can fix, not the whole scorecard. Naming statuses
 * explicitly selects those rows whether or not the run probed them, so
 * every rendered row stays reachable.
 */
export function matchFindings(
  rows: readonly FindingRow[],
  filters: FindingFilters,
  opts: { order?: 'priority' | 'document' } = {},
): FindingRow[] {
  const { ids, keywords, statuses } = filters;
  const matched = rows.filter((row) => {
    if (ids && !ids.includes(row.id)) return false;
    if (keywords && !keywords.includes(row.keyword)) return false;
    if (statuses) return statuses.includes(row.status);
    return isRemediable(row);
  });
  if (opts.order === 'document') return [...matched].sort((a, b) => a.order - b.order);
  return orderFindings(matched);
}

export type PageMeta = {
  returned: number;
  omitted: number;
  next_offset: number | null;
};

/**
 * R21 continuation for a page that returned `returned` items from
 * `offset`. `returned` is what the caller actually kept, which can be
 * fewer than the requested limit when an output cap ends the page early;
 * `omitted` is what still matches after it. A page that returns nothing
 * is terminal — a reader that cannot make progress is sent no cursor to
 * loop on, and `omitted` still reports what it could not reach.
 */
export function pageMeta(offset: number, total: number, returned: number): PageMeta {
  const consumed = offset + returned;
  const omitted = Math.max(0, total - consumed);
  return { returned, omitted, next_offset: returned > 0 && omitted > 0 ? consumed : null };
}

export type FindingSelection =
  | { ok: true; query: NormalizedQuery; total: number; items: FindingRow[] }
  | { ok: false; error: FindingValidationError };

/**
 * Validate, filter, order, and page one request. The page holds at most
 * `limit` items; a caller under an output cap may keep fewer and report
 * the shortfall through `pageMeta`.
 */
export function selectFindings(rows: readonly FindingRow[], input: Record<string, unknown>): FindingSelection {
  const normalized = normalizeFindingQuery(input);
  if (!normalized.ok) return normalized;
  const { query } = normalized;
  const matched = matchFindings(rows, query);
  return {
    ok: true,
    query,
    total: matched.length,
    items: matched.slice(query.offset, query.offset + query.limit),
  };
}
