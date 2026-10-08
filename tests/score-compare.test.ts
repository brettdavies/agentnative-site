// The corpus before/after harness decides which rows a change to anc moved.
// docker/score/compare.sh produces the scorecards inside the scorer image;
// everything it concludes from them is pinned here over small run directories
// in the shape the harness writes: runs/<n>/status.tsv plus
// runs/<n>/{base,head}/<tool>.json.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReport,
  cohortBand,
  loadRun,
  majority,
  noiseTsv,
  parseNoise,
  rerunSet,
} from '../docker/score/compare-diff.mjs';
import { renderMarkdown, renderText } from '../docker/score/compare-render.mjs';
import { badgeColor } from '../src/build/badge.mjs';
import { REPO_ROOT } from './helpers/workflows';

type Row = { id: string; audit_id: string; status: string; evidence: string | null; confidence: string };
type Scorecard = Record<string, any>;
type Side = Scorecard | string;

const row = (
  id: string,
  audit_id: string,
  status: string,
  evidence: string | null = null,
  confidence = 'high',
): Row => ({
  id,
  audit_id,
  status,
  evidence,
  confidence,
});

let clock = 0;

function scorecard(rows: Row[], over: Scorecard = {}): Scorecard {
  const summary: Record<string, number> = {
    total: rows.length,
    pass: 0,
    warn: 0,
    fail: 0,
    opt_out: 0,
    n_a: 0,
    skip: 0,
  };
  for (const r of rows) summary[r.status] = (summary[r.status] ?? 0) + 1;
  clock += 1;
  return {
    schema_version: '0.9',
    summary,
    audience: 'mixed',
    audit_profile: null,
    badge: { eligible: false, score_pct: 60 },
    run: { started_at: `2026-10-08T00:00:${String(clock).padStart(2, '0')}Z`, duration_ms: 1000 + clock },
    results: rows,
    ...over,
  };
}

/** One round of a run directory. A string side is a not-scored status. */
function writeRound(runDir: string, n: number, tools: Record<string, { base: Side; head: Side }>): void {
  const dir = join(runDir, 'runs', String(n));
  const lines: string[] = [];
  for (const [tool, pair] of Object.entries(tools)) {
    for (const side of ['base', 'head'] as const) {
      mkdirSync(join(dir, side), { recursive: true });
      if (typeof pair[side] !== 'string') writeFileSync(join(dir, side, `${tool}.json`), JSON.stringify(pair[side]));
    }
    const status = (side: Side) => (typeof side === 'string' ? side : 'ok');
    lines.push([tool, status(pair.base), status(pair.head)].join('\t'));
  }
  writeFileSync(join(dir, 'status.tsv'), `${lines.join('\n')}\n`);
}

function runDir(rounds: Array<Record<string, { base: Side; head: Side }>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'score-compare-'));
  rounds.forEach((tools, n) => {
    writeRound(dir, n, tools);
  });
  return dir;
}

const compare = (rounds: Array<Record<string, { base: Side; head: Side }>>, noise: Set<string> = new Set()): any =>
  buildReport(loadRun(runDir(rounds)), { mode: 'diff', noise });

const PCTS = Array.from({ length: 100 }, (_, pct) => pct);
/** EDGE and EDGE + 1 sit in different bands; FLAT and FLAT + 1 share one. */
const EDGE = PCTS.find((pct) => badgeColor(pct) !== badgeColor(pct + 1)) ?? 0;
const FLAT = PCTS.find((pct) => badgeColor(pct) === badgeColor(pct + 1)) ?? 0;

const QUIET = row('p7-must-quiet', 'p7-quiet', 'warn', 'no --quiet/-q flag detected in --help output');
const VERSION = row('p3-must-version', 'p3-version', 'pass');
const keys = (rows: Array<{ tool: string; id: string; audit_id: string }>) =>
  rows.map((r) => [r.tool, r.id, r.audit_id].join(' '));

