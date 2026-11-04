// The CLI-parity report: what it says for each way a run can end, and which of
// those keep the check green. The log excerpts are real `cargo test` output from
// the CLI's suites against a changed golden, a malformed golden and a build input
// the CLI's build script rejects.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { ParityInput } from '../scripts/web-audit/cli-parity-outcome';
import { renderParityReport } from '../scripts/web-audit/cli-parity-summary';
import { CONTRACT_FINGERPRINT_PATH } from '../src/build/web-audit-contract-paths.mjs';
import { REPO_ROOT, workflowText } from './helpers/workflows';

const MARKER = '<!-- web-audit-cli-parity -->';
const SCRIPT = join(REPO_ROOT, 'scripts/web-audit/cli-parity-summary.ts');
const WORKFLOW = 'web-audit-cli-parity.yml';

const PASSING_LOG = `     Running tests/web_audit_divergences.rs (target/debug/deps/web_audit_divergences-06b78d95cce71c39)

running 1 test
test dump_corpus_divergences ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 4.69s
`;

const CHANGED_GOLDEN_LOG = `     Running tests/web_audit_conformance.rs (target/debug/deps/web_audit_conformance-221cd0fee985ecc8)

running 3 tests
test a_mutated_golden_fails_the_comparison ... ok
test the_fetch_parity_scenarios_are_present_and_green ... ok
test every_corpus_scenario_reproduces_the_site_scorecard_or_is_ledgered ... FAILED

failures:
    every_corpus_scenario_reproduces_the_site_scorecard_or_is_ledgered

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.57s

error: test failed, to rerun pass \`--test web_audit_conformance\`
     Running tests/web_audit_divergences.rs (target/debug/deps/web_audit_divergences-06b78d95cce71c39)

running 1 test
test dump_corpus_divergences ... ok
`;

const MALFORMED_GOLDEN_LOG = `     Running tests/web_audit_divergences.rs (target/debug/deps/web_audit_divergences-06b78d95cce71c39)

running 1 test
test dump_corpus_divergences ... FAILED

failures:

---- dump_corpus_divergences stdout ----

thread 'dump_corpus_divergences' (1751435) panicked at tests/common/corpus.rs:160:45:
alias-unpublished-optional-absent/scorecard.json: key must be a string at line 1 column 3
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace
`;

const BUILD_FAILURE_LOG = `   Compiling agentnative v0.7.0 (/home/runner/work/agentnative-site/agentnative-site)
error: failed to run custom build command for \`agentnative v0.7.0 (/home/runner/work/agentnative-site/agentnative-site)\`

Caused by:
  process didn't exit successfully: \`target/debug/build/agentnative-1/build-script-build\` (exit status: 101)
  --- stderr

  thread 'main' (1774891) panicked at build.rs:315:25:

    web-audit registry: YAML parse error: error: line 1198 column 1: duplicate mapping key: checks
`;

const DUMP_WRITE_PANIC_LOG = `     Running tests/web_audit_divergences.rs (target/debug/deps/web_audit_divergences-06b78d95cce71c39)

running 2 tests
test dump_unported_bindings ... ok
test dump_corpus_divergences ... FAILED

failures:

---- dump_corpus_divergences stdout ----

thread 'dump_corpus_divergences' (3608) panicked at tests/web_audit_divergences.rs:33:29:
write /nonexistent/dir/d.json: No such file or directory (os error 2)
`;

const CLI_COMPILE_FAILURE_LOG = `error[E0308]: mismatched types
  --> target/debug/build/agentnative-1/out/generated_web_registry.rs:90:13

error: could not compile \`agentnative\` (lib) due to 1 previous error
`;

const DEPENDENCY_BUILD_FAILURE_LOGS = [
  'error: failed to run custom build command for `aws-lc-sys v0.30.0`\n\nCaused by:\n  is `cmake` not installed?\n',
  'error: could not compile `ring` (lib) due to 1 previous error\n',
];

const LIB_SUITE_LOG = `     Running unittests src/lib.rs (target/debug/deps/agentnative-3c302479454ea739)

running 2 tests
test web_audit::scorecard::keeps_order ... FAILED

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 4.66s

     Running tests/build_registry.rs (target/debug/deps/build_registry-393847b08390b122)

running 1 test
test reads_the_contract ... ok
`;

