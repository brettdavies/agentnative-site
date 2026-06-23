// Agent-readiness discovery: cross-surface drift gates, build smoke tests,
// and Worker red-team coverage for every endpoint touched by the
// isitagentready remediation (MCP descriptor aliases, api-catalog, OAuth
// metadata, agent-skills index, auth.md, oauth2/token, webmcp.js).
//
// Complements tests/build-discovery-emit.test.ts (emit shape) and
// tests/worker-mcp-dispatch.test.ts (GET /mcp content negotiation).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitShell } from '../src/build/shell.mjs';
import worker, { MCP_DESCRIPTOR_CANONICAL_PATH } from '../src/worker/index';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DIST_DIR = join(REPO_ROOT, 'dist');

const MCP_DESCRIPTOR_ALIASES = [
  MCP_DESCRIPTOR_CANONICAL_PATH,
  '/.well-known/mcp',
  '/mcp.json',
  '/.well-known/mcp.json',
] as const;

const FIXTURE_MCP_SEED = JSON.stringify({
  mcp_endpoint: 'https://anc.dev/mcp',
  version: '1.0',
  protocolVersion: '2025-06-18',
  documentation: 'https://anc.dev/mcp-skill.md',
  url: 'https://anc.dev/mcp',
  transport: { type: 'streamable-http', endpoint: 'https://anc.dev/mcp' },
  authentication: { required: false, schemes: [], documentation: 'https://anc.dev/auth.md' },
});

const FIXTURE_API_CATALOG = JSON.stringify({
  linkset: [
    {
      anchor: 'https://anc.dev/mcp',
      'service-desc': [{ href: 'https://anc.dev/.well-known/mcp/server-card.json' }],
      'service-doc': [{ href: 'https://anc.dev/mcp-skill' }],
    },
  ],
});

const FIXTURE_OAUTH_PR = JSON.stringify({
  resource: 'https://anc.dev/mcp',
  authorization_servers: ['https://anc.dev'],
  bearer_methods_supported: ['header'],
  resource_documentation: 'https://anc.dev/auth.md',
});

const FIXTURE_OAUTH_AS = JSON.stringify({
  issuer: 'https://anc.dev',
  authorization_endpoint: 'https://anc.dev/auth.md',
  token_endpoint: 'https://anc.dev/oauth2/token',
  jwks_uri: 'https://anc.dev/.well-known/jwks.json',
  service_documentation: 'https://anc.dev/auth.md',
  agent_auth: {
    skill: 'https://anc.dev/auth.md',
    register_uri: 'https://anc.dev/auth.md',
    anonymous: { claim_uri: 'https://anc.dev/auth.md' },
  },
});

const FIXTURE_AUTH_MD = `# auth.md - anc.dev agent authentication

No authentication required.
`;

const FIXTURE_AGENT_SKILLS = JSON.stringify({
  $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
  skills: [{ name: 'agentnative-mcp', type: 'skill-md', url: 'https://anc.dev/mcp-skill.md', digest: 'sha256:abc' }],
});

const FIXTURE_JWKS = JSON.stringify({ keys: [] });

