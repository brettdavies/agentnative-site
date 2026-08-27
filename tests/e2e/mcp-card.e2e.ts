// Era-agnostic MCP server-card surface: GET /mcp content negotiation and
// the SEP-1649 pointer aliases. None of it depends on a JSON-RPC lane, so
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

test.describe('MCP server card — GET /mcp negotiation', () => {
  test('a JSON Accept 301s to the canonical card', async ({ request, baseURL }) => {
    const res = await request.get('/mcp', {
      headers: { accept: 'application/json' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(301);
    expect(res.headers().location).toBe(`${baseURL}${CANONICAL_PATH}`);
  });

  test('an HTML Accept serves the endpoint landing page', async ({ request }) => {
    const res = await request.get('/mcp', { headers: { accept: 'text/html' } });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    expect(await res.text()).toContain('anc.dev MCP server');
  });

  // `*/*` (a bare curl, and the browser default) reduces to HTML rather
  // than the card, so a human clicking /mcp lands on the rendered page.
  test('a wildcard Accept serves the landing page, not the card', async ({ request }) => {
    const res = await request.get('/mcp', { headers: { accept: '*/*' }, maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
  });

  test('a markdown Accept serves the twin', async ({ request }) => {
    const res = await request.get('/mcp', { headers: { accept: 'text/markdown' } });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/markdown');
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
    expect(body.documentation).toBe(`${baseURL}/mcp-skill.md`);
  });

  // The card is a public discovery surface: agents fetch it cross-origin.
  test('is CORS-open, unlike the JSON-RPC endpoint itself', async ({ request }) => {
    const res = await request.get(CANONICAL_PATH);
    expect(res.headers()['access-control-allow-origin']).toBe('*');
  });
});