const DUMP_FAILED_ONCE = `     Running tests/web_audit_divergences.rs (target/debug/deps/web_audit_divergences-06b78d95cce71c39)

running 1 test
test dump_corpus_divergences ... FAILED
`;

const NO_TARGET_LOG = `error: no test target named \`web_audit_divergences\` in default-run packages

help: a target with a similar name exists: \`web_audit_api\`
`;

const NO_FEATURE_LOG = `     Running tests/web_audit_divergences.rs (target/debug/deps/web_audit_divergences-06b78d95cce71c39)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

const UNPORTED_NONE = JSON.stringify({ handlers: {}, evals: {} });

const ledgerOf = (...entries: [string, string, string][]): string =>
  [
    'site_sha = "d5772289d71d056fd1c427ccb994e8c547ea2a43"',
    ...entries.map(
      ([scenario, element, owner]) =>
        `\n[[divergence]]\nscenario = "${scenario}"\nelement = "${element}"\nowner = "${owner}"`,
    ),
  ].join('\n');

const input = (overrides: Partial<ParityInput> = {}): ParityInput => ({
  marker: MARKER,
  siteSha: 'b536c19bf282ac87c43b89c2c2807504d986a26f',
  cliRef: 'dev',
  cliSha: '6b616b4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  cliPin: 'd5772289d71d056fd1c427ccb994e8c547ea2a43\n',
  runUrl: 'https://github.com/brettdavies/agentnative-site/actions/runs/1',
  syncExit: 0,
  syncLog: '',
  testExit: 0,
  testLog: PASSING_LOG,
  dump: '[]',
  ledger: ledgerOf(),
  unported: UNPORTED_NONE,
  siteFingerprint: '686ddd155166\n',
  vendoredFingerprint: '686ddd155166\n',
  ...overrides,
});

describe('a run that produced a dump', () => {
  test('a contract every scenario reproduces reports that in one line', () => {
    const report = renderParityReport(input());
    expect(report.exitCode).toBe(0);
    expect(report.summary).toContain('**The CLI reproduces every conformance scenario at this contract.**');
    expect(report.summary).not.toContain('| Scenario |');
    expect(report.summary).toContain('`b536c19bf282`');
    expect(report.summary).toContain('CLI `dev` at `6b616b4aaaaa` (pinned to site `d5772289d71d`)');
    expect(report.summary).toContain('site changes merged since that pin');
  });

  test('a changed golden names its scenario and element as new, and the failing test', () => {
    const report = renderParityReport(
      input({
        testExit: 101,
        testLog: CHANGED_GOLDEN_LOG,
        dump: '[["alias-unpublished-optional-absent","row:openapi"]]',
      }),
    );
    expect(report.exitCode).toBe(0);
    expect(report.summary).toContain('**The next CLI bump carries 1 new divergence across 1 scenario.**');
    expect(report.summary).toContain('| `alias-unpublished-optional-absent` | `row:openapi` | new |');
    expect(report.summary).toContain(
      '- `web_audit_conformance::every_corpus_scenario_reproduces_the_site_scorecard_or_is_ledgered`',
    );
    expect(report.summary).not.toContain('dump_corpus_divergences');
  });

  test('an element the ledger holds is marked with its owner, and sorts after the new ones', () => {
    const report = renderParityReport(
      input({
        testExit: 101,
        testLog: CHANGED_GOLDEN_LOG,
        dump: '[["a-ledgered","row:one"],["b-new","document"]]',
        ledger: ledgerOf(['a-ledgered', 'row:one', '#504']),
      }),
    );
    expect(report.summary).toContain('1 new divergence across 1 scenario. 1 divergence already in the CLI ledger.');
    const fresh = report.summary.indexOf('| `b-new` | `document` | new |');
    const ledgered = report.summary.indexOf('| `a-ledgered` | `row:one` | in the CLI ledger (`#504`) |');
    expect(fresh).toBeGreaterThan(-1);
    expect(ledgered).toBeGreaterThan(fresh);
  });

  test('a divergence only the ledger explains is not new', () => {
    const report = renderParityReport(input({ dump: '[["a","row:one"]]', ledger: ledgerOf(['a', 'row:one', '#504']) }));
    expect(report.summary).toContain('**No new divergence. 1 divergence already in the CLI ledger.**');
  });

  test('a ledger entry the dump no longer holds reads as now matching', () => {
    const report = renderParityReport(input({ ledger: ledgerOf(['a', 'row:one', '#504']) }));
    expect(report.summary).toContain('**No new divergence. 1 ledger entry no longer diverging.**');
    expect(report.summary).toContain('| `a` | `row:one` | no longer diverges, in the CLI ledger (`#504`) |');
  });

  test('a failing test beside an empty dump is not reported as full parity', () => {
    const failed = renderParityReport(input({ testExit: 101, testLog: CHANGED_GOLDEN_LOG }));
    expect(failed.summary).toContain('**No scorecard divergence, but 1 CLI test fails at this contract.**');
    const unnamed = renderParityReport(input({ testExit: 101, testLog: PASSING_LOG }));
    expect(unnamed.summary).toContain('**No scorecard divergence, but the CLI tests ended with exit code 101.**');
  });

  test('a crash that names no failing test is stated beside the rows', () => {
    const report = renderParityReport(
      input({ testExit: 101, dump: '[["a","row:one"]]', ledger: ledgerOf(['a', 'row:one', '#504']) }),
    );
    expect(report.summary).toContain(
      '**No new divergence. 1 divergence already in the CLI ledger. The CLI tests ended with exit code 101.**',
    );
  });

  test('a failure in the unit tests names its suite, and the report counts the suites that ran', () => {
    const report = renderParityReport(input({ testExit: 101, testLog: LIB_SUITE_LOG }));
    expect(report.summary).toContain('- `src/lib::web_audit::scorecard::keeps_order`');
    expect(report.summary).toContain('Ran 2 CLI test suites.');
  });

  test('a should_panic test that fails is listed', () => {
    const testLog = `     Running unittests src/lib.rs (target/debug/deps/agentnative-3)

test scorecard::audience::tests::rejects_a_duplicate_signal - should panic ... FAILED
`;
    const report = renderParityReport(input({ testExit: 101, testLog }));
    expect(report.summary).toContain('**No scorecard divergence, but 1 CLI test fails at this contract.**');
    expect(report.summary).toContain('- `src/lib::scorecard::audience::tests::rejects_a_duplicate_signal`');
  });

  test("the dump's suite running twice counts once, and its failure lists once", () => {
    const report = renderParityReport(
      input({ testExit: 101, testLog: `${DUMP_FAILED_ONCE}${DUMP_FAILED_ONCE}`, dump: '[]' }),
    );
    expect(report.summary).toContain('Ran 1 CLI test suite.');
    expect(report.summary.match(/dump_corpus_divergences/g)).toHaveLength(1);
  });

  test('a failing-test list that would overrun a comment is capped and says where the rest are', () => {
    const lines = Array.from(
      { length: 1400 },
      (_, i) => `test web_audit::a_long_unit_test_name_of_ordinary_length_${i} ... FAILED`,
    );
    const testLog = `     Running unittests src/lib.rs (target/debug/deps/agentnative-3)\n${lines.join('\n')}\n`;
    const pairs = Array.from({ length: 300 }, (_, i) => [`scenario-name-of-ordinary-length-${i}`, `row:check-${i}`]);
    const report = renderParityReport(input({ testExit: 101, testLog, dump: JSON.stringify(pairs) }));
    expect(report.comment.length).toBeLessThan(65536);
    expect(report.comment).toContain('1300 more failing tests in the [run log]');
  });

  test('a large report stays within what a PR comment holds, and says what it left out', () => {
    const pairs = Array.from({ length: 5000 }, (_, i) => [`scenario-name-of-ordinary-length-${i}`, `row:check-${i}`]);
    const report = renderParityReport(
      input({ testExit: 101, testLog: CHANGED_GOLDEN_LOG, dump: JSON.stringify(pairs) }),
    );
    expect(report.comment.length).toBeLessThan(65536);
    expect(report.comment).toContain('**The next CLI bump carries 5000 new divergences across 5000 scenarios.**');
    expect(report.comment).toContain('4800 more rows in the [job summary]');
    expect(report.summary).toContain('3000 more rows not shown.');
    expect(new TextEncoder().encode(report.summary).length).toBeLessThan(1024 * 1024);
  });

  test('a table cell cannot break out of its row', () => {
    const report = renderParityReport(input({ dump: JSON.stringify([['a|b`c\nd', 'row:x']]) }));
    expect(report.summary).toContain('| `a b c d` | `row:x` | new |');
  });
});