describe('row diff', () => {
  test('identical rows report nothing, though every run stamps its own start time and duration', () => {
    const report = compare([
      {
        ripgrep: { base: scorecard([QUIET, VERSION]), head: scorecard([QUIET, VERSION]) },
        terraform: { base: scorecard([VERSION]), head: scorecard([VERSION]) },
      },
    ]);
    expect(report.moved).toEqual([]);
    expect(report.derived_moved).toEqual([]);
    expect(report.harness_bugs).toEqual([]);
    expect(report.not_scored).toEqual([]);
    expect(report.tools).toEqual({ selected: 2, compared: 2, rerun: [] });
  });

  test('rows key on (tool, id, audit_id): one requirement fed by two audits moves one row, not both', () => {
    const gate = row('p1-must-no-interactive', 'p1-flag-existence', 'skip', 'target satisfies P1 via alternative gate');
    const report = compare([
      {
        kubectl: {
          base: scorecard([row('p1-must-no-interactive', 'p1-non-interactive', 'pass'), gate, QUIET]),
          head: scorecard([
            row('p1-must-no-interactive', 'p1-non-interactive', 'warn', 'bare invocation timed out', 'medium'),
            gate,
            QUIET,
          ]),
        },
      },
    ]);
    expect(report.moved).toEqual([
      {
        tool: 'kubectl',
        id: 'p1-must-no-interactive',
        audit_id: 'p1-non-interactive',
        change: 'changed',
        fields: ['status', 'evidence', 'confidence'],
        base: { status: 'pass', evidence: null, confidence: 'high' },
        head: { status: 'warn', evidence: 'bare invocation timed out', confidence: 'medium' },
      },
    ]);
  });

  test('a move in evidence alone names only that field', () => {
    const report = compare([
      {
        ripgrep: {
          base: scorecard([QUIET]),
          head: scorecard([{ ...QUIET, evidence: 'no --quiet, -q or --silent flag in --help output' }]),
        },
      },
    ]);
    expect(report.moved.map((m: any) => m.fields)).toEqual([['evidence']]);
  });

  test('a row one build emits and the other does not is a move', () => {
    const report = compare([
      {
        ripgrep: { base: scorecard([QUIET, VERSION]), head: scorecard([QUIET]) },
        terraform: { base: scorecard([QUIET]), head: scorecard([QUIET, VERSION]) },
      },
    ]);
    expect(
      report.moved.map((m: any) => [m.tool, m.id, m.change, m.base?.status ?? null, m.head?.status ?? null]),
    ).toEqual([
      ['ripgrep', 'p3-must-version', 'removed', 'pass', null],
      ['terraform', 'p3-must-version', 'added', null, 'pass'],
    ]);
  });

  test('two rows that share (id, audit_id) in one scorecard stop the diff', () => {
    const dir = runDir([{ ripgrep: { base: scorecard([QUIET, QUIET]), head: scorecard([QUIET]) } }]);
    expect(() => loadRun(dir)).toThrow('p7-must-quiet');
  });
});

describe('propagated rows', () => {
  const output = (status: string) => row('p2-must-output-flag', 'p2-json-output', status);
  const errors = (evidence: string | null, status = 'skip') =>
    row('p2-must-json-errors', 'p2-json-errors', status, evidence);

  test('a moved row is labeled with its antecedent when the antecedent moved in the same run', () => {
    const report = compare([
      {
        kubectl: {
          base: scorecard([output('pass'), errors(null, 'pass')]),
          head: scorecard([output('opt_out'), errors('antecedent `p2-json-output` is opt_out: no JSON output', 'n_a')]),
        },
      },
    ]);
    expect(report.moved.map((m: any) => [m.audit_id, m.propagated_from ?? null])).toEqual([
      ['p2-json-errors', ['p2-json-output']],
      ['p2-json-output', null],
    ]);
  });

  test('a row that cites an antecedent which held still carries no label', () => {
    const report = compare([
      {
        kubectl: {
          base: scorecard([output('opt_out'), errors('antecedent `p2-json-output` is opt_out: no JSON output')]),
          head: scorecard([output('opt_out'), errors('antecedent `p2-json-output` is opt_out: declared in .anc.toml')]),
        },
      },
    ]);
    expect(report.moved).toHaveLength(1);
    expect(report.moved[0].propagated_from).toBeUndefined();
  });
});

