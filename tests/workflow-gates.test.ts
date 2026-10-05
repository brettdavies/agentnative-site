// These gates are contracts written into workflow YAML that nothing
// executes at PR time: the daily sweep must stay lightweight and
// hard-failing (no delta gate, no soft-fail), the production post-deploy
// smoke must stay a governed burn-in exception (non-blocking, pinned to
// the deploy's concurrency group), and the deep-check crash retry must
// stay a single rerun fired from outside the run it retries. A one-line
// edit to any of these files silently reverts a gate, so these
// assertions read the tracked files directly. The burn-in contract
// itself lives in docs/runbooks/live-surface-sweep.md.

import { describe, expect, test } from 'bun:test';
import * as yaml from 'js-yaml';
import { workflowText } from './helpers/workflows';

/** Job ids: the two-space-indented keys after the top-level `jobs:` line. */
function jobIds(workflow: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.indexOf('jobs:');
  return lines
    .slice(start + 1)
    .filter((line) => /^ {2}[\w-]+:\s*$/.test(line))
    .map((line) => line.trim().slice(0, -1));
}

/** One job's block: from its id line up to the next job id (or EOF). */
function jobBlock(workflow: string, id: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${id}:`);
  if (start === -1) return '';
  const next = lines.slice(start + 1).findIndex((line) => /^ {2}[\w-]+:\s*$/.test(line));
  return lines.slice(start, next === -1 ? undefined : start + 1 + next).join('\n');
}

interface Step {
  uses?: string;
  run?: string;
  with?: { name?: string; path?: string };
}

interface Job {
  name?: string;
  if?: string;
  steps?: Step[];
}

interface Workflow {
  name?: string;
  on?: { workflow_run?: { workflows?: string[]; types?: string[] } };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

/** Every line of every `run:` script, minus shell comment lines. */
function runLines(workflow: Workflow): string[] {
  return Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .flatMap((step) => (step.run ?? '').split('\n'))
    .filter((line) => !line.trimStart().startsWith('#'));
}

const deployYml = workflowText('deploy.yml');
const sweepYml = workflowText('mcp-sweep.yml');
const deepCheck = yaml.load(workflowText('deep-check.yml')) as Workflow;
const retry = yaml.load(workflowText('deep-check-crash-retry.yml')) as Workflow;
const PROBE_ACTION = './.github/actions/wrangler-crash-probe';

describe('deploy.yml production smoke is a governed burn-in gate', () => {
  const smoke = jobBlock(deployYml, 'production-smoke');

  test('the job exists and needs the production deploy', () => {
    expect(
      jobIds(deployYml),
      'deploy.yml must keep a production-smoke job; restore it next to the production job',
    ).toContain('production-smoke');
    expect(smoke, 'production-smoke must declare `needs: production` so it probes the deployment it follows').toMatch(
      /^\s{4}needs:\s*production\s*$/m,
    );
  });

  test('the job shares the deploy-production concurrency group, no cancel-in-progress', () => {
    expect(
      smoke,
      'production-smoke must set `group: deploy-production` so a second merge queues instead of swapping the deploy under a running smoke',
    ).toMatch(/^\s{6}group:\s*deploy-production\s*$/m);
    expect(
      smoke,
      'production-smoke must set `cancel-in-progress: false`; cancelling the group would kill the smoke or the queued deploy',
    ).toMatch(/^\s{6}cancel-in-progress:\s*false\s*$/m);
  });

  test('the job is non-blocking via a literal job-level continue-on-error', () => {
    // Job-level = 4-space indent; a literal `true` keeps the flip to
    // blocking a pure deletion (docs/runbooks/live-surface-sweep.md).
    expect(
      smoke,
      'production-smoke must carry job-level `continue-on-error: true` until the burn-in flip criterion in docs/runbooks/live-surface-sweep.md is met',
    ).toMatch(/^ {4}continue-on-error: true\s*$/m);
  });
});

describe('mcp-sweep.yml probes the live surfaces daily, ungated and hard-failing', () => {
  test('fires on a daily cron and on manual dispatch', () => {
    expect(sweepYml, 'mcp-sweep.yml must keep its daily `schedule:` cron trigger').toMatch(
      /^\s{4}- cron: '\d+ \d+ \* \* \*'\s*$/m,
    );
    expect(sweepYml, 'mcp-sweep.yml must keep `workflow_dispatch:` so green runs can be seeded manually').toMatch(
      /^\s{2}workflow_dispatch:\s*$/m,
    );
  });

  test('exactly two legs, staging and production, as independent jobs', () => {
    expect(
      jobIds(sweepYml),
      'mcp-sweep.yml must hold exactly the sweep-staging and sweep-production jobs; separate jobs let each surface red independently',
    ).toEqual(['sweep-staging', 'sweep-production']);
  });

  test('the staging leg checks out dev', () => {
    expect(
      jobBlock(sweepYml, 'sweep-staging'),
      'sweep-staging must check out `ref: dev`; staging deploys from dev, so any other ref asserts against a deployment it does not describe',
    ).toMatch(/^\s{10}ref: dev\s*$/m);
  });

  test('no delta gate: every scheduled run probes the live surface', () => {
    // The sweep exists because surfaces rot without code changes, so any
    // change-detection gate defeats it.
    expect(sweepYml, 'mcp-sweep.yml must not filter on paths; the sweep runs regardless of what changed').not.toMatch(
      /^\s*paths(-ignore)?:/m,
    );
    expect(
      sweepYml,
      'mcp-sweep.yml must not gate on prior activity (no preflight/should_run job); delete the gate, not the probes',
    ).not.toMatch(/should_run/);
    expect(
      sweepYml,
      'mcp-sweep.yml jobs must not depend on each other via `needs:`; each leg reds independently',
    ).not.toMatch(/^\s*needs:/m);
  });

  test('no continue-on-error anywhere', () => {
    // The sweep gates nothing downstream, so red simply shows red; a
    // soft-fail probe silently reverts the gate. Comment lines are
    // exempt: the file's own header states this rule.
    const yamlLines = sweepYml.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    expect(
      yamlLines.filter((line) => line.includes('continue-on-error')),
      'mcp-sweep.yml must not set continue-on-error; the sweep is blocking by design, so remove the soft-fail or the broken check',
    ).toEqual([]);
  });

  test('each leg probes the homepage as HTML and greps a captured body', () => {
    for (const id of jobIds(sweepYml)) {
      const leg = jobBlock(sweepYml, id);
      expect(
        leg,
        `${id} must send an explicit HTML Accept header; curl's default Accept negotiates the markdown twin, which has no HTML markers`,
      ).toMatch(/-H 'Accept: text\/html'/);
      expect(
        leg,
        `${id} must capture the homepage body to a file (curl -o) instead of piping; under pipefail, curl | grep false-fails on early matches (SIGPIPE)`,
      ).toMatch(/-o "\$RUNNER_TEMP\/home\.html"/);
      expect(leg, `${id} must grep the captured body file for the homepage marker`).toMatch(
        /grep -q '[^']+' "\$RUNNER_TEMP\/home\.html"/,
      );
    }
  });
});