describe('unported handler kinds and eval rules', () => {
  test('each name the CLI cannot run is listed with its check count, and a fully ported contract says so', () => {
    expect(renderParityReport(input()).summary).toContain(
      'Every handler kind and eval rule in this contract is ported.',
    );
    const unported = JSON.stringify({ handlers: { 'brand-new': ['a', 'b'] }, evals: { 'new-rule': ['b'] } });
    expect(renderParityReport(input({ unported })).summary).toContain(
      'Not yet ported by the CLI: handler kind `brand-new` (2 checks), eval rule `new-rule` (1 check).',
    );
  });

  test('a missing or unreadable list reads as not checked, never as ported', () => {
    const notChecked = 'Unported handler kinds and eval rules: not checked';
    for (const unported of [
      null,
      '{ broken',
      '{}',
      '[]',
      '{"handlers":{},"evals":[1]}',
      '{"handlers":[],"evals":[]}',
    ]) {
      const report = renderParityReport(input({ unported }));
      expect(report.summary).toContain(notChecked);
      expect(report.summary).not.toContain('is ported');
    }
  });
});

describe('a run with no dump never reads as zero divergences', () => {
  const ZERO_CLAIMS = ['reproduces every', 'No scorecard divergence', 'No new divergence', 'new divergence'];
  const expectUnavailable = (text: string, reason: string): void => {
    expect(text).toContain(`**Report unavailable: ${reason}.**`);
    for (const claim of ZERO_CLAIMS) expect(text).not.toContain(claim);
  };

  test('a sync failure the contract did not cause fails the run', () => {
    for (const syncLog of [
      'error: commit abc is not in /home/runner/work/agentnative-site/agentnative-site\n',
      'error: pin must be a full 40-hex commit SHA (got abc)\n',
      'scripts/sync-web-audit.sh: line 40: scripts/hardened-git.sh: No such file or directory\n',
    ]) {
      const report = renderParityReport(input({ syncExit: 1, syncLog, testExit: null, testLog: '', dump: null }));
      expect(report.exitCode).toBe(1);
      expectUnavailable(report.summary, 'the CLI sync ended with exit code 1');
    }
  });

  test('a contract the sync refuses for a symlink stays green', () => {
    const syncLog = 'error: commit abc vendors a symlink, which a sync refuses: build/link.json\n';
    const report = renderParityReport(input({ syncExit: 1, syncLog, testExit: null, testLog: '', dump: null }));
    expect(report.exitCode).toBe(0);
    expectUnavailable(report.summary, 'the CLI could not read this contract');
  });

  test('a sync that ended cleanly but vendored another contract fails the run', () => {
    for (const vendoredFingerprint of ['aaaaaaaaaaaa\n', null]) {
      const report = renderParityReport(input({ vendoredFingerprint }));
      expect(report.exitCode).toBe(1);
      expectUnavailable(report.summary, 'the CLI did not vendor this contract');
      expect(report.summary).toContain('contract fingerprint 686ddd155166');
    }
    const noSiteFile = renderParityReport(input({ siteFingerprint: null }));
    expect(noSiteFile.exitCode).toBe(1);
  });

  test('a suite failing beside a missing dump fails the run: the suites loaded the contract', () => {
    const report = renderParityReport(input({ testExit: 101, testLog: CHANGED_GOLDEN_LOG, dump: null }));
    expect(report.exitCode).toBe(1);
    expectUnavailable(report.summary, 'the CLI tests ended with exit code 101 and wrote no divergence dump');
  });

  test("a long log's excerpt keeps the end, where the failure is named", () => {
    const testLog = `${'x'.repeat(5000)}\nerror: the line that names the failure\n`;
    const report = renderParityReport(input({ testExit: 101, testLog, dump: null }));
    expect(report.exitCode).toBe(1);
    expect(report.summary).toContain('error: the line that names the failure');
  });

  test('a dump test that cannot write its file fails the run', () => {
    const report = renderParityReport(input({ testExit: 101, testLog: DUMP_WRITE_PANIC_LOG, dump: null }));
    expect(report.exitCode).toBe(1);
    expect(report.summary).toContain('write /nonexistent/dir/d.json');
  });

  test('a dependency that does not build fails the run: it says nothing about the contract', () => {
    for (const testLog of DEPENDENCY_BUILD_FAILURE_LOGS) {
      const report = renderParityReport(input({ testExit: 101, testLog, dump: null }));
      expect(report.exitCode).toBe(1);
    }
  });

  test('a CLI that does not compile against the contract stays green', () => {
    const report = renderParityReport(input({ testExit: 101, testLog: CLI_COMPILE_FAILURE_LOG, dump: null }));
    expect(report.exitCode).toBe(0);
    expectUnavailable(report.summary, 'the CLI did not build against this contract');
    expect(report.summary).toContain('mismatched types');
  });

  test('a contract the sync cannot map stays green and names the missing path', () => {
    const syncLog =
      'reading abc from local site\nerror: commit abc has no tests/fixtures/web-audit-score-parity.json\n';
    const report = renderParityReport(input({ syncExit: 1, syncLog, testExit: null, testLog: '', dump: null }));
    expect(report.exitCode).toBe(0);
    expectUnavailable(report.summary, 'the CLI could not read this contract');
    expect(report.summary).toContain('has no tests/fixtures/web-audit-score-parity.json');
  });

  test('a build the contract breaks stays green and quotes the build script', () => {
    const report = renderParityReport(input({ testExit: 101, testLog: BUILD_FAILURE_LOG, dump: null }));
    expect(report.exitCode).toBe(0);
    expectUnavailable(report.summary, 'the CLI did not build against this contract');
    expect(report.summary).toContain('duplicate mapping key: checks');
  });

  test('a golden the suites cannot load stays green and quotes the panic', () => {
    const report = renderParityReport(input({ testExit: 101, testLog: MALFORMED_GOLDEN_LOG, dump: null }));
    expect(report.exitCode).toBe(0);
    expectUnavailable(report.summary, 'the CLI could not replay this contract');
    expect(report.summary).toContain('scorecard.json: key must be a string');
  });

  test('tests that pass without writing a dump fail the run: the web feature was dropped', () => {
    const report = renderParityReport(input({ testExit: 0, testLog: NO_FEATURE_LOG, dump: null }));
    expect(report.exitCode).toBe(1);
    expectUnavailable(report.summary, 'the CLI tests ended with exit code 0 and wrote no divergence dump');
    expect(report.summary).toContain('a reason the contract does not explain');
  });

  test('a missing test target fails the run', () => {
    const report = renderParityReport(input({ testExit: 101, testLog: NO_TARGET_LOG, dump: null }));
    expect(report.exitCode).toBe(1);
    expect(report.comment).toContain('no test target named');
  });

  test('a sync that could not start, a test step that never ran and a mangled dump fail the run', () => {
    const noScript = renderParityReport(
      input({ syncExit: 127, syncLog: 'bash: scripts/sync-web-audit.sh: No such file' }),
    );
    expect(noScript.exitCode).toBe(1);
    expectUnavailable(noScript.summary, 'the CLI sync ended with exit code 127');
    const noSync = renderParityReport(input({ syncExit: null }));
    expect(noSync.exitCode).toBe(1);
    expectUnavailable(noSync.summary, 'the CLI sync did not run');
    const neverRan = renderParityReport(input({ testExit: null, testLog: '', dump: null }));
    expect(neverRan.exitCode).toBe(1);
    expectUnavailable(neverRan.summary, 'the CLI tests did not run');
    for (const dump of ['[["trun', '{"a":1}', '[["only-one"]]']) {
      const mangled = renderParityReport(input({ dump }));
      expect(mangled.exitCode).toBe(1);
      expectUnavailable(mangled.summary, 'the divergence dump is not a list of pairs');
    }
  });

  test('a dump beside a ledger that will not parse fails the run instead of calling everything new', () => {
    for (const ledger of [null, 'site_sha = ']) {
      const report = renderParityReport(input({ dump: '[["a","row:one"]]', ledger }));
      expect(report.exitCode).toBe(1);
      expectUnavailable(report.summary, 'the CLI divergence ledger is missing or unreadable');
    }
  });
});

