// The one exit-code table the web audit reports through, shared with the
// `anc` binary (plan-003 KTD12). `anc web` and `anc audit` return the same
// four codes, and this runner returns them too, so a script that gates on
// one gates on all three the same way.
//
// Pure data logic on plain records, like web-audit-findings: it names
// neither the Worker nor the DOM, so both tsconfigs accept it.

/** Every applicable check passed. */
export const EXIT_CLEAN = 0;
/** Warnings only: a SHOULD or MAY check missed. */
export const EXIT_WARNINGS = 1;
/** Failures present: a MUST check missed, or a usage error. */
export const EXIT_FAILURES = 2;
/**
 * Could not check: the target was unreachable, a probe errored or was cut
 * short, or every selected check was inapplicable. The case both tables
 * lacked, so a site nobody reached stops reading as a site with failures.
 */
export const EXIT_COULD_NOT_CHECK = 3;

/** The table, as `--help` and the README print it. */
export const EXIT_TABLE = [
  '0  clean: every applicable check passed',
  '1  warnings only: a SHOULD or MAY check missed',
  '2  failures present: a MUST check missed, or a usage error',
  '3  could not check: the target was unreachable, a probe errored or was cut',
  '   short by the deadline, or every selected check was inapplicable',
] as const;

/** A row reduced to what the exit table reads. */
export type ExitRow = {
  /** Scorecard status. */
  status: string;
  /** The RFC-2119 keyword the check carries. */
  keyword: string;
};

/** A row that probed a surface and found it wanting. */
function isMiss(row: ExitRow): boolean {
  return row.status === 'noncompliant' || row.status === 'broken' || row.status === 'absent';
}

/**
 * The code a set of rows returns. Web statuses become warnings or
 * failures through the tier: a MUST miss is a failure, a SHOULD or MAY
 * miss a warning. A row nobody could evaluate outranks both, because a
 * partial run must not read as a clean one.
 */
export function webExitCode(rows: readonly ExitRow[]): number {
  if (rows.length === 0 || rows.every((r) => r.status === 'n_a')) return EXIT_COULD_NOT_CHECK;
  if (rows.some((r) => r.status === 'error' || r.status === 'skip')) return EXIT_COULD_NOT_CHECK;
  if (rows.some((r) => isMiss(r) && r.keyword === 'must')) return EXIT_FAILURES;
  if (rows.some(isMiss)) return EXIT_WARNINGS;
  return EXIT_CLEAN;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** What earned a code, for the line every run closes with. */
export function webExitReason(code: number, rows: readonly ExitRow[]): string {
  if (code === EXIT_CLEAN) return 'every applicable check passed';
  if (code === EXIT_WARNINGS) {
    const n = rows.filter(isMiss).length;
    return `warnings only (${n} SHOULD or MAY ${plural(n, 'miss', 'misses')})`;
  }
  if (code === EXIT_FAILURES) {
    const n = rows.filter((r) => isMiss(r) && r.keyword === 'must').length;
    return `failures present (${n} MUST ${plural(n, 'miss', 'misses')})`;
  }
  if (rows.length === 0 || rows.every((r) => r.status === 'n_a')) {
    return 'could not check: every selected check was inapplicable';
  }
  const errored = rows.filter((r) => r.status === 'error').length;
  const skipped = rows.filter((r) => r.status === 'skip').length;
  return `could not check: ${errored} ${plural(errored, 'probe', 'probes')} errored, ${skipped} skipped`;
}