describe('derived fields', () => {
  test('audience, badge and summary are compared per scorecard beside the row that moved them', () => {
    const report = compare([
      {
        kubectl: {
          base: scorecard([QUIET], {
            audience: null,
            audience_reason: 'suppressed',
            badge: { eligible: false, score_pct: EDGE },
          }),
          head: scorecard([{ ...QUIET, status: 'pass', evidence: null }], {
            audience: 'agent-optimized',
            badge: { eligible: true, score_pct: EDGE + 1 },
          }),
        },
      },
    ]);
    const derived = Object.fromEntries(report.derived_moved.map((d: any) => [d.field, [d.base, d.head]]));
    expect(derived).toEqual({
      audience: [null, 'agent-optimized'],
      audience_reason: ['suppressed', null],
      'badge.score_pct': [EDGE, EDGE + 1],
      'badge.eligible': [false, true],
      band: [cohortBand(EDGE), cohortBand(EDGE + 1)],
      'summary.pass': [0, 1],
      'summary.warn': [1, 0],
    });
    expect(report.harness_bugs).toEqual([]);
  });

  test('the band is the score range the site paints with one badge fill', () => {
    const scores = [...PCTS, 100];
    const disagree = scores.flatMap((a) =>
      scores.filter((b) => (cohortBand(a) === cohortBand(b)) !== (badgeColor(a) === badgeColor(b))).map((b) => [a, b]),
    );
    expect(disagree).toEqual([]);
    expect(cohortBand(EDGE)?.endsWith(`-${EDGE}`)).toBe(true);
    expect(cohortBand(EDGE + 1)?.startsWith(`${EDGE + 1}-`)).toBe(true);
  });

  test('a derived field that moves on a tool with no moved row is flagged as a harness bug', () => {
    const report = compare([
      {
        ripgrep: {
          base: scorecard([QUIET], { badge: { eligible: false, score_pct: FLAT } }),
          head: scorecard([QUIET], { badge: { eligible: false, score_pct: FLAT + 1 } }),
        },
      },
    ]);
    expect(report.moved).toEqual([]);
    const score = { tool: 'ripgrep', field: 'badge.score_pct', base: FLAT, head: FLAT + 1 };
    expect(report.harness_bugs).toEqual([{ tool: 'ripgrep', round: 0, derived: [score] }]);
    expect(report.derived_moved).toEqual([score]);
  });
});

describe('tools that did not score', () => {
  test('a tool that scores under one build only is a scoring failure, never a moved row', () => {
    const report = compare([
      {
        sgpt: { base: scorecard([QUIET, VERSION]), head: 'anc-exit-101' },
        yazi: { base: 'timeout', head: scorecard([QUIET]) },
        cursor: { base: 'binary-absent', head: 'binary-absent' },
        ripgrep: { base: scorecard([QUIET]), head: scorecard([QUIET]) },
      },
    ]);
    expect(report.moved).toEqual([]);
    expect(report.not_scored).toEqual([
      { tool: 'cursor', round: 0, base: 'binary-absent', head: 'binary-absent' },
      { tool: 'sgpt', round: 0, base: 'ok', head: 'anc-exit-101' },
      { tool: 'yazi', round: 0, base: 'timeout', head: 'ok' },
    ]);
    expect(report.tools).toEqual({ selected: 4, compared: 1, rerun: [] });
    expect(rerunSet(loadRun(runDir([{ sgpt: { base: scorecard([QUIET]), head: 'timeout' } }]))[0], new Set())).toEqual(
      [],
    );
  });
});

