#!/usr/bin/env bun
// Renders the informational CLI-parity report from what web-audit-cli-parity.yml
// collected: the exit codes and logs of the CLI's sync and tests, its divergence
// dump, ledger and handler vocabulary, and the contract's registry. Writes a job
// summary and the body of the PR comment.
//
// Exit 0 for any report or a stated "report unavailable", because a divergence is
// expected whenever the engine changes and a contract can stop the CLI building.
// Exit 1 only for a run the contract cannot explain, so a broken workflow stays red.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CONTRACT_BUILD_DIR } from '../../src/build/web-audit-contract-paths.mjs';
import { classify, type Outcome, type ParityInput, type Row } from './cli-parity-outcome';

// A PR comment holds 65,536 characters and a step summary 1 MiB; a contract change
// can diverge every row of every scenario, which overruns both.
const COMMENT_ROW_CAP = 200;
const SUMMARY_ROW_CAP = 2000;
const DETAIL_CHAR_CAP = 2000;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

export type { ParityInput };

export interface ParityReport {
  summary: string;
  comment: string;
  exitCode: 0 | 1;
}

function verdict(outcome: Outcome & { kind: 'report' }, testExit: number | null): string {
  const count = (status: Row['status']): number => outcome.rows.filter((row) => row.status === status).length;
  const fresh = outcome.rows.filter((row) => row.status === 'new');
  const parts: string[] = [];
  if (fresh.length > 0) {
    const scenarios = new Set(fresh.map((row) => row.scenario)).size;
    parts.push(
      `The next CLI bump carries ${plural(fresh.length, 'new divergence', 'new divergences')} across ${plural(scenarios, 'scenario', 'scenarios')}.`,
    );
  } else if (outcome.rows.length > 0) {
    parts.push('No new divergence.');
  }
  if (count('ledgered') > 0) parts.push(`${plural(count('ledgered'), 'divergence', 'divergences')} already in the CLI ledger.`);
  if (count('closed') > 0) parts.push(`${plural(count('closed'), 'ledger entry', 'ledger entries')} now matching.`);
  if (parts.length > 0) return parts.join(' ');
  if (outcome.failedTests.length > 0) {
    return `No scorecard divergence, but ${plural(outcome.failedTests.length, 'CLI test fails', 'CLI tests fail')} at this contract.`;
  }
  if (testExit !== 0) return `No scorecard divergence, but the CLI tests ended with exit code ${testExit}.`;
  return 'The CLI reproduces every conformance scenario at this contract.';
}

const code = (value: string): string => `\`${value.replace(/[`|\r\n]/g, ' ')}\``;
const fence = (text: string): string =>
  `\`\`\`text\n${text.slice(0, DETAIL_CHAR_CAP).replace(/`{3,}/g, "'''")}\n\`\`\``;

const STATUS_LABEL: Record<Row['status'], string> = {
  new: 'new',
  ledgered: 'in the CLI ledger',
  closed: 'now matches, in the CLI ledger',
};

function table(rows: Row[], cap: number, overflow: string): string {
  const shown = rows.slice(0, cap).map((row) => {
    const owner = row.owner === undefined ? '' : ` (${code(row.owner)})`;
    return `| ${code(row.scenario)} | ${code(row.element)} | ${STATUS_LABEL[row.status]}${owner} |`;
  });
  const more = rows.length > cap ? `\n\n${plural(rows.length - cap, 'more row', 'more rows')} ${overflow}` : '';
  return ['| Scenario | Element | Status |', '| --- | --- | --- |', ...shown].join('\n') + more;
}

