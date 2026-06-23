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

const MCP_DESCRIPTOR_ALIASES = [
  '/.well-known/mcp/server-card.json',
  '/.well-known/mcp',
  '/mcp.json',
  '/.well-known/mcp.json',
] as const;

test.describe('staging MCP descriptor aliases', () => {
  test('all four alias paths return byte-identical JSON bodies', async ({ request }) => {
    const bodies: string[] = [];
    for (const path of MCP_DESCRIPTOR_ALIASES) {
      const res = await request.get(`${STAGING_BASE}${path}`, { headers: ACCESS_HEADERS });
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('application/json');
      bodies.push(await res.text());
    }
    for (let i = 1; i < bodies.length; i++) {
      expect(bodies[i]).toBe(bodies[0]);
    }
  });

  test('canonical server-card.json carries mcp_endpoint, version, transport, documentation', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/.well-known/mcp/server-card.json`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      mcp_endpoint: string;
      version: string;
      protocolVersion: string;
      transport: { type: string };
      documentation: string;
    };
    expect(body.mcp_endpoint).toBe('https://anc.dev/mcp');
    expect(body.version).toBe('1.0');
    expect(body.protocolVersion).toBe('2025-06-18');
    expect(body.transport.type).toBe('streamable-http');
    expect(body.documentation).toBe('https://anc.dev/mcp-skill.md');
    expect((body as { authentication?: { required: boolean } }).authentication?.required).toBe(false);
  });

  test('Accept: text/markdown on canonical path still returns application/json', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/.well-known/mcp/server-card.json`, {
      headers: { ...ACCESS_HEADERS, accept: 'text/markdown' },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');
    expect(() => JSON.parse(await res.text())).not.toThrow();
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

test.describe('staging agent-readiness well-known surfaces', () => {
  test('/.well-known/api-catalog returns application/linkset+json with MCP anchor', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/.well-known/api-catalog`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/linkset+json');
    const body = (await res.json()) as {
      linkset: Array<{ anchor: string; 'service-desc': Array<{ href: string }> }>;
    };
    expect(body.linkset[0].anchor).toBe('https://anc.dev/mcp');
    expect(body.linkset[0]['service-desc'][0].href).toBe('https://anc.dev/.well-known/mcp/server-card.json');
  });

  test('/.well-known/oauth-protected-resource declares the MCP resource', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/.well-known/oauth-protected-resource`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe('https://anc.dev/mcp');
    expect(body.authorization_servers).toContain('https://anc.dev');
  });

  test('/.well-known/oauth-authorization-server carries agent_auth anonymous block', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/.well-known/oauth-authorization-server`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      issuer: string;
      token_endpoint: string;
      agent_auth: { anonymous: { claim_uri: string } };
    };
    expect(body.issuer).toBe('https://anc.dev');
    expect(body.token_endpoint).toBe('https://anc.dev/oauth2/token');
    expect(body.agent_auth.anonymous.claim_uri).toBe('https://anc.dev/auth.md');
  });

  test('/.well-known/jwks.json is a valid JWKS document', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/.well-known/jwks.json`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(Array.isArray(body.keys)).toBe(true);
  });

  test('/.well-known/agent-skills/index.json lists the MCP skill with a digest', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/.well-known/agent-skills/index.json`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { skills: Array<{ url: string; digest: string }> };
    expect(body.skills.length).toBeGreaterThanOrEqual(1);
    expect(body.skills[0].url).toBe('https://anc.dev/mcp-skill.md');
    expect(body.skills[0].digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('/auth.md declares the no-auth posture', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/auth.md`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/markdown');
    const text = await res.text();
    expect(text.toLowerCase()).toContain('auth.md');
    expect(text).toContain('no authentication');
    expect(text).toContain('public_catalog');
    expect(text).toContain('/.well-known/mcp/server-card.json');
  });

  test('/robots.txt carries Content-Signal directives', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/robots.txt`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/^Content-Signal:.*ai-train=/m);
    expect(text).toMatch(/^Content-Signal:.*search=/m);
    expect(text).toMatch(/^Content-Signal:.*ai-input=/m);
  });

  test('POST /oauth2/token returns public_catalog error', async ({ request }) => {
    const res = await request.post(`${STAGING_BASE}/oauth2/token`, {
      headers: { ...ACCESS_HEADERS, 'content-type': 'application/json' },
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('public_catalog');
  });

  test('GET /oauth2/token is not a token endpoint (404)', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/oauth2/token`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(404);
  });

  test('/_internal/mcp-server-card.json is not publicly reachable', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/_internal/mcp-server-card.json`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(404);
  });

  test('Accept: text/markdown on api-catalog still returns linkset+json', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/.well-known/api-catalog`, {
      headers: { ...ACCESS_HEADERS, accept: 'text/markdown' },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/linkset+json');
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
