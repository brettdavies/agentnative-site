// Era-agnostic MCP server-card surface: GET /mcp is protocol-only (405), the
// SEP-2127 card and the AI catalog that lists it, and the SEP-1649 card with
// its pointer aliases. None of it depends on a JSON-RPC lane, so
// it runs against the local `wrangler dev` webServer in the default
// chromium project rather than opt-in staging, so a card regression is
// caught on the PR that causes it instead of on the next staging sweep.
//
// Staging-only card assertions (deployed-origin rewrites, cross-surface
// drift) stay in discoverability.e2e.ts under the staging-mcp project.
//
// Requests go through the `request` fixture and honor Playwright's
// baseURL, so this spec follows whichever origin the active project
// targets.

import { expect, test } from '@playwright/test';

// Source of truth: MCP_DESCRIPTOR_ALIAS_PATHS and
// MCP_DESCRIPTOR_CANONICAL_PATH in src/worker/mcp/descriptor-paths.ts.
// Duplicated as literals because the worker module is not importable in
// Playwright's node env; a new alias must be added in both places.
const CANONICAL_PATH = '/.well-known/mcp/server-card.json';
const ALIAS_PATHS = ['/.well-known/mcp', '/mcp.json', '/.well-known/mcp.json'] as const;

// The SEP-2127 wire contract, written out so a change to the constants in
// src/shared/mcp-discovery.ts reads as a change to what clients receive.
const SERVER_CARD_PATH = '/mcp/server-card';
const AI_CATALOG_PATH = '/.well-known/ai-catalog.json';
const SERVER_CARD_TYPE = 'application/mcp-server-card+json';
const SEP_2127_SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';

test.describe('MCP server card: SEP-2127 card and AI catalog', () => {
  test('the card names its streamable-http remote on the serving origin', async ({ request, baseURL }) => {
    const res = await request.get(SERVER_CARD_PATH, { headers: { accept: SERVER_CARD_TYPE } });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain(SERVER_CARD_TYPE);
    expect(res.headers()['access-control-allow-origin']).toBe('*');
    const card = (await res.json()) as { $schema?: string; remotes?: Array<{ type: string; url: string }> };
    expect(card.$schema).toBe(SEP_2127_SCHEMA_URL);
    expect(card.remotes).toEqual([{ type: 'streamable-http', url: `${baseURL}/mcp` }]);
  });

  test('the AI catalog lists the card at the location it is served from', async ({ request, baseURL }) => {
    const res = await request.get(AI_CATALOG_PATH);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/ai-catalog+json');
    const catalog = (await res.json()) as { specVersion?: string; entries?: Array<{ type: string; url: string }> };
    expect(catalog.specVersion).toBe('1.0');
    const cards = (catalog.entries ?? []).filter((entry) => entry.type === SERVER_CARD_TYPE);
    expect(cards.map((entry) => entry.url)).toEqual([`${baseURL}${SERVER_CARD_PATH}`]);
  });
});

test.describe('MCP server card — pointer aliases', () => {
  test('every alias 301s to the canonical server-card path', async ({ request, baseURL }) => {
    for (const path of ALIAS_PATHS) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), `alias ${path}`).toBe(301);
      expect(res.headers().location, `alias ${path}`).toBe(`${baseURL}${CANONICAL_PATH}`);
    }
  });

  test('an alias redirect chain resolves to the canonical card body', async ({ request, baseURL }) => {
    const res = await request.get('/mcp.json');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');
    const body = (await res.json()) as { mcp_endpoint?: string; transport?: { type?: string } };
    expect(body.mcp_endpoint).toBe(`${baseURL}/mcp`);
    expect(body.transport?.type).toBe('streamable-http');
  });

  test('a non-GET method on an alias is refused with 405', async ({ request }) => {
    const res = await request.post('/mcp.json', { maxRedirects: 0 });
    expect(res.status()).toBe(405);
  });
});

test.describe('MCP endpoint — GET is protocol-only', () => {
  for (const accept of ['text/event-stream', 'text/html', 'text/markdown', 'application/json', '*/*']) {
    test(`GET /mcp Accept ${accept} returns 405 Allow POST`, async ({ request, baseURL }) => {
      const res = await request.get('/mcp', { headers: { accept }, maxRedirects: 0 });
      expect(res.status()).toBe(405);
      expect(res.headers().allow).toBe('POST');
      expect(res.headers()['cache-control'] ?? '').toContain('no-store');
      expect(res.headers()['content-type'] ?? '').toContain('text/plain');
      const body = await res.text();
      expect(body).toContain(`${baseURL}/mcp-docs`);
      expect(body.toLowerCase()).not.toContain('<html');
    });
  }

  test('GET /mcp-docs serves the endpoint description as HTML', async ({ request }) => {
    const res = await request.get('/mcp-docs', { headers: { accept: 'text/html' } });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    expect(await res.text()).toContain('anc.dev MCP server');
  });

  test('GET /mcp-docs.md serves the markdown twin', async ({ request }) => {
    const res = await request.get('/mcp-docs.md');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/markdown');
    expect(await res.text()).toContain('405 Method Not Allowed');
  });

  test('llms.txt links the endpoint and the docs page, and the docs link resolves', async ({ request, baseURL }) => {
    const res = await request.get('/llms.txt');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain(`${baseURL}/mcp`);
    expect(text).toContain(`${baseURL}/mcp-docs.md`);
    const docs = await request.get('/mcp-docs.md');
    expect(docs.status()).toBe(200);
  });
});

test.describe('MCP server card — canonical path', () => {
  test('serves JSON naming the endpoint and the served protocol revision', async ({ request, baseURL }) => {
    const res = await request.get(CANONICAL_PATH);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');
    const body = (await res.json()) as {
      mcp_endpoint: string;
      protocolVersion: string;
      documentation: string;
    };
    expect(body.mcp_endpoint).toBe(`${baseURL}/mcp`);
    expect(body.protocolVersion).toBe('2026-07-28');
    expect(body.documentation).toBe(`${baseURL}/mcp-skill.md#server-cards`);
    expect(body).not.toHaveProperty('$schema');
  });

  // The card is a public discovery surface: agents fetch it cross-origin.
  test('is CORS-open, unlike the JSON-RPC endpoint itself', async ({ request }) => {
    const res = await request.get(CANONICAL_PATH);
    expect(res.headers()['access-control-allow-origin']).toBe('*');
  });
});
