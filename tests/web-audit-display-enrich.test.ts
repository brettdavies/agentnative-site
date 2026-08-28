// Read-time display enrichment: category normalization + inline
// remediation are derived from the current registry/catalog on read, so a
// cached scorecard renders the current shape without a re-audit.

import { describe, expect, test } from 'bun:test';
import {
  attachInlineRemediation,
  type DisplayRegistry,
  enrichWebScorecardForDisplay,
  normalizeScorecardCategories,
} from '../src/worker/audit-web/display';
import type { WebRemediationCatalog } from '../src/worker/audit-web/remediation';
import { categoryRollups } from '../src/worker/audit-web/score';

// A registry that splits the combined API/MCP surface into two categories,
// the exact display-only change that leaves old-shape cached scorecards
// grouped under a single bucket.
const SPLIT_REGISTRY: DisplayRegistry = {
  category_order: ['api', 'mcp'],
  categories: { api: 'API', mcp: 'MCP' },
  checks: [
    { id: 'openapi', category: 'api' },
    { id: 'json-schemas', category: 'api' },
    { id: 'mcp-initialize', category: 'mcp' },
    { id: 'mcp-tools-list', category: 'mcp' },
    { id: 'dns-aid', category: 'mcp' },
  ],
};

// The live registry is the read-time authority for a row's normative
// keyword and tier as well as its category, so a cached row that predates
// either field still renders the current obligation.
const HYDRATING_REGISTRY: DisplayRegistry = {
  category_order: ['mcp'],
  categories: { mcp: 'MCP' },
  checks: [
    { id: 'mcp-modern-tools-list', category: 'mcp', keyword: 'must', tier: 'required' },
    { id: 'mcp-tools-list', category: 'mcp', keyword: 'should', tier: 'recommended' },
  ],
};

const CATALOG: WebRemediationCatalog = {
  openapi: { title: 'OpenAPI', goal: 'Publish an OpenAPI description', fix: 'Add /openapi.json', resources: [] },
  'json-schemas': { title: 'Schemas', goal: 'Publish JSON Schemas', fix: 'Reference schemas', resources: [] },
  'mcp-tools-list': {
    title: 'tools/list',
    goal: 'Serve a valid tools/list',
    fix: 'Return a tools array',
    resources: [],
  },
  'dns-aid': {
    title: 'DNS-AID',
    goal: 'Publish DNS-AID records',
    fix: 'Add SVCB records for agent discovery',
    resources: [{ label: 'DNS-AID', url: 'https://anc.dev/dns-aid' }],
  },
};

/** An old-shape stored scorecard: one combined `mcp-api` category, rows tagged `mcp-api`. */
function oldShapeStored() {
  return {
    schema_version: '0.2',
    target_url: 'https://example.com/',
    score_pct: 70,
    score: { relative: 70, global: 55 },
    summary: { pass: 2, broken: 0, absent: 2, n_a: 0, skip: 0, error: 0 },
    coverage_summary: {
      must: { total: 1, verified: 1 },
      should: { total: 2, verified: 1 },
      may: { total: 0, verified: 0 },
    },
    categories: [{ id: 'mcp-api', name: 'MCP & API', passed: 2, counted: 4 }],
    results: [
      { id: 'openapi', category: 'mcp-api', keyword: 'must', status: 'pass', evidence: 'openapi -> 200' },
      { id: 'json-schemas', category: 'mcp-api', keyword: 'should', status: 'absent', evidence: null },
      { id: 'mcp-initialize', category: 'mcp-api', keyword: 'must', status: 'pass', evidence: 'ok' },
      { id: 'mcp-tools-list', category: 'mcp-api', keyword: 'should', status: 'broken', evidence: 'no tools array' },
    ],
  };
}

type NormalizedShape = {
  categories: Array<{ id: string; name: string; passed: number; counted: number }>;
  results: Array<{ id: string; category: string; status: string }>;
  score_pct: number;
  score: { relative: number; global: number };
  summary: Record<string, number>;
  coverage_summary: unknown;
};