function req(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

function makeEnv(bodyByPath: Record<string, string> = {}) {
  const defaults: Record<string, string> = {
    '/_internal/mcp-server-card.json': FIXTURE_MCP_SEED,
    '/.well-known/api-catalog': FIXTURE_API_CATALOG,
    '/.well-known/oauth-protected-resource': FIXTURE_OAUTH_PR,
    '/.well-known/oauth-authorization-server': FIXTURE_OAUTH_AS,
    '/.well-known/agent-skills/index.json': FIXTURE_AGENT_SKILLS,
    '/.well-known/jwks.json': FIXTURE_JWKS,
    '/auth.md': FIXTURE_AUTH_MD,
  };
  const merged = { ...defaults, ...bodyByPath };

  return {
    ASSETS: {
      async fetch(request: Request | string): Promise<Response> {
        const url = typeof request === 'string' ? request : request.url;
        const path = new URL(url).pathname;
        const body = merged[path];
        if (body === undefined) {
          return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
        }
        return new Response(body, {
          status: 200,
          headers: { 'X-Echo-Path': path },
        });
      },
    } as unknown as Fetcher,
  };
}

// ---------------------------------------------------------------------------
// Built dist/ — cross-surface drift + webmcp smoke
// ---------------------------------------------------------------------------

describe('agent-readiness cross-surface drift (built dist/)', () => {
  test('api-catalog service-desc href matches the SEP-1649 canonical MCP path', async () => {
    const catalog = JSON.parse(await readFile(join(DIST_DIR, '.well-known', 'api-catalog'), 'utf8')) as {
      linkset: Array<{ 'service-desc': Array<{ href: string }> }>;
    };
    expect(catalog.linkset[0]['service-desc'][0].href).toBe(`https://anc.dev${MCP_DESCRIPTOR_CANONICAL_PATH}`);
  });

  test('auth.md names the canonical server-card path and pointer aliases', async () => {
    const raw = await readFile(join(DIST_DIR, 'auth.md'), 'utf8');
    expect(raw).toContain(MCP_DESCRIPTOR_CANONICAL_PATH);
    expect(raw).toContain('/.well-known/mcp');
    expect(raw).toContain('/mcp.json');
    expect(raw).toContain('/.well-known/api-catalog');
  });

  test('llms.txt Programmatic access section points at the canonical server-card path', async () => {
    const llms = await readFile(join(DIST_DIR, 'llms.txt'), 'utf8');
    expect(llms).toContain(`https://anc.dev${MCP_DESCRIPTOR_CANONICAL_PATH}`);
  });

  test('shell HTML pages load /js/webmcp.js on spec surfaces only', async () => {
    for (const page of ['index.html', 'mcp.html', 'p1.html']) {
      const html = await readFile(join(DIST_DIR, page), 'utf8');
      expect(html).toContain('/js/webmcp.js');
    }
    const about = await readFile(join(DIST_DIR, 'about.html'), 'utf8');
    expect(about).not.toContain('/js/webmcp.js');
    const scorecard = await readFile(join(DIST_DIR, 'score', 'curl.html'), 'utf8');
    expect(scorecard).not.toContain('/js/webmcp.js');
  });
});

describe('webmcp.js (built dist/)', () => {
  test('bundle exists and registers site navigation tools', async () => {
    const js = await readFile(join(DIST_DIR, 'js', 'webmcp.js'), 'utf8');
    expect(js.length).toBeGreaterThan(100);
    expect(js).toContain('get_principle_url');
    expect(js).toContain('navigator.modelContext');
  });
});

// ---------------------------------------------------------------------------
// Worker — MCP descriptor alias equivalence + red-team
// ---------------------------------------------------------------------------

describe('MCP descriptor aliases — byte-identical bodies', () => {
  test('all four alias paths return the same JSON body for a given origin', async () => {
    const env = makeEnv();
    const origin = 'https://staging.example';
    const bodies: string[] = [];
    for (const path of MCP_DESCRIPTOR_ALIASES) {
      const res = await worker.fetch(req(`${origin}${path}`), env);
      expect(res.status).toBe(200);
      bodies.push(await res.text());
    }
    for (let i = 1; i < bodies.length; i++) {
      expect(bodies[i]).toBe(bodies[0]);
    }
  });

  test('canonical path stamps application/json, CORS, and cacheable Cache-Control', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req(`https://anc.dev${MCP_DESCRIPTOR_CANONICAL_PATH}`), env);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const cc = res.headers.get('Cache-Control') ?? '';
    expect(cc).toContain('max-age=300');
    expect(cc).not.toContain('no-store');
  });

  for (const path of MCP_DESCRIPTOR_ALIASES) {
    test(`${path} — non-GET returns 405 Allow: GET`, async () => {
      const env = makeEnv();
      const res = await worker.fetch(req(`https://anc.dev${path}`, { method: 'POST' }), env);
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET');
    });
  }

  for (const path of MCP_DESCRIPTOR_ALIASES) {
    test(`${path} — Accept: text/markdown still returns JSON (intercept bypasses CN rewrite)`, async () => {
      const env = makeEnv();
      const res = await worker.fetch(
        req(`https://anc.dev${path}`, { headers: { accept: 'text/markdown' } }),
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
      const text = await res.text();
      expect(() => JSON.parse(text)).not.toThrow();
    });
  }

  test('Accept typo (application/jso) on canonical path still returns JSON body', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      req(`https://anc.dev${MCP_DESCRIPTOR_CANONICAL_PATH}`, { headers: { accept: 'application/jso' } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });

  test('path typo /.well-known/mcp/server-card.JSON is not an alias (404)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/.well-known/mcp/server-card.JSON'), env);
    expect(res.status).toBe(404);
  });

  test('seed asset /_internal/mcp-server-card.json is not publicly reachable', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/_internal/mcp-server-card.json'), env);
    expect(res.status).toBe(404);
  });

  test('missing seed returns 503 instead of an unhandled exception', async () => {
    const noSeedEnv = {
      ASSETS: {
        async fetch(): Promise<Response> {
          return new Response('not found', { status: 404 });
        },
      } as unknown as Fetcher,
    };
    const res = await worker.fetch(req(`https://anc.dev${MCP_DESCRIPTOR_CANONICAL_PATH}`), noSeedEnv);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('unavailable');
  });

  test('authentication.documentation rewrites to the inbound origin', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://staging.example/.well-known/mcp/server-card.json'), env);
    const body = JSON.parse(await res.text()) as {
      authentication: { documentation: string };
    };
    expect(body.authentication.documentation).toBe('https://staging.example/auth.md');
  });
});

