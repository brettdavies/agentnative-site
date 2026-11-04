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
  vocab: string | null;
  registry: string | null;
}

export interface Row {
  scenario: string;
  element: string;
  status: 'new' | 'ledgered' | 'closed';
  owner?: string;
}

export type Outcome =
  | { kind: 'report'; rows: Row[]; failedTests: string[] }
  | { kind: 'unavailable' | 'broken'; reason: string; detail: string };

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

function parseLedger(text: string): Map<string, string> | null {
  try {
    const file = Bun.TOML.parse(text) as { divergence?: { scenario: string; element: string; owner: string }[] };
    return new Map((file.divergence ?? []).map((e) => [rowKey(e.scenario, e.element), e.owner]));
  } catch {
    return null;
  }
}

/** Failing tests as `<suite>::<test>`, from libtest's text output. */
function parseFailedTests(log: string): string[] {
  let suite = '';
  const failed: string[] = [];
  for (const line of log.split('\n')) {
    const running = /^\s*Running tests\/(\S+)\.rs /.exec(line);
    if (running) suite = running[1] ?? '';
    const test = /^test (\S+) \.\.\. FAILED$/.exec(line);
    if (test) failed.push(`${suite}::${test[1]}`);
  }
  return failed;
}

/** The lines from the first match of `pattern`, the part of a log that names a failure. */
function excerptFrom(log: string, pattern: RegExp, count: number): string | null {
  const lines = log.split('\n');
  const start = lines.findIndex((line) => pattern.test(line));
  return start === -1 ? null : lines.slice(start, start + count).join('\n');
}

function classifyMissingDump(input: ParityInput): Outcome {
  const log = input.testLog;
  const panic = excerptFrom(log, /panicked at/, 8);
  if (/failed to run custom build command|could not compile/.test(log)) {
    return {
      kind: 'unavailable',
      reason: 'the CLI did not build against this contract',
      detail: panic ?? excerptFrom(log, /^error/, 12) ?? lastLines(log, 15),
    };
  }
  if (/^test \S+ \.\.\. FAILED$/m.test(log)) {
    return {
      kind: 'unavailable',
      reason: 'the CLI could not load this contract',
      detail: panic ?? lastLines(log, 15),
    };
  }
  return {
    kind: 'broken',
    reason:
      input.testExit === null
        ? 'the CLI tests did not run'
        : `the CLI tests ended with exit code ${input.testExit} and wrote no divergence dump`,
    detail: lastLines(log, 15),
  };
}

export function classify(input: ParityInput): Outcome {
  if (input.syncExit === 1) {
    return { kind: 'unavailable', reason: 'the CLI could not read this contract', detail: lastLines(input.syncLog, 5) };
  }
  if (input.syncExit !== 0) {
    return {
      kind: 'broken',
      reason: input.syncExit === null ? 'the CLI sync did not run' : `the CLI sync ended with exit code ${input.syncExit}`,
      detail: lastLines(input.syncLog, 15),
    };
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
    const owner = ledger.get(rowKey(scenario, element));
    return owner === undefined
      ? { scenario, element, status: 'new' }
      : { scenario, element, status: 'ledgered', owner };
  });
  const closed: Row[] = [...ledger]
    .filter(([key]) => !observed.has(key))
    .map(([key, owner]) => {
      const [scenario = '', element = ''] = key.split('\0');
      return { scenario, element, status: 'closed', owner };
    });
  const order: Row['status'][] = ['new', 'ledgered', 'closed'];
  return {
    kind: 'report',
    rows: order.flatMap((status) => [...seen, ...closed].filter((row) => row.status === status)),
    failedTests: parseFailedTests(input.testLog),
  };
}