describe('normalizeScorecardCategories', () => {
  test('an old-shape combined category splits into the current registry categories', () => {
    const out = normalizeScorecardCategories(oldShapeStored(), SPLIT_REGISTRY) as NormalizedShape;
    expect(out.categories.map((c) => c.id)).toEqual(['api', 'mcp']);
    const byId = new Map(out.results.map((r) => [r.id, r.category]));
    expect(byId.get('openapi')).toBe('api');
    expect(byId.get('json-schemas')).toBe('api');
    expect(byId.get('mcp-initialize')).toBe('mcp');
    expect(byId.get('mcp-tools-list')).toBe('mcp');
    // The stale combined bucket is gone.
    expect(out.categories.some((c) => c.id === 'mcp-api')).toBe(false);
  });

  test('rebuilt rollups equal categoryRollups over the re-derived rows', () => {
    const out = normalizeScorecardCategories(oldShapeStored(), SPLIT_REGISTRY) as NormalizedShape;
    const expected = categoryRollups(
      out.results.map((r) => ({ category: r.category, status: r.status as never })),
      SPLIT_REGISTRY.category_order,
      SPLIT_REGISTRY.categories,
    );
    expect(out.categories).toEqual(expected);
    // Spot-check: api has openapi(pass) + json-schemas(absent) -> 1/2.
    const api = out.categories.find((c) => c.id === 'api');
    expect(api).toEqual({ id: 'api', name: 'API', passed: 1, counted: 2 });
  });

  test('a row whose id is absent from the registry keeps its stored category, appended after registry order', () => {
    const stored = oldShapeStored();
    stored.results.push({
      id: 'legacy-check',
      category: 'legacy',
      keyword: 'may',
      status: 'pass',
      evidence: 'legacy',
    });
    const out = normalizeScorecardCategories(stored, SPLIT_REGISTRY) as NormalizedShape;
    expect(out.results.find((r) => r.id === 'legacy-check')?.category).toBe('legacy');
    expect(out.categories.map((c) => c.id)).toEqual(['api', 'mcp', 'legacy']);
    const legacy = out.categories.find((c) => c.id === 'legacy');
    // Name falls back to the id (no registry entry), rolled up from its rows.
    expect(legacy).toEqual({ id: 'legacy', name: 'legacy', passed: 1, counted: 1 });
  });

  test('a check new to the stored set is grouped by the current registry and remediated (registry/catalog-driven)', () => {
    const stored = oldShapeStored();
    stored.results.push({
      id: 'dns-aid',
      category: 'mcp-api',
      keyword: 'may',
      status: 'absent',
      evidence: 'no DNS-AID records',
    });
    const enriched = enrichWebScorecardForDisplay(stored, {
      registry: SPLIT_REGISTRY,
      catalog: CATALOG,
      origin: 'https://anc.dev',
    }) as {
      results: Array<{ id: string; category: string; remediation?: { skill_url: string } }>;
    };
    const dns = enriched.results.find((r) => r.id === 'dns-aid');
    expect(dns?.category).toBe('mcp');
    expect(dns?.remediation?.skill_url).toBe('https://anc.dev/web-audit/skill/dns-aid');
  });

  test('score, score_pct, summary, and coverage_summary are byte-identical after normalization', () => {
    const stored = oldShapeStored();
    const before = JSON.stringify({
      score: stored.score,
      score_pct: stored.score_pct,
      summary: stored.summary,
      coverage_summary: stored.coverage_summary,
    });
    const out = normalizeScorecardCategories(stored, SPLIT_REGISTRY) as NormalizedShape;
    const after = JSON.stringify({
      score: out.score,
      score_pct: out.score_pct,
      summary: out.summary,
      coverage_summary: out.coverage_summary,
    });
    expect(after).toBe(before);
  });

  test('a payload without a results array passes through unchanged', () => {
    const minimal = { score_pct: 88 };
    expect(normalizeScorecardCategories(minimal, SPLIT_REGISTRY)).toBe(minimal);
  });

  test('a cached row missing keyword and tier receives both from the live registry', () => {
    const stored = {
      results: [
        { id: 'mcp-modern-tools-list', category: 'mcp-api', status: 'noncompliant', evidence: 'legacy tools/list' },
      ],
    };
    const out = normalizeScorecardCategories(stored, HYDRATING_REGISTRY) as {
      results: Array<{ id: string; category: string; keyword?: string; tier?: string }>;
    };
    expect(out.results[0]).toMatchObject({ category: 'mcp', keyword: 'must', tier: 'required' });
  });

  test('the live registry overrides a stale stored keyword and tier', () => {
    const stored = {
      results: [
        {
          id: 'mcp-modern-tools-list',
          category: 'mcp',
          keyword: 'should',
          tier: 'recommended',
          status: 'noncompliant',
          evidence: 'legacy tools/list',
        },
      ],
    };
    const out = normalizeScorecardCategories(stored, HYDRATING_REGISTRY) as {
      results: Array<{ keyword?: string; tier?: string }>;
    };
    expect(out.results[0].keyword).toBe('must');
    expect(out.results[0].tier).toBe('required');
  });

  test('a row absent from the registry keeps its stored keyword and tier', () => {
    const stored = {
      results: [
        { id: 'retired-check', category: 'legacy', keyword: 'may', tier: 'optional', status: 'pass', evidence: null },
      ],
    };
    const out = normalizeScorecardCategories(stored, HYDRATING_REGISTRY) as {
      results: Array<{ category: string; keyword?: string; tier?: string }>;
    };
    expect(out.results[0]).toMatchObject({ category: 'legacy', keyword: 'may', tier: 'optional' });
  });

  test('a registry entry without keyword or tier leaves the stored values alone', () => {
    const stored = oldShapeStored();
    const out = normalizeScorecardCategories(stored, SPLIT_REGISTRY) as {
      results: Array<{ id: string; keyword?: string }>;
    };
    expect(out.results.find((r) => r.id === 'openapi')?.keyword).toBe('must');
    expect(out.results.find((r) => r.id === 'json-schemas')?.keyword).toBe('should');
  });

  test('a registry that lacks every row id leaves stored categories intact without throwing', () => {
    const empty: DisplayRegistry = { category_order: [], categories: {}, checks: [] };
    const stored = oldShapeStored();
    const out = normalizeScorecardCategories(stored, empty) as NormalizedShape;
    for (const row of out.results) expect(row.category).toBe('mcp-api');
    expect(out.categories.map((c) => c.id)).toEqual(['mcp-api']);
    expect(out.categories[0]).toEqual({ id: 'mcp-api', name: 'mcp-api', passed: 2, counted: 4 });
  });
});

