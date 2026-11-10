import { describe, expect, test } from 'bun:test';
import type { InstallSpec } from '../src/worker/score/discover-binary';
import { type ScoreSandboxEnv, streamScore } from '../src/worker/score/do';
import { type ContainerLike, type ExecLike, score } from '../src/worker/score/sandbox-exec';
import { scorecardShapeIssue } from '../src/worker/score/scorecard-shape';
import { ANC_VERSION } from '../src/worker/spec-version.gen';
import { loadScorecardFixture, SCORECARD_FIXTURES, validScorecard } from './helpers/scorecard-fixture';

const SPEC: InstallSpec = { pm: 'cargo-binstall', package: 'ripgrep', binary: 'rg' };

type Node = Record<string, unknown>;

function parentOf(card: Node, path: string): { node: Node; key: string } {
  const keys = path.split('.');
  let node = card;
  for (const key of keys.slice(0, -1)) node = node[key] as Node;
  return { node, key: keys[keys.length - 1] as string };
}

function withField(path: string, value: unknown): Node {
  const card = validScorecard();
  const { node, key } = parentOf(card, path);
  node[key] = value;
  return card;
}

function withoutField(path: string): Node {
  const card = validScorecard();
  const { node, key } = parentOf(card, path);
  delete node[key];
  return card;
}

const COUNTS = ['total', 'pass', 'warn', 'fail', 'opt_out', 'n_a', 'skip', 'error'].map((f) => `summary.${f}`);
const LEVEL_COUNTS = ['must', 'should', 'may'].flatMap((l) => [
  `coverage_summary.${l}.total`,
  `coverage_summary.${l}.verified`,
]);
const NULLABLE_TEXT = [
  'audience',
  'audit_profile',
  'tool.binary',
  'tool.version',
  'target.path',
  'target.command',
  'badge.embed_markdown',
  'badge.scorecard_url',
  'badge.badge_url',
  'results.0.evidence',
  'results.0.tier',
];
const TEXT = [
  'schema_version',
  'spec_version',
  'tool.name',
  'anc.version',
  'run.invocation',
  'run.started_at',
  'run.platform.os',
  'run.platform.arch',
  'target.kind',
  'badge.convention_url',
  'results.0.id',
  'results.0.label',
  'results.0.group',
  'results.0.layer',
  'results.0.confidence',
  'results.0.audit_id',
];
const REQUIRED = [
  ...COUNTS,
  ...LEVEL_COUNTS,
  ...NULLABLE_TEXT,
  ...TEXT,
  'results',
  'summary',
  'coverage_summary',
  'tool',
  'anc',
  'run',
  'run.duration_ms',
  'run.platform',
  'target',
  'badge',
  'badge.eligible',
  'badge.score_pct',
  'results.0.status',
];

describe('scorecard shape: accepted', () => {
  test.each([...SCORECARD_FIXTURES])('%s matches', (file) => {
    expect(scorecardShapeIssue(loadScorecardFixture(file))).toBeNull();
  });

  test.each(['surprise', 'tool.surprise', 'badge.surprise', 'results.0.surprise'])(
    'unknown field %s passes',
    (path) => {
      expect(scorecardShapeIssue(withField(path, { any: 'value' }))).toBeNull();
    },
  );

  test.each(NULLABLE_TEXT)('%s may be null', (path) => {
    expect(scorecardShapeIssue(withField(path, null))).toBeNull();
  });

  test.each(['pass', 'warn', 'fail', 'opt_out', 'n_a', 'skip', 'error'])('status %s passes', (status) => {
    expect(scorecardShapeIssue(withField('results.0.status', status))).toBeNull();
  });

  test.each([0, 76, 100])('badge score %d passes', (pct) => {
    expect(scorecardShapeIssue(withField('badge.score_pct', pct))).toBeNull();
  });
});

