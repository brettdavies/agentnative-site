// Classifies what a CLI-parity run collected: a report, a stated "report unavailable"
// the contract can explain, or a broken run the workflow itself must fix. A missing
// or mangled divergence dump never classifies as zero divergences.

export interface ParityInput {
  marker: string;
  siteSha: string;
  cliRef: string;
  cliSha: string;
  runUrl: string;
  syncExit: number | null;
  syncLog: string;
  testExit: number | null;
  testLog: string;
  dump: string | null;
  ledger: string | null;
  unported: string | null;
  siteFingerprint: string | null;
  vendoredFingerprint: string | null;
}

export interface Row {
  scenario: string;
  element: string;
  status: 'new' | 'ledgered' | 'closed';
  owner?: string;
}

export type Outcome =
  | { kind: 'report'; rows: Row[]; failedTests: string[]; suiteCount: number }
  | { kind: 'unavailable' | 'broken'; reason: string; detail: string };

interface LedgerEntry {
  scenario: string;
  element: string;
  owner: string;
}

// The sync's messages that blame the commit's contract. It exits 1 for its other
// failures too, such as a commit missing from the checkout, and those are wiring.
const CONTRACT_REFUSED = /^error: commit \S+ (?:has no |vendors a symlink)/m;
// The CLI's own crate only: a dependency's build failure says nothing about the contract.
const CLI_BUILD_FAILED = /failed to run custom build command for `agentnative |could not compile `agentnative`/;
const DUMP_TEST_PANIC = /^thread 'dump_corpus_divergences'.* panicked at /;
// The corpus loads through tests/common, so a panic in the dump test's own file is its
// write to the path this workflow passes.
const DUMP_WRITE_PANIC = 'panicked at tests/web_audit_divergences.rs';

const rowKey = (scenario: string, element: string): string => `${scenario}\0${element}`;
const lastLines = (text: string, count: number): string => text.trimEnd().split('\n').slice(-count).join('\n');

function parseDump(text: string): [string, string][] | null {
  try {
    const value: unknown = JSON.parse(text);
    const isPairs =
      Array.isArray(value) &&
      value.every((p) => Array.isArray(p) && p.length === 2 && p.every((s) => typeof s === 'string'));
    return isPairs ? (value as [string, string][]) : null;
  } catch {
    return null;
  }
}

function parseLedger(text: string): Map<string, LedgerEntry> | null {
  try {
    const file = Bun.TOML.parse(text) as { divergence?: LedgerEntry[] };
    return new Map((file.divergence ?? []).map((entry) => [rowKey(entry.scenario, entry.element), entry]));
  } catch {
    return null;
  }
}

/** Failing tests as `<suite>::<test>` and the suites that ran, from libtest's text output. */
function parseTestLog(log: string): { failedTests: string[]; suiteCount: number } {
  let suite = '';
  let suiteCount = 0;
  const failedTests: string[] = [];
  for (const line of log.split('\n')) {
    const running = /^\s*Running (?:unittests )?(?:tests\/)?(\S+)\.rs /.exec(line);
    if (running) {
      suite = running[1] ?? '';
      suiteCount += 1;
    }
    const test = /^test (\S+) \.\.\. FAILED$/.exec(line);
    if (test) failedTests.push(`${suite}::${test[1]}`);
  }
  return { failedTests, suiteCount };
}

/** The lines from the first match of `pattern`, the part of a log that names a failure. */
function excerptFrom(log: string, pattern: RegExp, count: number): string | null {
  const lines = log.split('\n');
  const start = lines.findIndex((line) => pattern.test(line));
  return start === -1 ? null : lines.slice(start, start + count).join('\n');
}

function classifyMissingDump(input: ParityInput): Outcome {
  const log = input.testLog;
  if (CLI_BUILD_FAILED.test(log)) {
    return {
      kind: 'unavailable',
      reason: 'the CLI did not build against this contract',
      detail: excerptFrom(log, /panicked at/, 8) ?? excerptFrom(log, /^error/, 12) ?? lastLines(log, 15),
    };
  }
  const dumpPanic = excerptFrom(log, DUMP_TEST_PANIC, 8);
  if (dumpPanic !== null && !dumpPanic.includes(DUMP_WRITE_PANIC)) {
    return { kind: 'unavailable', reason: 'the CLI could not load this contract', detail: dumpPanic };
  }
  return {
    kind: 'broken',
    reason: `the CLI tests ended with exit code ${input.testExit} and wrote no divergence dump`,
    detail: dumpPanic ?? lastLines(log, 15),
  };
}

function classifySync(input: ParityInput): Outcome | null {
  if (input.syncExit === 0) return null;
  if (input.syncExit === 1 && CONTRACT_REFUSED.test(input.syncLog)) {
    return { kind: 'unavailable', reason: 'the CLI could not read this contract', detail: lastLines(input.syncLog, 5) };
  }
  return {
    kind: 'broken',
    reason: input.syncExit === null ? 'the CLI sync did not run' : `the CLI sync ended with exit code ${input.syncExit}`,
    detail: lastLines(input.syncLog, 15),
  };
}

export function classify(input: ParityInput): Outcome {
  const refused = classifySync(input);
  if (refused !== null) return refused;
  // A sync that ignores the override falls back to the CLI's pin and exits 0, and the
  // report would then read clean about a contract this PR did not write.
  const site = input.siteFingerprint?.trim();
  const vendored = input.vendoredFingerprint?.trim();
  if (site === undefined || site !== vendored) {
    return {
      kind: 'broken',
      reason: 'the CLI did not vendor this contract',
      detail: `contract fingerprint ${site ?? 'missing'}, vendored fingerprint ${vendored ?? 'missing'}`,
    };
  }
  if (input.testExit === null) {
    return { kind: 'broken', reason: 'the CLI tests did not run', detail: lastLines(input.testLog, 15) };
  }
  if (input.dump === null) return classifyMissingDump(input);
  const pairs = parseDump(input.dump);
  if (pairs === null) {
    return { kind: 'broken', reason: 'the divergence dump is not a list of pairs', detail: input.dump };
  }
  const ledger = input.ledger === null ? null : parseLedger(input.ledger);
  if (ledger === null) {
    return { kind: 'broken', reason: 'the CLI divergence ledger is missing or unreadable', detail: '' };
  }
  const observed = new Set(pairs.map(([scenario, element]) => rowKey(scenario, element)));
  const seen: Row[] = pairs.map(([scenario, element]) => {
    const owner = ledger.get(rowKey(scenario, element))?.owner;
    return owner === undefined
      ? { scenario, element, status: 'new' }
      : { scenario, element, status: 'ledgered', owner };
  });
  const closed: Row[] = [...ledger]
    .filter(([key]) => !observed.has(key))
    .map(([, { scenario, element, owner }]) => ({ scenario, element, status: 'closed', owner }));
  const order: Row['status'][] = ['new', 'ledgered', 'closed'];
  return {
    kind: 'report',
    rows: order.flatMap((status) => [...seen, ...closed].filter((row) => row.status === status)),
    ...parseTestLog(input.testLog),
  };
}