// ---------------------------------------------------------------------------
// Worker — api-catalog
// ---------------------------------------------------------------------------

describe('/.well-known/api-catalog — worker red-team', () => {
  test('GET stamps application/linkset+json and does not rewrite body', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/.well-known/api-catalog'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/linkset+json; charset=utf-8');
    expect(await res.text()).toBe(FIXTURE_API_CATALOG);
  });

  test('POST does not receive the linkset+json content-type stamp (GET-only intercept)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/.well-known/api-catalog', { method: 'POST' }), env);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET');
  });

  test('Accept: text/markdown still returns linkset+json (GET intercept precedes CN rewrite)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      req('https://anc.dev/.well-known/api-catalog', { headers: { accept: 'text/markdown' } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/linkset+json; charset=utf-8');
    expect(await res.text()).toBe(FIXTURE_API_CATALOG);
  });
});

// ---------------------------------------------------------------------------
// Worker — OAuth metadata
// ---------------------------------------------------------------------------

describe('OAuth discovery metadata — worker red-team', () => {
  test('GET /.well-known/oauth-protected-resource stamps JSON + CORS', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/.well-known/oauth-protected-resource'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  test('GET /.well-known/oauth-authorization-server stamps JSON + CORS', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/.well-known/oauth-authorization-server'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  test('POST on oauth-protected-resource returns 405 Allow: GET', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      req('https://anc.dev/.well-known/oauth-protected-resource', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET');
  });

  test('GET /.well-known/oauth-protected-resource rewrites resource_documentation to auth.md', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://staging.example/.well-known/oauth-protected-resource'), env);
    const body = JSON.parse(await res.text()) as { resource_documentation: string };
    expect(body.resource_documentation).toBe('https://staging.example/auth.md');
  });

  test('GET /.well-known/oauth-authorization-server rewrites service_documentation to auth.md', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://staging.example/.well-known/oauth-authorization-server'), env);
    const body = JSON.parse(await res.text()) as { service_documentation: string };
    expect(body.service_documentation).toBe('https://staging.example/auth.md');
  });

  test('Accept: text/markdown still returns JSON (GET intercept precedes CN rewrite)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      req('https://anc.dev/.well-known/oauth-protected-resource', { headers: { accept: 'text/markdown' } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    const body = JSON.parse(await res.text()) as { resource: string };
    expect(body.resource).toBe('https://anc.dev/mcp');
  });
});

// ---------------------------------------------------------------------------
// Worker — static JSON + auth.md content negotiation
// ---------------------------------------------------------------------------

