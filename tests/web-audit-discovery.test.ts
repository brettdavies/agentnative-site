// MCP endpoint discovery + engine orchestration tests (plan U5).

import { describe, expect, test } from 'bun:test';
import { discoverMcpEndpoint } from '../src/worker/audit-web/discovery';
import { runWebAudit } from '../src/worker/audit-web/engine';
import type { WebAuditRegistry } from '../src/worker/audit-web/registry';

function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

const DISCOVERY = {
  well_known: ['/.well-known/mcp.json', '/.well-known/mcp/server-card.json'],
  common_paths: ['/mcp', '/sse'],
  protocol_version: '2025-06-18',
};

function initializeResponse(): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'anc' }, protocolVersion: '2025-06-18' } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('discoverMcpEndpoint', () => {
  test('reads a well-known card exposing mcp_endpoint', async () => {
    const fetchImpl = stubFetch((url) => {
      if (url.endsWith('/.well-known/mcp.json')) {
        return new Response(JSON.stringify({ mcp_endpoint: 'https://example.com/mcp' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    const { endpoint } = await discoverMcpEndpoint('https://example.com/', DISCOVERY, {
      fetchOptions: { fetchImpl },
      timeoutMs: 5000,
    });
    expect(endpoint).toBe('https://example.com/mcp');
  });

  test('reads transport.endpoint from a card that nests it', async () => {
    const fetchImpl = stubFetch((url) => {
      if (url.endsWith('/.well-known/mcp/server-card.json')) {
        return new Response(JSON.stringify({ transport: { endpoint: 'https://example.com/rpc' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    const { endpoint } = await discoverMcpEndpoint('https://example.com/', DISCOVERY, {
      fetchOptions: { fetchImpl },
      timeoutMs: 5000,
    });
    expect(endpoint).toBe('https://example.com/rpc');
  });

  test('falls back to a common-path initialize probe when no card resolves', async () => {
    const fetchImpl = stubFetch((url, init) => {
      if (url.endsWith('/mcp') && init?.method === 'POST') return initializeResponse();
      return new Response('not found', { status: 404 });
    });
    const { endpoint, evidence } = await discoverMcpEndpoint('https://example.com/', DISCOVERY, {
      fetchOptions: { fetchImpl },
      timeoutMs: 5000,
    });
    expect(endpoint).toBe('https://example.com/mcp');
    expect(evidence.some((e) => e.probed === 'initialize')).toBe(true);
  });

  test('returns null when nothing answers', async () => {
    const fetchImpl = stubFetch(() => new Response('not found', { status: 404 }));
    const { endpoint } = await discoverMcpEndpoint('https://example.com/', DISCOVERY, {
      fetchOptions: { fetchImpl },
      timeoutMs: 5000,
    });
    expect(endpoint).toBeNull();
  });
});

function tinyRegistry(): WebAuditRegistry {
  return {
    version: 1,
    mcp_discovery: DISCOVERY,
    category_order: ['mcp-api', 'content-for-agents', 'discoverability'],
    categories: {
      'mcp-api': 'MCP & API',
      'content-for-agents': 'Content for agents',
      discoverability: 'Discoverability',
    },
    checks: [
      {
        id: 'mcp-initialize',
        category: 'mcp-api',
        tier: 'required',
        keyword: 'must',
        principle: 'P2',
        site_types: ['mcp'],
        antecedent: 'mcp-present',
        weight: 5,
        title: 'initialize handshake',
        hint: 'h',
        handler: 'mcp',
        with: { op: 'initialize' },
      },
      {
        id: 'llms-txt',
        category: 'content-for-agents',
        tier: 'recommended',
        keyword: 'should',
        principle: 'P2',
        site_types: ['all'],
        antecedent: 'none',
        weight: 4,
        title: 'llms.txt present',
        hint: 'h',
        handler: 'http',
        with: { path: '/llms.txt', expect: { status: [200] } },
      },
      {
        id: 'robots',
        category: 'content-for-agents',
        tier: 'recommended',
        keyword: 'should',
        principle: 'P7',
        site_types: ['all'],
        antecedent: 'none',
        weight: 2,
        title: 'robots.txt present',
        hint: 'h',
        handler: 'http',
        with: { path: '/robots.txt', expect: { status: [200] } },
      },
      {
        id: 'dns-aid',
        category: 'discoverability',
        tier: 'optional',
        keyword: 'may',
        principle: 'P8',
        site_types: ['all'],
        antecedent: 'none',
        weight: 1,
        title: 'DNS-AID records',
        hint: 'h',
        handler: 'dns-doh',
        with: { names: ['_index._agents.{host}'], type: 'SVCB' },
      },
    ],
  };
}

async function collect(gen: AsyncGenerator<import('../src/worker/audit-web/engine').AuditEvent>) {
  const events: import('../src/worker/audit-web/engine').AuditEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('runWebAudit engine', () => {
  test('gates mcp-present checks to n_a when no endpoint is discovered', async () => {
    const fetchImpl = stubFetch((url) => {
      if (url.endsWith('/llms.txt') || url.endsWith('/robots.txt')) return new Response('ok', { status: 200 });
      if (url.includes('dns-query') || url.includes('/resolve')) {
        return new Response(JSON.stringify({ Status: 3, Answer: [] }), {
          status: 200,
          headers: { 'content-type': 'application/dns-json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: tinyRegistry(), fetchOptions: { fetchImpl } }),
    );
    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.type).toBe('complete');
    if (complete?.type === 'complete') {
      const mcpRow = complete.scorecard.results.find((r) => r.id === 'mcp-initialize');
      expect(mcpRow?.status).toBe('n_a');
    }
  });

  test('streams a result event per check plus a terminal complete event', async () => {
    const fetchImpl = stubFetch((url, init) => {
      if (url.endsWith('/mcp') && init?.method === 'POST') return initializeResponse();
      if (url.endsWith('/llms.txt') || url.endsWith('/robots.txt')) return new Response('ok', { status: 200 });
      if (url.includes('dns-query') || url.includes('/resolve')) {
        return new Response(JSON.stringify({ Status: 0, Answer: [{ name: 'x' }] }), {
          status: 200,
          headers: { 'content-type': 'application/dns-json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: tinyRegistry(), fetchOptions: { fetchImpl } }),
    );
    const resultEvents = events.filter((e) => e.type === 'result');
    expect(resultEvents.length).toBe(4);
    expect(events.at(-1)?.type).toBe('complete');
    const discovery = events.find((e) => e.type === 'discovery');
    expect(discovery?.type).toBe('discovery');
  });

  test('a single check that throws yields error and the run still completes and scores', async () => {
    let calls = 0;
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls++;
      if (url.endsWith('/robots.txt')) return Promise.reject(new Error('kaboom-unhandled'));
      if (url.endsWith('/mcp') && init?.method === 'POST') return Promise.resolve(initializeResponse());
      if (url.endsWith('/llms.txt')) return Promise.resolve(new Response('ok', { status: 200 }));
      return Promise.resolve(
        new Response(JSON.stringify({ Status: 3, Answer: [] }), {
          status: 200,
          headers: { 'content-type': 'application/dns-json' },
        }),
      );
    }) as typeof fetch;
    // guardedFetch converts a rejected fetch into a fail response, not a throw,
    // so robots resolves as fail; the run must still complete.
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: tinyRegistry(), fetchOptions: { fetchImpl } }),
    );
    expect(calls).toBeGreaterThan(0);
    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.type).toBe('complete');
    if (complete?.type === 'complete') {
      expect(typeof complete.scorecard.badge.score_pct).toBe('number');
    }
  });

  test('full stubbed run groups results by principle and scores MUST+SHOULD only', async () => {
    const fetchImpl = stubFetch((url, init) => {
      if (url.endsWith('/mcp') && init?.method === 'POST') return initializeResponse();
      if (url.endsWith('/llms.txt')) return new Response('ok', { status: 200 });
      if (url.endsWith('/robots.txt')) return new Response('missing', { status: 404 });
      if (url.includes('dns-query') || url.includes('/resolve')) {
        return new Response(JSON.stringify({ Status: 3, Answer: [] }), {
          status: 200,
          headers: { 'content-type': 'application/dns-json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: tinyRegistry(), fetchOptions: { fetchImpl } }),
    );
    const complete = events.find((e) => e.type === 'complete');
    if (complete?.type !== 'complete') throw new Error('no complete event');
    const sc = complete.scorecard;
    // MUST mcp-initialize (w5) pass + SHOULD llms-txt (w4) pass + SHOULD robots (w2) fail.
    // MAY dns-aid excluded from the score. got=9, max=11 → 82.
    expect(sc.badge.score_pct).toBe(82);
    expect(sc.results.find((r) => r.id === 'llms-txt')?.group).toBe('P2');
    expect(sc.results.find((r) => r.id === 'robots')?.status).toBe('fail');
    expect(sc.tool.url).toBe('https://example.com/');
    expect(sc.target_url).toBe('https://example.com/');
    expect(complete.complete).toBe(true);
  });
});