function rustStrSlice(source: string, name: string): string[] | null {
  const body = new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`).exec(source)?.[1];
  return body === undefined ? null : [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
}

function unportedLine(input: ParityInput): string {
  const notChecked = 'Unported handler kinds and eval rules: not checked, the CLI vocabulary or the registry did not parse.';
  if (input.vocab === null || input.registry === null) return notChecked;
  const handlers = rustStrSlice(input.vocab, 'HANDLER_KINDS');
  const evals = rustStrSlice(input.vocab, 'EVAL_RULES');
  if (handlers === null || evals === null) return notChecked;
  let checks: { handler?: string; eval?: string }[];
  try {
    checks = (JSON.parse(input.registry) as { checks: { handler?: string; eval?: string }[] }).checks;
    if (!Array.isArray(checks)) return notChecked;
  } catch {
    return notChecked;
  }
  const missing = (names: (string | undefined)[], known: string[]): string[] =>
    [...new Set(names.filter((name): name is string => name !== undefined && !known.includes(name)))].sort();
  const parts = [
    ...missing(checks.map((check) => check.handler), handlers).map((name) => `handler kind ${code(name)}`),
    ...missing(checks.map((check) => check.eval), evals).map((name) => `eval rule ${code(name)}`),
  ];
  return parts.length === 0
    ? 'Every handler kind and eval rule in this contract is ported.'
    : `Not yet ported by the CLI: ${parts.join(', ')}.`;
}

function render(input: ParityInput, outcome: Outcome, cap: number, overflow: string): string {
  const context = `Contract at ${code(input.siteSha.slice(0, 12))}, CLI ${code(input.cliRef)} at ${code(input.cliSha.slice(0, 12))}. [Run](${input.runUrl})`;
  const sections = ['## CLI parity'];
  if (outcome.kind === 'report') {
    sections.push(`**${verdict(outcome, input.testExit)}**`, context);
    if (outcome.rows.length > 0) sections.push(table(outcome.rows, cap, overflow));
    if (outcome.failedTests.length > 0) {
      sections.push(`Failing CLI tests:\n\n${outcome.failedTests.map((name) => `- ${code(name)}`).join('\n')}`);
    }
    sections.push(unportedLine(input));
    sections.push(
      'Informational: this check is not required and asks nothing of this PR. A divergence reaches the CLI through its next bump PR, where a port closes it.',
    );
    return sections.join('\n\n');
  }
  sections.push(`**Report unavailable: ${outcome.reason}.**`, context);
  if (outcome.detail !== '') sections.push(fence(outcome.detail));
  if (outcome.kind === 'unavailable') {
    sections.push(unportedLine(input));
    sections.push('Informational: this check is not required. The result says nothing about parity at this contract.');
  } else {
    sections.push('This run failed because the report workflow itself needs a fix. The contract is not the cause.');
  }
  return sections.join('\n\n');
}

export function renderParityReport(input: ParityInput): ParityReport {
  const outcome = classify(input);
  return {
    summary: render(input, outcome, SUMMARY_ROW_CAP, 'not shown.'),
    comment: `${input.marker}\n${render(input, outcome, COMMENT_ROW_CAP, `in the [job summary](${input.runUrl}).`)}`,
    exitCode: outcome.kind === 'broken' ? 1 : 0,
  };
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: Object.fromEntries(
      [
        'marker',
        'site-sha',
        'cli-ref',
        'cli-sha',
        'run-url',
        'sync-exit',
        'sync-log',
        'test-exit',
        'test-log',
        'dump',
        'ledger',
        'vocab',
        'summary-out',
        'comment-out',
      ].map((name) => [name, { type: 'string' as const }]),
    ),
  });
  const required = (name: string): string => {
    const value = values[name];
    if (typeof value !== 'string') throw new Error(`--${name} is required`);
    return value;
  };
  const optionalFile = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);
  const exitCode = (name: string): number | null => {
    const value = required(name);
    return /^\d+$/.test(value) ? Number(value) : null;
  };
  const report = renderParityReport({
    marker: required('marker'),
    siteSha: required('site-sha'),
    cliRef: required('cli-ref'),
    cliSha: required('cli-sha'),
    runUrl: required('run-url'),
    syncExit: exitCode('sync-exit'),
    syncLog: optionalFile(required('sync-log')) ?? '',
    testExit: exitCode('test-exit'),
    testLog: optionalFile(required('test-log')) ?? '',
    dump: optionalFile(required('dump')),
    ledger: optionalFile(required('ledger')),
    vocab: optionalFile(required('vocab')),
    registry: optionalFile(join(CONTRACT_BUILD_DIR, 'registry.json')),
  });
  appendFileSync(required('summary-out'), `${report.summary}\n`);
  writeFileSync(required('comment-out'), `${report.comment}\n`);
  return report.exitCode;
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)));