describe('the script as the workflow runs it', () => {
  function run(args: Record<string, string>): { code: number; summary: string; comment: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cli-parity-'));
    const write = (name: string, text: string): string => {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    };
    const summaryOut = write('summary.md', 'an earlier step wrote this\n');
    const commentOut = join(dir, 'comment.md');
    const flags = {
      marker: MARKER,
      'site-sha': 'b536c19bf282ac87c43b89c2c2807504d986a26f',
      'cli-ref': 'dev',
      'cli-sha': '6b616b4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'cli-pin': join(dir, 'absent-SITE_SHA'),
      'run-url': 'https://github.com/brettdavies/agentnative-site/actions/runs/1',
      'sync-exit': '0',
      'sync-log': join(dir, 'absent-sync.log'),
      'test-exit': '0',
      'test-log': write('tests.log', PASSING_LOG),
      dump: join(dir, 'absent-divergences.json'),
      ledger: write('ledger.toml', ledgerOf()),
      unported: write('unported.json', UNPORTED_NONE),
      'vendored-fingerprint': write('FINGERPRINT', readFileSync(CONTRACT_FINGERPRINT_PATH, 'utf8')),
      'summary-out': summaryOut,
      'comment-out': commentOut,
      ...args,
    };
    const result = Bun.spawnSync([
      'bun',
      SCRIPT,
      ...Object.entries(flags).flatMap(([name, value]) => [`--${name}`, value]),
    ]);
    return {
      code: result.exitCode,
      summary: readFileSync(summaryOut, 'utf8'),
      comment: readFileSync(commentOut, 'utf8'),
    };
  }

  test('a missing dump file goes red, appends to the summary and still writes the comment', () => {
    const { code, summary, comment } = run({});
    expect(code).toBe(1);
    expect(summary.startsWith('an earlier step wrote this\n')).toBe(true);
    expect(summary).toContain('**Report unavailable:');
    expect(comment.startsWith(`${MARKER}\n`)).toBe(true);
    expect(summary).not.toContain(MARKER);
  });

  test('a test step the workflow skipped arrives as an empty exit code and reads as unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-parity-sync-'));
    const syncLog = join(dir, 'sync.log');
    writeFileSync(syncLog, 'error: commit abc has no src/data/web-audit/contract/build/\n');
    const { code, comment } = run({ 'sync-exit': '1', 'test-exit': '', 'sync-log': syncLog });
    expect(code).toBe(0);
    expect(comment).toContain('**Report unavailable: the CLI could not read this contract.**');
  });
});

