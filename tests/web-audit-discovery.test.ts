// MCP endpoint discovery + engine orchestration tests (plan U5).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import { discoverMcpEndpoint } from '../src/worker/audit-web/discovery';
import { runWebAudit } from '../src/worker/audit-web/engine';
import { ALWAYS_ADMIT_BUDGET } from '../src/worker/audit-web/follow-requests';
import type { WebAuditRegistry } from '../src/worker/audit-web/registry';
import { isModernProbe } from './helpers/mcp-modern';
import { stubFetch } from './helpers/stub-fetch';

function modernToolsResponse(): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a', inputSchema: {} }] } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function legacyRejectResponse(code = -32022): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message: 'unsupported' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const DISCOVERY = {
  ai_catalog: '/.well-known/ai-catalog.json',
  card_suffix: '/server-card',
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

  test('falls back to a modern header-routed tools/list when the legacy initialize pass finds nothing', async () => {
    const fetchImpl = stubFetch((url, init) => {
      if (url.endsWith('/mcp') && init?.method === 'POST') {
        return isModernProbe(init) ? modernToolsResponse() : legacyRejectResponse();
      }
      return new Response('not found', { status: 404 });
    });
    const { endpoint, evidence } = await discoverMcpEndpoint('https://example.com/', DISCOVERY, {
      fetchOptions: { fetchImpl },
      timeoutMs: 5000,
    });
    expect(endpoint).toBe('https://example.com/mcp');
    expect(evidence.some((e) => e.probed === 'modern-tools-list' && e.endpoint === 'https://example.com/mcp')).toBe(
      true,
    );
  });

  test('both lanes are probed together on every common path, and legacy evidence wins when both answer', async () => {
    let modernProbes = 0;
    const fetchImpl = stubFetch((url, init) => {
      if (init?.method === 'POST' && isModernProbe(init)) modernProbes++;
      if (url.endsWith('/mcp') && init?.method === 'POST') {
        return isModernProbe(init) ? modernToolsResponse() : initializeResponse();
      }
      return new Response('not found', { status: 404 });
    });
    const { endpoint, evidence } = await discoverMcpEndpoint('https://example.com/', DISCOVERY, {
      fetchOptions: { fetchImpl },
      timeoutMs: 5000,
    });
    expect(endpoint).toBe('https://example.com/mcp');
    expect(modernProbes).toBe(DISCOVERY.common_paths.length);
    const postEvidence = evidence.filter((e) => typeof e.probed === 'string');
    expect(postEvidence).toEqual([{ source: '/mcp', endpoint: 'https://example.com/mcp', probed: 'initialize' }]);
  });

  test('a common path answering a POST with a redirect off the origin is recorded and declared, and nothing is sent there', async () => {
    const sent: string[] = [];
    const fetchImpl = stubFetch((url, init) => {
      const method = init?.method ?? 'GET';
      sent.push(`${method} ${url}`);
      if (method === 'POST' && url === 'https://example.com/mcp') {
        return new Response(null, { status: 307, headers: { location: 'https://Victim.example:443/hook' } });
      }
      if (method === 'POST' && url === 'https://example.com/sse') {
        return new Response(null, { status: 302, headers: { location: '//cdn.example.net/sse' } });
      }
      return new Response('not found', { status: 404 });
    });
    const { endpoint, evidence, declarations, redirected } = await discoverMcpEndpoint(
      'https://example.com/',
      DISCOVERY,
      { fetchOptions: { fetchImpl }, timeoutMs: 5000 },
    );
    expect(endpoint).toBeNull();
    expect(sent.filter((request) => !request.includes('//example.com/'))).toEqual([]);
    expect(evidence.filter((e) => typeof e.probed === 'string')).toEqual([
      {
        source: '/mcp',
        status: 307,
        probed: 'initialize (off-origin redirect)',
        redirect: 'https://victim.example/hook',
      },
      {
        source: '/sse',
        status: 302,
        probed: 'initialize (off-origin redirect)',
        redirect: 'https://cdn.example.net/sse',
      },
      {
        source: '/mcp',
        status: 307,
        probed: 'modern-tools-list (off-origin redirect)',
        redirect: 'https://victim.example/hook',
      },
      {
        source: '/sse',
        status: 302,
        probed: 'modern-tools-list (off-origin redirect)',
        redirect: 'https://cdn.example.net/sse',
      },
    ]);
    expect(declarations).toEqual([]);
    expect(redirected).toEqual([
      { kind: 'mcp-endpoint', url: 'https://victim.example/hook', source: '/mcp' },
      { kind: 'mcp-endpoint', url: 'https://cdn.example.net/sse', source: '/sse' },
    ]);
  });

  test('where other common paths redirect is never followed once one of them answers', async () => {
    const fetchImpl = stubFetch((url, init) => {
      if (init?.method === 'POST' && url === 'https://example.com/mcp') {
        return new Response(null, { status: 307, headers: { location: 'https://victim.example/hook' } });
      }
      if (init?.method === 'POST' && url === 'https://example.com/sse') return initializeResponse();
      return new Response('not found', { status: 404 });
    });
    const { endpoint, redirected } = await discoverMcpEndpoint('https://example.com/', DISCOVERY, {
      fetchOptions: { fetchImpl },
      timeoutMs: 5000,
    });
    expect(endpoint).toBe('https://example.com/sse');
    expect(redirected).toEqual([
      {
        kind: 'mcp-endpoint',
        url: 'https://victim.example/hook',
        source: '/mcp',
        not_followed: 'beyond-endpoint-of-record',
      },
    ]);
  });

  test('an off-origin endpoint declared by a card is recorded and never probed', async () => {
    const probed: string[] = [];
    const fetchImpl = stubFetch((url) => {
      probed.push(url);
      if (url.endsWith('/.well-known/mcp.json')) {
        return new Response(JSON.stringify({ mcp_endpoint: 'https://victim.example/mcp' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    const { endpoint, evidence, declarations } = await discoverMcpEndpoint('https://example.com/', DISCOVERY, {
      fetchOptions: { fetchImpl },
      timeoutMs: 5000,
    });
    expect(endpoint).toBeNull();
    expect(evidence.some((e) => e.blocked === 'off-origin endpoint declaration')).toBe(true);
    expect(declarations).toEqual([
      { kind: 'mcp-endpoint', url: 'https://victim.example/mcp', source: '/.well-known/mcp.json' },
    ]);
    expect(probed.some((url) => url.includes('victim.example'))).toBe(false);
  });

  test('discovery stops at its budget instead of walking every pass', async () => {
    let hops = 0;
    let clock = 1_000;
    const fetchImpl = stubFetch(() => {
      hops += 1;
      clock += 8_000;
      return new Response('not found', { status: 404 });
    });
    const { endpoint, evidence } = await discoverMcpEndpoint('https://example.com/', DISCOVERY, {
      fetchOptions: { fetchImpl },
      timeoutMs: 8_000,
      deadlineAt: clock + 25_000,
      now: () => clock,
    });
    expect(endpoint).toBeNull();
    // The 12s discovery budget affords the concurrent document reads (two
    // well-known cards, the AI catalog, the API catalog), whose stubbed
    // clock advances past the budget; the POST probing never launches.
    expect(hops).toBe(DISCOVERY.well_known.length + 2);
    expect(evidence.some((e) => e.note === 'per-audit deadline exceeded during discovery')).toBe(true);
  });

  test('a tarpitting target is bounded by the pass timeout, not one timeout per path', async () => {
    let launched = 0;
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        launched += 1;
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      })) as typeof fetch;
    const started = Date.now();
    const { endpoint, evidence } = await discoverMcpEndpoint('https://example.com/', DISCOVERY, {
      fetchOptions: { fetchImpl },
      timeoutMs: 100,
    });
    const elapsed = Date.now() - started;
    expect(endpoint).toBeNull();
    // Two passes of concurrent requests (the document reads, then both POST
    // lanes together): ~2 pass timeouts, not one per request. Generous
    // ceiling to keep CI unflaky.
    expect(elapsed).toBeLessThan(2_000);
    expect(launched).toBe(DISCOVERY.well_known.length + 2 + 2 * DISCOVERY.common_paths.length);
    expect(evidence.every((e) => typeof e.status !== 'number')).toBe(true);
  });

  test('a modern probe answer without a tools result does not win', async () => {
    const fetchImpl = stubFetch((url, init) => {
      if (url.endsWith('/mcp') && init?.method === 'POST' && isModernProbe(init)) {
        return legacyRejectResponse(-32603);
      }
      return new Response('not found', { status: 404 });
    });
    const { endpoint } = await discoverMcpEndpoint('https://example.com/', DISCOVERY, {
      fetchOptions: { fetchImpl },
      timeoutMs: 5000,
    });
    expect(endpoint).toBeNull();
  });

  test('a common path answering 401 is the endpoint only when metadata on its own host names it', async () => {
    const metadataUrl = 'https://example.com/.well-known/oauth-protected-resource';
    const challenged = (metadata: unknown) =>
      stubFetch((url, init) => {
        if (url === 'https://example.com/mcp' && init?.method === 'POST') {
          return new Response('{"error":"unauthorized"}', {
            status: 401,
            headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` },
          });
        }
        if (url === metadataUrl && metadata !== null) {
          return new Response(JSON.stringify(metadata), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      });
    const opts = { timeoutMs: 5000 };
    const named = await discoverMcpEndpoint('https://example.com/', DISCOVERY, {
      ...opts,
      fetchOptions: { fetchImpl: challenged({ resource: 'https://example.com/mcp', authorization_servers: [] }) },
    });
    expect(named.endpoint).toBe('https://example.com/mcp');
    expect(named.endpointMetadata?.url).toBe(metadataUrl);
    expect(named.endpointChallenge).toEqual({
      challenge: `Bearer resource_metadata="${metadataUrl}"`,
      lane: 'legacy',
    });
    expect(named.evidence).toContainEqual({
      source: '/mcp',
      endpoint: 'https://example.com/mcp',
      probed: 'initialize (auth required)',
      resource_metadata: metadataUrl,
    });
    const bare = await discoverMcpEndpoint('https://example.com/', DISCOVERY, {
      ...opts,
      fetchOptions: { fetchImpl: challenged(null) },
    });
    expect(bare.endpoint).toBeNull();
    expect(bare.endpointMetadata).toBeNull();
    expect(bare.endpointChallenge).toBeNull();
  });
});

const MCP_CARD_TYPE = 'application/mcp-server-card+json';
const CATALOG_URL = 'https://example.com/.well-known/ai-catalog.json';
const DOCUMENT_CAP = 256 * 1024;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function sep2127Card(...remotes: Array<{ type: string; url: string }>) {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: 'com.example/weather',
    version: '1.0.0',
    description: 'Weather lookups',
    remotes,
  };
}

type SeenRequest = { method: string; url: string; accept: string | null };

/** Answers `METHOD url` routes and 404s everything else, recording every request. */
function routedFetch(routes: Record<string, () => Response>, seen: SeenRequest[]): typeof fetch {
  return stubFetch((url, init) => {
    const method = init?.method ?? 'GET';
    seen.push({ method, url, accept: new Headers(init?.headers).get('accept') });
    const route = routes[`${method} ${url}`];
    return route ? route() : new Response('not found', { status: 404 });
  });
}

function discover(fetchImpl: typeof fetch) {
  return discoverMcpEndpoint('https://example.com/', DISCOVERY, { fetchOptions: { fetchImpl }, timeoutMs: 5000 });
}

describe('discoverMcpEndpoint: SEP-2127 order and retained documents', () => {
  const OFF_ORIGIN_REMOTE = { type: 'streamable-http', url: 'https://mcp.example.net/mcp' };

  test("an AI catalog entry by URL declares its card's first streamable-http remote, and its other remotes as not followed", async () => {
    const seen: SeenRequest[] = [];
    const card = sep2127Card({ type: 'sse', url: 'https://example.com/sse' }, OFF_ORIGIN_REMOTE, {
      type: 'streamable-http',
      url: 'https://mcp.example.net/v2',
    });
    const result = await discover(
      routedFetch(
        {
          [`GET ${CATALOG_URL}`]: () =>
            jsonResponse({
              specVersion: '1.0',
              entries: [{ identifier: 'urn:air:example.com:mcp:weather', type: MCP_CARD_TYPE, url: '/cards/weather' }],
            }),
          'GET https://example.com/cards/weather': () => jsonResponse(card),
        },
        seen,
      ),
    );
    expect(result.declarations).toEqual([
      { kind: 'mcp-endpoint', url: 'https://mcp.example.net/mcp', source: '/cards/weather' },
      {
        kind: 'mcp-endpoint',
        url: 'https://example.com/sse',
        source: '/cards/weather',
        not_followed: 'beyond-endpoint-of-record',
      },
      {
        kind: 'mcp-endpoint',
        url: 'https://mcp.example.net/v2',
        source: '/cards/weather',
        not_followed: 'beyond-endpoint-of-record',
      },
    ]);
    expect(result.documents.get('server-card')).toMatchObject({
      url: 'https://example.com/cards/weather',
      shape: 'sep-2127',
    });
    expect(seen.find((r) => r.url === 'https://example.com/cards/weather')?.accept).toBe(MCP_CARD_TYPE);
    expect(seen.some((r) => r.url.startsWith('https://mcp.example.net'))).toBe(false);
  });

  test('an inline catalog card declares the same remote with no card request, and the catalog is kept whole', async () => {
    const seen: SeenRequest[] = [];
    const result = await discover(
      routedFetch(
        {
          [`GET ${CATALOG_URL}`]: () =>
            jsonResponse({
              specVersion: '1.0',
              entries: [
                {
                  identifier: 'urn:air:example.com:mcp:weather',
                  type: MCP_CARD_TYPE,
                  data: sep2127Card(OFF_ORIGIN_REMOTE),
                },
              ],
            }),
        },
        seen,
      ),
    );
    const source = '/.well-known/ai-catalog.json#/entries/0/data';
    expect(result.declarations).toEqual([{ kind: 'mcp-endpoint', url: 'https://mcp.example.net/mcp', source }]);
    expect(result.documents.get('server-card')).toMatchObject({
      url: `${CATALOG_URL}#/entries/0/data`,
      shape: 'sep-2127',
    });
    const catalog = result.documents.get('ai-catalog');
    expect(catalog?.response.status).toBe(200);
    expect(catalog?.response.truncated).toBeUndefined();
    expect(result.evidence.find((e) => e.document === 'ai-catalog')).toEqual({
      source: '/.well-known/ai-catalog.json',
      document: 'ai-catalog',
      status: 200,
      shape: 'ai-catalog',
    });
    const gets = seen.filter((r) => r.method === 'GET').map((r) => r.url);
    expect(gets.sort()).toEqual(
      [
        'https://example.com/.well-known/mcp.json',
        'https://example.com/.well-known/mcp/server-card.json',
        CATALOG_URL,
        'https://example.com/.well-known/api-catalog',
      ].sort(),
    );
  });

  test('a same-origin remote in a catalog card is the endpoint, and no common path is POSTed', async () => {
    const seen: SeenRequest[] = [];
    const result = await discover(
      routedFetch(
        {
          [`GET ${CATALOG_URL}`]: () =>
            jsonResponse({
              specVersion: '1.0',
              entries: [
                {
                  identifier: 'w',
                  type: MCP_CARD_TYPE,
                  data: sep2127Card({ type: 'streamable-http', url: 'https://example.com/rpc' }),
                },
              ],
            }),
        },
        seen,
      ),
    );
    expect(result.endpoint).toBe('https://example.com/rpc');
    expect(seen.some((r) => r.method === 'POST')).toBe(false);
  });

  test('with no catalog card, the card at <endpoint>/server-card is the SEP-2127 card of record', async () => {
    const seen: SeenRequest[] = [];
    const result = await discover(
      routedFetch(
        {
          'POST https://example.com/mcp': () => initializeResponse(),
          'GET https://example.com/mcp/server-card': () =>
            jsonResponse(sep2127Card({ type: 'streamable-http', url: 'https://example.com/mcp' })),
        },
        seen,
      ),
    );
    expect(result.endpoint).toBe('https://example.com/mcp');
    expect(result.documents.get('server-card')).toMatchObject({
      url: 'https://example.com/mcp/server-card',
      shape: 'sep-2127',
    });
    expect(seen.find((r) => r.url === 'https://example.com/mcp/server-card')?.accept).toBe(MCP_CARD_TYPE);
  });

  test('a SEP-1649 card alone at the well-known path is the card of record and names the endpoint', async () => {
    const seen: SeenRequest[] = [];
    const result = await discover(
      routedFetch(
        {
          'GET https://example.com/.well-known/mcp/server-card.json': () =>
            jsonResponse({ name: 'example', mcp_endpoint: 'https://example.com/mcp' }),
        },
        seen,
      ),
    );
    expect(result.endpoint).toBe('https://example.com/mcp');
    expect(result.documents.get('server-card')).toMatchObject({
      url: 'https://example.com/.well-known/mcp/server-card.json',
      shape: 'sep-1649',
    });
    expect(seen.some((r) => r.method === 'POST')).toBe(false);
  });

  test('a card with transport.url, the Stripe shape, yields a declaration and the SEP-1649 classification', async () => {
    const seen: SeenRequest[] = [];
    const result = await discover(
      routedFetch(
        {
          'GET https://example.com/.well-known/mcp/server-card.json': () =>
            jsonResponse({
              name: 'stripe',
              transport: { type: 'streamable-http', url: 'https://mcp.stripe.example/' },
            }),
        },
        seen,
      ),
    );
    expect(result.declarations).toEqual([
      { kind: 'mcp-endpoint', url: 'https://mcp.stripe.example/', source: '/.well-known/mcp/server-card.json' },
    ]);
    expect(result.documents.get('server-card')?.shape).toBe('sep-1649');
    expect(seen.some((r) => r.url.startsWith('https://mcp.stripe.example'))).toBe(false);
  });

  test('a templated remote URL is declared not-followed and never fetched', async () => {
    const seen: SeenRequest[] = [];
    const templated = 'https://{tenant}.example.com/mcp';
    const result = await discover(
      routedFetch(
        {
          [`GET ${CATALOG_URL}`]: () =>
            jsonResponse({
              specVersion: '1.0',
              entries: [
                {
                  identifier: 't',
                  type: MCP_CARD_TYPE,
                  data: sep2127Card({ type: 'streamable-http', url: templated }),
                },
              ],
            }),
        },
        seen,
      ),
    );
    expect(result.declarations).toEqual([
      {
        kind: 'mcp-endpoint',
        url: templated,
        source: '/.well-known/ai-catalog.json#/entries/0/data',
        not_followed: 'templated-url',
      },
    ]);
    expect(result.endpoint).toBeNull();
    expect(seen.some((r) => r.url.includes('tenant') || r.url.includes('%7B'))).toBe(false);
  });

  test('an off-origin catalog card URL is a card-document declaration with no request; only four MCP entries are read', async () => {
    const seen: SeenRequest[] = [];
    const entry = (identifier: string, url: string) => ({ identifier, type: MCP_CARD_TYPE, url });
    const result = await discover(
      routedFetch(
        {
          [`GET ${CATALOG_URL}`]: () =>
            jsonResponse({
              specVersion: '1.0',
              entries: [
                { identifier: 'agent', type: 'application/a2a-agent-card+json', url: '/agent.json' },
                entry('b', 'https://cards.example.net/b'),
                entry('c', '/cards/c'),
                entry('d', '/cards/d'),
                entry('e', '/cards/e'),
                entry('f', '/cards/f'),
                entry('g', '/cards/g'),
              ],
            }),
        },
        seen,
      ),
    );
    expect(result.declarations).toEqual([
      { kind: 'card-document', url: 'https://cards.example.net/b', source: '/.well-known/ai-catalog.json#/entries/1' },
    ]);
    const cardReads = seen.filter((r) => r.url.includes('/cards/') || r.url.includes('agent.json')).map((r) => r.url);
    expect(cardReads.sort()).toEqual([
      'https://example.com/cards/c',
      'https://example.com/cards/d',
      'https://example.com/cards/e',
    ]);
  });

  test('the API catalog is read and retained during discovery', async () => {
    const linkset = {
      linkset: [
        { anchor: 'https://api.example.com/', 'service-desc': [{ href: 'https://api.example.com/openapi.json' }] },
      ],
    };
    const seen: SeenRequest[] = [];
    const result = await discover(
      routedFetch(
        {
          'GET https://example.com/.well-known/api-catalog': () =>
            new Response(JSON.stringify(linkset), { headers: { 'content-type': 'application/linkset+json' } }),
        },
        seen,
      ),
    );
    const apiCatalog = result.documents.get('api-catalog');
    expect(apiCatalog?.url).toBe('https://example.com/.well-known/api-catalog');
    expect(apiCatalog?.response.status).toBe(200);
    expect(JSON.parse(apiCatalog?.response.body ?? '')).toEqual(linkset);
    expect(result.evidence.find((e) => e.document === 'api-catalog')).toEqual({
      source: '/.well-known/api-catalog',
      document: 'api-catalog',
      status: 200,
      shape: 'linkset',
    });
    expect(seen.filter((r) => r.url === 'https://example.com/.well-known/api-catalog')).toHaveLength(1);
  });

  test('an AI catalog over its cap is read to 256 KiB, recorded truncated, and treated as unparseable', async () => {
    const inline = { identifier: 'w', type: MCP_CARD_TYPE, data: sep2127Card(OFF_ORIGIN_REMOTE) };
    const body = JSON.stringify({ specVersion: '1.0', entries: [inline], padding: 'x'.repeat(2 * 1024 * 1024) });
    const result = await discover(
      routedFetch(
        { [`GET ${CATALOG_URL}`]: () => new Response(body, { headers: { 'content-type': 'application/json' } }) },
        [],
      ),
    );
    const catalog = result.documents.get('ai-catalog');
    expect(catalog?.response.body.length).toBe(DOCUMENT_CAP);
    expect(catalog?.response.truncated).toBe(true);
    expect(result.evidence.find((e) => e.document === 'ai-catalog')).toEqual({
      source: '/.well-known/ai-catalog.json',
      document: 'ai-catalog',
      status: 200,
      truncated: true,
      shape: 'unparseable',
    });
    expect(result.declarations).toEqual([]);
  });

  test('with every common path hanging, both POST lanes are in flight together and share one timeout', async () => {
    let launched = 0;
    let launchedAtFirstAbort = null as number | null;
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return Promise.resolve(new Response('not found', { status: 404 }));
      launched += 1;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          launchedAtFirstAbort ??= launched;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }) as typeof fetch;
    const { endpoint } = await discoverMcpEndpoint('https://example.com/', DISCOVERY, {
      fetchOptions: { fetchImpl },
      timeoutMs: 100,
    });
    expect(endpoint).toBeNull();
    expect(launched).toBe(2 * DISCOVERY.common_paths.length);
    expect(launchedAtFirstAbort).toBe(2 * DISCOVERY.common_paths.length);
  });
});

describe('discoverMcpEndpoint: several card sources for one endpoint', () => {
  const MCP_URL = 'https://example.com/mcp';
  const SUFFIX_URL = 'https://example.com/mcp/server-card';
  const WELL_KNOWN_CARD = '/.well-known/mcp/server-card.json';
  const WELL_KNOWN_CARD_URL = `https://example.com${WELL_KNOWN_CARD}`;
  const inlineCatalog = () =>
    jsonResponse({
      specVersion: '1.0',
      entries: [{ identifier: 'w', type: MCP_CARD_TYPE, data: sep2127Card({ type: 'streamable-http', url: MCP_URL }) }],
    });
  const legacyCard = (fields: Record<string, unknown> = {}) =>
    jsonResponse({ name: 'example', version: '1.0.0', mcp_endpoint: MCP_URL, ...fields });

  test('a catalog card winning the endpoint keeps the auth a SEP-1649 card declares for it', async () => {
    const result = await discover(
      routedFetch(
        {
          [`GET ${CATALOG_URL}`]: inlineCatalog,
          [`GET ${WELL_KNOWN_CARD_URL}`]: () => legacyCard({ authentication: { type: 'oauth2' } }),
          [`POST ${MCP_URL}`]: () => initializeResponse(),
        },
        [],
      ),
    );
    expect(result.endpoint).toBe(MCP_URL);
    const declaringAuth = result.evidence.filter((e) => e.authentication === true);
    expect(declaringAuth.map((e) => e.source)).toEqual([WELL_KNOWN_CARD]);
  });

  test('a suffix answer that is not a card never displaces the SEP-1649 card of record', async () => {
    const seen: SeenRequest[] = [];
    const result = await discover(
      routedFetch(
        {
          [`GET ${WELL_KNOWN_CARD_URL}`]: () => legacyCard(),
          [`GET ${SUFFIX_URL}`]: () =>
            jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }),
        },
        seen,
      ),
    );
    expect(result.endpoint).toBe(MCP_URL);
    expect(seen.some((r) => r.url === SUFFIX_URL)).toBe(true);
    expect(result.documents.get('server-card')).toMatchObject({ url: WELL_KNOWN_CARD_URL, shape: 'sep-1649' });
  });

  test('a catalog card is the card of record over a suffix card and a SEP-1649 card', async () => {
    const result = await discover(
      routedFetch(
        {
          [`GET ${CATALOG_URL}`]: inlineCatalog,
          [`GET ${SUFFIX_URL}`]: () => jsonResponse(sep2127Card({ type: 'streamable-http', url: MCP_URL })),
          [`GET ${WELL_KNOWN_CARD_URL}`]: () => legacyCard(),
        },
        [],
      ),
    );
    expect(result.documents.get('server-card')).toMatchObject({
      url: `${CATALOG_URL}#/entries/0/data`,
      shape: 'sep-2127',
    });
  });

  test('with no catalog card, a SEP-2127 suffix card is the card of record over a SEP-1649 card', async () => {
    const result = await discover(
      routedFetch(
        {
          [`GET ${SUFFIX_URL}`]: () => jsonResponse(sep2127Card({ type: 'streamable-http', url: MCP_URL })),
          [`GET ${WELL_KNOWN_CARD_URL}`]: () => legacyCard(),
        },
        [],
      ),
    );
    expect(result.documents.get('server-card')).toMatchObject({ url: SUFFIX_URL, shape: 'sep-2127' });
  });
});

