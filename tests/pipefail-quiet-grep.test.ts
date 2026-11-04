// Guard: nothing that runs under `set -o pipefail` pipes into a quiet grep.
//
// `grep -q` exits on its first match while the writer on the left of the pipe
// may still be writing. The writer takes SIGPIPE and pipefail returns its 141,
// so the pipeline reports failure because the grep matched: a gate reads a
// healthy page as broken, and a guard reads forbidden content as clean. A
// here-string leaves no writer to signal.

import { describe, expect, test } from 'bun:test';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import * as yaml from 'js-yaml';
import { listWorkflows, REPO_ROOT, workflowText } from './helpers/workflows';

const ACTIONS_DIR = join(REPO_ROOT, '.github/actions');
const SETS_PIPEFAIL = /^\s*set\b[^\n#]*\bpipefail\b/m;
const SOURCES_SCRIPT = /^\s*(?:\.|source)\s+.*?([\w.-]+\.sh)\b/gm;
const SHELL_SHEBANG = /^#!.*\b(?:ba)?sh\b/;
// A real pipe, never the `||` operator, into grep or rg with a quiet flag.
const PIPE_INTO_QUIET_GREP =
  /(?<!\|)\|(?!\|)&?\s*[ef]?(?:grep|rg)\b[^|;&]*?\s(?:-[a-zA-Z]*q[a-zA-Z]*|--quiet|--silent)(?=\s|$)/;

/** The pipelines in `script` that end in a quiet grep, each joined onto one line. */
function offendingPipelines(script: string): string[] {
  return script
    .replace(/\\\n\s*/g, ' ')
    .replace(/\|[ \t]*\n\s*/g, '| ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('#') && PIPE_INTO_QUIET_GREP.test(line));
}

/** Tracked shell files with their text. A hook carries no extension, so a shebang counts too. */
function trackedShellFiles(): Map<string, string> {
  const listing = Bun.spawnSync(['git', 'ls-files'], { cwd: REPO_ROOT });
  if (listing.exitCode !== 0) throw new Error(`git ls-files failed: ${listing.stderr.toString()}`);
  const scripts = new Map<string, string>();
  for (const path of listing.stdout.toString().split('\n').filter(Boolean)) {
    const absolute = join(REPO_ROOT, path);
    const extension = extname(path);
    if (extension !== '' && extension !== '.sh' && extension !== '.bash') continue;
    if (!lstatSync(absolute).isFile()) continue;
    const text = readFileSync(absolute, 'utf8');
    if (extension !== '' || SHELL_SHEBANG.test(text)) scripts.set(path, text);
  }
  return scripts;
}

/** Scripts that set pipefail, plus the libraries they source, which run under it too. */
function scriptsUnderPipefail(): Map<string, string> {
  const scripts = trackedShellFiles();
  const sourced = new Set<string>();
  for (const text of scripts.values()) {
    if (!SETS_PIPEFAIL.test(text)) continue;
    for (const [, name] of text.matchAll(SOURCES_SCRIPT)) sourced.add(name);
  }
  return new Map([...scripts].filter(([path, text]) => SETS_PIPEFAIL.test(text) || sourced.has(basename(path))));
}

interface Step {
  name?: string;
  run?: string;
  shell?: string;
}
interface RunDefaults {
  defaults?: { run?: { shell?: string } };
}
interface Workflow extends RunDefaults {
  jobs?: Record<string, RunDefaults & { steps?: Step[] }>;
}
interface CompositeAction {
  runs?: { steps?: Step[] };
}

/** Workflow and composite action `run:` blocks under pipefail, labeled by where they live. */
function stepsUnderPipefail(): Map<string, string> {
  const found = new Map<string, string>();
  const scan = (where: string, steps: Step[] = [], defaultShell?: string) => {
    for (const [index, step] of steps.entries()) {
      if (!step.run) continue;
      const shell = step.shell ?? defaultShell;
      // An explicit `shell: bash` runs `bash -eo pipefail`; an unset shell runs `bash -e`.
      if (shell === 'bash' || shell?.includes('pipefail') || SETS_PIPEFAIL.test(step.run)) {
        found.set(`${where}[${step.name ?? index}]`, step.run);
      }
    }
  };
  for (const file of listWorkflows()) {
    const workflow = yaml.load(workflowText(file)) as Workflow;
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      scan(`.github/workflows/${file} ${jobId}`, job.steps, job.defaults?.run?.shell ?? workflow.defaults?.run?.shell);
    }
  }
  for (const name of readdirSync(ACTIONS_DIR)) {
    const action = yaml.load(readFileSync(join(ACTIONS_DIR, name, 'action.yml'), 'utf8')) as CompositeAction;
    scan(`.github/actions/${name}`, action.runs?.steps);
  }
  return found;
}

describe('offendingPipelines', () => {
  test.each([
    `if printf '%s' "$html" | grep -q 'lrow'; then`,
    `if docker run anc --help 2>/dev/null \\\n  | grep -qE "^  $cmd "; then`,
    `producer |\n  grep -q marker`,
    `id -nG "$USER" | tr ' ' '\\n' | grep -qx docker`,
    'producer | grep -E -q marker',
    'producer | grep --quiet marker',
    'producer | egrep -q marker',
    'producer | rg -q marker',
    'producer |& grep -q marker',
  ])('reports %j', (script) => {
    expect(offendingPipelines(script)).toHaveLength(1);
  });

  test.each([
    `grep -q 'lrow' <<<"$html"`,
    `grep -q marker <<<"$(producer | tr a b)"`,
    'grep -q marker file || true',
    '[[ -f file ]] || grep -q marker file',
    'producer || grep -q marker file',
    '# producer | grep -q marker',
    'producer | grep -c marker',
    'producer | grep -oE marker | sed s/a/b/',
  ])('allows %j', (script) => {
    expect(offendingPipelines(script)).toEqual([]);
  });
});

describe('nothing under pipefail pipes into a quiet grep', () => {
  const scripts = scriptsUnderPipefail();
  const steps = stepsUnderPipefail();

  test('the scan reaches release scripts, an extensionless hook, a sourced library, a workflow step and a composite action', () => {
    expect([...scripts.keys()]).toEqual(
      expect.arrayContaining([
        'scripts/release/postflight.sh',
        'scripts/release/preflight.sh',
        'scripts/monitoring/check-kill-switch.sh',
        'docker/score/setup-host.sh',
        'scripts/hooks/pre-push',
        'scripts/release/_lib.sh',
      ]),
    );
    const stepLabels = [...steps.keys()];
    expect(stepLabels.some((label) => label.startsWith('.github/workflows/ci.yml'))).toBe(true);
    expect(stepLabels.some((label) => label.startsWith('.github/actions/wrangler-crash-probe'))).toBe(true);
  });

  test('every pipeline feeds its grep a here-string', () => {
    const offenders = [...scripts, ...steps].flatMap(([where, text]) =>
      offendingPipelines(text).map((pipeline) => `${where}: ${pipeline}`),
    );
    expect(offenders, 'a quiet grep behind a pipe fails on a match; use grep -q PATTERN <<<"$body"').toEqual([]);
  });
});
