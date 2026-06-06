// Live-network e2e for POST /mcp against the staging Worker.
//
// Opt-in suite (project: staging-mcp). Excluded from the default
// `bun run test:e2e` run because it hits the real CF staging Worker, the
// agents@^0.13.3 + @modelcontextprotocol/sdk runtime in workerd, and the
// real registry-index.json + mcp-catalog.json bundle. Use to validate a
// staging deploy before promoting to production or to triage a
// regression that the bun unit suite can't reproduce against workerd.
//
// Run with:
//   ANC_STAGING_BASE_URL=https://agentnative-site-staging.brettdavies.workers.dev \
//     bun x playwright test --project=staging-mcp
//
// The staging Worker is gated by Cloudflare Access. Set
// ANC_STAGING_ACCESS_CLIENT_ID + ANC_STAGING_ACCESS_CLIENT_SECRET to a
// service-token pair if running headless (CI / cron); interactive auth
// works in a real browser via the Access challenge.
//
// SDK round-trip is intentionally NOT exercised here. The MCP SDK's
// StreamableHTTPClientTransport is a workerd-runtime-sensitive surface;
// this suite POSTs raw JSON-RPC envelopes to assert the wire shape, and
// a future v2 plan owns the full SDK round-trip if a regression slips
// past the bun unit + raw-JSON-RPC layers.

import { expect, test } from '@playwright/test';

const STAGING_BASE = process.env.ANC_STAGING_BASE_URL;

test.skip(
  !STAGING_BASE,
  'ANC_STAGING_BASE_URL not set — opt-in staging MCP suite. Set it to the staging Worker URL to run.',
);

const ACCESS_HEADERS: Record<string, string> = {};
if (process.env.ANC_STAGING_ACCESS_CLIENT_ID && process.env.ANC_STAGING_ACCESS_CLIENT_SECRET) {
  ACCESS_HEADERS['CF-Access-Client-Id'] = process.env.ANC_STAGING_ACCESS_CLIENT_ID;
  ACCESS_HEADERS['CF-Access-Client-Secret'] = process.env.ANC_STAGING_ACCESS_CLIENT_SECRET;
}

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...ACCESS_HEADERS,
};

type JsonRpcBody = {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: {
    serverInfo?: { name?: string; version?: string };
    protocolVersion?: string;
    capabilities?: { resources?: { subscribe?: boolean } };
    instructions?: string;
    tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    resources?: Array<{ uri: string; name?: string }>;
    resourceTemplates?: Array<{ uriTemplate: string; name?: string }>;
    content?: Array<{ type: string; text: string }>;
    contents?: Array<{ uri: string; mimeType: string; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
};

test.describe('staging /mcp — handshake', () => {
  test('initialize returns serverInfo.name "anc" and protocolVersion "2025-06-18"', async ({ request }) => {
    const res = await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'playwright-staging-mcp', version: '0.0.0' },
        },
      }),
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as JsonRpcBody;
    expect(body.error).toBeUndefined();
    expect(body.result?.serverInfo?.name).toBe('anc');
    expect(body.result?.protocolVersion).toBe('2025-06-18');
  });

  test('initialize advertises stateless capabilities (no resources/subscribe)', async ({ request }) => {
    const res = await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    const body = (await res.json()) as JsonRpcBody;
    expect(body.result?.capabilities?.resources?.subscribe).toBeFalsy();
  });

  test('initialize instructions string carries the literal numeric facts (drift gate)', async ({ request }) => {
    const res = await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    const body = (await res.json()) as JsonRpcBody;
    const instructions = body.result?.instructions ?? '';
    expect(instructions).toContain('9 tools');
    expect(instructions).toContain('5 resources');
    expect(instructions).toContain('60 requests per 60 seconds');
    expect(instructions).toContain('5 fresh audits per 60 minutes');
    expect(instructions).toContain('2025-06-18');
    expect(instructions).toContain('https://anc.dev/mcp-skill.md');
  });
});

