// Probe-handler tests (plan U4). Each handler reproduces the extracted
// pass/fail/na outcomes for representative inputs, and every egress is
// routed through the SSRF-guarded fetch (verified by asserting the stub
// fetch is the only network path).

import { describe, expect, test } from 'bun:test';
import { runCorsPreflight } from '../src/worker/audit-web/handlers/cors-preflight';
import { runDnsDoh } from '../src/worker/audit-web/handlers/dns-doh';
import { runHttp } from '../src/worker/audit-web/handlers/http';
import { runMcp } from '../src/worker/audit-web/handlers/mcp';
import type { HandlerContext } from '../src/worker/audit-web/handlers/types';
import type { WebCheck } from '../src/worker/audit-web/registry';

function ctx(overrides: Partial<HandlerContext> & { fetchImpl: typeof fetch }): HandlerContext {
  return {
    base: 'https://example.com/',
    host: 'example.com',
    mcpEndpoint: null,
    protocolVersion: '2025-06-18',
    defaultTimeoutMs: 5000,
    fetchOptions: { fetchImpl: overrides.fetchImpl },
    ...overrides,
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

function check(partial: Partial<WebCheck>): WebCheck {
  return {
    id: 'x',
    category: 'content-for-agents',
    tier: 'recommended',
    keyword: 'should',
    principle: 'P2',
    site_types: ['all'],
    antecedent: 'none',
    weight: 1,
    title: 't',
    hint: 'h',
    handler: 'http',
    with: {},
    ...partial,
  };
}

describe('runHttp', () => {
  test('passes on a 200 /llms.txt with url + status evidence', async () => {
    const fetchImpl = stubFetch((url) => {
      expect(url).toBe('https://example.com/llms.txt');
      return new Response('# Site\n\n- [x](https://example.com/x)', { status: 200 });
    });
    const outcome = await runHttp(
      check({ with: { path: '/llms.txt', expect: { status: [200], body_regex: '^#|\\]\\(https?://' } } }),
      ctx({ fetchImpl }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].url).toBe('https://example.com/llms.txt');
    expect(outcome.evidence[0].status).toBe(200);
    expect(outcome.evidence[0].ok).toBe(true);
  });

  test('path_any passes on the second candidate', async () => {
    const fetchImpl = stubFetch((url) => {
      if (url.endsWith('/openapi.json')) return new Response('nope', { status: 404 });
      return new Response('{"openapi":"3.1.0"}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const outcome = await runHttp(
      check({
        with: {
          path_any: ['/openapi.json', '/openapi.yaml'],
          expect: { status: [200], body_regex: 'openapi|swagger' },
        },
      }),
      ctx({ fetchImpl }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence.length).toBe(2);
    expect(outcome.evidence[1].ok).toBe(true);
  });

  test('fails when no candidate satisfies expect', async () => {
    const fetchImpl = stubFetch(() => new Response('missing', { status: 404 }));
    const outcome = await runHttp(
      check({ with: { path: '/robots.txt', expect: { status: [200] } } }),
      ctx({ fetchImpl }),
    );
    expect(outcome.status).toBe('fail');
    expect(outcome.evidence[0].ok).toBe(false);
  });

  test('substitutes {mcp_endpoint} in the path', async () => {
    const seen: string[] = [];
    const fetchImpl = stubFetch((url) => {
      seen.push(url);
      return new Response('', { status: 405 });
    });
    const outcome = await runHttp(
      check({ with: { path: '{mcp_endpoint}', method: 'GET', expect: { status: [405, 400, 404, 406] } } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(seen).toEqual(['https://example.com/mcp']);
    expect(outcome.status).toBe('pass');
  });

  test('honors an absolute path_any URL without rejoining the base', async () => {
    const fetchImpl = stubFetch((url) => {
      expect(url).toBe('https://cdn.example.com/schema.json');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const outcome = await runHttp(
      check({ with: { path_any: ['https://cdn.example.com/schema.json'], expect: { status: [200] } } }),
      ctx({ fetchImpl }),
    );
    expect(outcome.status).toBe('pass');
  });
});

describe('runCorsPreflight', () => {
  test('passes on 204 with Access-Control-Allow-Origin', async () => {
    const fetchImpl = stubFetch((_url, init) => {
      expect(init?.method).toBe('OPTIONS');
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      });
    });
    const outcome = await runCorsPreflight(
      check({
        handler: 'cors-preflight',
        with: {
          path: '{mcp_endpoint}',
          origin: 'https://example.com',
          request_method: 'POST',
          request_headers: 'content-type',
        },
      }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].allow_origin).toBe('*');
    expect(outcome.evidence[0].allow_methods).toBe('POST, OPTIONS');
  });

  test('fails on 204 without Access-Control-Allow-Origin', async () => {
    const fetchImpl = stubFetch(() => new Response(null, { status: 204 }));
    const outcome = await runCorsPreflight(
      check({ handler: 'cors-preflight', with: { path: '{mcp_endpoint}' } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('fail');
  });

  test('returns n_a when the path has no endpoint to resolve', async () => {
    let called = 0;
    const fetchImpl = stubFetch(() => {
      called++;
      return new Response('');
    });
    const outcome = await runCorsPreflight(
      check({ handler: 'cors-preflight', with: { path: '{mcp_endpoint}' } }),
      ctx({ fetchImpl, mcpEndpoint: null }),
    );
    expect(outcome.status).toBe('na');
    expect(called).toBe(0);
  });
});

describe('runMcp', () => {
  test('initialize passes and records serverInfo / protocolVersion / capabilities', async () => {
    const fetchImpl = stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe('initialize');
      expect(body.params.protocolVersion).toBe('2025-06-18');
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            serverInfo: { name: 'anc', version: '0.1.0' },
            protocolVersion: '2025-06-18',
            capabilities: { tools: {}, resources: {} },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'initialize' } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].serverInfo).toEqual({ name: 'anc', version: '0.1.0' });
    expect(outcome.evidence[0].protocolVersion).toBe('2025-06-18');
    expect(outcome.evidence[0].capabilities).toEqual(['tools', 'resources']);
  });

  test('capabilities assertion fails on an empty capabilities object', async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'anc' }, capabilities: {} } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'initialize', assert: 'capabilities' } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('fail');
  });

  test('tools-list parses an SSE (text/event-stream) response and counts input schemas', async () => {
    const sse =
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a","inputSchema":{}},{"name":"b"}]}}\n\n';
    const fetchImpl = stubFetch(
      () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'tools-list' } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].tools).toEqual(['a', 'b']);
    expect(outcome.evidence[0].with_input_schema).toBe(1);
  });

  test('error op passes when the error code matches expect_code', async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'error', method: 'nonexistent/method', expect_code: -32601 } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].error_code).toBe(-32601);
  });

  test('cors assertion checks Access-Control-Allow-Origin on the POST', async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        }),
    );
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'tools-list', origin: 'https://example.com', assert: 'cors' } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].allow_origin).toBe('*');
  });

  test('returns n_a when no endpoint was discovered', async () => {
    let called = 0;
    const fetchImpl = stubFetch(() => {
      called++;
      return new Response('');
    });
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'initialize' } }),
      ctx({ fetchImpl, mcpEndpoint: null }),
    );
    expect(outcome.status).toBe('na');
    expect(called).toBe(0);
  });

  test('fails when the response has no parseable JSON-RPC', async () => {
    const fetchImpl = stubFetch(() => new Response('<html>error</html>', { status: 500 }));
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'initialize' } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('fail');
  });
});