function tinyRegistry(): WebAuditRegistry {
  return {
    version: 1,
    mcp_discovery: DISCOVERY,
    category_order: ['mcp', 'content-for-agents', 'discoverability'],
    categories: {
      mcp: 'MCP',
      'content-for-agents': 'Content for agents',
      discoverability: 'Discoverability',
    },
    checks: [
      {
        id: 'mcp-initialize',
        category: 'mcp',
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
      runWebAudit({
        url: 'https://example.com/',
        registry: tinyRegistry(),
        fetchOptions: { fetchImpl },
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
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
      runWebAudit({
        url: 'https://example.com/',
        registry: tinyRegistry(),
        fetchOptions: { fetchImpl },
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
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
      runWebAudit({
        url: 'https://example.com/',
        registry: tinyRegistry(),
        fetchOptions: { fetchImpl },
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    expect(calls).toBeGreaterThan(0);
    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.type).toBe('complete');
    if (complete?.type === 'complete') {
      expect(typeof complete.scorecard.score_pct).toBe('number');
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
      runWebAudit({
        url: 'https://example.com/',
        registry: tinyRegistry(),
        fetchOptions: { fetchImpl },
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    const complete = events.find((e) => e.type === 'complete');
    if (complete?.type !== 'complete') throw new Error('no complete event');
    const sc = complete.scorecard;
    // MUST mcp-initialize (w5) pass + SHOULD llms-txt (w4) pass + SHOULD robots (w2) fail.
    // MUST +5, SHOULD llms +3, SHOULD robots absent (0 over half weight),
    // MAY absent → n_a. relative = 8/9.5 → 84; global = 8/(5+3+3+1) → 67.
    expect(sc.score_pct).toBe(84);
    expect(sc.score.global).toBe(67);
    expect(sc.results.find((r) => r.id === 'llms-txt')?.group).toBe('P2');
    expect(sc.results.find((r) => r.id === 'robots')?.status).toBe('absent');
    expect(sc.tool.url).toBe('https://example.com/');
    expect(sc.target_url).toBe('https://example.com/');
    expect(complete.complete).toBe(true);
  });
});

function tarpitFetch(matcher?: (url: string) => boolean): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (matcher && !matcher(url)) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      );
    });
  }) as typeof fetch;
}

describe('runWebAudit reachability', () => {
  test('total network silence ends in an unreachable terminal, not a scored run', async () => {
    const events = await collect(
      runWebAudit({
        url: 'https://example.com/',
        registry: tinyRegistry(),
        fetchOptions: { fetchImpl: tarpitFetch() },
        perCheckTimeoutMs: 100,
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('unreachable');
    if (terminal?.type === 'unreachable') {
      expect(terminal.reason).toContain('did not answer any probe');
    }
    expect(events.some((e) => e.type === 'complete')).toBe(false);
    expect(events.some((e) => e.type === 'result')).toBe(false);
  });

  test('a tarpitted root with a live MCP endpoint still audits to completion', async () => {
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://example.com/') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        });
      }
      if (url.endsWith('/mcp') && init?.method === 'POST') return Promise.resolve(initializeResponse());
      if (url.endsWith('/llms.txt') || url.endsWith('/robots.txt')) {
        return Promise.resolve(new Response('ok', { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    const events = await collect(
      runWebAudit({
        url: 'https://example.com/',
        registry: tinyRegistry(),
        fetchOptions: { fetchImpl },
        perCheckTimeoutMs: 100,
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    expect(events.some((e) => e.type === 'unreachable')).toBe(false);
    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.type).toBe('complete');
  });

  test('a host the edge answers for with 530 on every probe is unreachable, not a scored run', async () => {
    const fetchImpl = stubFetch(() => new Response('origin DNS error', { status: 530 }));
    const events = await collect(
      runWebAudit({
        url: 'https://example.com/',
        registry: tinyRegistry(),
        fetchOptions: { fetchImpl },
        perCheckTimeoutMs: 100,
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('unreachable');
    if (terminal?.type === 'unreachable') {
      expect(terminal.reason).toContain('edge');
    }
    expect(events.some((e) => e.type === 'complete')).toBe(false);
    expect(events.some((e) => e.type === 'result')).toBe(false);
  });

  test('an edge 52x on every probe is unreachable for the same reason', async () => {
    const fetchImpl = stubFetch(() => new Response('origin unreachable', { status: 523 }));
    const events = await collect(
      runWebAudit({
        url: 'https://example.com/',
        registry: tinyRegistry(),
        fetchOptions: { fetchImpl },
        perCheckTimeoutMs: 100,
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    expect(events.at(-1)?.type).toBe('unreachable');
  });

  test('an edge 530 on the root with a real answer elsewhere is scored, not unreachable', async () => {
    const fetchImpl = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://example.com/') return Promise.resolve(new Response('origin DNS error', { status: 530 }));
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    const events = await collect(
      runWebAudit({
        url: 'https://example.com/',
        registry: tinyRegistry(),
        fetchOptions: { fetchImpl },
        perCheckTimeoutMs: 100,
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    expect(events.some((e) => e.type === 'unreachable')).toBe(false);
    expect(events.find((e) => e.type === 'complete')?.type).toBe('complete');
  });

  test('a root that redirects to http ends the run unreachable after the root request alone', async () => {
    const sent: string[] = [];
    const fetchImpl = stubFetch((url) => {
      sent.push(url);
      return url.startsWith('https:')
        ? new Response(null, { status: 301, headers: { location: url.replace('https:', 'http:') } })
        : new Response('served over plaintext', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const events = await collect(
      runWebAudit({
        url: 'https://example.com/',
        registry: tinyRegistry(),
        fetchOptions: { fetchImpl },
        perCheckTimeoutMs: 100,
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    expect(sent).toEqual(['https://example.com/']);
    expect(events).toEqual([
      { type: 'unreachable', reason: 'https://example.com/ redirects to http, and anc sends no plaintext request.' },
    ]);
  });

  test('an http target is never requested: the run ends unreachable and says the target is not https', async () => {
    const sent: string[] = [];
    const fetchImpl = stubFetch((url) => {
      sent.push(url);
      return new Response('served over plaintext', { status: 200 });
    });
    const events = await collect(
      runWebAudit({
        url: 'http://example.com/',
        registry: tinyRegistry(),
        fetchOptions: { fetchImpl },
        perCheckTimeoutMs: 100,
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    expect(sent).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: 'unreachable',
      reason: 'http://example.com/ is not https, and anc sends no plaintext request.',
    });
  });

  test('a target that answers 401 everywhere is scored, not classified unreachable', async () => {
    const fetchImpl = stubFetch(() => new Response('denied', { status: 401 }));
    const events = await collect(
      runWebAudit({
        url: 'https://example.com/',
        registry: tinyRegistry(),
        fetchOptions: { fetchImpl },
        perCheckTimeoutMs: 100,
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    expect(events.some((e) => e.type === 'unreachable')).toBe(false);
    const complete = events.find((e) => e.type === 'complete');
    if (complete?.type !== 'complete') throw new Error('no complete event');
    expect(complete.complete).toBe(true);
    expect(typeof complete.scorecard.score_pct).toBe('number');
  });
});

function eraRegistry(): WebAuditRegistry {
  const registry = tinyRegistry();
  registry.checks.push({
    id: 'mcp-modern-tools-list',
    category: 'mcp',
    tier: 'required',
    keyword: 'must',
    principle: 'P2',
    site_types: ['mcp'],
    antecedent: 'mcp-present',
    weight: 4,
    title: 'modern tools/list',
    hint: 'h',
    handler: 'mcp',
    with: { op: 'modern-tools-list' },
  });
  return registry;
}

describe('runWebAudit era lanes', () => {
  test('a modern-only server is discovered via the modern fallback and scored per lane (AE3)', async () => {
    const fetchImpl = stubFetch((url, init) => {
      if (url.endsWith('/mcp') && init?.method === 'POST') {
        return isModernProbe(init) ? modernToolsResponse() : legacyRejectResponse();
      }
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
      runWebAudit({
        url: 'https://example.com/',
        registry: eraRegistry(),
        fetchOptions: { fetchImpl },
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    const discovery = events.find((e) => e.type === 'discovery');
    if (discovery?.type !== 'discovery') throw new Error('no discovery event');
    expect(discovery.endpoint).toBe('https://example.com/mcp');
    expect(discovery.evidence.some((e) => e.probed === 'modern-tools-list')).toBe(true);
    const complete = events.find((e) => e.type === 'complete');
    if (complete?.type !== 'complete') throw new Error('no complete event');
    expect(complete.scorecard.results.find((r) => r.id === 'mcp-initialize')?.status).toBe('absent');
    expect(complete.scorecard.results.find((r) => r.id === 'mcp-modern-tools-list')?.status).toBe('pass');
  });

  test('with every MCP probe dead both era lanes stay n_a and are excluded from scoring', async () => {
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
      runWebAudit({
        url: 'https://example.com/',
        registry: eraRegistry(),
        fetchOptions: { fetchImpl },
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    const complete = events.find((e) => e.type === 'complete');
    if (complete?.type !== 'complete') throw new Error('no complete event');
    const legacy = complete.scorecard.results.find((r) => r.id === 'mcp-initialize');
    const modern = complete.scorecard.results.find((r) => r.id === 'mcp-modern-tools-list');
    expect(legacy?.status).toBe('n_a');
    expect(modern?.status).toBe('n_a');
    expect(complete.scorecard.coverage_summary.must.total).toBe(0);
  });
});

// The card check scores the card of record discovery kept, with no request
// of its own, against the required fields the build read from the vendored
// schema; the registry here is the real one, so those lists are the built ones.
describe('mcp-server-card scores the card discovery kept', () => {
  const REGISTRY_PATH = join(new URL('..', import.meta.url).pathname, 'src', 'data', 'web-audit', 'registry.yaml');
  const full = normalizeWebAuditRegistry(
    yaml.load(readFileSync(REGISTRY_PATH, 'utf8')) as object,
  ) as unknown as WebAuditRegistry;
  const registry: WebAuditRegistry = {
    ...full,
    alternatives: [],
    checks: full.checks.filter((check) => check.id === 'mcp-server-card'),
  };
  const SEP_2127_CARD = {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: 'com.example/example',
    version: '1.0.0',
    description: 'Example MCP server',
    remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
  };
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  const inlineCatalog = (card: unknown) => json({ specVersion: '1.0', entries: [{ type: MCP_CARD_TYPE, data: card }] });

  async function cardRow(fetchImpl: typeof fetch) {
    const events = await collect(
      runWebAudit({
        url: 'https://example.com/',
        registry,
        fetchOptions: { fetchImpl },
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    const complete = events.find((e) => e.type === 'complete');
    if (complete?.type !== 'complete') throw new Error('no complete event');
    const row = complete.scorecard.results.find((r) => r.id === 'mcp-server-card');
    if (row === undefined) throw new Error('no mcp-server-card row');
    return row;
  }

  test('a retained SEP-2127 card with every required field passes, with no advisory', async () => {
    const row = await cardRow(
      stubFetch((url) => (url === CATALOG_URL ? inlineCatalog(SEP_2127_CARD) : new Response('', { status: 404 }))),
    );
    expect(row.status).toBe('pass');
    expect(row.advisory).toBeUndefined();
    expect(row.evidence).toBe(`${CATALOG_URL}#/entries/0/data -> 200`);
  });

  test('a SEP-2127 card missing name reads broken, naming the missing field', async () => {
    const { name: _name, ...nameless } = SEP_2127_CARD;
    const row = await cardRow(
      stubFetch((url) => (url === CATALOG_URL ? inlineCatalog(nameless) : new Response('', { status: 404 }))),
    );
    expect(row.status).toBe('broken');
    expect(row.evidence).toContain('missing required field name');
  });

  test('a SEP-1649-shaped card passes with the superseded advisory', async () => {
    const row = await cardRow(
      stubFetch((url) =>
        url.endsWith('/.well-known/mcp/server-card.json')
          ? json({ name: 'example', mcp_endpoint: 'https://example.com/mcp' })
          : new Response('', { status: 404 }),
      ),
    );
    expect({ status: row.status, advisory: row.advisory }).toEqual({ status: 'pass', advisory: 'superseded' });
  });

  test('no card reads absent at the recommended tier', async () => {
    const row = await cardRow(
      stubFetch((url, init) =>
        url.endsWith('/mcp') && init?.method === 'POST' ? initializeResponse() : new Response('', { status: 404 }),
      ),
    );
    expect({ status: row.status, keyword: row.keyword, tier: row.tier, advisory: row.advisory }).toEqual({
      status: 'absent',
      keyword: 'should',
      tier: 'recommended',
      advisory: undefined,
    });
  });
});
