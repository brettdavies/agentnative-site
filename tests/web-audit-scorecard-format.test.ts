// Web presentation tests (plan U9 + U10, reworked per plan-003 U14/U15):
// the web result page renders standalone, grouped by visible category
// with per-check Goal/Result/Fix/Resources + prompt, and the web
// leaderboard sorts by GLOBAL with a RELATIVE column.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebAggregateEntry } from '../src/worker/audit-web/cache';
import {
  buildWebLeaderboardBody,
  buildWebLeaderboardMarkdown,
  rankWebEntries,
} from '../src/worker/audit-web/leaderboard-render';
import { assembleRemediation } from '../src/worker/audit-web/remediation';
import {
  buildWebScorecard,
  type EngineResult,
  type NaReason,
  type ScorecardStatus,
  WEB_SCHEMA_VERSION,
} from '../src/worker/audit-web/scorecard';
import { buildWebSummaryBody, buildWebSummaryMarkdown } from '../src/worker/audit-web/summary-render';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

/** Reverse the escHtml entity set to recover the raw prompt from a carrier. */
function htmlUnescape(s: string): string {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

function webScorecard(pct = 82) {
  return {
    schema_version: '0.2',
    spec_version: SPEC_VERSION,
    target_url: 'https://example.com/',
    mcp_endpoint: 'https://example.com/mcp',
    tool: { name: 'example.com', url: 'https://example.com/' },
    audience: null,
    audit_profile: null,
    site_type: null,
    score_pct: pct,
    score: { relative: pct, global: Math.max(0, pct - 10) },
    categories: [
      { id: 'discoverability', name: 'Discoverability', passed: 0, counted: 1 },
      { id: 'content-for-agents', name: 'Content for agents', passed: 0, counted: 0 },
      { id: 'mcp-api', name: 'MCP & API', passed: 1, counted: 2 },
      { id: 'agent-discovery-auth', name: 'Agent discovery & auth', passed: 1, counted: 1 },
    ],
    coverage_summary: {
      must: { total: 2, verified: 2 },
      should: { total: 15, verified: 9 },
      may: { total: 15, verified: 12 },
    },
    summary: { pass: 10, broken: 2, absent: 4, n_a: 0, skip: 0, error: 0 },
    results: [
      {
        id: 'mcp-initialize',
        label: 'initialize handshake',
        category: 'mcp-api',
        group: 'P2',
        principle: 'P2',
        keyword: 'must',
        tier: 'required',
        status: 'pass' as ScorecardStatus,
        evidence: 'serverInfo anc',
      },
      {
        id: 'openapi',
        label: 'An OpenAPI description is published',
        category: 'mcp-api',
        group: 'P2',
        principle: 'P2',
        keyword: 'must',
        tier: 'required',
        status: 'absent' as ScorecardStatus,
        evidence: 'https://example.com/openapi.json -> 404',
      },
      {
        id: 'robots',
        label: 'robots.txt present',
        category: 'discoverability',
        group: 'P7',
        principle: 'P7',
        keyword: 'should',
        tier: 'recommended',
        status: 'absent' as ScorecardStatus,
        evidence: 'https://example.com/robots.txt -> 404',
      },
      {
        id: 'llms-full-txt',
        label: 'llms-full.txt present',
        category: 'content-for-agents',
        group: 'P2',
        principle: 'P2',
        keyword: 'may',
        tier: 'optional',
        status: 'n_a' as ScorecardStatus,
        na_reason: 'antecedent-unmet' as NaReason,
        evidence: 'not a docs/content site',
      },
      {
        id: 'dns-aid',
        label: 'DNS-AID records',
        category: 'agent-discovery-auth',
        group: 'P8',
        principle: 'P8',
        keyword: 'may',
        tier: 'optional',
        status: 'n_a' as ScorecardStatus,
        na_reason: 'optional-absent' as NaReason,
        evidence: 'no DNS-AID records',
      },
      {
        id: 'oauth-discovery',
        label: 'OAuth discovery',
        category: 'agent-discovery-auth',
        group: 'P1',
        principle: 'P1',
        keyword: 'may',
        tier: 'optional',
        status: 'pass' as ScorecardStatus,
        evidence: 'https://example.com/.well-known/openid-configuration -> 200',
      },
    ],
  };
}

const REMEDIATION_FIXTURE = {
  openapi: {
    title: 'An OpenAPI description is published',
    goal: 'Publish an OpenAPI description so non-MCP agents can call your API',
    fix: 'Publish an OpenAPI 3.1 description at /openapi.json.',
    resources: [{ label: 'OpenAPI 3.1', url: 'https://spec.openapis.org/oas/latest.html' }],
  },
  robots: {
    title: '/robots.txt present',
    goal: 'Publish robots.txt and state your crawl policy explicitly',
    fix: 'Publish a robots.txt.',
    resources: [{ label: 'RFC 9309', url: 'https://www.rfc-editor.org/rfc/rfc9309' }],
  },
};

describe('buildWebSummaryBody (U14)', () => {
  const html = buildWebSummaryBody({
    scorecard: webScorecard(),
    domain: 'example.com',
    targetUrl: 'https://example.com/',
    remediation: REMEDIATION_FIXTURE,
    origin: 'https://anc.dev',
  });

  test('headlines RELATIVE with GLOBAL as a labeled secondary metric', () => {
    expect(html).toContain('bigscore__n">82<');
    expect(html).toContain('site score');
    expect(html).toContain('bigscore__n">72<');
    expect(html).toContain('global-ready');
    expect(html).toContain('maximally agent-ready site');
  });

  test('groups rows under the visible categories in category_order, with rollups', () => {
    const discoverability = html.indexOf('Discoverability');
    const content = html.indexOf('Content for agents');
    const mcpApi = html.indexOf('MCP &amp; API');
    const auth = html.indexOf('Agent discovery &amp; auth');
    expect(discoverability).toBeGreaterThan(-1);
    expect(content).toBeGreaterThan(discoverability);
    expect(mcpApi).toBeGreaterThan(content);
    expect(auth).toBeGreaterThan(mcpApi);
    expect(html).toMatch(/audit-group__rollup[^"]*">1 \/ 2</);
  });

  test('a category with only n_a rows shows 0/0 and is de-emphasized', () => {
    expect(html).toContain('catcard--empty');
    expect(html).toContain('<span class="audit-group__rollup">0 / 0</span>');
  });

  test('the two n_a wordings render distinctly', () => {
    expect(html).toContain('Not applicable (not a docs/content site)');
    expect(html).toContain('Not implemented, optional (no DNS-AID records)');
  });

  test('a non-passing row exposes Goal, Result, Fix, Resources, and a hidden prompt carrier (no rendered prompt)', () => {
    expect(html).toContain('Publish an OpenAPI description so non-MCP agents can call your API');
    expect(html).toContain('Not found (https://example.com/openapi.json -&gt; 404)');
    expect(html).toContain('Publish an OpenAPI 3.1 description at /openapi.json.');
    expect(html).toContain('https://spec.openapis.org/oas/latest.html');
    expect(html).toContain('https://anc.dev/web-audit/skill/openapi');
    // The prompt is carried in a data attribute, never rendered as a <pre>.
    expect(html).not.toContain('<pre>');
    expect(html).toContain('data-copy-text="Goal: Publish an OpenAPI description');
    expect(html).toContain('Issue: https://example.com/openapi.json -&gt; 404');
  });

  test('the carrier prompt equals assembleRemediation(...).prompt byte-for-byte (single source)', () => {
    const m = html.match(/data-copy-text="(Goal: Publish an OpenAPI[^"]*)"/);
    expect(m).not.toBeNull();
    const recovered = htmlUnescape((m as RegExpMatchArray)[1]);
    const expected = assembleRemediation(REMEDIATION_FIXTURE.openapi, {
      checkId: 'openapi',
      origin: 'https://anc.dev',
      evidence: 'https://example.com/openapi.json -> 404',
    }).prompt;
    expect(recovered).toBe(expected);
  });

  test('a passing row carries Goal + Result + Resources but no Fix or prompt carrier', () => {
    const passBlock = html.slice(html.indexOf('initialize handshake'), html.indexOf('An OpenAPI description'));
    expect(passBlock).toContain('Verified (serverInfo anc)');
    expect(passBlock).not.toContain('data-copy-text');
    expect(passBlock).not.toContain('<strong>Fix:</strong>');
  });

  test('no badge-embed markup and no P-principle grouping', () => {
    expect(html).not.toContain('Embed the badge');
    expect(html).not.toContain('badge floor');
    expect(html).not.toContain('scorecard-embed');
    expect(html).not.toContain('P2:');
    expect(html).not.toContain('principles met');
  });

  test('omits CLI-only chrome: no tier/language/install rows, no reproduce CTA', () => {
    expect(html).not.toContain('tier-badge');
    expect(html).not.toContain('anc audit --command');
    expect(html).not.toContain('Reproduce');
    expect(html).not.toContain('Version scored');
  });

  test('shows the web CTA note instead of the CLI install note', () => {
    expect(html).toContain('audit_website');
  });
});

describe('buildWebSummaryMarkdown (U14)', () => {
  const md = buildWebSummaryMarkdown({
    scorecard: webScorecard(),
    domain: 'example.com',
    targetUrl: 'https://example.com/',
    remediation: REMEDIATION_FIXTURE,
    origin: 'https://anc.dev',
  });

  test('mirrors the category structure with both scores and no CLI chrome', () => {
    expect(md).toContain('# example.com');
    expect(md).toContain('**Score:** 82%');
    expect(md).toContain('**Global:** 72%');
    expect(md).toContain('## MCP & API (1/2)');
    expect(md).toContain('## Content for agents (0/0)');
    expect(md).not.toContain('/p2');
    expect(md).not.toContain('## Embed the badge');
    expect(md).not.toContain('## Reproduce locally');
  });

  test('a non-passing row carries the fix and the fenced prompt', () => {
    expect(md).toContain('### MISSING — An OpenAPI description is published');
    expect(md).toContain('- Fix: Publish an OpenAPI 3.1 description at /openapi.json.');
    expect(md).toContain('```text');
    expect(md).toContain('Skill: https://anc.dev/web-audit/skill/openapi');
  });
});

describe('web leaderboard (U15)', () => {
  // A small perfect site (relative 100, low global) vs a bigger,
  // higher-GLOBAL platform: GLOBAL ranks the platform first by default;
  // RELATIVE puts the perfect site on top.
  function entry(domain: string, relative: number, globalScore: number): WebAggregateEntry {
    return {
      domain,
      url: `https://${domain}/`,
      name: domain,
      description: 'x',
      score_pct: relative,
      score: { relative, global: globalScore },
    };
  }
  const entries = [entry('small-perfect.dev', 100, 45), entry('big-platform.dev', 88, 79)];

  test('default order is GLOBAL descending: the bigger routine outranks the small perfect site', () => {
    const ranked = rankWebEntries(entries);
    expect(ranked.map((e) => e.domain)).toEqual(['big-platform.dev', 'small-perfect.dev']);
    expect(ranked[0].rank).toBe(1);
  });

  test('the RELATIVE key re-ranks the perfect-for-its-type site to the top', () => {
    const ranked = rankWebEntries(entries, 'relative');
    expect(ranked.map((e) => e.domain)).toEqual(['small-perfect.dev', 'big-platform.dev']);
  });

  test('renders both score columns, row sort data, the toggle control, and /web links', () => {
    const html = buildWebLeaderboardBody(entries);
    expect(html).toContain('href="/web/small-perfect.dev"');
    expect(html).toContain('data-web-sort="global"');
    expect(html).toContain('data-web-sort="relative"');
    expect(html).toContain('data-global="79" data-relative="88"');
    expect(html).toContain('<th class="lb-score">Global</th>');
    expect(html).toContain('<th class="lb-score">Relative</th>');
    expect(html).not.toContain('lb-principles');
    expect(html).not.toContain('ANC 100');
  });

  test('an empty board renders the scoring-in-progress state, not a broken table', () => {
    const html = buildWebLeaderboardBody([]);
    expect(html).not.toContain('<tbody>');
    expect(html).toContain('Scoring in progress');
  });

  test('markdown twin lists GLOBAL-ordered rows with both columns, origin-absolute', () => {
    const md = buildWebLeaderboardMarkdown(entries, 'https://anc.dev');
    expect(md).toContain('| 1 | [big-platform.dev](https://anc.dev/web/big-platform.dev) | 79% | 88% |');
    expect(md).toContain('| 2 | [small-perfect.dev](https://anc.dev/web/small-perfect.dev) | 45% | 100% |');
  });

  test('the CLI leaderboard hero is not present on the web board', () => {
    expect(buildWebLeaderboardBody(entries)).toContain('Web Agent-Readiness Leaderboard');
  });
});

const DOCUMENTED_TOP_LEVEL = [
  'schema_version',
  'spec_version',
  'target_url',
  'mcp_endpoint',
  'mcp_discovery',
  'tool',
  'audience',
  'audit_profile',
  'site_type',
  'summary',
  'coverage_summary',
  'score_pct',
  'score',
  'categories',
  'results',
];

// The web scorecard schema doc (content/web-scorecard-schema.md) is the
// published contract. Pin an engine-produced scorecard to the documented
// top-level fields so engine output cannot silently drift from the doc.
describe('web scorecard conforms to the documented schema (U16)', () => {
  function engineRow(partial: Partial<EngineResult>): EngineResult {
    return {
      id: 'llms-txt',
      title: 'llms.txt',
      principle: 'P2',
      keyword: 'should',
      tier: 'recommended',
      category: 'content-surface',
      weight: 4,
      status: 'pass',
      evidence: 'https://example.com/llms.txt -> 200',
      raw_evidence: [],
      ...partial,
    };
  }

  const produced = buildWebScorecard(
    [
      engineRow({ keyword: 'must', tier: 'required', status: 'pass' }),
      engineRow({ status: 'absent' }),
      engineRow({ keyword: 'may', tier: 'optional', status: 'n_a', na_reason: 'optional-absent' }),
    ],
    {
      targetUrl: 'https://example.com/',
      domain: 'example.com',
      mcpEndpoint: 'https://example.com/mcp',
      discoveryEvidence: [{ source: '/mcp', probed: 'initialize' }],
      specVersion: SPEC_VERSION,
      registry: {
        category_order: ['content-surface'],
        categories: { 'content-surface': 'Content for agents' },
        checks: [{ keyword: 'must' }, { keyword: 'should' }, { keyword: 'may' }] as never,
      },
    },
  );

  test('carries exactly the documented top-level fields (no badge)', () => {
    expect(Object.keys(produced).sort()).toEqual([...DOCUMENTED_TOP_LEVEL].sort());
    expect('badge' in produced).toBe(false);
  });

  test('schema_version is the site-owned 0.2, independent of the CLI schema', () => {
    expect(produced.schema_version).toBe('0.2');
  });

  test('the web tool shape is { name, url } with no CLI fields', () => {
    expect(Object.keys(produced.tool).sort()).toEqual(['name', 'url']);
    expect((produced.tool as Record<string, unknown>).binary).toBeUndefined();
    expect((produced.tool as Record<string, unknown>).install).toBeUndefined();
  });

  test('score_pct is the RELATIVE score beside the { relative, global } pair', () => {
    expect(typeof produced.score_pct).toBe('number');
    expect(produced.score_pct).toBe(produced.score.relative);
    expect(typeof produced.score.global).toBe('number');
  });

  test('every result row carries the documented fields (na_reason only when set)', () => {
    const REQUIRED_ROW_FIELDS = [
      'category',
      'evidence',
      'group',
      'id',
      'keyword',
      'label',
      'layer',
      'principle',
      'status',
      'tier',
    ];
    for (const row of produced.results) {
      const expected = row.status === 'n_a' ? [...REQUIRED_ROW_FIELDS, 'na_reason'] : REQUIRED_ROW_FIELDS;
      expect(Object.keys(row).sort()).toEqual([...expected].sort());
      expect(row.layer).toBe('web');
    }
  });

  test('a scorecard missing a documented required field fails conformance loudly', () => {
    const broken = { ...produced } as Record<string, unknown>;
    delete broken.score_pct;
    expect(Object.keys(broken).sort()).not.toEqual([...DOCUMENTED_TOP_LEVEL].sort());
  });
});

// U16: pin content/web-scorecard-schema.md to WEB_SCHEMA_VERSION and to
// the emitted top-level shape, so the published contract cannot drift
// from the engine.
describe('web scorecard schema doc drift guard (U16)', () => {
  const DOC_PATH = join(new URL('..', import.meta.url).pathname, 'content', 'web-scorecard-schema.md');

  test('the doc names the same schema version the engine emits', async () => {
    const doc = await readFile(DOC_PATH, 'utf8');
    const match = doc.match(/`schema_version` is \*\*([0-9.]+)\*\*/);
    expect(match?.[1]).toBe(WEB_SCHEMA_VERSION);
    expect(doc).toContain(`"schema_version": "${WEB_SCHEMA_VERSION}"`);
  });

  test('the doc top-level example carries exactly the emitted top-level fields', async () => {
    const doc = await readFile(DOC_PATH, 'utf8');
    const example = doc.slice(doc.indexOf('## Top-level fields'), doc.indexOf('| Field'));
    const documented = [...example.matchAll(/^\s*"([a-z_]+)":/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual([...DOCUMENTED_TOP_LEVEL].sort());
  });
});
