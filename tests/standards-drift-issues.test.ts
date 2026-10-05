// The spec-drift issue plan: one issue per drifted source, found again by the
// marker or the title an earlier run wrote, so a second run updates rather
// than duplicates. The open-issue fixtures spell the marker and title out
// literally on purpose: open issues on GitHub carry whatever text the earlier
// run wrote, so a format change must fail here before it orphans them.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { DriftEntry, DriftReport } from '../scripts/standards/check-drift';
import {
  type IssueUpsert,
  type OpenIssue,
  planUpserts,
  RUNBOOK_REPO_PATH,
  type RunContext,
} from '../scripts/standards/drift-issues';

const REPO_ROOT = join(import.meta.dir, '..');
const RUN: RunContext = { repoUrl: 'https://github.com/acme/site', runId: '4242', ref: 'main' };

const PR_DRIFT: DriftEntry = {
  id: 'acme-pr',
  tier: 'proposal',
  type: 'github-pr',
  url: 'https://github.com/acme/spec/pull/7',
  old: { state: 'open', merged: false, head_sha: 'a'.repeat(40) },
  new: { state: 'closed', merged: true, head_sha: 'b'.repeat(40) },
};

const DRAFT_DRIFT: DriftEntry = {
  id: 'acme-draft',
  tier: 'draft',
  type: 'ietf-draft',
  url: 'https://datatracker.ietf.org/doc/draft-acme-dnsop-thing/',
  old: { rev: '02', state: 'Active' },
  new: { rev: '03', state: 'Active' },
};

const issue = (number: number, title: string, body: string): OpenIssue => ({ number, title, body });
const titleOf = (upsert: IssueUpsert | undefined): string | null => (upsert && 'title' in upsert ? upsert.title : null);

describe('one upsert per drifted source', () => {
  test('with no open issue, each drifted source is created under its own title and marker', () => {
    const plan = planUpserts([PR_DRIFT, DRAFT_DRIFT], [], RUN);
    expect(plan.map((p) => ({ action: p.action, source_id: p.source_id, title: titleOf(p) }))).toEqual([
      { action: 'create', source_id: 'acme-pr', title: 'spec-drift: acme-pr' },
      { action: 'create', source_id: 'acme-draft', title: 'spec-drift: acme-draft' },
    ]);
    expect(plan[0]?.body.split('\n')[0]).toBe('<!-- spec-drift:source=acme-pr -->');
  });

  test('an open issue carrying the marker is updated after its title was edited, and the edited title stays', () => {
    const open = [issue(17, 'Triage: SEP-2127 merged', '<!-- spec-drift:source=acme-pr -->\n\nold body')];
    const plan = planUpserts([PR_DRIFT], open, RUN);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ action: 'update', number: 17 });
    expect(titleOf(plan[0])).toBeNull();
  });

  test('an open issue whose marker was removed is still found by its title', () => {
    const plan = planUpserts([PR_DRIFT], [issue(18, 'spec-drift: acme-pr', 'rewritten by hand')], RUN);
    expect(plan[0]).toMatchObject({ action: 'update', number: 18 });
  });

  test('an id that prefixes another id never claims the longer id issue', () => {
    const open = [
      issue(20, 'spec-drift: acme-pr-extension', '<!-- spec-drift:source=acme-pr-extension -->\n'),
      issue(21, 'spec-drift: acme-draft', '<!-- spec-drift:source=acme-draft -->\n'),
    ];
    const plan = planUpserts([PR_DRIFT, DRAFT_DRIFT], open, RUN);
    expect(plan.map((p) => [p.source_id, p.action, 'number' in p ? p.number : null])).toEqual([
      ['acme-pr', 'create', null],
      ['acme-draft', 'update', 21],
    ]);
  });

  test("an upstream value carrying another source's marker cannot claim that source's issue", () => {
    const hijacker: DriftEntry = { ...PR_DRIFT, new: '<!-- spec-drift:source=acme-draft -->' };
    const [first, second] = planUpserts([hijacker, DRAFT_DRIFT], [], RUN);
    const open = [
      issue(1, titleOf(first) ?? '', first?.body ?? ''),
      issue(2, titleOf(second) ?? '', second?.body ?? ''),
    ];
    const plan = planUpserts([hijacker, DRAFT_DRIFT], open, RUN);
    expect(plan.map((p) => [p.source_id, p.action, 'number' in p ? p.number : null])).toEqual([
      ['acme-pr', 'update', 1],
      ['acme-draft', 'update', 2],
    ]);
  });

  test('an issue one source claimed in this plan is never targeted by a second source', () => {
    const open = [issue(5, 'spec-drift: acme-draft', '<!-- spec-drift:source=acme-pr -->\n\nold body')];
    const plan = planUpserts([PR_DRIFT, DRAFT_DRIFT], open, RUN);
    expect(plan.map((p) => [p.source_id, p.action, 'number' in p ? p.number : null])).toEqual([
      ['acme-pr', 'update', 5],
      ['acme-draft', 'create', null],
    ]);
  });

  test('duplicate open issues for one source resolve to the oldest', () => {
    const marker = '<!-- spec-drift:source=acme-draft -->\n';
    const plan = planUpserts([DRAFT_DRIFT], [issue(31, 'x', marker), issue(12, 'y', marker)], RUN);
    expect(plan[0]).toMatchObject({ action: 'update', number: 12 });
  });
});