test.describe('staging /mcp — tools/list', () => {
  test('returns exactly nine tools in the expected order', async ({ request }) => {
    await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    const res = await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as JsonRpcBody;
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toEqual([
      'list_tools',
      'get_tool',
      'search_tools',
      'list_principles',
      'get_principle',
      'list_spec_sections',
      'get_spec_section',
      'get_scorecard',
      'score_cli',
    ]);
  });

  test('every tool carries a non-empty description and an inputSchema', async ({ request }) => {
    await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    const res = await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const body = (await res.json()) as JsonRpcBody;
    for (const tool of body.result?.tools ?? []) {
      expect(typeof tool.description).toBe('string');
      expect((tool.description ?? '').length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

test.describe('staging /mcp — registry surface', () => {
  test('list_tools matches the deployed registry-index.json row count', async ({ request }) => {
    await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    const mcpRes = await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_tools', arguments: {} },
      }),
    });
    const mcpBody = (await mcpRes.json()) as JsonRpcBody;
    const text = mcpBody.result?.content?.[0]?.text ?? '[]';
    const rows = JSON.parse(text) as Array<{ slug: string }>;

    const indexRes = await request.get(`${STAGING_BASE}/registry-index.json`, { headers: ACCESS_HEADERS });
    const indexBody = (await indexRes.json()) as { by_slug: Record<string, unknown> };
    expect(rows.length).toBe(Object.keys(indexBody.by_slug).length);
  });

  test('get_scorecard slug=ripgrep returns the registry-curated hit', async ({ request }) => {
    await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    const res = await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_scorecard', arguments: { slug: 'ripgrep' } },
      }),
    });
    const body = (await res.json()) as JsonRpcBody;
    expect(body.result?.isError).toBeFalsy();
    const parsed = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as {
      found: boolean;
      source: string;
      scorecard_url: string;
    };
    expect(parsed.found).toBe(true);
    expect(parsed.source).toBe('registry');
    expect(parsed.scorecard_url).toBe('https://anc.dev/score/ripgrep');
  });
});

test.describe('staging /mcp — principles surface', () => {
  test('list_principles returns 8 entries with numbers 1..8', async ({ request }) => {
    await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    const res = await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_principles', arguments: {} },
      }),
    });
    const body = (await res.json()) as JsonRpcBody;
    const rows = JSON.parse(body.result?.content?.[0]?.text ?? '[]') as Array<{ n: number }>;
    expect(rows.length).toBe(8);
    expect(rows.map((r) => r.n).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('get_principle n=1 returns the principle body', async ({ request }) => {
    await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    const res = await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_principle', arguments: { n: 1 } },
      }),
    });
    const body = (await res.json()) as JsonRpcBody;
    const parsed = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as {
      found: boolean;
      principle?: { n: number; body_markdown: string };
    };
    expect(parsed.found).toBe(true);
    expect(parsed.principle?.n).toBe(1);
    expect(parsed.principle?.body_markdown).toContain('# P1');
  });
});

test.describe('staging /mcp — resources/templates/list', () => {
  test('returns exactly four templates with the expected URI patterns', async ({ request }) => {
    await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    const res = await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/templates/list' }),
    });
    const body = (await res.json()) as JsonRpcBody;
    const patterns = (body.result?.resourceTemplates ?? []).map((t) => t.uriTemplate).sort();
    expect(patterns).toEqual([
      'anc://principle/{n}',
      'anc://scorecard/{binary}',
      'anc://spec/{section}',
      'anc://tool/{slug}',
    ]);
  });
});

test.describe('staging /mcp — gate posture', () => {
  test('Accept: text/csv returns 406 with text/plain (no JSON-RPC envelope)', async ({ request }) => {
    const res = await request.post(`${STAGING_BASE}/mcp`, {
      headers: {
        'content-type': 'application/json',
        accept: 'text/csv',
        ...ACCESS_HEADERS,
      },
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    expect(res.status()).toBe(406);
    const ct = res.headers()['content-type'] ?? '';
    expect(ct).toContain('text/plain');
    const text = await res.text();
    expect(text).not.toContain('jsonrpc');
  });

  test('GET /mcp returns 405 with Allow: POST', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/mcp`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(405);
    expect(res.headers().allow).toBe('POST');
  });

  test('response carries no Access-Control-Allow-Origin header (KTD-10 server-to-agent posture)', async ({
    request,
  }) => {
    const res = await request.post(`${STAGING_BASE}/mcp`, {
      headers: MCP_HEADERS,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    expect(res.headers()['access-control-allow-origin']).toBeUndefined();
  });
});
