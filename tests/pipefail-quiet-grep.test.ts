// Guard: no shell in this repo pipes into a quiet grep.
//
// `grep -q` exits on its first match while the writer on the left of the pipe
// may still be writing. The writer takes SIGPIPE and pipefail returns its 141,
// so the pipeline reports failure because the grep matched: a gate reads a
// healthy page as broken, and a guard reads forbidden content as clean. A
// here-string leaves no writer to signal.
//
// The rule holds for every script rather than only those that set pipefail,
// because that cannot be read from the file: a sourced library inherits it, and
// `source "$LIB"`, `shopt -so` or `bash -c` set it out of sight.

import { describe, expect, test } from 'bun:test';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import * as yaml from 'js-yaml';
import { listWorkflows, REPO_ROOT, workflowText } from './helpers/workflows';

const ACTIONS_DIR = join(REPO_ROOT, '.github/actions');
const SHELL_SHEBANG = /^#!.*\b(?:ba)?sh\b/;
// A double-quoted string holding `$(` is kept, because a pipeline can live inside it.
const QUOTED_TEXT = /'[^']*'|"(?:[^"$\\]|\\.|\$(?!\())*"/g;
// A real pipe, never the `||` operator, into grep or rg with a quiet flag, past any
// group, path, environment assignment or wrapper in front of the command.
const PIPE_INTO_QUIET_GREP =
  /(?<!\|)\|(?!\|)&?\s*[{(]?\s*(?:\w+=\S*\s+|(?:command|env)\s+|timeout\s+\S+\s+)*(?:\S*\/)?[ef]?(?:grep|rg)\b[^|;&]*?\s(?:-[a-zA-Z0-9]*q[a-zA-Z0-9]*|--quiet|--silent)(?=\s|$)/;

/** The pipelines in `script` that end in a quiet grep, each joined onto one line. */
function offendingPipelines(script: string): string[] {
  return script
    .replace(/^[ \t]*#.*(?:\n|$)/gm, '')
    .replace(/\\\n\s*/g, ' ')
    .replace(/\|[ \t]*\n\s*/g, '| ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => PIPE_INTO_QUIET_GREP.test(line.replace(QUOTED_TEXT, "''")));
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
    // `git ls-files` still lists a file removed from the tree until the removal is staged.
    if (!lstatSync(absolute, { throwIfNoEntry: false })?.isFile()) continue;
    const text = readFileSync(absolute, 'utf8');
    if (extension !== '' || SHELL_SHEBANG.test(text)) scripts.set(path, text);
  }
  return scripts;
}

interface Step {
  name?: string;
  run?: string;
}
interface Workflow {
  jobs?: Record<string, { steps?: Step[] }>;
}
interface CompositeAction {
  runs?: { steps?: Step[] };
}

/** Every workflow and composite action `run:` block, labeled by where it lives. */
function runBlocks(): Map<string, string> {
  const found = new Map<string, string>();
  const scan = (where: string, steps: Step[] = []) => {
    for (const [index, step] of steps.entries()) {
      if (step.run) found.set(`${where}[${step.name ?? index}]`, step.run);
    }
  };
  for (const file of listWorkflows()) {
    const workflow = yaml.load(workflowText(file)) as Workflow;
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      scan(`.github/workflows/${file} ${jobId}`, job.steps);
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
    `producer |\n  # why this pipe\n  grep -q marker`,
    `id -nG "$USER" | tr ' ' '\\n' | grep -qx docker`,
    `x="$(producer | grep -q marker && echo yes)"`,
    'producer | grep -E -q marker',
    `producer | grep -E 'a|b' -q`,
    'producer | grep --quiet marker',
    'producer | grep -qm1 marker',
    'producer | egrep -q marker',
    'producer | rg -q marker',
    'producer |& grep -q marker',
    'producer | LC_ALL=C grep -q marker',
    'producer | command grep -q marker',
    'producer | env grep -q marker',
    'producer | timeout 5 grep -q marker',
    'producer | /usr/bin/grep -q marker',
    'producer | { grep -q marker; }',
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
    `producer | grep -c 'x -quiet y'`,
    `echo "producer | grep -q marker"`,
    'producer | grep -oE marker | sed s/a/b/',
  ])('allows %j', (script) => {
    expect(offendingPipelines(script)).toEqual([]);
  });
});

describe('no shell pipes into a quiet grep', () => {
  const scripts = trackedShellFiles();
  const blocks = runBlocks();

  test('the scan reaches scripts, an extensionless hook, a library, a workflow step and a composite action', () => {
    expect([...scripts.keys()]).toEqual(
      expect.arrayContaining([
        'scripts/release/postflight.sh',
        'scripts/release/preflight.sh',
        'scripts/monitoring/check-kill-switch.sh',
        'scripts/staging-cache-smoke.sh',
        'scripts/cf-access-bootstrap.sh',
        'docker/score/setup-host.sh',
        'scripts/hooks/pre-push',
        'scripts/release/_lib.sh',
      ]),
    );
    const labels = [...blocks.keys()];
    expect(labels.some((label) => label.startsWith('.github/workflows/ci.yml'))).toBe(true);
    expect(labels.some((label) => label.startsWith('.github/actions/wrangler-crash-probe'))).toBe(true);
  });

  test('every pipeline feeds its grep a here-string', () => {
    const offenders = [...scripts, ...blocks].flatMap(([where, text]) =>
      offendingPipelines(text).map((pipeline) => `${where}: ${pipeline}`),
    );
    expect(offenders, 'a quiet grep behind a pipe fails on a match; use grep -q PATTERN <<<"$body"').toEqual([]);
  });
});