describe('attachInlineRemediation', () => {
  test('every row gains a result line; broken/noncompliant/absent gain remediation; pass/n_a/skip do not', () => {
    const stored = {
      results: [
        { id: 'openapi', status: 'pass', evidence: 'openapi -> 200' },
        { id: 'json-schemas', status: 'absent', evidence: 'json-schemas -> 404' },
        { id: 'mcp-tools-list', status: 'broken', evidence: 'no tools array' },
        { id: 'mcp-unknown-method', status: 'noncompliant', evidence: 'expected error code -32601, got -32603' },
        { id: 'dns-aid', status: 'n_a', na_reason: 'optional-absent', evidence: 'no DNS-AID records' },
        { id: 'sitemap', status: 'skip', evidence: null },
      ],
    };
    const out = attachInlineRemediation(stored, CATALOG, 'https://anc.dev') as {
      results: Array<{ id: string; result?: string; remediation?: { prompt: string; skill_url: string } }>;
    };
    const byId = new Map(out.results.map((r) => [r.id, r]));

    expect(byId.get('openapi')?.result).toContain('Verified');
    expect(byId.get('openapi')?.remediation).toBeUndefined();

    expect(byId.get('json-schemas')?.result).toContain('Not found');
    expect(byId.get('json-schemas')?.remediation?.skill_url).toBe('https://anc.dev/web-audit/skill/json-schemas');

    const broken = byId.get('mcp-tools-list');
    expect(broken?.result).toContain('Present but broken');
    expect(broken?.remediation?.prompt).toContain('Issue: no tools array');

    // A noncompliant surface works, and the spec detail it violates is
    // exactly what the fix prompt names, so it must carry one.
    const noncompliant = byId.get('mcp-unknown-method');
    expect(noncompliant?.result).toContain('Works but does not conform');
    expect(noncompliant?.remediation?.prompt).toContain('Issue: expected error code -32601, got -32603');

    const na = byId.get('dns-aid');
    expect(na?.result).toContain('Not implemented, optional');
    expect(na?.remediation).toBeUndefined();

    const skip = byId.get('sitemap');
    expect(skip?.result).toContain('audit deadline');
    expect(skip?.remediation).toBeUndefined();
  });

  test('a payload without a results array passes through unchanged', () => {
    const minimal = { badge: { score_pct: 88 } };
    expect(attachInlineRemediation(minimal, CATALOG, 'https://anc.dev')).toBe(minimal);
  });

  test('an unprobed row carries a result line but never a remediation', () => {
    // The row settled from an antecedent, so a fix prompt would name a
    // defect nothing observed.
    const stored = {
      results: [
        { id: 'mcp-modern-tools-list', status: 'absent', unprobed: true, evidence: 'no modern lane' },
        { id: 'json-schemas', status: 'absent', evidence: 'json-schemas -> 404' },
      ],
    };
    const out = attachInlineRemediation(stored, CATALOG, 'https://anc.dev') as {
      results: Array<{ id: string; result?: string; remediation?: unknown }>;
    };
    const unprobed = out.results.find((r) => r.id === 'mcp-modern-tools-list');
    expect(unprobed?.result).toContain('Not found');
    expect('remediation' in (unprobed ?? {})).toBe(false);
    expect('remediation' in (out.results.find((r) => r.id === 'json-schemas') ?? {})).toBe(true);
  });

  test('an absent row missing a catalog entry degrades to a generic prompt rather than throwing', () => {
    const stored = { results: [{ id: 'no-catalog-entry', status: 'absent', evidence: 'missing' }] };
    const out = attachInlineRemediation(stored, {}, 'https://anc.dev') as {
      results: Array<{ remediation?: { skill_url: string; prompt: string } }>;
    };
    expect(out.results[0].remediation?.skill_url).toBe('https://anc.dev/web-audit/skill/no-catalog-entry');
    expect(out.results[0].remediation?.prompt).toContain('Issue: missing');
  });
});
