// Web presentation tests (plan U9 + U10): the shared renderer consumes a
// web scorecard with CLI-only chrome absent, and the web leaderboard
// renders web-appropriate columns linking to /web/<domain>.

import { describe, expect, test } from 'bun:test';
import {
  buildWebLeaderboardBody,
  buildWebLeaderboardMarkdown,
  rankWebEntries,
} from '../src/build/web-leaderboard-render.mjs';
import { buildWebSummaryBody, buildWebSummaryMarkdown } from '../src/worker/audit-web/summary-render';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

function webScorecard(pct = 82) {
  return {
    schema_version: '0.1',
    spec_version: SPEC_VERSION,
    target_url: 'https://example.com/',
    mcp_endpoint: 'https://example.com/mcp',
    tool: { name: 'example.com', url: 'https://example.com/' },
    audience: null,
    audit_profile: null,
    badge: { score_pct: pct, eligible: false },
    coverage_summary: {
      must: { total: 2, verified: 2 },
      should: { total: 15, verified: 9 },
      may: { total: 15, verified: 12 },
    },
    summary: { pass: 10, fail: 6, n_a: 0, skip: 0, error: 0 },
    results: [
      { id: 'mcp-initialize', label: 'initialize handshake', group: 'P2', status: 'pass', evidence: 'serverInfo anc' },
      { id: 'robots', label: 'robots.txt present', group: 'P7', status: 'fail', evidence: '404' },
      { id: 'oauth-discovery', label: 'OAuth discovery', group: 'P1', status: 'pass', evidence: '200' },
    ],
  };
}

describe('buildWebSummaryBody (U9)', () => {
  const html = buildWebSummaryBody({
    scorecard: webScorecard(),
    domain: 'example.com',
    targetUrl: 'https://example.com/',
  });

  test('renders the score badge and the target URL in the header', () => {
    expect(html).toContain('82%');
    expect(html).toContain('https://example.com/');
  });

  test('groups results under the P-principle headings', () => {
    expect(html).toContain('P2:');
    expect(html).toContain('P7:');
    expect(html).toContain('P1:');
  });

  test('omits CLI-only chrome: no tier/language/install rows, no badge-embed, no reproduce CTA', () => {
    expect(html).not.toContain('tier-badge');
    expect(html).not.toContain('Install');
    expect(html).not.toContain('Embed the badge');
    expect(html).not.toContain('badge floor');
    expect(html).not.toContain('anc audit --command');
    expect(html).not.toContain('Reproduce');
    expect(html).not.toContain('Version scored');
  });

  test('shows the web CTA note instead of the CLI install note', () => {
    expect(html).toContain('audit_website');
  });
});

describe('buildWebSummaryMarkdown (U9)', () => {
  const md = buildWebSummaryMarkdown({
    scorecard: webScorecard(),
    domain: 'example.com',
    targetUrl: 'https://example.com/',
  });

  test('is a parallel structure with an absolute principle link and no CLI chrome', () => {
    expect(md).toContain('# example.com');
    expect(md).toContain('82% pass rate');
    expect(md).toContain('https://anc.dev/p2');
    expect(md).not.toContain('## Embed the badge');
    expect(md).not.toContain('## Reproduce locally');
    expect(md).not.toContain('Version scored');
  });
});

describe('web leaderboard (U10)', () => {
  const entries = [
    {
      domain: 'anc.dev',
      url: 'https://anc.dev/',
      name: 'anc.dev',
      description: 'The auditor.',
      scorecard: webScorecard(67),
    },
    {
      domain: 'high.dev',
      url: 'https://high.dev/',
      name: 'high.dev',
      description: 'Higher.',
      scorecard: webScorecard(90),
    },
  ];

  test('ranks entries highest-score-first', () => {
    const ranked = rankWebEntries(entries);
    expect(ranked.map((e) => e.domain)).toEqual(['high.dev', 'anc.dev']);
    expect(ranked[0].rank).toBe(1);
  });

  test('renders web columns (domain + score + principles), links to /web/<domain>, no tier/lang columns', () => {
    const html = buildWebLeaderboardBody(entries);
    expect(html).toContain('href="/web/anc.dev"');
    expect(html).toContain('href="/web/high.dev"');
    expect(html).toContain('90%');
    expect(html).not.toContain('data-sort-col="tier"');
    expect(html).not.toContain('>Lang<');
    expect(html).not.toContain('ANC 100');
  });

  test('empty seed renders an empty-state, not a broken table', () => {
    const html = buildWebLeaderboardBody([]);
    expect(html).not.toContain('<tbody>');
    expect(html).toContain('No websites are on the board yet');
  });

  test('markdown twin lists ranked rows with /web links', () => {
    const md = buildWebLeaderboardMarkdown(entries);
    expect(md).toContain('[high.dev](/web/high.dev)');
    expect(md).toContain('| 1 | [high.dev]');
  });

  test('the CLI leaderboard hero is not present on the web board', () => {
    expect(buildWebLeaderboardBody(entries)).toContain('Web Agent-Readiness Leaderboard');
  });
});
