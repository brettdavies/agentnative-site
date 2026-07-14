// Two-score scorer tests (plan-003 U4, KTD-3). The scorer mirrors
// scripts/scoring/score_model.py; the committed fixture pins both
// implementations to the same expected scores, and the Python tool is
// cross-checked directly when it exists (it is guarded from main, so
// the fixture's committed `expected` is the invariant that runs
// everywhere).

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  categoryRollups,
  DEFAULT_BROKEN_FACTOR,
  DEFAULT_SCORE_WEIGHTS,
  type ScoreWeights,
  scoreWebAudit,
  universeMaxOf,
} from '../src/worker/audit-web/score';
import { buildWebScorecard, type EngineResult, WEB_SCHEMA_VERSION } from '../src/worker/audit-web/scorecard';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const FIXTURE_PATH = join(REPO_ROOT, 'tests', 'fixtures', 'web-audit-score-parity.json');
const PY_TOOL = join(REPO_ROOT, 'scripts', 'scoring', 'score_model.py');

type TierOutcome = [keyof ScoreWeights, 'pass' | 'broken' | 'absent' | 'n_a'];

interface ParityFixture {
  weights: ScoreWeights;
  broken_factor: number;
  universe_tiers: Array<keyof ScoreWeights>;
  rows: TierOutcome[];
  expected: { relative: number; global: number };
}

function rowsToResults(rows: TierOutcome[]): Array<Pick<EngineResult, 'keyword' | 'status'>> {
  return rows.map(([keyword, status]) => ({ keyword, status }));
}

/** A registry-shaped universe: 5 MUST, 15 SHOULD, 16 MAY at default weights. */
const UNIVERSE_MAX = universeMaxOf([
  ...Array.from({ length: 5 }, () => ({ keyword: 'must' as const })),
  ...Array.from({ length: 15 }, () => ({ keyword: 'should' as const })),
  ...Array.from({ length: 16 }, () => ({ keyword: 'may' as const })),
]);

function bucketRows(buckets: Partial<Record<string, number>>): Array<Pick<EngineResult, 'keyword' | 'status'>> {
  const out: Array<Pick<EngineResult, 'keyword' | 'status'>> = [];
  for (const [key, count] of Object.entries(buckets)) {
    const [keyword, status] = key.split('_') as [EngineResult['keyword'], EngineResult['status']];
    for (let i = 0; i < (count ?? 0); i++) out.push({ keyword, status });
  }
  return out;
}

describe('scoreWebAudit', () => {
  test('the fairness pair: a bigger correct routine outranks a small perfect one on GLOBAL', () => {
    const big = scoreWebAudit(
      bucketRows({ must_pass: 4, must_absent: 1, should_pass: 13, should_absent: 2, may_pass: 10, may_n_a: 6 }),
      UNIVERSE_MAX,
    );
    const small = scoreWebAudit(bucketRows({ must_pass: 2, should_pass: 8, may_pass: 3, may_n_a: 13 }), UNIVERSE_MAX);
    expect(small.relative).toBe(100);
    expect(big.relative).toBeLessThan(100);
    expect(big.global).toBeGreaterThan(small.global);
  });

  test('a broken MAY scores below the same rows with that MAY absent (n_a)', () => {
    const withBroken = scoreWebAudit(bucketRows({ must_pass: 3, should_pass: 5, may_broken: 2 }), UNIVERSE_MAX);
    const withAbsent = scoreWebAudit(bucketRows({ must_pass: 3, should_pass: 5, may_n_a: 2 }), UNIVERSE_MAX);
    expect(withBroken.relative).toBeLessThan(withAbsent.relative);
    expect(withBroken.global).toBeLessThan(withAbsent.global);
  });

  test('a SHOULD absent drags the relative score less than a MUST absent', () => {
    const shouldAbsent = scoreWebAudit(bucketRows({ must_pass: 1, should_absent: 1 }), UNIVERSE_MAX);
    const mustAbsent = scoreWebAudit(bucketRows({ must_pass: 1, must_absent: 1 }), UNIVERSE_MAX);
    expect(shouldAbsent.relative).toBeGreaterThan(mustAbsent.relative);
  });

  test('broken costs more than absent at every tier', () => {
    for (const keyword of ['must', 'should', 'may'] as const) {
      const broken = scoreWebAudit(
        [
          { keyword: 'must', status: 'pass' },
          { keyword, status: 'broken' },
        ],
        UNIVERSE_MAX,
      );
      const absent = scoreWebAudit(
        [
          { keyword: 'must', status: 'pass' },
          { keyword, status: 'absent' },
        ],
        UNIVERSE_MAX,
      );
      expect(broken.earned).toBeLessThan(absent.earned);
    }
  });

  test('both scores floor at 0 (a mostly-broken site cannot go negative)', () => {
    const score = scoreWebAudit(bucketRows({ must_broken: 3, should_broken: 5 }), UNIVERSE_MAX);
    expect(score.relative).toBe(0);
    expect(score.global).toBe(0);
  });

  test('skip and error rows are excluded from both scores', () => {
    const clean = scoreWebAudit(bucketRows({ must_pass: 2 }), UNIVERSE_MAX);
    const noisy = scoreWebAudit(bucketRows({ must_pass: 2, should_skip: 3, may_error: 2 }), UNIVERSE_MAX);
    expect(noisy).toEqual(clean);
  });

  test('defaults are 5/3/1 weights and a 0.75 broken factor', () => {
    expect(DEFAULT_SCORE_WEIGHTS).toEqual({ must: 5, should: 3, may: 1 });
    expect(DEFAULT_BROKEN_FACTOR).toBe(0.75);
  });
});

