// Web-audit registry shape + scoring tests (plan U1 + U5).
//
// The registry half validates the vendored YAML through the same
// normalize function the build uses, so a bad edit to
// src/data/web-audit/registry.yaml fails here AND at build time.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { KEYWORD_BY_TIER, normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import { buildWebScorecard, computeWebScorePct, type EngineResult } from '../src/worker/audit-web/scorecard';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const REGISTRY_PATH = join(REPO_ROOT, 'src', 'data', 'web-audit', 'registry.yaml');

async function loadNormalized() {
  const raw = await readFile(REGISTRY_PATH, 'utf8');
  return normalizeWebAuditRegistry(yaml.load(raw));
}

describe('web-audit registry shape', () => {
  test('normalizes to exactly 32 checks', async () => {
    const registry = await loadNormalized();
    expect(registry.checks.length).toBe(32);
  });

  test('every check carries id/category/tier/principle/keyword/handler/weight/title/hint', async () => {
    const registry = await loadNormalized();
    for (const check of registry.checks) {
      expect(check.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(Object.keys(registry.categories)).toContain(check.category);
      expect(['required', 'recommended', 'optional']).toContain(check.tier);
      expect(check.principle).toMatch(/^P[1-8]$/);
      expect(['must', 'should', 'may']).toContain(check.keyword);
      expect(['http', 'cors-preflight', 'mcp', 'dns-doh']).toContain(check.handler);
      expect(Number.isInteger(check.weight) && check.weight > 0).toBe(true);
      expect(check.title.length).toBeGreaterThan(0);
      expect(check.hint.length).toBeGreaterThan(0);
      expect(typeof check.with).toBe('object');
    }
  });

  test('keyword is derived mechanically from tier for every check', async () => {
    const registry = await loadNormalized();
    for (const check of registry.checks) {
      expect(check.keyword).toBe(KEYWORD_BY_TIER[check.tier as keyof typeof KEYWORD_BY_TIER]);
    }
  });

  test('tier counts are exactly required 2 / recommended 15 / optional 15', async () => {
    const registry = await loadNormalized();
    const counts: Record<string, number> = {};
    for (const check of registry.checks) counts[check.tier] = (counts[check.tier] ?? 0) + 1;
    expect(counts).toEqual({ required: 2, recommended: 15, optional: 15 });
  });

  test('derived keyword counts match must 2 / should 15 / may 15', async () => {
    const registry = await loadNormalized();
    const counts: Record<string, number> = {};
    for (const check of registry.checks) counts[check.keyword] = (counts[check.keyword] ?? 0) + 1;
    expect(counts).toEqual({ must: 2, should: 15, may: 15 });
  });

  test('principle distribution matches the plan mapping (P5 has zero web checks)', async () => {
    const registry = await loadNormalized();
    const counts: Record<string, number> = {};
    for (const check of registry.checks) counts[check.principle] = (counts[check.principle] ?? 0) + 1;
    expect(counts).toEqual({ P1: 3, P2: 9, P3: 4, P4: 3, P6: 3, P7: 4, P8: 6 });
    expect(counts.P5).toBeUndefined();
  });

  test('mcp_discovery carries well_known, common_paths, and the pinned protocol version', async () => {
    const registry = await loadNormalized();
    expect(registry.mcp_discovery.well_known.length).toBeGreaterThan(0);
    expect(registry.mcp_discovery.common_paths.length).toBeGreaterThan(0);
    expect(registry.mcp_discovery.protocol_version).toBe('2025-06-18');
  });

  test('a check missing principle aborts normalization with a named error', () => {
    const doc = {
      version: 1,
      mcp_discovery: { well_known: ['/x'], common_paths: ['/mcp'], protocol_version: '2025-06-18' },
      categories: { c: 'c' },
      checks: [
        { id: 'x', category: 'c', tier: 'required', weight: 1, title: 't', hint: 'h', handler: 'http', with: {} },
      ],
    };
    expect(() => normalizeWebAuditRegistry(doc)).toThrow(/needs a principle/);
  });

  test('a hand-authored keyword aborts normalization (no keyword drift)', () => {
    const base = {
      version: 1,
      mcp_discovery: { well_known: ['/x'], common_paths: ['/mcp'], protocol_version: '2025-06-18' },
      categories: { c: 'c' },
    };
    const check = {
      id: 'x',
      category: 'c',
      tier: 'optional',
      principle: 'P2',
      weight: 1,
      title: 't',
      hint: 'h',
      handler: 'http',
      with: {},
    };
    expect(() => normalizeWebAuditRegistry({ ...base, checks: [{ ...check, keyword: 'must' }] })).toThrow(/keyword/);
    expect(() => normalizeWebAuditRegistry({ ...base, checks: [{ ...check, keyword: 'may' }] })).toThrow(
      /hand-authors a keyword/,
    );
  });

  test('duplicate check ids abort normalization', () => {
    const doc = {
      version: 1,
      mcp_discovery: { well_known: ['/x'], common_paths: ['/mcp'], protocol_version: '2025-06-18' },
      categories: { c: 'c' },
      checks: [
        {
          id: 'x',
          category: 'c',
          tier: 'optional',
          principle: 'P2',
          weight: 1,
          title: 't',
          hint: 'h',
          handler: 'http',
          with: {},
        },
        {
          id: 'x',
          category: 'c',
          tier: 'optional',
          principle: 'P2',
          weight: 1,
          title: 't',
          hint: 'h',
          handler: 'http',
          with: {},
        },
      ],
    };
    expect(() => normalizeWebAuditRegistry(doc)).toThrow(/duplicate check id/);
  });

  test('normalized JSON round-trips to 32 entries', async () => {
    const registry = await loadNormalized();
    const roundTripped = JSON.parse(JSON.stringify(registry));
    expect(roundTripped.checks.length).toBe(32);
  });
});

function row(partial: Partial<EngineResult>): EngineResult {
  return {
    id: 'x',
    title: 'x',
    principle: 'P2',
    keyword: 'should',
    tier: 'recommended',
    category: 'content-surface',
    weight: 1,
    status: 'pass',
    evidence: '',
    raw_evidence: [],
    ...partial,
  };
}

describe('computeWebScorePct', () => {
  test('credits MUST + SHOULD passes, excludes MAY and n_a', () => {
    const rows: EngineResult[] = [
      row({ keyword: 'must', weight: 5, status: 'pass' }),
      row({ keyword: 'must', weight: 5, status: 'pass' }),
      row({ keyword: 'should', weight: 2, status: 'fail' }),
      row({ keyword: 'may', weight: 3, status: 'fail' }),
      row({ keyword: 'must', weight: 4, status: 'n_a' }),
    ];
    expect(computeWebScorePct(rows)).toBe(83);
  });

  test('all applicable pass yields 100', () => {
    const rows: EngineResult[] = [
      row({ keyword: 'must', weight: 1, status: 'pass' }),
      row({ keyword: 'should', weight: 1, status: 'pass' }),
    ];
    expect(computeWebScorePct(rows)).toBe(100);
  });

  test('no applicable MUST/SHOULD checks yields 0 (never null; renderer reads a number)', () => {
    const rows: EngineResult[] = [
      row({ keyword: 'must', weight: 5, status: 'n_a' }),
      row({ keyword: 'may', weight: 2, status: 'fail' }),
    ];
    expect(computeWebScorePct(rows)).toBe(0);
  });

  test('skip and error statuses are excluded from the denominator', () => {
    const rows: EngineResult[] = [
      row({ keyword: 'must', weight: 2, status: 'pass' }),
      row({ keyword: 'should', weight: 2, status: 'skip' }),
      row({ keyword: 'should', weight: 2, status: 'error' }),
    ];
    expect(computeWebScorePct(rows)).toBe(100);
  });
});

describe('buildWebScorecard', () => {
  const rows: EngineResult[] = [
    row({ id: 'mcp-initialize', principle: 'P2', keyword: 'must', weight: 5, status: 'pass', title: 'init' }),
    row({ id: 'llms-txt', principle: 'P2', keyword: 'should', weight: 4, status: 'pass', title: 'llms' }),
    row({ id: 'robots', principle: 'P7', keyword: 'should', weight: 2, status: 'fail', title: 'robots' }),
    row({ id: 'dns-aid', principle: 'P8', keyword: 'may', weight: 1, status: 'fail', title: 'dns' }),
  ];

  test('produces a CLI-isomorphic shape: badge.score_pct, results[], coverage_summary, tool', () => {
    const sc = buildWebScorecard(rows, {
      targetUrl: 'https://example.com/',
      domain: 'example.com',
      mcpEndpoint: 'https://example.com/mcp',
      discoveryEvidence: [],
      specVersion: '0.3.0',
    });
    expect(sc.schema_version).toBe('0.1');
    expect(sc.spec_version).toBe('0.3.0');
    expect(sc.tool).toEqual({ name: 'example.com', url: 'https://example.com/' });
    expect(sc.target_url).toBe('https://example.com/');
    expect(sc.mcp_endpoint).toBe('https://example.com/mcp');
    expect(sc.badge.score_pct).toBe(82);
    expect(sc.badge.eligible).toBe(false);
    expect(sc.results.length).toBe(4);
    expect(sc.results.every((r) => /^P[1-8]$/.test(r.group))).toBe(true);
    expect(sc.coverage_summary.must.total).toBe(1);
    expect(sc.coverage_summary.must.verified).toBe(1);
    expect(sc.coverage_summary.should.total).toBe(2);
    expect(sc.coverage_summary.should.verified).toBe(1);
  });

  test('n_a rows are excluded from coverage totals', () => {
    const sc = buildWebScorecard(
      [row({ keyword: 'must', status: 'n_a' }), row({ keyword: 'should', status: 'pass' })],
      { targetUrl: 'https://x.dev/', domain: 'x.dev', mcpEndpoint: null, discoveryEvidence: [], specVersion: '0.3.0' },
    );
    expect(sc.coverage_summary.must.total).toBe(0);
    expect(sc.coverage_summary.should.total).toBe(1);
  });

  test('the summary tally counts every status', () => {
    const sc = buildWebScorecard(rows, {
      targetUrl: 'https://example.com/',
      domain: 'example.com',
      mcpEndpoint: null,
      discoveryEvidence: [],
      specVersion: '0.3.0',
    });
    expect(sc.summary.pass).toBe(2);
    expect(sc.summary.fail).toBe(2);
  });
});