describe('runDnsDoh', () => {
  const dohCheck = check({
    id: 'dns-aid',
    handler: 'dns-doh',
    category: 'agent-discovery',
    principle: 'P8',
    tier: 'optional',
    keyword: 'may',
    with: { names: ['_index._agents.{host}', '_mcp._agents.{host}'], type: 'SVCB' },
  });

  test('passes on Status:0 with a non-empty Answer array', async () => {
    const fetchImpl = stubFetch((url) => {
      expect(url).toContain('name=_index._agents.example.com');
      return new Response(JSON.stringify({ Status: 0, Answer: [{ name: '_index._agents.example.com' }] }), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
    });
    const outcome = await runDnsDoh(dohCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].answers).toBe(1);
  });

  test('first name NXDOMAIN is definitive; second name Status:0 passes', async () => {
    const fetchImpl = stubFetch((url) => {
      if (url.includes('_index._agents')) {
        return new Response(JSON.stringify({ Status: 3, Answer: [] }), {
          status: 200,
          headers: { 'content-type': 'application/dns-json' },
        });
      }
      return new Response(JSON.stringify({ Status: 0, Answer: [{ name: '_mcp._agents.example.com' }] }), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
    });
    const outcome = await runDnsDoh(dohCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('pass');
  });

  test('falls back to the second resolver only on resolver-level failure', async () => {
    const resolversHit: string[] = [];
    const fetchImpl = stubFetch((url) => {
      resolversHit.push(new URL(url).host);
      if (url.startsWith('https://cloudflare-dns.com')) return new Response('gateway error', { status: 502 });
      return new Response(JSON.stringify({ Status: 0, Answer: [{ name: 'x' }] }), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
    });
    const outcome = await runDnsDoh(dohCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('pass');
    expect(resolversHit).toContain('cloudflare-dns.com');
    expect(resolversHit).toContain('dns.google');
  });

  test('fails when all resolvers network-fail', async () => {
    const fetchImpl = stubFetch(() => new Response('boom', { status: 500 }));
    const outcome = await runDnsDoh(dohCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('fail');
  });

  test('fails when every name resolves NXDOMAIN', async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response(JSON.stringify({ Status: 3, Answer: [] }), {
          status: 200,
          headers: { 'content-type': 'application/dns-json' },
        }),
    );
    const outcome = await runDnsDoh(dohCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('fail');
  });
});
