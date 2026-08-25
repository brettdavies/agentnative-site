// Engine coverage for U4: API JSON errors + rate-limit headers, MCP
// resources honesty, and optional ARD catalog.

import { describe, expect, test } from 'bun:test';
import { type AuditEvent, runWebAudit } from '../src/worker/audit-web/engine';
import type { WebAuditRegistry, WebCheck } from '../src/worker/audit-web/registry';

function makeCheck(partial: Partial<WebCheck> & { id: string }): WebCheck {
  return {
    category: 'api',
    tier: 'recommended',
    keyword: 'should',
    principle: 'P4',
    site_types: ['all'],
    antecedent: 'none',
    weight: 1,
    title: partial.id,
    hint: 'h',
    handler: 'http',
    with: {},
    ...partial,
  };
}

const OPENAPI_SPEC = JSON.stringify({
  openapi: '3.1.0',
  paths: {
    '/v1/items/{id}': {
      get: { responses: { '200': { description: 'ok' }, '404': { description: 'missing' } } },
      post: { responses: { '201': { description: 'created' } } },
    },
  },
});

const CHECKS: WebCheck[] = [
  makeCheck({
    id: 'openapi',
    principle: 'P2',
    site_types: ['api'],
    antecedent: 'api-surface',
    handler: 'http',
    with: { path: '/openapi.json', retain_body: true, expect: { status: [200], body_regex: 'openapi' } },
  }),
  makeCheck({
    id: 'json-errors',
    site_types: ['api'],
    antecedent: 'api-surface',
    handler: 'api-hygiene',
    with: { op: 'json-errors' },
  }),
  makeCheck({
    id: 'rate-limit-headers',
    principle: 'P6',
    site_types: ['api'],
    antecedent: 'api-surface',
    handler: 'api-hygiene',
    with: { op: 'rate-limit' },
  }),
  makeCheck({
    id: 'mcp-initialize',
    category: 'mcp',
    principle: 'P2',
    site_types: ['mcp'],
    antecedent: 'mcp-present',
    handler: 'mcp',
    with: { op: 'initialize' },
  }),
  makeCheck({
    id: 'mcp-resources-list',
    category: 'mcp',
    principle: 'P2',
    site_types: ['mcp'],
    antecedent: 'mcp-resources',
    handler: 'mcp',
    with: { op: 'resources-list' },
  }),
  makeCheck({
    id: 'ai-catalog',
    category: 'agent-discovery-auth',
    principle: 'P8',
    tier: 'optional',
    keyword: 'may',
    site_types: ['all'],
    handler: 'http',
    with: {
      path: '/.well-known/ai-catalog.json',
      expect: { status: [200], content_type: 'json', body_regex: 'specVersion|entries' },
    },
  }),
];

function registryOf(checks: WebCheck[]): WebAuditRegistry {
  return {
    version: 1,
    mcp_discovery: { well_known: ['/.well-known/mcp.json'], common_paths: ['/mcp'], protocol_version: '2025-06-18' },
    category_order: ['api', 'mcp', 'agent-discovery-auth'],
    categories: { api: 'API', mcp: 'MCP', 'agent-discovery-auth': 'Agent discovery & auth' },
    checks,
  };
}

async function collect(gen: AsyncGenerator<AuditEvent>): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function resultsOf(events: AuditEvent[]) {
  return events.flatMap((e) => (e.type === 'result' ? [e.result] : []));
}

function siteFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