describe('scorecard shape: refused', () => {
  test.each([101, -1, 1.5, '76', null])('badge score %p is refused', (pct) => {
    expect(scorecardShapeIssue(withField('badge.score_pct', pct))).toBe('badge.score_pct');
  });

  test.each(['passed', '', 1, null])('status %p is refused', (status) => {
    expect(scorecardShapeIssue(withField('results.0.status', status))).toBe('results.0.status');
  });

  test.each([...COUNTS, ...LEVEL_COUNTS, 'run.duration_ms'])('%s must be a count', (path) => {
    expect(scorecardShapeIssue(withField(path, '1'))).toBe(path);
    expect(scorecardShapeIssue(withField(path, -1))).toBe(path);
  });

  test.each([...NULLABLE_TEXT, ...TEXT])('%s must be text', (path) => {
    expect(scorecardShapeIssue(withField(path, 1))).toBe(path);
  });

  test('badge.eligible must be a boolean', () => {
    expect(scorecardShapeIssue(withField('badge.eligible', 'true'))).toBe('badge.eligible');
  });

  test('results must be an array', () => {
    expect(scorecardShapeIssue(withField('results', {}))).toBe('results');
  });

  test.each(REQUIRED)('%s is required', (path) => {
    expect(scorecardShapeIssue(withoutField(path))).toBe(path);
  });

  test.each([[null], [[]], ['text'], [1]])('%p is not a scorecard', (value) => {
    expect(scorecardShapeIssue(value)).toBe('root');
  });
});

function stubContainer(ancStdout: string, success = true): ContainerLike {
  return {
    async setOutboundHandler(): Promise<void> {},
    async exec(command: string): Promise<ExecLike> {
      if (command.startsWith('which ')) return { success: true, stdout: '/usr/local/bin/rg\n', stderr: '' };
      if (command === 'anc --version') return { success: true, stdout: `anc ${ANC_VERSION}\n`, stderr: '' };
      if (command.startsWith('anc audit ')) return { success, stdout: ancStdout, stderr: '' };
      return { success: true, stdout: '', stderr: '' };
    },
  };
}

describe('score() returns only a scorecard of the published shape', () => {
  test('a matching scorecard is returned unchanged, unknown fields included', async () => {
    const card = validScorecard({ surprise: true });
    const result = await score(stubContainer(JSON.stringify(card)), SPEC);
    expect(result).toMatchObject({ ok: true, value: { scorecard: card } });
  });

  test.each([true, false])('valid JSON of the wrong shape is refused when anc reports success=%p', async (success) => {
    const result = await score(stubContainer(JSON.stringify(withField('results', 'none')), success), SPEC);
    expect(result).toEqual({ ok: false, error: 'anc_audit_failed', details: 'scorecard shape: results' });
  });

  test('the refusal names the field and never its value', async () => {
    const marker = 'value-that-must-stay-out-of-the-detail';
    const result = await score(stubContainer(JSON.stringify(withField('results.0.status', marker))), SPEC);
    expect(result).toEqual({ ok: false, error: 'anc_audit_failed', details: 'scorecard shape: results.0.status' });
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});

describe('streamScore stores only a scorecard of the published shape', () => {
  async function run(ancStdout: string): Promise<{ writes: string[]; last: Node }> {
    const writes: string[] = [];
    const env: ScoreSandboxEnv = {
      ASSETS: { fetch: async () => new Response('unused') } as unknown as Fetcher,
      SCORE_CACHE: {
        async put(key: string) {
          writes.push(key);
        },
      } as unknown as R2Bucket,
    };
    const { body, done } = streamScore(SPEC, {
      env,
      run: (spec, onPhase) => score(stubContainer(ancStdout), spec, { onPhase }),
      purge: async () => {},
    });
    const text = await new Response(body).text();
    await done;
    const lines = text.trim().split('\n');
    return { writes, last: JSON.parse(lines[lines.length - 1] as string) as Node };
  }

  test('a refused scorecard writes nothing and ends with an error line', async () => {
    const { writes, last } = await run(JSON.stringify(withField('badge.score_pct', 'high')));
    expect(writes).toEqual([]);
    expect(last).toEqual({ error: 'anc_audit_failed', details: 'scorecard shape: badge.score_pct' });
  });

  test('a matching scorecard is written', async () => {
    const { writes, last } = await run(JSON.stringify(validScorecard()));
    expect(writes).toHaveLength(1);
    expect(last).toMatchObject({ anc_version: ANC_VERSION });
  });
});