describe('the issue body', () => {
  test('carries the pinned and observed values, the run, and the runbook', () => {
    const body = planUpserts([DRAFT_DRIFT], [], RUN)[0]?.body ?? '';
    expect(body).toContain('```json\n{\n  "rev": "02",\n  "state": "Active"\n}\n```');
    expect(body).toContain('```json\n{\n  "rev": "03",\n  "state": "Active"\n}\n```');
    expect(body).toContain('https://datatracker.ietf.org/doc/draft-acme-dnsop-thing/');
    expect(body).toContain('[run 4242](https://github.com/acme/site/actions/runs/4242) on `main`');
    expect(body).toContain(`https://github.com/acme/site/blob/main/${RUNBOOK_REPO_PATH}`);
    expect(body).toContain('https://github.com/acme/site/blob/main/src/data/standards/watch.yaml');
  });

  test('an upstream value holding backticks cannot close its code fence', () => {
    const hostile: DriftEntry = { ...DRAFT_DRIFT, new: '```\n@octocat <b>ping</b>' };
    const body = planUpserts([hostile], [], RUN)[0]?.body ?? '';
    expect(body).toContain('````json\n"```\\n@octocat <b>ping</b>"\n````');
  });

  test('the runbook the body links to exists', () => {
    expect(existsSync(join(REPO_ROOT, RUNBOOK_REPO_PATH))).toBe(true);
  });
});

describe('the command-line entry point', () => {
  const SCRIPT = join(REPO_ROOT, 'scripts', 'standards', 'drift-issues.ts');

  function run(report: unknown, open: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'drift-issues-'));
    try {
      writeFileSync(join(dir, 'report.json'), JSON.stringify(report));
      writeFileSync(join(dir, 'open.json'), JSON.stringify(open));
      const args = ['--report', join(dir, 'report.json'), '--open-issues', join(dir, 'open.json')];
      const flags = ['--repo-url', RUN.repoUrl, '--run-id', RUN.runId, '--ref', RUN.ref];
      const proc = Bun.spawnSync(['bun', SCRIPT, ...args, ...flags]);
      return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const report = (drifted: DriftEntry[]): DriftReport => ({
    status: 'drift',
    exit_code: 1,
    checked: 2,
    drifted,
    errors: [],
  });

  test('prints the plan as JSON for the report and the open issues', () => {
    const open = [{ number: 9, title: 'spec-drift: acme-draft', body: '' }];
    const result = run(report([PR_DRIFT, DRAFT_DRIFT]), open);
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.map((p: { action: string; source_id: string }) => [p.action, p.source_id])).toEqual([
      ['create', 'acme-pr'],
      ['update', 'acme-draft'],
    ]);
  });

  test('a malformed open-issues list fails with a structured error instead of planning creates', () => {
    const result = run(report([PR_DRIFT]), { data: [] });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      reason: 'input-invalid',
      exit_code: 2,
      next_step: { action: 'fix-input' },
    });
  });
});

