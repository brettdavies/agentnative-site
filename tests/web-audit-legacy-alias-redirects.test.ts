// legacy-alias-redirects eval rule tests: the MAY row covering whether a
// site's legacy MCP card paths point at the canonical card.

import { describe, expect, test } from 'bun:test';
import { classifyAliasProbe, type ProbeResponse } from '../src/worker/audit-web/assert';
import { runLegacyAliasRedirects } from '../src/worker/audit-web/handlers/http';
import type { HandlerContext } from '../src/worker/audit-web/handlers/types';
import type { WebCheck } from '../src/worker/audit-web/registry';

const CANONICAL = 'https://example.com/.well-known/mcp/server-card.json';

function resp(partial: Partial<ProbeResponse>): ProbeResponse {
  return { status: 200, headers: {}, body: '', error: null, ...partial };
}

describe('classifyAliasProbe', () => {
  test('a 301 to the canonical path passes', () => {
    const r = resp({ status: 301, headers: { location: '/.well-known/mcp/server-card.json' } });
    expect(classifyAliasProbe(r, 'https://example.com/mcp.json', CANONICAL).verdict).toBe('pass');
  });

  test('a 308 with an absolute Location to the canonical passes', () => {
    const r = resp({ status: 308, headers: { location: CANONICAL } });
    expect(classifyAliasProbe(r, 'https://example.com/.well-known/mcp', CANONICAL).verdict).toBe('pass');
  });

  test('a 200 serving content inline is broken (ambiguous duplicate)', () => {
    const r = resp({ status: 200, body: '{"mcp_endpoint":"/mcp"}' });
    expect(classifyAliasProbe(r, 'https://example.com/mcp.json', CANONICAL).verdict).toBe('broken');
  });

  test('a 404 alias is n_a (no penalty)', () => {
    expect(classifyAliasProbe(resp({ status: 404 }), 'https://example.com/mcp.json', CANONICAL).verdict).toBe('n_a');
  });

  test('a 302 is broken: only permanent redirects credit', () => {
    const r = resp({ status: 302, headers: { location: '/.well-known/mcp/server-card.json' } });
    expect(classifyAliasProbe(r, 'https://example.com/mcp.json', CANONICAL).verdict).toBe('broken');
  });

  test('a 301 away from the canonical is broken', () => {
    const r = resp({ status: 301, headers: { location: '/somewhere-else.json' } });
    expect(classifyAliasProbe(r, 'https://example.com/mcp.json', CANONICAL).verdict).toBe('broken');
  });

  test('a network error on the alias is n_a, not a penalty', () => {
    const r = resp({ status: null, error: 'TimeoutError: deadline exceeded' });
    expect(classifyAliasProbe(r, 'https://example.com/mcp.json', CANONICAL).verdict).toBe('n_a');
  });
});

// ---------------------------------------------------------------------------
// runLegacyAliasRedirects orchestration
// ---------------------------------------------------------------------------

const CARD_BODY = '{"mcp_endpoint":"https://example.com/mcp","serverInfo":{"name":"x"}}';
const ALIASES = ['/.well-known/mcp', '/.well-known/mcp.json', '/mcp.json'];

function aliasCheck(aliases: unknown[] = ALIASES): WebCheck {
  return {
    id: 'mcp-card-legacy-aliases',
    category: 'mcp',
    tier: 'optional',
    keyword: 'may',
    principle: 'P8',
    site_types: ['mcp'],
    antecedent: 'mcp-present',
    eval: 'legacy-alias-redirects',
    weight: 1,
    title: 'legacy aliases',
    hint: 'h',
    handler: 'http',
    with: { canonical: '/.well-known/mcp/server-card.json', aliases },
  };
}

function ctx(fetchImpl: typeof fetch): HandlerContext {
  return {
    base: 'https://example.com/',
    host: 'example.com',
    mcpEndpoint: 'https://example.com/mcp',
    protocolVersion: '2025-06-18',
    defaultTimeoutMs: 5000,
    fetchOptions: { fetchImpl },
  };
}

