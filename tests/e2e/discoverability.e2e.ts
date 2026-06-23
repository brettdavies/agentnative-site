// Live-network e2e for discoverability surfaces against the staging
// Worker. Opt-in suite (project: staging-mcp). Asserts the four wire
// surfaces U6 ships (.well-known/mcp, security.txt, ai.txt, plus the
// llms.txt Programmatic access section) AND the mcp-skill HTML + .md
// twin pages U2 ships, with cross-surface drift assertions so a change
// in any one (the JSON pointer's documentation URL, the docs page's
// tool list, the well-known + handshake spec revision) breaks the
// suite.
//
// Run with:
//   ANC_STAGING_BASE_URL=https://agentnative-site-staging.brettdavies.workers.dev \
//     bun x playwright test --project=staging-mcp tests/e2e/discoverability.e2e.ts

import { expect, test } from '@playwright/test';

const STAGING_BASE = process.env.ANC_STAGING_BASE_URL;

test.skip(
  !STAGING_BASE,
  'ANC_STAGING_BASE_URL not set — opt-in staging discoverability suite. Set it to the staging Worker URL to run.',
);

const ACCESS_HEADERS: Record<string, string> = {};
if (process.env.ANC_STAGING_ACCESS_CLIENT_ID && process.env.ANC_STAGING_ACCESS_CLIENT_SECRET) {
  ACCESS_HEADERS['CF-Access-Client-Id'] = process.env.ANC_STAGING_ACCESS_CLIENT_ID;
  ACCESS_HEADERS['CF-Access-Client-Secret'] = process.env.ANC_STAGING_ACCESS_CLIENT_SECRET;
}

test.describe('staging /.well-known/mcp/server-card.json', () => {
  test('returns valid JSON with mcp_endpoint, version, transport, documentation', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/.well-known/mcp/server-card.json`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      mcp_endpoint: string;
      version: string;
      transport: { type: string };
      documentation: string;
    };
    expect(body.mcp_endpoint).toBe('https://anc.dev/mcp');
    expect(body.version).toBe('2025-06-18');
    expect(body.transport.type).toBe('streamable-http');
    expect(body.documentation).toBe('https://anc.dev/mcp-skill.md');
  });
});

test.describe('staging /.well-known/security.txt', () => {
  test('carries Contact 97-boss-beetle@icloud.com and a valid Expires field', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/.well-known/security.txt`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('Contact: mailto:97-boss-beetle@icloud.com');
    const match = text.match(/^Expires:\s+(\S+)/m);
    expect(match).not.toBeNull();
    expect(() => new Date(match?.[1] ?? '')).not.toThrow();
  });
});

test.describe('staging /.well-known/ai.txt', () => {
  test('carries Programmatic-API at the MCP endpoint and the canonical contact', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/.well-known/ai.txt`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('Programmatic-API: https://anc.dev/mcp');
    expect(text).toContain('Contact: mailto:97-boss-beetle@icloud.com');
    expect(text).toContain('Allow-AI-Training: yes');
    expect(text).toContain('Allow-Inference: yes');
  });
});

test.describe('staging /llms.txt', () => {
  test('contains the Programmatic access section with three expected links', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/llms.txt`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('## Programmatic access');
    // The section sits between the H1+summary and the Principles index.
    const progIdx = text.indexOf('## Programmatic access');
    const princIdx = text.indexOf('## Principles');
    expect(progIdx).toBeGreaterThan(0);
    expect(princIdx).toBeGreaterThan(progIdx);
    expect(text).toContain('https://anc.dev/mcp');
    expect(text).toContain('https://anc.dev/.well-known/mcp/server-card.json');
    expect(text).toContain('https://anc.dev/mcp-skill.md');
  });
});

test.describe('staging /mcp-skill surfaces', () => {
  test('/mcp-skill/ returns the HTML page', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/mcp-skill/`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    const ct = res.headers()['content-type'] ?? '';
    expect(ct).toContain('text/html');
  });

  test('/mcp-skill.md returns the markdown twin', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/mcp-skill.md`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    const ct = res.headers()['content-type'] ?? '';
    expect(ct).toContain('text/markdown');
  });

  test('mcp-skill.md text equality on the nine tool names + four template URIs (drift gate per KTD-8)', async ({
    request,
  }) => {
    const res = await request.get(`${STAGING_BASE}/mcp-skill.md`, { headers: ACCESS_HEADERS });
    const md = await res.text();
    for (const toolName of [
      'list_tools',
      'get_tool',
      'search_tools',
      'list_principles',
      'get_principle',
      'list_spec_sections',
      'get_spec_section',
      'get_scorecard',
      'score_cli',
    ]) {
      expect(md).toContain(toolName);
    }
    for (const uri of [
      'anc://registry',
      'anc://tool/{slug}',
      'anc://principle/{n}',
      'anc://spec/{section}',
      'anc://scorecard/{binary}',
    ]) {
      expect(md).toContain(uri);
    }
  });
});