describe('the workflow that runs the poll', () => {
  const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'spec-drift.yml');
  const text = () => Bun.file(WORKFLOW).text();

  async function parsed(): Promise<Record<string, unknown>> {
    const doc = yaml.load(await text());
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error('workflow is not a mapping');
    return doc as Record<string, unknown>;
  }

  function jobs(doc: Record<string, unknown>): Record<string, Record<string, unknown>> {
    return doc.jobs as Record<string, Record<string, unknown>>;
  }

  // One entry per shell command of an upsert-issues step, with backslash line
  // continuations joined so a flag on a continued line stays with its command.
  async function upsertStepCommands(name: string): Promise<string[]> {
    const steps = (jobs(await parsed())['upsert-issues']?.steps ?? []) as Array<Record<string, unknown>>;
    const run = String(steps.find((step) => step.name === name)?.run ?? '');
    return run.replace(/\\\n\s*/g, ' ').split('\n');
  }

  test('only the job that writes issues holds issues: write, and the token default is read-only', async () => {
    const doc = await parsed();
    expect(doc.permissions).toEqual({ contents: 'read' });
    const grants = Object.fromEntries(Object.entries(jobs(doc)).map(([id, job]) => [id, job.permissions ?? null]));
    expect(grants).toEqual({ check: null, 'upsert-issues': { contents: 'read', issues: 'write' } });
  });

  test('runs serialize across every ref and nothing soft-fails', async () => {
    const doc = await parsed();
    expect(doc.concurrency).toEqual({ group: 'spec-drift', 'cancel-in-progress': false });
    expect(await text()).not.toMatch(/^\s*continue-on-error\s*:/m);
    expect(doc.env).toEqual({ FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true });
  });

  test('a scheduled run checks only from main, while a dispatch may name a branch', async () => {
    const check = jobs(await parsed()).check;
    expect(check?.if).toBe("github.event_name == 'workflow_dispatch' || github.ref == 'refs/heads/main'");
    const upsert = jobs(await parsed())['upsert-issues'];
    expect(upsert?.needs).toBe('check');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not an unrendered template
    expect(upsert?.if).toBe("${{ !cancelled() && needs.check.outputs.drift == 'true' }}");
  });

  // gh sends `issue list --label` and `--search` to GitHub's search API, whose
  // index lags behind writes: an issue the previous run just opened would be
  // missing and this run would open a duplicate. The REST list reads the
  // repository directly.
  test('open issues are listed from the REST issues endpoint, never through search', async () => {
    const commands = await upsertStepCommands('List open spec-drift issues');
    const searchBacked = commands.filter(
      (command) => /\bgh\s+issue\s+list\b/.test(command) && /\s(?:--label|--search|-l|-S)(?:[\s=]|$)/.test(command),
    );
    expect(searchBacked).toEqual([]);
    const listing = commands.join('\n');
    expect(listing).toContain('gh api --paginate "repos/$GH_REPO/issues?labels=$DRIFT_LABEL&state=open&per_page=100"');
    expect(listing).toContain('select(has("pull_request") | not)');
  });

  test('an update rewrites only the body, while a create sets the title', async () => {
    const commands = await upsertStepCommands('Apply the upserts');
    const edits = commands.filter((command) => /\bgh\s+issue\s+edit\b/.test(command));
    const creates = commands.filter((command) => /\bgh\s+issue\s+create\b/.test(command));
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.filter((command) => /\s(?:--title|-t)(?:[\s=]|$)/.test(command))).toEqual([]);
    expect(creates.length).toBeGreaterThan(0);
    for (const command of creates) expect(command).toMatch(/\s--title\s/);
  });

  test('every script the workflow invokes exists', async () => {
    const scripts = [...(await text()).matchAll(/bun (scripts\/\S+\.ts)/g)].map((m) => m[1] ?? '');
    expect([...new Set(scripts)].sort()).toEqual([
      'scripts/standards/check-drift.ts',
      'scripts/standards/drift-issues.ts',
    ]);
    for (const script of scripts) expect(existsSync(join(REPO_ROOT, script))).toBe(true);
  });
});