describe('reruns and the majority rule', () => {
  const pass = { ...QUIET, status: 'pass', evidence: null };
  const NOISE = new Set(['kubectl\tp7-must-quiet\tp7-quiet']);

  test('the value two of three runs agree on is the majority; three different values have none', () => {
    const [a, b, c] = [{ status: 'pass' }, { status: 'warn' }, { status: 'fail' }];
    expect(majority([a, b, a])).toEqual(a);
    expect(majority([b, b, b])).toEqual(b);
    expect(majority([a, b, c])).toBeNull();
    expect(majority([a, null, a])).toEqual(a);
    expect(majority([a, null, b])).toBeNull();
  });

  test('every tool with a moved row and every noise-listed tool reruns', () => {
    const rounds = loadRun(
      runDir([
        {
          kubectl: { base: scorecard([QUIET]), head: scorecard([QUIET]) },
          terraform: { base: scorecard([QUIET]), head: scorecard([pass]) },
          ripgrep: { base: scorecard([QUIET]), head: scorecard([QUIET]) },
        },
      ]),
    );
    expect(rerunSet(rounds[0], NOISE)).toEqual(['kubectl', 'terraform']);
    expect(rerunSet(rounds[0], new Set())).toEqual(['terraform']);
  });

  test('a noise-listed row that flips in one rerun and holds in the other two is reported by its majority', () => {
    const steady = { kubectl: { base: scorecard([QUIET]), head: scorecard([QUIET]) } };
    const flipped = { kubectl: { base: scorecard([QUIET]), head: scorecard([pass]) } };
    const report = compare([steady, steady, flipped, steady], NOISE);

    expect(report.moved).toEqual([]);
    expect(report.unstable).toEqual([]);
    expect(report.tools.rerun).toEqual(['kubectl']);
    expect(keys(report.remeasured)).toEqual(['kubectl p7-must-quiet p7-quiet']);
    const [examined] = report.remeasured;
    const warn = { status: 'warn', evidence: QUIET.evidence, confidence: 'high' };
    const flip = { status: 'pass', evidence: null, confidence: 'high' };
    expect(examined.noise_listed).toBe(true);
    expect(examined.runs.base).toEqual({ initial: warn, reruns: [warn, warn, warn], majority: warn });
    expect(examined.runs.head).toEqual({ initial: warn, reruns: [warn, flip, warn], majority: warn });
  });

  test('a noise-listed row that never differs is still shown with its per-run results', () => {
    const steady = { kubectl: { base: scorecard([QUIET]), head: scorecard([QUIET]) } };
    const report = compare([steady, steady, steady, steady], NOISE);
    expect(keys(report.remeasured)).toEqual(['kubectl p7-must-quiet p7-quiet']);
    expect(report.remeasured[0].runs.head.reruns).toHaveLength(3);
  });

  test('a row moves when the majorities differ, and the move carries the majority values', () => {
    const moved = { kubectl: { base: scorecard([QUIET]), head: scorecard([pass]) } };
    const steady = { kubectl: { base: scorecard([QUIET]), head: scorecard([QUIET]) } };
    const report = compare([moved, moved, steady, moved]);

    expect(keys(report.moved)).toEqual(['kubectl p7-must-quiet p7-quiet']);
    expect(report.moved[0].base.status).toBe('warn');
    expect(report.moved[0].head.status).toBe('pass');
    expect(report.moved[0].runs.head.reruns.map((r: any) => r.status)).toEqual(['pass', 'warn', 'pass']);
    expect(report.remeasured).toEqual([]);
  });

  test('a noise-listed row whose majorities differ is noise while both builds return a shared result', () => {
    const at = (base: Row, head: Row, pct = 60) => ({
      kubectl: {
        base: scorecard([base], { badge: { eligible: false, score_pct: base.status === 'pass' ? pct + 1 : pct } }),
        head: scorecard([head], { badge: { eligible: false, score_pct: head.status === 'pass' ? pct + 1 : pct } }),
      },
    });
    // Base runs pass, warn, pass, warn and head runs pass, pass, pass, warn:
    // the rerun majorities are warn and pass, and each build returned both.
    const rounds = [at(pass, pass), at(QUIET, pass), at(pass, pass), at(QUIET, QUIET)];

    const listed = compare(rounds, NOISE);
    expect(listed.moved).toEqual([]);
    expect(keys(listed.noise)).toEqual(['kubectl p7-must-quiet p7-quiet']);
    expect(listed.noise[0].runs.base.majority.status).toBe('warn');
    expect(listed.noise[0].runs.head.majority.status).toBe('pass');
    expect(listed.derived_moved).toEqual([]);
    expect(listed.derived_noise.map((d: any) => d.field)).toContain('badge.score_pct');

    const unlisted = compare(rounds);
    expect(keys(unlisted.moved)).toEqual(['kubectl p7-must-quiet p7-quiet']);
    expect(unlisted.noise).toEqual([]);
  });

  test('a noise-listed row moves when the two builds share no result', () => {
    const moved = { kubectl: { base: scorecard([QUIET]), head: scorecard([pass]) } };
    const report = compare([moved, moved, moved, moved], NOISE);
    expect(keys(report.moved)).toEqual(['kubectl p7-must-quiet p7-quiet']);
    expect(report.noise).toEqual([]);
  });

  test('a row that moved in the first run and settles in the reruns is shown as re-measured, not dropped', () => {
    const moved = { kubectl: { base: scorecard([QUIET]), head: scorecard([pass]) } };
    const steady = { kubectl: { base: scorecard([QUIET]), head: scorecard([QUIET]) } };
    const report = compare([moved, steady, steady, steady]);
    expect(report.moved).toEqual([]);
    expect(keys(report.remeasured)).toEqual(['kubectl p7-must-quiet p7-quiet']);
    expect(report.remeasured[0].noise_listed).toBe(false);
    expect(report.remeasured[0].runs.head.initial.status).toBe('pass');
  });

  test('three different results under one build make the row unstable, with every result shown', () => {
    const head = (status: string) => ({
      kubectl: { base: scorecard([QUIET]), head: scorecard([{ ...QUIET, status, evidence: null }]) },
    });
    const report = compare([head('pass'), head('pass'), head('fail'), head('skip')]);
    expect(report.moved).toEqual([]);
    expect(keys(report.unstable)).toEqual(['kubectl p7-must-quiet p7-quiet']);
    expect(report.unstable[0].runs.head.majority).toBeNull();
    expect(report.unstable[0].runs.head.reruns.map((r: any) => r.status)).toEqual(['pass', 'fail', 'skip']);
  });

  test('a rerun that fails to score casts no vote and is reported as a scoring failure in its round', () => {
    const moved = { kubectl: { base: scorecard([QUIET]), head: scorecard([pass]) } };
    const failed = { kubectl: { base: scorecard([QUIET]), head: 'timeout' } };
    const report = compare([moved, moved, failed, moved]);
    expect(keys(report.moved)).toEqual(['kubectl p7-must-quiet p7-quiet']);
    expect(report.moved[0].runs.head.reruns[1]).toBeNull();
    expect(report.not_scored).toEqual([{ tool: 'kubectl', round: 2, base: 'ok', head: 'timeout' }]);
  });

  test('a derived field is voted like a row', () => {
    const at = (pct: number) => ({
      kubectl: { base: scorecard([QUIET]), head: scorecard([pass], { badge: { eligible: false, score_pct: pct } }) },
    });
    const report = compare([at(64), at(64), at(64), at(64)]);
    const score = report.derived_moved.find((d: any) => d.field === 'badge.score_pct');
    expect([score.base, score.head]).toEqual([60, 64]);
    expect(score.runs.head.reruns).toEqual([{ value: 64 }, { value: 64 }, { value: 64 }]);
  });
});

