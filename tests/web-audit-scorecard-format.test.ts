// Web presentation tests (plan U9 + U10, reworked per plan-003 U14/U15):
// the web result page renders standalone, grouped by visible category
// with per-check Goal/Result/Fix/Resources + prompt, and the web
// leaderboard sorts by GLOBAL with a RELATIVE column.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WEB_AUDIT_STALE_AFTER_MS } from '../src/worker/audit-web/cache';
import {
  buildFrontpageBoardRows,
  buildWebLeaderboardBody,
  buildWebLeaderboardMarkdown,
  rankWebEntries,
  type WebBoardEntry,
} from '../src/worker/audit-web/leaderboard-render';
import { assembleRemediation } from '../src/worker/audit-web/remediation';
import {
  buildWebScorecard,
  type EngineResult,
  type NaReason,
  type ScorecardStatus,
  WEB_SCHEMA_VERSION,
  type WebScorecardMeta,
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
      { id: 'api', name: 'API', passed: 0, counted: 1 },
      { id: 'mcp', name: 'MCP', passed: 1, counted: 1 },
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
        category: 'mcp',
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
        category: 'api',
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

  test('groups rows under the visible categories in category_order, with API before MCP and rollups', () => {
    const discoverability = html.indexOf('Discoverability');
    const content = html.indexOf('Content for agents');
    const api = html.indexOf('audit-group__title">API<');
    const mcp = html.indexOf('audit-group__title">MCP<');
    const auth = html.indexOf('Agent discovery &amp; auth');
    expect(discoverability).toBeGreaterThan(-1);
    expect(content).toBeGreaterThan(discoverability);
    expect(api).toBeGreaterThan(content);
    expect(mcp).toBeGreaterThan(api);
    expect(auth).toBeGreaterThan(mcp);
    // API card: openapi absent -> 0 / 1; MCP card: mcp-initialize pass -> 1 / 1.
    expect(html).toMatch(/audit-group__rollup[^"]*">0 \/ 1</);
    expect(html).toMatch(/audit-group__rollup[^"]*">1 \/ 1</);
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
    // The run's evidence is reported on the Result line and nowhere in
    // the prompt: the audited site writes that string (R19).
    expect(html).toContain('Issue: the check did not pass in the latest audit');
    expect(html).not.toContain('Issue: https://example.com/openapi.json');
  });

  test('the carrier prompt equals assembleRemediation(...).prompt byte-for-byte (single source)', () => {
    const m = html.match(/data-copy-text="(Goal: Publish an OpenAPI[^"]*)"/);
    expect(m).not.toBeNull();
    const recovered = htmlUnescape((m as RegExpMatchArray)[1]);
    const expected = assembleRemediation(REMEDIATION_FIXTURE.openapi, {
      checkId: 'openapi',
      origin: 'https://anc.dev',
    }).prompt;
    expect(recovered).toBe(expected);
  });

  test('a passing row carries Goal + Result + Resources but no Fix or prompt carrier', () => {
    const passStart = html.indexOf('initialize handshake');
    const passBlock = html.slice(passStart, html.indexOf('</details>', passStart));
    expect(passBlock).toContain('Verified (serverInfo anc)');
    expect(passBlock).not.toContain('data-copy-text');
    expect(passBlock).not.toContain('<strong>Fix:</strong>');
  });

  test('fixable rows carry keyword and status on the prompt carrier; pass and n_a do not', () => {
    // The carrier is conditional (U4 consolidates it); the row root always
    // carries canonical metadata, so scope the absence check to carriers.
    expect(html).toContain('data-copy-text="Goal: Publish an OpenAPI description');
    const carriers = [...html.matchAll(/<span class="web-check__prompt"[^>]*>/g)].map((m) => m[0]);
    expect(carriers.length).toBeGreaterThan(0);
    for (const carrier of carriers) {
      expect(carrier).toMatch(/data-keyword="(must|should|may)" data-status="(absent|broken|noncompliant)"/);
    }
    expect(html).not.toContain('data-assemble-prompt');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
    expect(html).toContain('data-web-audit-result');
  });

  test('every .web-check details carries data-id; the body loads /js/webmcp.js', () => {
    expect(html).toContain('class="web-check web-check--absent" open data-id="openapi"');
    expect(html).toContain('class="web-check web-check--pass" data-id="mcp-initialize"');
    expect(html).toContain('<script defer src="/js/webmcp.js"></script>');
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

  test('each check row carries its own RFC-2119 tier chip, beside the status', () => {
    // The fixture mixes tiers: mcp-initialize + openapi are MUST, robots is
    // SHOULD, the optional rows are MAY. The chip is per-check, in the summary.
    expect(html).toContain('<span class="tier tier-must">MUST</span>');
    expect(html).toContain('<span class="tier tier-should">SHOULD</span>');
    expect(html).toContain('<span class="tier tier-may">MAY</span>');
    expect(html).toMatch(
      /web-check__label">[^<]*<\/span> <span class="tier tier-must">MUST<\/span> <span class="audit__status"/,
    );
    // The category header still carries no tier (that was the misnomer).
    expect(html).not.toContain('catcard__hd tier-');
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
    expect(md).toContain('## API (0/1)');
    expect(md).toContain('## MCP (1/1)');
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
    expect(md).not.toContain('Assemble fix prompts');
    expect(md).not.toContain('Include SHOULD');
  });

  test('each check row carries its per-check tier', () => {
    expect(md).toContain('- Tier: MUST'); // mcp-initialize / openapi
    expect(md).toContain('- Tier: SHOULD'); // robots
    expect(md).toContain('- Tier: MAY'); // the optional rows
  });

  test('probed-server evidence cannot break out of the bullet or the fenced prompt', () => {
    const scorecard = webScorecard();
    const hostile = 'serverInfo `evil`\n\n## Injected heading\n```\nbreakout';
    scorecard.results = scorecard.results.map((row) =>
      row.id === 'openapi' ? { ...row, evidence: hostile } : row,
    ) as typeof scorecard.results;
    const rendered = buildWebSummaryMarkdown({
      scorecard,
      domain: 'example.com',
      targetUrl: 'https://example.com/',
      remediation: REMEDIATION_FIXTURE,
      origin: 'https://anc.dev',
    });
    // The Result bullet stays one line with no code span opened.
    expect(rendered).toContain('- Result: Not found (serverInfo \\`evil\\` ## Injected heading \\`\\`\\` breakout)');
    // Every fence is a real delimiter, so the injected heading stays
    // inside the prompt block instead of becoming page structure.
    const fences = rendered.split('\n').filter((line) => line.startsWith('```'));
    expect(fences.length % 2).toBe(0);
    expect(rendered).not.toContain('\n```\nbreakout');
  });
});

// U3/KTD2: the rendered row is the canonical record, so every
// `.web-check[data-id]` root carries keyword, tier, status, and unprobed
// regardless of whether the conditional prompt carrier is present.
describe('canonical row metadata on every row root (R1)', () => {
  const ALL_STATUSES: ScorecardStatus[] = ['pass', 'noncompliant', 'broken', 'absent', 'n_a', 'skip', 'error'];

  function row(status: ScorecardStatus, over: Record<string, unknown> = {}) {
    return {
      id: `check-${status}`,
      label: `check ${status}`,
      category: 'mcp',
      keyword: 'should',
      tier: 'recommended',
      status,
      evidence: null,
      ...over,
    };
  }

  const metadataScorecard = {
    schema_version: '0.4',
    spec_version: SPEC_VERSION,
    target_url: 'https://example.com/',
    tool: { name: 'example.com', url: 'https://example.com/' },
    score_pct: 72,
    score: { relative: 72, global: 55 },
    categories: [{ id: 'mcp', name: 'MCP', passed: 1, counted: 9 }],
    results: [
      ...ALL_STATUSES.map((status) => row(status)),
      row('absent', { id: 'check-unprobed', label: 'settled from an antecedent', unprobed: true }),
      row('pass', { id: 'check-unknown', label: 'no registry entry', keyword: undefined, tier: undefined }),
    ],
  };

  const html = buildWebSummaryBody({
    scorecard: metadataScorecard,
    domain: 'example.com',
    targetUrl: 'https://example.com/',
    remediation: REMEDIATION_FIXTURE,
    origin: 'https://anc.dev',
  });

  /** The `<details>` open tag for a row id (attribute values are escaped, so `>` is safe). */
  function openTag(id: string): string {
    const at = html.indexOf(`data-id="${id}"`);
    expect(at).toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf('<details', at), html.indexOf('>', at) + 1);
  }

  function blockFor(id: string): string {
    const at = html.indexOf(`data-id="${id}"`);
    const start = html.lastIndexOf('<details', at);
    return html.slice(start, html.indexOf('</details>', start));
  }

  function attrOf(tag: string, name: string): string | null {
    const m = tag.match(new RegExp(`${name}="([^"]*)"`));
    return m === null ? null : m[1];
  }

  test('every schema 0.4 status renders canonical root metadata', () => {
    for (const status of ALL_STATUSES) {
      const tag = openTag(`check-${status}`);
      expect(attrOf(tag, 'data-status')).toBe(status);
      expect(attrOf(tag, 'data-keyword')).toBe('should');
      expect(attrOf(tag, 'data-tier')).toBe('recommended');
      expect(attrOf(tag, 'data-unprobed')).toBe('false');
    }
  });

  test('rows with no prompt carrier still carry root metadata', () => {
    for (const status of ['pass', 'n_a', 'skip', 'error'] as ScorecardStatus[]) {
      expect(blockFor(`check-${status}`)).not.toContain('data-copy-text');
      expect(attrOf(openTag(`check-${status}`), 'data-status')).toBe(status);
    }
  });

  test('an unprobed actionable row exposes its state and status but renders no remediation', () => {
    const tag = openTag('check-unprobed');
    expect(attrOf(tag, 'data-unprobed')).toBe('true');
    expect(attrOf(tag, 'data-status')).toBe('absent');
    expect(attrOf(tag, 'data-keyword')).toBe('should');
    const block = blockFor('check-unprobed');
    expect(block).not.toContain('data-copy-text');
    expect(block).not.toContain('<strong>Fix:</strong>');
  });

  test('a row with no known keyword or tier renders empty strings, never the literal undefined', () => {
    const tag = openTag('check-unknown');
    expect(attrOf(tag, 'data-keyword')).toBe('');
    expect(attrOf(tag, 'data-tier')).toBe('');
    expect(tag).not.toContain('undefined');
  });

  test('the conditional prompt carrier survives unchanged alongside the root metadata', () => {
    for (const status of ['noncompliant', 'broken', 'absent'] as ScorecardStatus[]) {
      const block = blockFor(`check-${status}`);
      expect(block).toContain('data-copy-text="');
      expect(block).toContain(`data-keyword="should" data-status="${status}"`);
    }
  });
});

describe('page-level machine audit context (R9, F1)', () => {
  const SCORED_AT = '2026-08-27T13:33:00.000Z';
  const REFRESH_AFTER = new Date(Date.parse(SCORED_AT) + WEB_AUDIT_STALE_AFTER_MS).toISOString();
  const STATUS_KEYS = ['pass', 'noncompliant', 'broken', 'absent', 'n_a', 'skip', 'error'];

  function contextTag(html: string): string {
    const m = html.match(/<div data-web-audit-context[^>]*><\/div>/);
    expect(m).not.toBeNull();
    return (m as RegExpMatchArray)[0];
  }

  // `data-count-n_a` carries the exact status token, underscore included.
  function attrs(tag: string): Record<string, string> {
    return Object.fromEntries([...tag.matchAll(/([a-z_-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  }

  const html = buildWebSummaryBody({
    scorecard: webScorecard(),
    domain: 'example.com',
    targetUrl: 'https://example.com/',
    remediation: REMEDIATION_FIXTURE,
    origin: 'https://anc.dev',
    freshness: { cached: true, scored_at: SCORED_AT, refresh_after: REFRESH_AFTER },
    now: Date.parse(SCORED_AT),
  });

  test('exactly one hidden context element sits inside the result article', () => {
    expect([...html.matchAll(/data-web-audit-context/g)]).toHaveLength(1);
    expect(contextTag(html)).toContain('hidden');
    const article = html.indexOf('<article');
    expect(html.indexOf('data-web-audit-context')).toBeGreaterThan(article);
  });

  test('carries the two scores and the freshness envelope', () => {
    const a = attrs(contextTag(html));
    expect(a['data-site-score']).toBe('82');
    expect(a['data-global-score']).toBe('72');
    expect(a['data-cached']).toBe('true');
    expect(a['data-scored-at']).toBe(SCORED_AT);
    expect(a['data-refresh-after']).toBe(REFRESH_AFTER);
  });

  test('all seven counts are always present and equal the rendered rows', () => {
    const a = attrs(contextTag(html));
    const rendered: Record<string, number> = {};
    for (const m of html.matchAll(/<details class="web-check[^>]*data-status="([a-z_]+)"/g)) {
      rendered[m[1]] = (rendered[m[1]] ?? 0) + 1;
    }
    for (const status of STATUS_KEYS) {
      expect(a[`data-count-${status}`]).toBe(String(rendered[status] ?? 0));
    }
    // The fixture has no broken, skip, or error rows; those still report 0.
    expect(a['data-count-broken']).toBe('0');
    expect(a['data-count-skip']).toBe('0');
    expect(a['data-count-error']).toBe('0');
    expect(a['data-count-n_a']).toBe('2');
    expect(a['data-count-na']).toBeUndefined();
    const total = STATUS_KEYS.reduce((sum, s) => sum + Number(a[`data-count-${s}`]), 0);
    expect(total).toBe([...html.matchAll(/<details class="web-check[^>]*data-id="/g)].length);
  });

  test('a legacy entry omits both instants rather than emitting empty strings', () => {
    const legacy = buildWebSummaryBody({
      scorecard: webScorecard(),
      domain: 'example.com',
      targetUrl: 'https://example.com/',
      freshness: { cached: true, scored_at: null, refresh_after: null },
    });
    const tag = contextTag(legacy);
    expect(tag).not.toContain('data-scored-at');
    expect(tag).not.toContain('data-refresh-after');
    expect(attrs(tag)['data-cached']).toBe('true');
    expect(attrs(tag)['data-count-pass']).toBe('2');
  });

  test('a freshly audited render reports cached false', () => {
    const fresh = buildWebSummaryBody({
      scorecard: webScorecard(),
      domain: 'example.com',
      targetUrl: 'https://example.com/',
      freshness: { cached: false, scored_at: SCORED_AT, refresh_after: REFRESH_AFTER },
    });
    expect(attrs(contextTag(fresh))['data-cached']).toBe('false');
  });
});

describe('human-readable freshness copy (R23, AE5/AE7/AE8)', () => {
  const SCORED_AT = '2026-08-27T13:33:00.000Z';
  const REFRESH_AFTER = new Date(Date.parse(SCORED_AT) + WEB_AUDIT_STALE_AFTER_MS).toISOString();
  const UNAVAILABLE = 'Scoring time unavailable; a fresh audit may still be subject to service limits.';

  function render(freshness: { cached: boolean; scored_at: string | null; refresh_after: string | null }, now: number) {
    const input = {
      scorecard: webScorecard(),
      domain: 'example.com',
      targetUrl: 'https://example.com/',
      remediation: REMEDIATION_FIXTURE,
      origin: 'https://anc.dev',
      freshness,
      now,
    };
    return { html: buildWebSummaryBody(input), md: buildWebSummaryMarkdown(input) };
  }

  const valid = { cached: true, scored_at: SCORED_AT, refresh_after: REFRESH_AFTER };
  const legacy = { cached: true, scored_at: null, refresh_after: null };

  // AE5: the refresh instant is still ahead of the reader's clock.
  const future = render(valid, Date.parse(SCORED_AT));
  // AE7: the entry has left the cache-reuse window.
  const expired = render(valid, Date.parse(REFRESH_AFTER));
  // AE8: a legacy entry with no usable instant.
  const unknown = render(legacy, Date.parse(SCORED_AT));

  test('a future refresh instant reads "Refresh available after" with semantic time elements', () => {
    expect(future.html).toContain(`<time datetime="${SCORED_AT}">`);
    expect(future.html).toContain(`Refresh available after <time datetime="${REFRESH_AFTER}">`);
    expect(future.html).not.toContain('Refresh available now');
    // The instant is legible on its own, not attribute-only, so a screen
    // reader and a 320px viewport both get the same sentence.
    expect(future.html).toMatch(/<time datetime="[^"]+">[^<]+<\/time>/);
    expect(future.html).not.toContain('aria-hidden="true">Scored');
  });

  test('a refresh instant at or before now reads "Refresh available now" with no future time', () => {
    expect(expired.html).toContain('Refresh available now.');
    expect(expired.html).not.toContain('Refresh available after');
    // The scored instant is still rendered.
    expect(expired.html).toContain(`<time datetime="${SCORED_AT}">`);
    const past = render(valid, Date.parse(REFRESH_AFTER) + 60_000);
    expect(past.html).toContain('Refresh available now.');
  });

  test('a null instant reads the exact unavailable sentence and renders no timestamp', () => {
    expect(unknown.html).toContain(UNAVAILABLE);
    expect(unknown.html).not.toContain('<time');
    expect(unknown.html).not.toContain('Refresh available');
  });

  test('the copy never promises that a fresh audit will run', () => {
    expect(future.html).toContain('subject to service limits');
    expect(expired.html).toContain('subject to service limits');
    expect(unknown.html).toContain('subject to service limits');
  });

  test('markdown carries equivalent plain-language text for all three states', () => {
    expect(future.md).toContain(`Scored ${SCORED_AT}.`);
    expect(future.md).toContain(`Refresh available after ${REFRESH_AFTER}.`);
    expect(expired.md).toContain(`Scored ${SCORED_AT}.`);
    expect(expired.md).toContain('Refresh available now.');
    expect(expired.md).not.toContain('Refresh available after');
    expect(unknown.md).toContain(UNAVAILABLE);
    expect(unknown.md).not.toContain('Refresh available');
  });

  test('HTML and markdown expose the same instants', () => {
    for (const rendered of [future, expired]) {
      const instants = [...rendered.html.matchAll(/<time datetime="([^"]+)"/g)].map((m) => m[1]);
      expect(instants.length).toBeGreaterThan(0);
      for (const instant of instants) expect(rendered.md).toContain(instant);
    }
  });

  test('a render with no freshness input degrades to the unavailable copy rather than a fabricated instant', () => {
    const bare = buildWebSummaryBody({
      scorecard: webScorecard(),
      domain: 'example.com',
      targetUrl: 'https://example.com/',
    });
    expect(bare).toContain(UNAVAILABLE);
    expect(bare).not.toContain('<time');
  });
});

describe('web scorecard category cards (six categories, no group tier)', () => {
  function cat(id: string, name: string, passed: number, counted: number) {
    return { id, name, passed, counted };
  }
  function sixCategoryScorecard() {
    return {
      schema_version: '0.2',
      spec_version: SPEC_VERSION,
      target_url: 'https://example.com/',
      tool: { name: 'example.com', url: 'https://example.com/' },
      score_pct: 70,
      score: { relative: 70, global: 60 },
      categories: [
        cat('discoverability', 'Discoverability', 1, 1),
        cat('content-for-agents', 'Content for agents', 1, 1),
        cat('bot-crawl-policy', 'Bot & crawl policy', 1, 1),
        cat('api', 'API', 1, 1),
        cat('mcp', 'MCP', 1, 1),
        cat('agent-discovery-auth', 'Agent discovery & auth', 1, 1),
      ],
      results: [],
    };
  }

  const html = buildWebSummaryBody({
    scorecard: sixCategoryScorecard(),
    domain: 'example.com',
    targetUrl: 'https://example.com/',
  });

  test('renders six category cards numbered C1-C6 in category_order, no C7', () => {
    for (let i = 1; i <= 6; i++) expect(html).toContain(`<span class="spec__id">C${i}</span>`);
    expect(html).not.toContain('<span class="spec__id">C7</span>');
  });

  test('the API card precedes the MCP card; headers show id + title + rollup, never a tier', () => {
    const c4 = html.indexOf('<span class="spec__id">C4</span>');
    const c5 = html.indexOf('<span class="spec__id">C5</span>');
    const c6 = html.indexOf('<span class="spec__id">C6</span>');
    expect(c4).toBeGreaterThan(-1);
    expect(c5).toBeGreaterThan(c4);
    expect(c6).toBeGreaterThan(c5);
    // C4 is API, C5 is MCP; the header goes id -> title -> rollup with no
    // tier badge (MUST/SHOULD/MAY is a per-check obligation, not a group's).
    expect(html).toMatch(
      /<span class="spec__id">C4<\/span>\s*<h3 class="audit-group__title">API<\/h3>\s*<span class="audit-group__rollup/,
    );
    expect(html).toMatch(
      /<span class="spec__id">C5<\/span>\s*<h3 class="audit-group__title">MCP<\/h3>\s*<span class="audit-group__rollup/,
    );
  });

  test('the markdown twin lists the six categories in category_order', () => {
    const md = buildWebSummaryMarkdown({
      scorecard: sixCategoryScorecard(),
      domain: 'example.com',
      targetUrl: 'https://example.com/',
    });
    const order = [
      '## Discoverability',
      '## Content for agents',
      '## Bot & crawl policy',
      '## API',
      '## MCP',
      '## Agent discovery & auth',
    ];
    let last = -1;
    for (const heading of order) {
      const at = md.indexOf(heading);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  test('no category header carries a tier badge or a tier-* class', () => {
    const headers = [...html.matchAll(/<div class="catcard__hd[^"]*">[\s\S]*?<\/div>/g)].map((m) => m[0]);
    expect(headers).toHaveLength(6);
    for (const header of headers) {
      expect(header).not.toContain('class="tier"');
      expect(header).not.toMatch(/tier-(must|should|may)/);
    }
  });
});

describe('web leaderboard (U15)', () => {
  // A small perfect site (relative 100, low global) vs a bigger,
  // higher-GLOBAL platform: GLOBAL ranks the platform first by default;
  // RELATIVE puts the perfect site on top.
  function entry(domain: string, relative: number, globalScore: number): WebBoardEntry {
    return {
      domain,
      url: `https://${domain}/`,
      name: domain,
      description: 'x',
      score_pct: relative,
      score: { relative, global: globalScore },
      curated: true,
    };
  }
  const entries = [entry('small-perfect.dev', 100, 45), entry('big-platform.dev', 88, 79)];
  const boardOpts = { view: 'all', curatedCount: 2, userCount: 0 } as const;

  test('default order is RELATIVE descending: the perfect-for-its-type site outranks the bigger routine', () => {
    const ranked = rankWebEntries(entries);
    expect(ranked.map((e) => e.domain)).toEqual(['small-perfect.dev', 'big-platform.dev']);
    expect(ranked[0].rank).toBe(1);
  });

  test('the GLOBAL key re-ranks the bigger routine to the top', () => {
    const ranked = rankWebEntries(entries, 'global');
    expect(ranked.map((e) => e.domain)).toEqual(['big-platform.dev', 'small-perfect.dev']);
  });

  test('renders both score columns, row sort data, the toggle control, and /web links', () => {
    const html = buildWebLeaderboardBody(entries, boardOpts);
    expect(html).toContain('data-surface-board-seg');
    expect(html).toContain('id="board-s-web"');
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
    const html = buildWebLeaderboardBody([], { view: 'all', curatedCount: 0, userCount: 0 });
    expect(html).not.toContain('<tbody>');
    expect(html).toContain('Scoring in progress');
    expect(html).toContain('data-surface-board-seg');
  });

  test('markdown twin lists RELATIVE-ordered rows with both columns, origin-absolute', () => {
    const md = buildWebLeaderboardMarkdown(entries, 'https://anc.dev', boardOpts);
    expect(md).toContain('| 1 | [small-perfect.dev](https://anc.dev/web/small-perfect.dev) | 45% | 100% | curated |');
    expect(md).toContain('| 2 | [big-platform.dev](https://anc.dev/web/big-platform.dev) | 79% | 88% | curated |');
  });

  test('the CLI leaderboard hero is not present on the web board', () => {
    expect(buildWebLeaderboardBody(entries, boardOpts)).toContain('Web Agent-Readiness Leaderboard');
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
  'public_listing',
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

  const ENGINE_ROWS = [
    engineRow({ keyword: 'must', tier: 'required', status: 'pass' }),
    engineRow({ status: 'absent' }),
    engineRow({ status: 'noncompliant' }),
    engineRow({ status: 'absent', unprobed: true }),
    engineRow({ keyword: 'may', tier: 'optional', status: 'n_a', na_reason: 'optional-absent' }),
  ];

  const BASE_META: WebScorecardMeta = {
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
  };

  const produced = buildWebScorecard(ENGINE_ROWS, BASE_META);

  test('carries exactly the documented top-level fields (no badge)', () => {
    expect(Object.keys(produced).sort()).toEqual([...DOCUMENTED_TOP_LEVEL].sort());
    expect('badge' in produced).toBe(false);
  });

  test('schema_version is the site-owned 0.4, independent of the CLI schema', () => {
    expect(produced.schema_version).toBe('0.4');
  });

  test('the web tool shape is { name, url } with no CLI fields', () => {
    expect(Object.keys(produced.tool).sort()).toEqual(['name', 'url']);
    expect((produced.tool as Record<string, unknown>).binary).toBeUndefined();
    expect((produced.tool as Record<string, unknown>).install).toBeUndefined();
  });

  test('public_listing defaults to false when the meta omits it', () => {
    expect(produced.public_listing).toBe(false);
  });

  test('coverage_summary counts a noncompliant row as applied but not verified', () => {
    // A scored row has to appear in the coverage totals it was scored in,
    // or the published coverage and the published score disagree about
    // what the audit found applicable.
    expect(produced.coverage_summary.should).toEqual({ total: 3, verified: 0 });
    expect(produced.coverage_summary.must).toEqual({ total: 1, verified: 1 });
    expect(produced.coverage_summary.may).toEqual({ total: 0, verified: 0 });
  });

  test('public_listing round-trips an explicit meta value; schema_version stays 0.4', () => {
    const listed = buildWebScorecard(ENGINE_ROWS, { ...BASE_META, publicListing: true });
    expect(listed.public_listing).toBe(true);
    expect(listed.schema_version).toBe('0.4');
    expect(buildWebScorecard(ENGINE_ROWS, { ...BASE_META, publicListing: false }).public_listing).toBe(false);
  });

  test('score_pct is the RELATIVE score beside the { relative, global } pair', () => {
    expect(typeof produced.score_pct).toBe('number');
    expect(produced.score_pct).toBe(produced.score.relative);
    expect(typeof produced.score.global).toBe('number');
  });

  test('every result row carries the documented fields (na_reason and unprobed only when set)', () => {
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
      const expected = [
        ...REQUIRED_ROW_FIELDS,
        ...(row.status === 'n_a' ? ['na_reason'] : []),
        ...(row.unprobed === true ? ['unprobed'] : []),
      ];
      expect(Object.keys(row).sort()).toEqual([...expected].sort());
      expect(row.layer).toBe('web');
    }
    expect(produced.results.filter((r) => r.unprobed === true).length).toBe(1);
    expect(produced.results.filter((r) => r.status === 'noncompliant').length).toBe(1);
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

describe('leaderboard friendly-name display', () => {
  function entry(over: Partial<WebBoardEntry> = {}): WebBoardEntry {
    return {
      domain: 'developers.cloudflare.com',
      url: 'https://developers.cloudflare.com/',
      name: 'Cloudflare Developers',
      description: 'Cloudflare developer docs.',
      score_pct: 96,
      score: { relative: 96, global: 90 },
      curated: true,
      ...over,
    };
  }
  const singleOpts = { view: 'all', curatedCount: 1, userCount: 0 } as const;

  test('/web renders "<domain> (<name>)" linking to the detail page, not the external site', () => {
    const html = buildWebLeaderboardBody([entry()], singleOpts);
    // whole-row stretched link: one anchor on the domain, row is position-anchored
    expect(html).toContain('<tr class="lb-row"');
    expect(html).toContain('<a class="lb-rowlink" href="/web/developers.cloudflare.com">developers.cloudflare.com</a>');
    expect(html).toContain('<span class="lb-tool__name">(Cloudflare Developers)</span>');
    // never links to the external site
    expect(html).not.toContain('href="https://developers.cloudflare.com');
  });

  test('a row whose name equals its domain shows no parenthetical', () => {
    const html = buildWebLeaderboardBody(
      [entry({ domain: 'crates.io', url: 'https://crates.io/', name: 'crates.io' })],
      singleOpts,
    );
    expect(html).not.toContain('lb-tool__name');
  });

  test('the homepage pane shows the friendly name and the site score (relative), not global', () => {
    const rows = buildFrontpageBoardRows([entry()]);
    expect(rows).toContain('developers.cloudflare.com (Cloudflare Developers)');
    expect(rows).toContain('href="/web/developers.cloudflare.com"');
    expect(rows).toContain('width:96%'); // relative meter
    expect(rows).not.toContain('width:90%'); // not the global score
  });
});
