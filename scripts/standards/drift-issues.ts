#!/usr/bin/env bun
// Turn a check-drift report into one issue upsert per drifted source and
// print the plan as JSON on stdout. The spec-drift workflow applies the plan
// with `gh`; this script makes no network calls.
//
// Usage:
//   bun scripts/standards/drift-issues.ts --report <report.json> \
//     --open-issues <issues.json> --repo-url <https://github.com/owner/repo> \
//     --run-id <id> --ref <ref>
//
// `--open-issues` is a JSON array of `{number, title, body}`, one per open
// `spec-drift` issue, read from the REST issues list. An open issue belongs to
// a source when its body's first line is the source's marker or its title is
// the source's title, so a hand-edited title or a stripped marker alone does
// not fork a duplicate. Each issue goes to at most one source per plan.
//
// Exit codes: 0 plan printed; 2 an input is missing or malformed (a
// structured error on stderr, nothing on stdout).

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { type DriftEntry, MANIFEST_REPO_PATH } from './check-drift';

export const RUNBOOK_REPO_PATH = 'docs/runbooks/spec-drift-poll.md';
const SELF_COMMAND = 'bun scripts/standards/drift-issues.ts';

export interface OpenIssue {
  number: number;
  title: string;
  body: string;
}

export interface RunContext {
  repoUrl: string;
  runId: string;
  ref: string;
}

interface Upsert {
  source_id: string;
  title: string;
  body: string;
}

export type IssueUpsert = (Upsert & { action: 'create' }) | (Upsert & { action: 'update'; number: number });

function issueTitle(id: string): string {
  return `spec-drift: ${id}`;
}

function issueMarker(id: string): string {
  return `<!-- spec-drift:source=${id} -->`;
}

// Pinned and observed values are third-party text. Inside a fence longer than
// any backtick run they hold, they render inert: no markdown, no HTML, and no
// @-mention notifications.
function fenced(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}json\n${text}\n${fence}`;
}

function renderBody(drift: DriftEntry, run: RunContext): string {
  const onMain = (path: string) => `${run.repoUrl}/blob/main/${path}`;
  return [
    issueMarker(drift.id),
    '',
    `The watched source \`${drift.id}\` no longer matches its pin in [\`${MANIFEST_REPO_PATH}\`](${onMain(MANIFEST_REPO_PATH)}).`,
    '',
    `- Source: ${drift.url}`,
    `- Tier: \`${drift.tier}\``,
    `- Type: \`${drift.type}\``,
    '',
    '**Pinned**',
    '',
    fenced(drift.old),
    '',
    '**Observed**',
    '',
    fenced(drift.new),
    '',
    "Review the upstream change, then re-pin by copying the observed value into the entry's `pinned` field. Keep this " +
      "issue open until the re-pin reaches `main`, because scheduled runs read `main`'s manifest. The title and this " +
      `body belong to the poll and are rewritten on every drifted run; discuss in comments. Procedure: the ` +
      `[spec-drift poll runbook](${onMain(RUNBOOK_REPO_PATH)}).`,
    '',
    `Last observed by [run ${run.runId}](${run.repoUrl}/actions/runs/${run.runId}) on \`${run.ref}\`.`,
  ].join('\n');
}

// The fenced values further down are third-party text and may hold any
// source's marker verbatim, so only the line renderBody writes the marker on
// can claim an issue.
function carriesMarker(issue: OpenIssue, marker: string): boolean {
  return (issue.body.split(/\r?\n/, 1)[0] ?? '').trim() === marker;
}

export function planUpserts(
  drifted: readonly DriftEntry[],
  open: readonly OpenIssue[],
  run: RunContext,
): IssueUpsert[] {
  const oldestFirst = [...open].sort((a, b) => a.number - b.number);
  // The apply step edits issues in plan order, so two upserts naming one
  // issue would leave only the last source's body on it.
  const claimed = new Set<number>();
  return drifted.map((drift): IssueUpsert => {
    const title = issueTitle(drift.id);
    const marker = issueMarker(drift.id);
    const body = renderBody(drift, run);
    const existing = oldestFirst.find(
      (issue) => !claimed.has(issue.number) && (carriesMarker(issue, marker) || issue.title === title),
    );
    if (!existing) return { action: 'create', source_id: drift.id, title, body };
    claimed.add(existing.number);
    return { action: 'update', source_id: drift.id, number: existing.number, title, body };
  });
}

class InputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new InputError(`${what} at ${path} is not readable JSON: ${err instanceof Error ? err.message : err}`);
  }
}

function parseDrifted(doc: unknown): DriftEntry[] {
  if (!isRecord(doc) || !Array.isArray(doc.drifted)) throw new InputError('report has no "drifted" list');
  return doc.drifted.map((raw: unknown, index): DriftEntry => {
    const ok =
      isRecord(raw) &&
      typeof raw.id === 'string' &&
      /^[a-z0-9][a-z0-9-]*$/.test(raw.id) &&
      typeof raw.tier === 'string' &&
      typeof raw.type === 'string' &&
      typeof raw.url === 'string' &&
      'old' in raw &&
      'new' in raw;
    if (!ok) throw new InputError(`report drifted[${index}] lacks a kebab-case id, tier, type, url, or old and new`);
    return raw as unknown as DriftEntry;
  });
}

function parseOpenIssues(doc: unknown): OpenIssue[] {
  if (!Array.isArray(doc)) throw new InputError('open issues must be a JSON array of {number, title, body} objects');
  return doc.map((raw: unknown, index): OpenIssue => {
    if (!isRecord(raw) || typeof raw.number !== 'number' || typeof raw.title !== 'string') {
      throw new InputError(`open issue [${index}] lacks a numeric number and a string title`);
    }
    return { number: raw.number, title: raw.title, body: typeof raw.body === 'string' ? raw.body : '' };
  });
}

function main(): number {
  try {
    const { values } = parseArgs({
      options: {
        report: { type: 'string' },
        'open-issues': { type: 'string' },
        'repo-url': { type: 'string' },
        'run-id': { type: 'string' },
        ref: { type: 'string' },
      },
      strict: true,
    });
    const { report, 'open-issues': openIssues, 'repo-url': repoUrl, 'run-id': runId, ref } = values;
    if (!report || !openIssues || !repoUrl || !runId || !ref) {
      throw new InputError('--report, --open-issues, --repo-url, --run-id, and --ref are all required');
    }
    const drifted = parseDrifted(readJson(report, 'report'));
    const open = parseOpenIssues(readJson(openIssues, 'open issues'));
    console.log(JSON.stringify(planUpserts(drifted, open, { repoUrl, runId, ref }), null, 2));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const next_step = { action: 'fix-input', command: SELF_COMMAND, docs: null };
    console.error(JSON.stringify({ reason: 'input-invalid', exit_code: 2, message, next_step }));
    return 2;
  }
}

if (import.meta.main) process.exit(main());