describe('deep-check-crash-retry.yml reruns a crashed deep-check once, from outside the run', () => {
  test('fires on the completion of the workflow deep-check.yml names itself', () => {
    expect(
      retry.on?.workflow_run,
      'deep-check-crash-retry.yml must trigger on `workflow_run` of deep-check with `types: [completed]`; the trigger matches by workflow name, and the API refuses a rerun until the run has completed',
    ).toEqual({ workflows: [deepCheck.name ?? ''], types: ['completed'] });
  });

  test('every job runs only for a failed first attempt', () => {
    const jobs = Object.entries(retry.jobs);
    expect(jobs.length).toBeGreaterThan(0);
    for (const [id, job] of jobs) {
      const guard = job.if ?? '';
      expect(guard, `${id} must skip deep-check runs that did not fail`).toMatch(
        /github\.event\.workflow_run\.conclusion == 'failure'/,
      );
      expect(
        guard,
        `${id} must cap the retry at one: the rerun's own completion fires this workflow again with run_attempt 2, which the guard must drop`,
      ).toMatch(/github\.event\.workflow_run\.run_attempt == 1\b/);
      expect(guard, `${id} must require both conditions together, never either one`).not.toMatch(/\|\|/);
    }
  });

  test('reruns every failed job in a single --failed call', () => {
    const reruns = runLines(retry).filter((line) => line.includes('gh run rerun'));
    expect(
      reruns,
      'deep-check-crash-retry.yml must call `gh run rerun` exactly once; a second call finds the run already in progress from the first and is refused',
    ).toHaveLength(1);
    expect(reruns[0], 'the one rerun call must pass --failed so every failed job reruns together').toMatch(
      /--failed\b/,
    );
    expect(
      retry.permissions?.actions,
      'deep-check-crash-retry.yml needs `actions: write`; without it GITHUB_TOKEN cannot rerun the run',
    ).toBe('write');
  });

  test('inspects every deep-check job that probes for the crash, through the artifact that job uploads', () => {
    const lines = runLines(retry);
    const artifactFor = new Map<string, string>();
    for (const [, prefix = '', artifact = ''] of lines.join('\n').matchAll(/\["([^"]+)"\]="([^"]+)"/g)) {
      artifactFor.set(prefix, artifact);
    }
    const loopLine = lines.find((line) => line.trimStart().startsWith('for prefix in ')) ?? '';
    expect(
      [...loopLine.matchAll(/"([^"]+)"/g)].map(([, prefix]) => prefix),
      'the retry loop must visit exactly the job-name prefixes artifact_for maps',
    ).toEqual([...artifactFor.keys()]);

    const probing = Object.entries(deepCheck.jobs).filter(([, job]) =>
      (job.steps ?? []).some((step) => step.uses === PROBE_ACTION),
    );
    expect(
      probing.length,
      `deep-check.yml must run ${PROBE_ACTION} in each job that boots wrangler dev`,
    ).toBeGreaterThan(0);
    for (const [id, job] of probing) {
      const prefix = [...artifactFor.keys()].find((key) => job.name?.startsWith(key)) ?? '';
      const artifact = artifactFor.get(prefix);
      expect(
        artifact,
        `deep-check job ${id} ("${job.name}") runs the crash probe, but no artifact_for prefix in deep-check-crash-retry.yml matches its name, so its crashes never earn the retry`,
      ).toBeDefined();
      const upload = (job.steps ?? []).find(
        (step) => step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === artifact,
      );
      expect(
        upload?.with?.path ?? '',
        `deep-check job ${id} must upload wrangler-logs/ in the "${artifact}" artifact the retry downloads`,
      ).toContain('wrangler-logs/');
    }
  });
});

describe('deep-check.yml leaves reruns to the crash-retry workflow', () => {
  test('no deep-check job requests a rerun', () => {
    expect(
      runLines(deepCheck).filter((line) => /\brerun\b/.test(line)),
      'deep-check.yml must not rerun its own jobs: the API refuses a rerun while the run is in progress, and a job inside deep-check is what keeps it in progress; the retry lives in deep-check-crash-retry.yml',
    ).toEqual([]);
  });
});