describe('the A/A noise list', () => {
  test('rows that differ between two runs of one build become the noise list a later run reads back', () => {
    const flaky = row('p1-must-no-interactive', 'p1-non-interactive', 'pass');
    const report = buildReport(
      loadRun(
        runDir([
          {
            gemini: { base: scorecard([flaky, QUIET]), head: scorecard([{ ...flaky, status: 'warn' }, QUIET]) },
            ripgrep: { base: scorecard([QUIET]), head: scorecard([QUIET]) },
          },
        ]),
      ),
      { mode: 'aa', noise: new Set() },
    );
    const tsv = noiseTsv(report);
    expect(tsv).toBe('tool\tid\taudit_id\tfields\ngemini\tp1-must-no-interactive\tp1-non-interactive\tstatus\n');
    expect(parseNoise(tsv)).toEqual(new Set(['gemini\tp1-must-no-interactive\tp1-non-interactive']));
  });
});

describe('rendering', () => {
  const MANIFEST = {
    mode: 'diff',
    image: { ref: 'anc-scorer:test', id: `sha256:${'a'.repeat(64)}` },
    registry_sha256: 'b'.repeat(64),
    builds: {
      base: { commit: '1'.repeat(40), sha256: 'c'.repeat(64) },
      head: { commit: '2'.repeat(40), sha256: 'd'.repeat(64) },
    },
    network: 'bridge',
  };
  const report = () =>
    compare([
      {
        kubectl: {
          base: scorecard([
            row('p6-may-color-flag', 'p6-color-flag', 'warn', 'no `--color` flag: `auto|always|never` for <bin>'),
          ]),
          head: scorecard([row('p6-may-color-flag', 'p6-color-flag', 'warn', 'default shown as `[default: <value>]`')]),
        },
        cursor: { base: 'binary-absent', head: 'binary-absent' },
        sgpt: { base: scorecard([QUIET]), head: 'anc-exit-101' },
      },
    ]);

  test('the markdown table keeps evidence inside its cell', () => {
    const md = renderMarkdown(report(), MANIFEST);
    expect(md).toContain(
      '| kubectl | `p6-may-color-flag` | `p6-color-flag` | warn | high | base: no `--color` flag: `auto\\|always\\|never` for &lt;bin><br>head: default shown as `[default: <value>]` |  |',
    );
    expect(md).toContain('`111111111111`');
    expect(md).toContain('`222222222222`');
  });

  test('the text report separates moved rows, tools that did not run, and one-build scoring failures', () => {
    const text = renderText(report(), MANIFEST);
    const section = (title: string) => text.slice(text.indexOf(title)).split('\n\n')[0];
    expect(section('Moved rows: 1')).toContain('head: default shown as `[default: <value>]`');
    expect(section('Did not run under either build: 1')).toContain('cursor');
    expect(section('Did not run under either build: 1')).not.toContain('sgpt');
    expect(section('Scoring failures under one build only: 1')).toContain('anc-exit-101');
  });
  test('per-run results list every re-measured row, and a moved row only when its runs disagree', () => {
    const pass = { ...QUIET, status: 'pass', evidence: null };
    const moved = { kubectl: { base: scorecard([QUIET, VERSION]), head: scorecard([pass, VERSION]) } };
    const steady = { kubectl: { base: scorecard([QUIET, VERSION]), head: scorecard([QUIET, VERSION]) } };
    const perRun = (md: string) => md.slice(md.indexOf('### Per-run results')).split('\n### ')[0];

    const agreed = compare([moved, moved, moved, moved], new Set(['kubectl\tp3-must-version\tp3-version']));
    expect(perRun(renderMarkdown(agreed, MANIFEST))).toContain(
      '| kubectl | `p3-must-version` | `p3-version` | not moved |',
    );
    expect(perRun(renderMarkdown(agreed, MANIFEST))).not.toContain('p7-must-quiet');
    expect(renderText(agreed, MANIFEST)).toContain('runs  base: 4 of 4 agree  head: 4 of 4 agree');

    const split = compare([moved, moved, steady, moved]);
    expect(perRun(renderMarkdown(split, MANIFEST))).toContain('| kubectl | `p7-must-quiet` | `p7-quiet` | moved |');
    expect(renderText(split, MANIFEST)).toContain('runs  base: A A A A (majority A)  head: B B A B (majority B)');
  });

  test('a noise row is listed with its runs under its own heading, apart from moved rows', () => {
    const pass = { ...QUIET, status: 'pass', evidence: null };
    const pair = (base: Row, head: Row) => ({ kubectl: { base: scorecard([base]), head: scorecard([head]) } });
    const noisy = compare(
      [pair(pass, pass), pair(QUIET, pass), pair(pass, pass), pair(QUIET, QUIET)],
      new Set(['kubectl\tp7-must-quiet\tp7-quiet']),
    );

    const text = renderText(noisy, MANIFEST);
    expect(text).toContain('Moved rows: 0');
    // The row, and the two summary counts that follow it.
    const section = text.slice(text.indexOf('Noise, a result shared by both builds: 3')).split('\n\n')[0];
    expect(section).toContain('kubectl  p7-must-quiet  p7-quiet');
    expect(section).toContain('kubectl  summary.pass');
    expect(section).toContain('runs  base: A B A B (majority B)  head: A A A B (majority A)');
    expect(renderMarkdown(noisy, MANIFEST)).toContain('| kubectl | `p7-must-quiet` | `p7-quiet` | noise |');
  });
});