describe('static discovery JSON — worker red-team', () => {
  test('GET /.well-known/jwks.json returns JSON with CORS via applyHeaders', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/.well-known/jwks.json'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  test('Accept: text/markdown on /.well-known/jwks.json does not CN-rewrite (.json suffix wins)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      req('https://anc.dev/.well-known/jwks.json', { headers: { accept: 'text/markdown' } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(await res.text()).toBe(FIXTURE_JWKS);
  });

  test('GET /.well-known/agent-skills/index.json returns JSON with CORS', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/.well-known/agent-skills/index.json'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('auth.md — worker content negotiation', () => {
  test('GET /auth.md serves markdown with noindex', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/auth.md'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(await res.text()).toContain('auth.md');
  });

  test('GET /auth with Accept: text/markdown rewrites to /auth.md', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      req('https://anc.dev/auth', { headers: { accept: 'text/markdown' } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('X-Echo-Path')).toBe('/auth.md');
  });
});

// ---------------------------------------------------------------------------
// Worker — oauth2/token
// ---------------------------------------------------------------------------

describe('POST /oauth2/token — worker red-team', () => {
  test('GET is not handled by the token stub (404 via asset fallthrough)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/oauth2/token', { method: 'GET' }), env);
    expect(res.status).toBe(404);
  });

  test('POST rewrites documentation and mcp_endpoint to the inbound origin', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      req('https://staging.example/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = JSON.parse(await res.text()) as {
      error: string;
      documentation: string;
      mcp_endpoint: string;
    };
    expect(body.error).toBe('public_catalog');
    expect(body.documentation).toBe('https://staging.example/auth.md');
    expect(body.mcp_endpoint).toBe('https://staging.example/mcp');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Site shell + homepage — MCP prose and link drift gates
// ---------------------------------------------------------------------------

function sampleShellHtml(): string {
  return emitShell({
    title: 'The agent-native CLI standard',
    description: 'Fixture page for shell MCP link drift gates.',
    canonicalPath: '/',
    bodyHtml: '<article>body</article>',
    themeInitJs: '/* theme init */',
    isIndex: true,
  });
}

describe('site shell MCP discoverability (emitShell)', () => {
  test('head alternate + describedby point at the SEP-1649 canonical server card', () => {
    const html = sampleShellHtml();
    expect(html).toContain(
      '<link rel="alternate" type="application/json" href="/.well-known/mcp/server-card.json" title="MCP server card" />',
    );
    expect(html).toContain('<link rel="describedby" href="/.well-known/mcp/server-card.json" />');
    // Retired U6-only pointer must not return as the sole JSON alternate.
    expect(html).not.toContain('href="/.well-known/mcp" title="MCP server descriptor"');
    expect(html).not.toMatch(/rel="describedby" href="\/\.well-known\/mcp" \/>/);
  });

  test('rel=mcp advertises the streamable-HTTP endpoint', () => {
    const html = sampleShellHtml();
    expect(html).toContain('<link rel="mcp" href="/mcp" />');
  });

  test('JSON-LD SoftwareApplication entry names the MCP server at /mcp', () => {
    const html = sampleShellHtml();
    expect(html).toContain('"@id":"https://anc.dev/#mcp-server"');
    expect(html).toContain('"url":"https://anc.dev/mcp"');
    expect(html).toContain('"documentation":"https://anc.dev/mcp-skill"');
  });

  test('footer MCP link targets the client integration guide', () => {
    const html = sampleShellHtml();
    expect(html).toContain('<a href="/mcp-skill/">MCP</a>');
  });
});

describe('homepage MCP prose (built dist/)', () => {
  test('hero__use-it links to the /mcp endpoint and /mcp-skill guide', async () => {
    const html = await readFile(join(DIST_DIR, 'index.html'), 'utf8');
    const useIt = html.match(/<p class="hero__use-it">[\s\S]*?<\/p>/)?.[0] ?? '';
    expect(useIt.length).toBeGreaterThan(0);
    expect(useIt).toContain('MCP');
    expect(useIt).toContain('href="/mcp"');
    expect(useIt).toContain('href="/mcp-skill"');
    expect(useIt).toContain('streamable-HTTP');
    expect(useIt).toContain('wire contract');
  });

  test('index.md twin mirrors the MCP endpoint + guide links', async () => {
    const md = await readFile(join(DIST_DIR, 'index.md'), 'utf8');
    expect(md).toContain('https://anc.dev/mcp');
    expect(md).toContain('/mcp-skill');
    expect(md).toContain('streamable-HTTP');
  });

  test('content/_use.md source still names the same two surfaces', async () => {
    const raw = await readFile(join(REPO_ROOT, 'content', '_use.md'), 'utf8');
    expect(raw).toContain('(/mcp)');
    expect(raw).toContain('(/mcp-skill)');
    expect(raw).not.toContain('/.well-known/mcp"');
  });
});

describe('homepage MCP links resolve (worker)', () => {
  const PAGE_ENV = makeEnv({
    '/mcp': '<!doctype html><html><body><h1>anc.dev MCP server</h1></body></html>',
    '/mcp-skill': '<!doctype html><html><body><h1>MCP skill</h1></body></html>',
    '/mcp-skill/': '<!doctype html><html><body><h1>MCP skill</h1></body></html>',
  });

  test('GET /mcp serves the endpoint landing page as HTML', async () => {
    const res = await worker.fetch(req('https://anc.dev/mcp'), PAGE_ENV);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('anc.dev MCP server');
  });

  test('GET /mcp-skill/ serves the client integration guide (footer link)', async () => {
    const res = await worker.fetch(req('https://anc.dev/mcp-skill/'), PAGE_ENV);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('MCP skill');
  });

  test('GET /mcp-skill serves the same integration guide without trailing slash', async () => {
    const res = await worker.fetch(req('https://anc.dev/mcp-skill'), PAGE_ENV);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('MCP skill');
  });
});
