// A website result that was not saved renders in place on the progress
// page: an unlinked spine whose freshness slot carries the reason, no
// Re-audit control, and no closing note pointing at one.

import { describe, expect, test } from 'bun:test';
import { WEB_CTA_NOTE_HTML } from '../src/worker/audit-web/copy';
import type { WebScorecardShape } from '../src/worker/audit-web/summary-model';
import { buildWebSummaryBody } from '../src/worker/audit-web/summary-render';
import type { TransientReason } from '../src/worker/audit-web/summary-transient';

const SCORECARD = {
  schema_version: '0.5',
  target_url: 'https://stripe.dev/',
  score_pct: 70,
  score: { relative: 70, global: 26 },
  categories: [{ id: 'mcp', name: 'MCP', passed: 1, counted: 1 }],
  results: [
    {
      id: 'mcp-initialize',
      label: 'initialize handshake',
      category: 'mcp',
      principle: 'P2',
      keyword: 'must',
      tier: 'required',
      status: 'pass',
      evidence: 'serverInfo stripe',
    },
  ],
} as unknown as WebScorecardShape;

function render(transient?: TransientReason): string {
  return buildWebSummaryBody({
    scorecard: SCORECARD,
    domain: 'stripe.dev',
    targetUrl: 'https://stripe.dev/',
    origin: 'https://anc.dev',
    freshness: { cached: false, scored_at: '2026-09-30T14:20:00.000Z', refresh_after: '2026-09-30T14:21:00.000Z' },
    transient,
  });
}

const BUDGET: TransientReason = {
  kind: 'domain-budget',
  domain: 'stripe.com',
  host: 'stripe.dev',
  savedScoredAt: '2026-09-10T17:00:00.000Z',
  retry: { after: 'hour', at: '2026-09-30T15:00:00.000Z' },
};

describe('the transient website summary', () => {
  test('an opted-out run reads "Not saved" in the freshness slot of an unlinked spine with no control', () => {
    const html = render({ kind: 'opt-out' });
    expect(html).toContain(
      '<span data-web-audit-transient>Not saved: declared hosts were not followed for this run.</span>',
    );
    expect(html).not.toContain('data-web-audit-freshness');
    expect(html).not.toContain('result-spine__links');
    expect(html).not.toContain('data-reaudit');
    expect(html).not.toContain(WEB_CTA_NOTE_HTML);
    expect(html).not.toContain('control above');
    expect(html).not.toContain('/js/webmcp.js');
    expect(html).toContain('data-id="mcp-initialize"');
  });

  test('a domain-budget result names the domain, links the saved scorecard with its date, and gives the retry hour', () => {
    const html = render(BUDGET);
    expect(html).toContain(
      "Not saved: stripe.com reached anc's hourly probe limit; " +
        '<a href="/score/stripe.dev">the saved scorecard from <time datetime="2026-09-10T17:00:00.000Z">2026-09-10</time></a> is unchanged. ' +
        'Try again after <time datetime="2026-09-30T15:00:00.000Z">15:00 UTC</time>.',
    );
    expect(html).not.toContain('data-reaudit');
    expect(html).not.toContain('control above');
    expect(html).not.toContain('result-spine__links');
  });

  test('a refusal the hour does not decide says to try again in a minute', () => {
    const html = render({ ...BUDGET, retry: { after: 'minute' } });
    expect(html).toContain(
      '<a href="/score/stripe.dev">the saved scorecard from <time datetime="2026-09-10T17:00:00.000Z">2026-09-10</time></a> is unchanged. ' +
        'Try again in a minute.</span>',
    );
    expect(html).not.toContain('Try again after');
  });

  test('a saved page keeps its freshness sentence, its links, and its closing note', () => {
    const html = render();
    expect(html).toContain('data-web-audit-freshness');
    expect(html).toContain('result-spine__links');
    expect(html).toContain(WEB_CTA_NOTE_HTML);
    expect(html).not.toContain('Not saved');
  });
});
