// The one exit-code table (plan-003 KTD12), pinned so a later edit cannot
// quietly merge the cases. The `anc` binary's `web_audit::render::exit_code`
// is the same function; these cases are the ones its Rust tests pin, so a
// divergence shows up on whichever side changes.

import { describe, expect, test } from 'bun:test';
import {
  EXIT_CLEAN,
  EXIT_COULD_NOT_CHECK,
  EXIT_FAILURES,
  EXIT_TABLE,
  EXIT_WARNINGS,
  type ExitRow,
  webExitCode,
  webExitReason,
} from '../src/shared/web-audit-exit';

const row = (status: string, keyword: string): ExitRow => ({ status, keyword });

describe('the web-audit exit table', () => {
  test('the four codes are distinct and documented', () => {
    expect([EXIT_CLEAN, EXIT_WARNINGS, EXIT_FAILURES, EXIT_COULD_NOT_CHECK]).toEqual([0, 1, 2, 3]);
    expect(EXIT_TABLE.length).toBe(5);
    for (const code of ['0  clean', '1  warnings only', '2  failures present', '3  could not check']) {
      expect(EXIT_TABLE.some((line) => line.startsWith(code))).toBe(true);
    }
  });

  test('every applicable check passing is clean', () => {
    expect(webExitCode([row('pass', 'must'), row('pass', 'should'), row('n_a', 'may')])).toBe(EXIT_CLEAN);
    expect(webExitReason(EXIT_CLEAN, [row('pass', 'must')])).toBe('every applicable check passed');
  });

  test('a SHOULD or MAY miss is a warning and a MUST miss is a failure', () => {
    expect(webExitCode([row('pass', 'must'), row('absent', 'should')])).toBe(EXIT_WARNINGS);
    expect(webExitCode([row('noncompliant', 'may')])).toBe(EXIT_WARNINGS);
    expect(webExitCode([row('broken', 'must'), row('absent', 'should')])).toBe(EXIT_FAILURES);
    expect(webExitReason(EXIT_WARNINGS, [row('absent', 'should'), row('broken', 'may')])).toBe(
      'warnings only (2 SHOULD or MAY misses)',
    );
    expect(webExitReason(EXIT_FAILURES, [row('broken', 'must')])).toBe('failures present (1 MUST miss)');
  });

  test('a row nobody could evaluate outranks a miss', () => {
    expect(webExitCode([row('pass', 'must'), row('error', 'may')])).toBe(EXIT_COULD_NOT_CHECK);
    expect(webExitCode([row('broken', 'must'), row('error', 'may')])).toBe(EXIT_COULD_NOT_CHECK);
    expect(webExitCode([row('skip', 'must')])).toBe(EXIT_COULD_NOT_CHECK);
    expect(webExitReason(EXIT_COULD_NOT_CHECK, [row('error', 'may'), row('skip', 'must')])).toBe(
      'could not check: 1 probe errored, 1 skipped',
    );
  });

  test('an all-inapplicable run and an empty one could not be checked', () => {
    expect(webExitCode([row('n_a', 'must'), row('n_a', 'may')])).toBe(EXIT_COULD_NOT_CHECK);
    expect(webExitCode([])).toBe(EXIT_COULD_NOT_CHECK);
    expect(webExitReason(EXIT_COULD_NOT_CHECK, [row('n_a', 'must')])).toBe(
      'could not check: every selected check was inapplicable',
    );
  });

  test('one row gates the same way the whole run does', () => {
    // `--check <id>` returns the table for a single row, which is what
    // makes `3` meaningful to a CI gate: the check did not apply here.
    expect(webExitCode([row('pass', 'should')])).toBe(EXIT_CLEAN);
    expect(webExitCode([row('absent', 'should')])).toBe(EXIT_WARNINGS);
    expect(webExitCode([row('absent', 'must')])).toBe(EXIT_FAILURES);
    expect(webExitCode([row('n_a', 'should')])).toBe(EXIT_COULD_NOT_CHECK);
    expect(webExitCode([row('error', 'should')])).toBe(EXIT_COULD_NOT_CHECK);
  });
});
