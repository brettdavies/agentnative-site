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
import { universeMaxOf } from '../src/worker/audit-web/score';
import { buildWebScorecard, type EngineResult } from '../src/worker/audit-web/scorecard';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const REGISTRY_PATH = join(REPO_ROOT, 'src', 'data', 'web-audit', 'registry.yaml');

interface NormalizedWebAuditCheck {
  id: string;
  category: string;
  tier: string;
  keyword: string;
  principle: string;
  site_types: string[];
  antecedent: string;
  eval?: string;
  weight: number;
  title: string;
  hint: string;
  handler: string;
  with: object;
}

interface NormalizedWebAuditRegistry {
  version: number;
  mcp_discovery: {
    well_known: string[];
    common_paths: string[];
    protocol_version: string;
  };
  category_order: string[];
  categories: Record<string, string>;
  checks: NormalizedWebAuditCheck[];
}

async function loadNormalized(): Promise<NormalizedWebAuditRegistry> {
  const raw = await readFile(REGISTRY_PATH, 'utf8');
  return normalizeWebAuditRegistry(yaml.load(raw) as object) as NormalizedWebAuditRegistry;
}

describe('web-audit registry shape', () => {
  test('normalizes to exactly 36 checks', async () => {
    const registry = await loadNormalized();
    expect(registry.checks.length).toBe(36);
  });

  test('every check carries id/category/tier/principle/keyword/site_types/antecedent/handler/weight/title/hint', async () => {
    const registry = await loadNormalized();
    for (const check of registry.checks) {
      expect(check.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(Object.keys(registry.categories)).toContain(check.category);
      expect(['required', 'recommended', 'optional']).toContain(check.tier);
      expect(check.principle).toMatch(/^P[1-8]$/);
      expect(['must', 'should', 'may']).toContain(check.keyword);
      expect(['http', 'cors-preflight', 'mcp', 'dns-doh', 'auth-md', 'webmcp', 'scoped-llms']).toContain(check.handler);
      expect(Array.isArray(check.site_types) && check.site_types.length > 0).toBe(true);
      for (const st of check.site_types) expect(['content', 'api', 'mcp', 'all']).toContain(st);
      expect(typeof check.antecedent).toBe('string');
      expect(Number.isInteger(check.weight) && check.weight > 0).toBe(true);
      expect(check.title.length).toBeGreaterThan(0);
      expect(check.hint.length).toBeGreaterThan(0);
      expect(typeof check.with).toBe('object');
    }
  });

  test('the six visible categories are ordered by category_order and each check names one', async () => {
    const registry = await loadNormalized();
    expect(registry.category_order).toEqual([
      'discoverability',
      'content-for-agents',
      'bot-crawl-policy',
      'api',
      'mcp',
      'agent-discovery-auth',
    ]);
    expect(Object.keys(registry.categories).sort()).toEqual([...registry.category_order].sort());
    for (const check of registry.checks) {
      expect(registry.category_order).toContain(check.category);
    }
  });

  test('auth-md and webmcp are registered with the settled applicability', async () => {
    const registry = await loadNormalized();
    const authMd = registry.checks.find((c) => c.id === 'auth-md');
    expect(authMd).toMatchObject({
      category: 'agent-discovery-auth',
      keyword: 'may',
      antecedent: 'auth-present',
      site_types: ['api', 'mcp'],
      handler: 'auth-md',
    });
    const webmcp = registry.checks.find((c) => c.id === 'webmcp');
    expect(webmcp).toMatchObject({
      category: 'mcp',
      keyword: 'may',
      antecedent: 'html-root',
      site_types: ['all'],
      handler: 'webmcp',
    });
  });

  test('well-known-mcp-card carries the canonical-redirect eval rule', async () => {
    const registry = await loadNormalized();
    const card = registry.checks.find((c) => c.id === 'well-known-mcp-card');
    expect(card?.eval).toBe('canonical-redirect');
    expect(card?.antecedent).toBe('mcp-present');
  });

  test('keyword is derived mechanically from tier for every check', async () => {
    const registry = await loadNormalized();
    for (const check of registry.checks) {
      expect(check.keyword).toBe(KEYWORD_BY_TIER[check.tier as keyof typeof KEYWORD_BY_TIER]);
    }
  });

  test('tier counts are exactly required 3 / recommended 15 / optional 18', async () => {
    const registry = await loadNormalized();
    const counts: Record<string, number> = {};
    for (const check of registry.checks) counts[check.tier] = (counts[check.tier] ?? 0) + 1;
    expect(counts).toEqual({ required: 3, recommended: 15, optional: 18 });
  });

  test('derived keyword counts match must 3 / should 15 / may 18', async () => {
    const registry = await loadNormalized();
    const counts: Record<string, number> = {};
    for (const check of registry.checks) counts[check.keyword] = (counts[check.keyword] ?? 0) + 1;
    expect(counts).toEqual({ must: 3, should: 15, may: 18 });
  });

  test('principle distribution matches the plan mapping (P5 has zero web checks)', async () => {
    const registry = await loadNormalized();
    const counts: Record<string, number> = {};
    for (const check of registry.checks) counts[check.principle] = (counts[check.principle] ?? 0) + 1;
    expect(counts).toEqual({ P1: 4, P2: 12, P3: 4, P4: 3, P6: 3, P7: 4, P8: 6 });
    expect(counts.P5).toBeUndefined();
  });

  test('mcp_discovery carries well_known, common_paths, and the pinned protocol version', async () => {
    const registry = await loadNormalized();
    expect(registry.mcp_discovery.well_known.length).toBeGreaterThan(0);
    expect(registry.mcp_discovery.common_paths.length).toBeGreaterThan(0);
    expect(registry.mcp_discovery.protocol_version).toBe('2025-06-18');
  });

  const abortBase = {
    version: 1,
    mcp_discovery: { well_known: ['/x'], common_paths: ['/mcp'], protocol_version: '2025-06-18' },
    category_order: ['c'],
    categories: { c: 'c' },
  };
  const abortCheck = {
    id: 'x',
    category: 'c',
    tier: 'optional',
    principle: 'P2',
    site_types: ['all'],
    antecedent: 'none',
    weight: 1,
    title: 't',
    hint: 'h',
    handler: 'http',
    with: {},
  };

  test('a check missing principle aborts normalization with a named error', () => {
    const { principle: _principle, ...check } = abortCheck;
    expect(() => normalizeWebAuditRegistry({ ...abortBase, checks: [{ ...check, tier: 'required' }] })).toThrow(
      /needs a principle/,
    );
  });

  test('a hand-authored keyword aborts normalization (no keyword drift)', () => {
    expect(() => normalizeWebAuditRegistry({ ...abortBase, checks: [{ ...abortCheck, keyword: 'must' }] })).toThrow(
      /keyword/,
    );
    expect(() => normalizeWebAuditRegistry({ ...abortBase, checks: [{ ...abortCheck, keyword: 'may' }] })).toThrow(
      /hand-authors a keyword/,
    );
  });

  test('an unknown antecedent token aborts normalization', () => {
    expect(() =>
      normalizeWebAuditRegistry({ ...abortBase, checks: [{ ...abortCheck, antecedent: 'not-a-token' }] }),
    ).toThrow(/unknown antecedent/);
  });

  test('an unknown eval rule aborts normalization', () => {
    expect(() => normalizeWebAuditRegistry({ ...abortBase, checks: [{ ...abortCheck, eval: 'not-a-rule' }] })).toThrow(
      /unknown eval rule/,
    );
  });

  test('a missing or invalid site_types aborts normalization', () => {
    const { site_types: _siteTypes, ...noSiteTypes } = abortCheck;
    expect(() => normalizeWebAuditRegistry({ ...abortBase, checks: [noSiteTypes] })).toThrow(/site_types/);
    expect(() =>
      normalizeWebAuditRegistry({ ...abortBase, checks: [{ ...abortCheck, site_types: ['commerce'] }] }),
    ).toThrow(/site_types entry/);
  });

  test('the retired applies_to field aborts normalization', () => {
    expect(() => normalizeWebAuditRegistry({ ...abortBase, checks: [{ ...abortCheck, applies_to: 'any' }] })).toThrow(
      /retired applies_to/,
    );
  });

  test('a category_order that does not match the categories keys aborts normalization', () => {
    expect(() =>
      normalizeWebAuditRegistry({ ...abortBase, category_order: ['c', 'extra'], checks: [abortCheck] }),
    ).toThrow(/category_order/);
  });

  test('duplicate check ids abort normalization', () => {
    expect(() => normalizeWebAuditRegistry({ ...abortBase, checks: [abortCheck, { ...abortCheck }] })).toThrow(
      /duplicate check id/,
    );
  });

  test('normalized JSON round-trips to 36 entries', async () => {
    const registry = await loadNormalized();
    const roundTripped = JSON.parse(JSON.stringify(registry));
    expect(roundTripped.checks.length).toBe(36);
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

describe('buildWebScorecard', () => {
  const registry = {
    category_order: ['content-for-agents'],
    categories: { 'content-for-agents': 'Content for agents' },
    checks: [{ keyword: 'must' }, { keyword: 'should' }, { keyword: 'should' }, { keyword: 'may' }] as never,
  };

  const rows: EngineResult[] = [
    row({ id: 'mcp-initialize', principle: 'P2', keyword: 'must', weight: 5, status: 'pass', title: 'init' }),
    row({ id: 'llms-txt', principle: 'P2', keyword: 'should', weight: 4, status: 'pass', title: 'llms' }),
    row({ id: 'robots', principle: 'P7', keyword: 'should', weight: 2, status: 'absent', title: 'robots' }),
    row({ id: 'dns-aid', principle: 'P8', keyword: 'may', weight: 1, status: 'broken', title: 'dns' }),
  ];

  test('produces the 0.2 shape: score_pct + score pair, results[], coverage_summary, tool', () => {
    const sc = buildWebScorecard(rows, {
      targetUrl: 'https://example.com/',
      domain: 'example.com',
      mcpEndpoint: 'https://example.com/mcp',
      discoveryEvidence: [],
      specVersion: '0.3.0',
      registry,
    });
    expect(sc.schema_version).toBe('0.2');
    expect(sc.spec_version).toBe('0.3.0');
    expect(sc.tool).toEqual({ name: 'example.com', url: 'https://example.com/' });
    expect(sc.target_url).toBe('https://example.com/');
    expect(sc.mcp_endpoint).toBe('https://example.com/mcp');
    // earned = 5 + 3 + 0 - 0.75; relative denominator = 5 + 3 + 1.5 + 1.
    expect(sc.score_pct).toBe(69);
    expect(sc.score).toEqual({ relative: 69, global: 60 });
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
      {
        targetUrl: 'https://x.dev/',
        domain: 'x.dev',
        mcpEndpoint: null,
        discoveryEvidence: [],
        specVersion: '0.3.0',
        registry,
      },
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
      registry,
    });
    expect(sc.summary.pass).toBe(2);
    expect(sc.summary.absent).toBe(1);
    expect(sc.summary.broken).toBe(1);
  });
});

// The load-bearing proof of KTD1: reassigning a check's display category
// (mcp-api -> api/mcp) must not move any score. score.ts reads keyword +
// status only, so a future edit that entangles a tier/weight change with a
// re-categorization is caught here.
describe('scoring invariance under the API/MCP category split (U4, KTD1)', () => {
  test('the real registry keeps its 3/15/18 tier distribution, so universeMax is unchanged', async () => {
    const registry = await loadNormalized();
    // 3 MUST x5 + 15 SHOULD x3 + 18 MAY x1 = 78. Retiering a check (e.g. the
    // deferred openapi MUST -> SHOULD) would move this; the display split
    // alone must not.
    const universeMax = universeMaxOf(
      registry.checks.map((c) => ({ keyword: c.keyword as 'must' | 'should' | 'may' })),
    );
    expect(universeMax).toBe(78);
  });

  test('the same outcomes score identically whether labeled mcp-api or split into api/mcp', () => {
    // One representative result set. The ONLY difference between the two
    // scorecards is each row's display category (and the registry's
    // category map/order); the universe, keywords, and statuses are shared.
    const outcomes = [
      { id: 'openapi', keyword: 'must', status: 'pass', legacyCat: 'mcp-api', splitCat: 'api' },
      { id: 'api-catalog', keyword: 'may', status: 'broken', legacyCat: 'mcp-api', splitCat: 'api' },
      { id: 'mcp-initialize', keyword: 'must', status: 'pass', legacyCat: 'mcp-api', splitCat: 'mcp' },
      { id: 'mcp-cors-preflight', keyword: 'should', status: 'absent', legacyCat: 'mcp-api', splitCat: 'mcp' },
      { id: 'webmcp', keyword: 'may', status: 'n_a', legacyCat: 'mcp-api', splitCat: 'mcp' },
      { id: 'robots', keyword: 'should', status: 'pass', legacyCat: 'discoverability', splitCat: 'discoverability' },
    ] as const;

    // A registry-shaped universe (3 MUST / 15 SHOULD / 18 MAY), shared by both.
    const universeChecks = [
      ...Array.from({ length: 3 }, () => ({ keyword: 'must' })),
      ...Array.from({ length: 15 }, () => ({ keyword: 'should' })),
      ...Array.from({ length: 18 }, () => ({ keyword: 'may' })),
    ] as never;

    const context = {
      targetUrl: 'https://example.com/',
      domain: 'example.com',
      mcpEndpoint: 'https://example.com/mcp',
      discoveryEvidence: [],
      specVersion: '0.5.0',
    };

    const legacy = buildWebScorecard(
      outcomes.map((o) => row({ id: o.id, keyword: o.keyword, status: o.status, category: o.legacyCat })),
      {
        ...context,
        registry: {
          category_order: ['discoverability', 'mcp-api'],
          categories: { discoverability: 'Discoverability', 'mcp-api': 'MCP & API' },
          checks: universeChecks,
        },
      },
    );

    const split = buildWebScorecard(
      outcomes.map((o) => row({ id: o.id, keyword: o.keyword, status: o.status, category: o.splitCat })),
      {
        ...context,
        registry: {
          category_order: ['discoverability', 'api', 'mcp'],
          categories: { discoverability: 'Discoverability', api: 'API', mcp: 'MCP' },
          checks: universeChecks,
        },
      },
    );

    // Scores are byte-for-byte identical across the two labelings.
    expect(split.score_pct).toBe(legacy.score_pct);
    expect(split.score.relative).toBe(legacy.score.relative);
    expect(split.score.global).toBe(legacy.score.global);

    // ...while the grouping is precisely what moved: mcp-api became api + mcp.
    expect(legacy.categories.map((c) => c.id)).toContain('mcp-api');
    expect(split.categories.map((c) => c.id)).toEqual(['discoverability', 'api', 'mcp']);
    expect(split.categories.map((c) => c.id)).not.toContain('mcp-api');
  });
});