function siteFetch(behaviors: Record<string, (init?: RequestInit) => Response>): {
  fetchImpl: typeof fetch;
  seen: string[];
} {
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
    const behavior = behaviors[new URL(url).pathname];
    if (behavior) return behavior(init);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function redirectTo(location: string, status = 301): () => Response {
  return () => new Response(null, { status, headers: { location } });
}

function card(): Response {
  return new Response(CARD_BODY, { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('runLegacyAliasRedirects', () => {
  test('every legacy path 301ing to the canonical passes', async () => {
    const { fetchImpl } = siteFetch({
      '/.well-known/mcp': redirectTo('/.well-known/mcp/server-card.json'),
      '/.well-known/mcp.json': redirectTo('/.well-known/mcp/server-card.json'),
      '/mcp.json': redirectTo('/.well-known/mcp/server-card.json', 308),
    });
    const outcome = await runLegacyAliasRedirects(aliasCheck(), ctx(fetchImpl));
    expect(outcome.status).toBe('pass');
    const aliasRows = outcome.evidence.filter((e) => e.role === 'alias');
    expect(aliasRows.length).toBe(3);
    expect(aliasRows.every((e) => e.alias_verdict === 'pass')).toBe(true);
  });

  // One correct redirect is the bar: a site serves whichever legacy paths it
  // historically published, so the rest carry no penalty.
  test('a single correct redirect passes while the other legacy paths 404', async () => {
    const { fetchImpl } = siteFetch({ '/mcp.json': redirectTo('/.well-known/mcp/server-card.json') });
    const outcome = await runLegacyAliasRedirects(aliasCheck(), ctx(fetchImpl));
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence.filter((e) => e.alias_verdict === 'n_a').length).toBe(2);
  });

  test('a correct redirect outranks an inline copy on another legacy path', async () => {
    const { fetchImpl } = siteFetch({
      '/mcp.json': redirectTo('/.well-known/mcp/server-card.json'),
      '/.well-known/mcp': card,
    });
    const outcome = await runLegacyAliasRedirects(aliasCheck(), ctx(fetchImpl));
    expect(outcome.status).toBe('pass');
  });

  test('an inline copy with no correct redirect is noncompliant, not broken', async () => {
    const { fetchImpl } = siteFetch({ '/mcp.json': card });
    const outcome = await runLegacyAliasRedirects(aliasCheck(), ctx(fetchImpl));
    expect(outcome.status).toBe('noncompliant');
  });

  test('a redirect away from the canonical is broken', async () => {
    const { fetchImpl } = siteFetch({ '/mcp.json': redirectTo('/somewhere-else.json') });
    const outcome = await runLegacyAliasRedirects(aliasCheck(), ctx(fetchImpl));
    expect(outcome.status).toBe('broken');
  });

  test('a non-permanent redirect is broken even when it lands on the canonical', async () => {
    const { fetchImpl } = siteFetch({ '/mcp.json': redirectTo('/.well-known/mcp/server-card.json', 302) });
    const outcome = await runLegacyAliasRedirects(aliasCheck(), ctx(fetchImpl));
    expect(outcome.status).toBe('broken');
  });

  test('a misdirecting alias outranks an inline copy', async () => {
    const { fetchImpl } = siteFetch({
      '/.well-known/mcp': card,
      '/mcp.json': redirectTo('/somewhere-else.json'),
    });
    const outcome = await runLegacyAliasRedirects(aliasCheck(), ctx(fetchImpl));
    expect(outcome.status).toBe('broken');
  });

  test('no legacy path published at all is absent, which a MAY row resolves to n_a upstream', async () => {
    const { fetchImpl } = siteFetch({});
    const outcome = await runLegacyAliasRedirects(aliasCheck(), ctx(fetchImpl));
    expect(outcome.status).toBe('absent');
  });

  test('the canonical card is never fetched: it is a comparison target, not a probe', async () => {
    const { fetchImpl, seen } = siteFetch({
      '/.well-known/mcp/server-card.json': card,
      '/mcp.json': redirectTo('/.well-known/mcp/server-card.json'),
    });
    await runLegacyAliasRedirects(aliasCheck(), ctx(fetchImpl));
    // Neither probed directly nor reached by following the alias 301.
    expect(seen.filter((u) => u.endsWith('/server-card.json')).length).toBe(0);
  });

  test('an alias spec carrying headers sends them', async () => {
    const seen: { accept: string | null } = { accept: null };
    const { fetchImpl } = siteFetch({
      '/mcp.json': (init) => {
        seen.accept = new Headers(init?.headers).get('accept');
        return new Response(null, { status: 301, headers: { location: '/.well-known/mcp/server-card.json' } });
      },
    });
    await runLegacyAliasRedirects(
      aliasCheck([{ path: '/mcp.json', headers: { Accept: 'application/json' } }]),
      ctx(fetchImpl),
    );
    expect(seen.accept).toBe('application/json');
  });
});