describe('compare-diff.mjs on a run directory', () => {
  const CLI = join(REPO_ROOT, 'docker/score/compare-diff.mjs');
  const run = (args: string[]) => {
    const result = Bun.spawnSync([process.execPath, CLI, ...args]);
    return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  const manifest = (mode: string) => ({
    mode,
    image: { ref: 'anc-scorer:test', id: `sha256:${'a'.repeat(64)}` },
    registry_sha256: 'b'.repeat(64),
    builds: {
      base: { commit: '1'.repeat(40), sha256: 'c'.repeat(64) },
      head: { commit: '2'.repeat(40), sha256: 'd'.repeat(64) },
    },
    network: 'bridge',
  });
  const moved = {
    terraform: { base: scorecard([QUIET]), head: scorecard([{ ...QUIET, status: 'pass', evidence: null }]) },
    ripgrep: { base: scorecard([QUIET]), head: scorecard([QUIET]) },
  };

  test('rerun-set prints one tool per line and report writes the diff beside the runs', () => {
    const dir = runDir([moved]);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest('diff')));

    expect(run(['rerun-set', dir])).toMatchObject({ exit: 0, stdout: 'terraform\n' });

    const reported = run(['report', dir]);
    expect(reported.exit).toBe(0);
    expect(reported.stdout).toContain('Moved rows: 1');
    expect(reported.stdout).toContain('p7-must-quiet');
    expect(keys(JSON.parse(readFileSync(join(dir, 'diff.json'), 'utf8')).moved)).toEqual([
      'terraform p7-must-quiet p7-quiet',
    ]);
    expect(readFileSync(join(dir, 'diff.md'), 'utf8')).toContain('| terraform | `p7-must-quiet` | `p7-quiet` |');
    expect(existsSync(join(dir, 'noise.tsv'))).toBe(false);
  });

  test('an A/A report writes the noise list, and a later run takes it with --noise', () => {
    const aa = runDir([moved]);
    writeFileSync(join(aa, 'manifest.json'), JSON.stringify(manifest('aa')));
    expect(run(['report', aa]).exit).toBe(0);
    const noise = join(aa, 'noise.tsv');
    expect(readFileSync(noise, 'utf8')).toContain('terraform\tp7-must-quiet\tp7-quiet\tstatus,evidence');

    const steady = { terraform: { base: scorecard([QUIET]), head: scorecard([QUIET]) } };
    const later = runDir([steady]);
    expect(run(['rerun-set', later]).stdout).toBe('');
    expect(run(['rerun-set', later, '--noise', noise]).stdout).toBe('terraform\n');
  });
});
