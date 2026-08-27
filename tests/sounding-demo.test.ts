import { describe, expect, test } from 'bun:test';
import { soundingFetch } from '../demo/src/index';

const ORIGIN = 'https://sounding.test';

function req(path: string, init?: RequestInit): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

async function rpc(method: string, complete = false): Promise<Record<string, unknown>> {
  const res = await soundingFetch(
    req('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
    }),
    { complete },
  );
  return res.json() as Promise<Record<string, unknown>>;
}

describe('sounding (broken patient)', () => {
  test('GET /api/reading returns JSON', async () => {
    const res = await soundingFetch(req('/api/reading'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meters: number };
    expect(body.meters).toBe(14.2);
  });

  test('openapi.json is missing', async () => {
    const res = await soundingFetch(req('/openapi.json'));
    expect(res.status).toBe(404);
  });

  test('homepage advertises OpenAPI via service-desc', async () => {
    const res = await soundingFetch(req('/'));
    const html = await res.text();
    expect(html).toContain('rel="service-desc"');
    expect(html).toContain('href="/openapi.json"');
    expect(html).toContain('name="description"');
    expect(html).toContain('<noscript');
    expect(res.headers.get('Link') ?? '').toContain('rel="service-desc"');
  });

  test('llms.txt points at /api/ and has a when-to-use heading', async () => {
    const res = await soundingFetch(req('/llms.txt'));
    const body = await res.text();
    expect(body.startsWith('# Sounding')).toBe(true);
    expect(body).toContain('/api/reading');
    expect(body).toMatch(/When to use/i);
  });

  test('well-known card discovers /mcp; aliases 301', async () => {
    const card = await soundingFetch(req('/.well-known/mcp/server-card.json'));
    expect(card.status).toBe(200);
    const body = (await card.json()) as { mcp_endpoint: string };
    expect(body.mcp_endpoint).toBe(`${ORIGIN}/mcp`);

    const alias = await soundingFetch(req('/mcp.json'));
    expect(alias.status).toBe(301);
    expect(alias.headers.get('Location')).toBe(`${ORIGIN}/.well-known/mcp/server-card.json`);
  });

  test('MCP CORS preflight passes', async () => {
    const res = await soundingFetch(
      req('/mcp', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  test('initialize is JSON-RPC without serverInfo', async () => {
    const body = await rpc('initialize');
    const result = body.result as { serverInfo?: unknown; protocolVersion?: string };
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.serverInfo).toBeUndefined();
  });

  test('tools/list has no tools array', async () => {
    const body = await rpc('tools/list');
    const result = body.result as { tools?: unknown };
    expect(Array.isArray(result.tools)).toBe(false);
  });

  test('unknown method is -32601 and POST echoes Allow-Origin', async () => {
    const res = await soundingFetch(
      req('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nonexistent/method', params: {} }),
      }),
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  test('GET /mcp fast-fails; Accept json 301s to the card', async () => {
    const get = await soundingFetch(req('/mcp'));
    expect(get.status).toBe(405);
    const asJson = await soundingFetch(req('/mcp', { headers: { Accept: 'application/json' } }));
    expect(asJson.status).toBe(301);
  });

  test('unknown API path is JSON 4xx with a rate-limit header', async () => {
    const res = await soundingFetch(req('/anc-web-audit-no-such-api'));
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('json');
    expect(res.headers.get('RateLimit-Limit')).toBe('60');
  });

  test('Accept text/markdown on / returns markdown', async () => {
    const res = await soundingFetch(req('/', { headers: { Accept: 'text/markdown' } }));
    expect(res.headers.get('Content-Type')).toContain('markdown');
    expect(res.headers.get('Vary')?.toLowerCase()).toContain('accept');
    expect(await res.text()).toContain('title: Sounding');
  });
});

describe('sounding (complete — recording-day target)', () => {
  test('serves OpenAPI 3.1', async () => {
    const res = await soundingFetch(req('/openapi.json'), { complete: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { openapi: string };
    expect(body.openapi).toBe('3.1.0');
  });

  test('initialize carries serverInfo.name and tools/list is an array', async () => {
    const init = await rpc('initialize', true);
    const info = (init.result as { serverInfo: { name: string } }).serverInfo;
    expect(info.name).toBe('sounding');
    const tools = await rpc('tools/list', true);
    expect(Array.isArray((tools.result as { tools: unknown[] }).tools)).toBe(true);
  });
});