describe('score_model.py parity (shared fixture)', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ParityFixture;

  test('the engine scorer reproduces the committed expected scores', () => {
    const universeMax = universeMaxOf(
      fixture.universe_tiers.map((keyword) => ({ keyword })),
      { weights: fixture.weights },
    );
    const score = scoreWebAudit(rowsToResults(fixture.rows), universeMax, {
      weights: fixture.weights,
      brokenFactor: fixture.broken_factor,
    });
    expect({ relative: score.relative, global: score.global }).toEqual(fixture.expected);
  });

  // The dev tool is guarded from main (guard-main-docs extra_paths), so
  // this cross-check runs only on branches that carry it; the committed
  // `expected` above is the always-on invariant.
  test('the Python tool reproduces the committed expected scores', () => {
    if (!existsSync(PY_TOOL)) return;
    const proc = Bun.spawnSync(['python3', '-B', PY_TOOL, '--fixture', FIXTURE_PATH]);
    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString()) as { relative: number; global: number };
    expect({ relative: out.relative, global: out.global }).toEqual(fixture.expected);
  });
});

describe('categoryRollups', () => {
  test('an all-n_a category reports 0/0 and rollups follow category_order', () => {
    const results = [
      { category: 'discoverability', status: 'pass' },
      { category: 'discoverability', status: 'absent' },
      { category: 'mcp-api', status: 'n_a' },
      { category: 'mcp-api', status: 'n_a' },
    ] as Array<Pick<EngineResult, 'category' | 'status'>>;
    const rollups = categoryRollups(results, ['discoverability', 'mcp-api'], {
      discoverability: 'Discoverability',
      'mcp-api': 'MCP & API',
    });
    expect(rollups).toEqual([
      { id: 'discoverability', name: 'Discoverability', passed: 1, counted: 2 },
      { id: 'mcp-api', name: 'MCP & API', passed: 0, counted: 0 },
    ]);
  });
});

describe('buildWebScorecard (schema 0.2)', () => {
  function engineRow(partial: Partial<EngineResult>): EngineResult {
    return {
      id: 'llms-txt',
      title: 'llms.txt',
      principle: 'P2',
      keyword: 'should',
      tier: 'recommended',
      category: 'content-for-agents',
      weight: 4,
      status: 'pass',
      evidence: 'https://example.com/llms.txt -> 200',
      raw_evidence: [],
      ...partial,
    };
  }

  const registry = {
    category_order: ['discoverability', 'content-for-agents'],
    categories: { discoverability: 'Discoverability', 'content-for-agents': 'Content for agents' },
    checks: [{ keyword: 'must' }, { keyword: 'should' }, { keyword: 'may' }] as never,
  };

  const scorecard = buildWebScorecard(
    [
      engineRow({ id: 'a', keyword: 'must', tier: 'required', status: 'pass' }),
      engineRow({ id: 'b', status: 'absent' }),
      engineRow({
        id: 'c',
        keyword: 'may',
        tier: 'optional',
        category: 'discoverability',
        status: 'n_a',
        na_reason: 'optional-absent',
      }),
    ],
    {
      targetUrl: 'https://example.com/',
      domain: 'example.com',
      mcpEndpoint: null,
      discoveryEvidence: [],
      specVersion: '0.5.0',
      registry,
    },
  );

  test('carries score_pct (RELATIVE), the score pair, and no badge', () => {
    expect(scorecard.schema_version).toBe(WEB_SCHEMA_VERSION);
    expect(WEB_SCHEMA_VERSION).toBe('0.2');
    expect(typeof scorecard.score_pct).toBe('number');
    expect(scorecard.score_pct).toBe(scorecard.score.relative);
    expect(typeof scorecard.score.global).toBe('number');
    expect('badge' in scorecard).toBe(false);
  });

  test('scores derive from the registry-shaped universe', () => {
    // earned = 5 + 0; relative denominator = 5 + 1.5; universe = 5+3+1.
    expect(scorecard.score.relative).toBe(77);
    expect(scorecard.score.global).toBe(56);
  });

  test('categories[] rolls up passed/counted excluding n_a, in category_order', () => {
    expect(scorecard.categories).toEqual([
      { id: 'discoverability', name: 'Discoverability', passed: 0, counted: 0 },
      { id: 'content-for-agents', name: 'Content for agents', passed: 1, counted: 2 },
    ]);
  });

  test('rows carry category + hidden principle + na_reason where set', () => {
    const naRow = scorecard.results.find((r) => r.id === 'c');
    expect(naRow?.na_reason).toBe('optional-absent');
    expect(naRow?.category).toBe('discoverability');
    expect(naRow?.principle).toBe('P2');
    const passRow = scorecard.results.find((r) => r.id === 'a');
    expect('na_reason' in (passRow ?? {})).toBe(false);
  });
});