describe('the workflow', () => {
  interface Step {
    name?: string;
    id?: string;
    run?: string;
    uses?: string;
    if?: string;
    env?: Record<string, string>;
  }
  interface Job {
    permissions?: Record<string, string>;
    env?: Record<string, string>;
    steps: Step[];
    if?: string;
    needs?: string;
  }
  const doc = yaml.load(workflowText(WORKFLOW)) as {
    permissions: Record<string, string>;
    jobs: { report: Job; comment: Job };
    env: Record<string, string>;
    // js-yaml reads the `on` key as the string it is written as.
    on: {
      pull_request: { paths: string[]; 'branches-ignore': string[] };
      workflow_dispatch: { inputs: { cli_ref: { default: string } } };
    };
  };

  test('the build holds no write scope and only the comment job can write', () => {
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(doc.jobs.report.permissions).toBeUndefined();
    expect(doc.jobs.comment.permissions).toEqual({ 'pull-requests': 'write' });
    expect(doc.jobs.comment.steps.some((step) => step.uses?.includes('checkout'))).toBe(false);
  });

  test('it reports on the contract and defaults to the CLI on dev', () => {
    expect(doc.on.pull_request.paths).toContain('src/data/web-audit/contract/**');
    expect(doc.on.workflow_dispatch.inputs.cli_ref.default).toBe('dev');
    expect(doc.on.pull_request['branches-ignore']).toEqual(['main']);
  });

  test('the test step passes the flags without which a clean run is a false reading', () => {
    const step = doc.jobs.report.steps.find((candidate) => candidate.id === 'tests');
    const [dumpRun, suitesRun] = (step?.run ?? '').split('tee "$RUNNER_TEMP/tests.log"');
    for (const flag of ['--features web', '--no-fail-fast', '--locked']) {
      expect(dumpRun).toContain(flag);
      expect(suitesRun).toContain(flag);
    }
    expect(dumpRun).toContain('--test web_audit_divergences');
    for (const flag of ['--lib', "--test 'web_audit_*'", '--test build_registry']) expect(suitesRun).toContain(flag);
    expect(suitesRun).not.toContain('sync_web_audit');
  });

  test('the dump paths reach only the run of the dump suite, not the bump suite and its fixtures', () => {
    const step = doc.jobs.report.steps.find((candidate) => candidate.id === 'tests');
    const [dumpRun, suitesRun] = (step?.run ?? '').split('tee "$RUNNER_TEMP/tests.log"');
    expect(dumpRun).toContain('WEB_AUDIT_DIVERGENCE_OUT=');
    expect(dumpRun).toContain('WEB_AUDIT_UNPORTED_OUT=');
    expect(suitesRun).not.toContain('WEB_AUDIT_');
    expect(step?.env).toBeUndefined();
  });

  test('a failure in either cargo run reaches the exit code the report reads', () => {
    const run = doc.jobs.report.steps.find((candidate) => candidate.id === 'tests')?.run ?? '';
    expect(run).toContain('if [ "$code" = 0 ]; then code=$suites; fi');
  });

  test('the bump suites run only beside a dump, so one log never mixes a failed build into a report', () => {
    const run = doc.jobs.report.steps.find((candidate) => candidate.id === 'tests')?.run ?? '';
    const gate = run.indexOf('if [ -f "$RUNNER_TEMP/divergences.json" ]; then');
    expect(gate).toBeGreaterThan(-1);
    expect(run.indexOf("--test 'web_audit_*'")).toBeGreaterThan(gate);
  });

  test('crate downloads stay on HTTP/1.1, as the CLI needs on hosted runners', () => {
    expect(doc.jobs.report.env?.CARGO_HTTP_MULTIPLEXING).toBe('false');
  });

  test('the sync uses a per-run commit and never moves the CLI pin', () => {
    const sync = doc.jobs.report.steps.find((step) => step.id === 'sync');
    expect(sync?.env?.WEB_AUDIT_SITE_REPO).toBeDefined();
    expect(sync?.env?.WEB_AUDIT_SITE_SHA).toBeDefined();
    expect(sync?.run).not.toContain('--pin');
  });

  test('a fork PR never reaches the comment step, and a cancelled run does not overwrite the comment', () => {
    expect(doc.jobs.comment.if?.split(/\s+&&\s+/).map((part) => part.trim())).toEqual([
      '!cancelled()',
      "github.event_name == 'pull_request'",
      'github.event.pull_request.head.repo.full_name == github.repository',
    ]);
  });

  test('no step soft-fails', () => {
    expect(workflowText(WORKFLOW)).not.toMatch(/^\s*continue-on-error:/m);
  });

  test('no ruleset requires the check', () => {
    for (const ruleset of ['protect-main.json', 'protect-dev.json']) {
      const text = readFileSync(join(REPO_ROOT, '.github/rulesets', ruleset), 'utf8');
      expect(text).toContain('required_status_checks');
      expect(text).not.toContain('CLI conformance');
      expect(text).not.toContain('web-audit-cli-parity');
    }
  });
});