function mcpInitialize(capabilities: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        serverInfo: { name: 'anc', version: '0.1.0' },
        protocolVersion: '2025-06-18',
        capabilities,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function resourcesList(resources: Array<{ uri: string }>): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { resources } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('API hygiene + MCP resources + ARD', () => {
  test('no api-surface leaves JSON-errors and rate-limit n_a', async () => {
    const fetchImpl = siteFetch((url) => {
      if (url.endsWith('/openapi.json')) return new Response('nope', { status: 404 });
      return new Response('<html><body>no api</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    const rows = resultsOf(
      await collect(
        runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
      ),
    );
    expect(rows.find((r) => r.id === 'json-errors')?.status).toBe('n_a');
    expect(rows.find((r) => r.id === 'rate-limit-headers')?.status).toBe('n_a');
    expect(rows.find((r) => r.id === 'json-errors')?.na_reason).toBe('antecedent-unmet');
  });

  test('API present with an HTML error body misses json-errors', async () => {
    const fetchImpl = siteFetch((url, init) => {
      if (url.endsWith('/mcp') && init?.method === 'POST') return mcpInitialize();
      if (url.endsWith('/openapi.json')) {
        return new Response(OPENAPI_SPEC, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/v1/items/')) {
        return new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
      }
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const rows = resultsOf(
      await collect(
        runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
      ),
    );
    expect(rows.find((r) => r.id === 'openapi')?.status).toBe('pass');
    expect(rows.find((r) => r.id === 'json-errors')?.status).toBe('broken');
    expect(rows.find((r) => r.id === 'json-errors')?.evidence).toContain('HTML');
  });

  test('API present with rate-limit headers passes rate-limit-headers', async () => {
    const fetchImpl = siteFetch((url, init) => {
      if (url.endsWith('/mcp') && init?.method === 'POST') return mcpInitialize();
      if (url.endsWith('/openapi.json')) {
        return new Response(OPENAPI_SPEC, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/v1/items/')) {
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json', 'ratelimit-limit': '100' },
        });
      }
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const rows = resultsOf(
      await collect(
        runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
      ),
    );
    expect(rows.find((r) => r.id === 'json-errors')?.status).toBe('pass');
    expect(rows.find((r) => r.id === 'rate-limit-headers')?.status).toBe('pass');
  });

  test('capabilities omit resources → resources check n_a', async () => {
    const fetchImpl = siteFetch((url, init) => {
      if (url.endsWith('/mcp') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body.method === 'initialize') return mcpInitialize({ tools: {} });
        if (body.method === 'resources/list') return resourcesList([{ uri: 'anc://x' }]);
      }
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const rows = resultsOf(
      await collect(
        runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
      ),
    );
    expect(rows.find((r) => r.id === 'mcp-resources-list')?.status).toBe('n_a');
    expect(rows.find((r) => r.id === 'mcp-resources-list')?.na_reason).toBe('antecedent-unmet');
  });

  test('capabilities.resources set with an empty list is broken', async () => {
    const fetchImpl = siteFetch((url, init) => {
      if (url.endsWith('/mcp') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body.method === 'initialize') return mcpInitialize({ resources: {} });
        if (body.method === 'resources/list') return resourcesList([]);
      }
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const rows = resultsOf(
      await collect(
        runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
      ),
    );
    expect(rows.find((r) => r.id === 'mcp-resources-list')?.status).toBe('broken');
  });

  test('resources-list follows initialize session id and initialized notification', async () => {
    const methods: string[] = [];
    const fetchImpl = siteFetch((url, init) => {
      if (url.endsWith('/mcp') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        methods.push(body.method);
        const session = new Headers(init.headers).get('mcp-session-id');
        if (body.method === 'initialize') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: {
                serverInfo: { name: 'anc', version: '0.1.0' },
                protocolVersion: '2025-06-18',
                capabilities: { resources: {} },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } },
          );
        }
        if (body.method === 'notifications/initialized') {
          if (session !== 'sess-1') return new Response('no session', { status: 400 });
          return new Response(null, { status: 202 });
        }
        if (body.method === 'resources/list') {
          if (session !== 'sess-1') {
            return new Response(
              JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'no session' } }),
              {
                status: 400,
                headers: { 'content-type': 'application/json' },
              },
            );
          }
          return resourcesList([{ uri: 'anc://x' }]);
        }
      }
      if (url.endsWith('/openapi.json')) return new Response('nope', { status: 404 });
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const rows = resultsOf(
      await collect(
        runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
      ),
    );
    expect(methods).toContain('notifications/initialized');
    expect(methods.indexOf('notifications/initialized')).toBeLessThan(methods.indexOf('resources/list'));
    expect(rows.find((r) => r.id === 'mcp-resources-list')?.status).toBe('pass');
  });

  test('missing ai-catalog is optional-absent n_a', async () => {
    const fetchImpl = siteFetch((url) => {
      if (url.endsWith('/ai-catalog.json')) return new Response('gone', { status: 404 });
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const rows = resultsOf(
      await collect(
        runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
      ),
    );
    const row = rows.find((r) => r.id === 'ai-catalog');
    expect(row?.status).toBe('n_a');
    expect(row?.na_reason).toBe('optional-absent');
  });
});
