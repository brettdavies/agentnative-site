// canonical-plus-redirect-aliases eval rule tests (plan-003 U5, R8).

import { describe, expect, test } from 'bun:test';
import { classifyAliasProbe, type ProbeResponse } from '../src/worker/audit-web/assert';
import { runCanonicalRedirect } from '../src/worker/audit-web/handlers/http';
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
// runCanonicalRedirect orchestration
// ---------------------------------------------------------------------------

const CARD_BODY = '{"mcp_endpoint":"https://example.com/mcp","serverInfo":{"name":"x"}}';

function cardCheck(): WebCheck {
  return {
    id: 'well-known-mcp-card',
    category: 'mcp-api',
    tier: 'recommended',
    keyword: 'should',
    principle: 'P8',
    site_types: ['mcp'],
    antecedent: 'mcp-present',
    eval: 'canonical-redirect',
    weight: 3,
    title: 'card',
    hint: 'h',
    handler: 'http',
    with: {
      path: '/.well-known/mcp/server-card.json',
      aliases: [
        '/.well-known/mcp',
        '/.well-known/mcp.json',
        '/mcp.json',
        { path: '/mcp', headers: { Accept: 'application/json' } },
      ],
      expect: { status: [200], content_type: 'json', body_regex: 'mcp_endpoint|serverInfo' },
    },
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

describe('runCanonicalRedirect', () => {
  test('valid canonical + all aliases 301 to it = pass', async () => {
    const { fetchImpl } = siteFetch({
      '/.well-known/mcp/server-card.json': card,
      '/.well-known/mcp': redirectTo('/.well-known/mcp/server-card.json'),
      '/.well-known/mcp.json': redirectTo('/.well-known/mcp/server-card.json'),
      '/mcp.json': redirectTo('/.well-known/mcp/server-card.json', 308),
      '/mcp': redirectTo('/.well-known/mcp/server-card.json'),
    });
    const outcome = await runCanonicalRedirect(cardCheck(), ctx(fetchImpl));
    expect(outcome.status).toBe('pass');
    const aliasRows = outcome.evidence.filter((e) => e.role === 'alias');
    expect(aliasRows.length).toBe(4);
    expect(aliasRows.every((e) => e.alias_verdict === 'pass')).toBe(true);
  });

  test('valid canonical + absent aliases = pass (absent aliases carry no penalty)', async () => {
    const { fetchImpl } = siteFetch({ '/.well-known/mcp/server-card.json': card });
    const outcome = await runCanonicalRedirect(cardCheck(), ctx(fetchImpl));
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence.filter((e) => e.alias_verdict === 'n_a').length).toBe(4);
  });

  test('an alias serving the card inline downgrades a valid canonical to broken', async () => {
    const { fetchImpl } = siteFetch({
      '/.well-known/mcp/server-card.json': card,
      '/mcp.json': card,
    });
    const outcome = await runCanonicalRedirect(cardCheck(), ctx(fetchImpl));
    expect(outcome.status).toBe('broken');
  });

  test('a missing canonical is absent on the canonical check', async () => {
    const { fetchImpl } = siteFetch({
      '/mcp.json': redirectTo('/.well-known/mcp/server-card.json'),
    });
    const outcome = await runCanonicalRedirect(cardCheck(), ctx(fetchImpl));
    expect(outcome.status).toBe('absent');
  });

  test('aliases are probed without following the redirect (the 301 itself is the evidence)', async () => {
    const { fetchImpl, seen } = siteFetch({
      '/.well-known/mcp/server-card.json': card,
      '/mcp.json': redirectTo('/.well-known/mcp/server-card.json'),
    });
    await runCanonicalRedirect(cardCheck(), ctx(fetchImpl));
    // canonical fetched once; the /mcp.json 301 is never followed back to it.
    expect(seen.filter((u) => u.endsWith('/server-card.json')).length).toBe(1);
  });

  test('the /mcp alias is probed with Accept: application/json', async () => {
    let acceptSeen: string | null = null;
    const { fetchImpl } = siteFetch({
      '/.well-known/mcp/server-card.json': card,
      '/mcp': (init) => {
        acceptSeen = new Headers(init?.headers).get('accept');
        return new Response(null, { status: 301, headers: { location: '/.well-known/mcp/server-card.json' } });
      },
    });
    await runCanonicalRedirect(cardCheck(), ctx(fetchImpl));
    expect(acceptSeen).toBe('application/json');
  });
});
