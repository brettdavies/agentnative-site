// .well-known/* emit tests for U6 of the MCP endpoint plan.
//
// Exercises src/build/11a-discovery-emit.mjs against the built dist/
// directory plus a separate temp-directory pass for the time-sensitive
// security.txt Expires field. The dist/ pass pins shape invariants;
// the temp-dir pass lets the test pin a known-good moment in time
// without taking on a clock dependency in the production code path.
//
// The llms.txt Programmatic access section is asserted here too,
// alongside the .well-known files, because the three surfaces are
// coupled by R11 of the plan (every entry points at the same MCP
// endpoint; drift in any one breaks the discoverability story).

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitAgentReadiness, emitDiscovery } from '../src/build/11a-discovery-emit.mjs';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DIST_DIR = join(REPO_ROOT, 'dist');

describe('MCP server card seed (built dist/)', () => {
  test('file exists at _internal/mcp-server-card.json and parses as JSON', async () => {
    const raw = await readFile(join(DIST_DIR, '_internal', 'mcp-server-card.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test('carries U6 pointer fields and SEP-1649 server-card fields in one document', async () => {
    const raw = await readFile(join(DIST_DIR, '_internal', 'mcp-server-card.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      $schema: string;
      mcp_endpoint: string;
      version: string;
      description: string;
      documentation: string;
      serverInfo: { name: string; version: string };
      protocolVersion: string;
      url: string;
      transport: { type: string; endpoint: string };
      capabilities: {
        tools: { listChanged: boolean };
        resources: { subscribe: boolean; listChanged: boolean };
        prompts: { listChanged: boolean };
      };
      authentication: { required: boolean; schemes: string[]; documentation: string };
    };
    expect(parsed.$schema).toContain('mcp-server-card');
    expect(parsed.mcp_endpoint).toBe('https://anc.dev/mcp');
    expect(parsed.version).toBe('1.0');
    expect(parsed.protocolVersion).toBe('2025-06-18');
    expect(parsed.transport.type).toBe('streamable-http');
    expect(parsed.transport.endpoint).toBe('https://anc.dev/mcp');
    expect(parsed.url).toBe('https://anc.dev/mcp');
    expect(parsed.capabilities.tools.listChanged).toBe(false);
    expect(parsed.capabilities.resources.subscribe).toBe(false);
    expect(parsed.authentication.required).toBe(false);
    expect(parsed.authentication.schemes).toEqual([]);
    expect(parsed.authentication.documentation).toBe('https://anc.dev/auth.md');
    expect(parsed.documentation).toBe('https://anc.dev/mcp-skill.md');
    expect(typeof parsed.serverInfo.name).toBe('string');
    expect(typeof parsed.serverInfo.version).toBe('string');
  });

  test('retired static pointer file is not emitted', async () => {
    await expect(readFile(join(DIST_DIR, '.well-known', 'mcp'), 'utf8')).rejects.toThrow();
  });
});

describe('.well-known/security.txt (built dist/)', () => {
  test('file exists and has the RFC 9116 fields in order', async () => {
    const raw = await readFile(join(DIST_DIR, '.well-known', 'security.txt'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines[0]).toBe('Contact: mailto:97-boss-beetle@icloud.com');
    expect(lines[1]).toMatch(/^Expires:\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(lines[2]).toBe('Preferred-Languages: en');
    expect(lines[3]).toBe('Canonical: https://anc.dev/.well-known/security.txt');
  });

  test('Expires is at least 300 days in the future', async () => {
    const raw = await readFile(join(DIST_DIR, '.well-known', 'security.txt'), 'utf8');
    const match = raw.match(/^Expires:\s+(\S+)/m);
    expect(match).not.toBeNull();
    const expires = new Date(match?.[1] ?? '');
    const days = (expires.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThanOrEqual(300);
  });
});

describe('.well-known/ai.txt (built dist/)', () => {
  test('file exists with the documented declarations', async () => {
    const raw = await readFile(join(DIST_DIR, '.well-known', 'ai.txt'), 'utf8');
    expect(raw).toContain('User-Agent: *');
    expect(raw).toContain('Allow: /');
    expect(raw).toContain('Allow-AI-Training: yes');
    expect(raw).toContain('Allow-Inference: yes');
    expect(raw).toContain('Programmatic-API: https://anc.dev/mcp');
    expect(raw).toContain('Contact: mailto:97-boss-beetle@icloud.com');
  });
});

describe('emitDiscovery() in isolation', () => {
  test('round-trips into an arbitrary distDir without touching the real dist/', async () => {
    const tmp = join(tmpdir(), `anc-discovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmp, { recursive: true });
    try {
      const stats = await emitDiscovery({ distDir: tmp, baseUrl: 'https://example.test' });
      expect(stats.mcpDescriptorSeedPath).toBe(join(tmp, '_internal', 'mcp-server-card.json'));
      expect(stats.securityPath).toBe(join(tmp, '.well-known', 'security.txt'));
      expect(stats.aiPath).toBe(join(tmp, '.well-known', 'ai.txt'));

      const mcp = JSON.parse(await readFile(stats.mcpDescriptorSeedPath, 'utf8')) as {
        mcp_endpoint: string;
        documentation: string;
      };
      expect(mcp.mcp_endpoint).toBe('https://example.test/mcp');
      expect(mcp.documentation).toBe('https://example.test/mcp-skill.md');

      const security = await readFile(stats.securityPath, 'utf8');
      expect(security).toContain('Canonical: https://example.test/.well-known/security.txt');

      const ai = await readFile(stats.aiPath, 'utf8');
      expect(ai).toContain('Programmatic-API: https://example.test/mcp');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('llms.txt Programmatic access section', () => {
  test('renders between the summary line and the Principles section', async () => {
    const llms = await readFile(join(DIST_DIR, 'llms.txt'), 'utf8');
    const progIdx = llms.indexOf('## Programmatic access');
    const princIdx = llms.indexOf('## Principles');
    expect(progIdx).toBeGreaterThan(0);
    expect(princIdx).toBeGreaterThan(progIdx);
  });

  test('lists exactly three links pointing at the MCP surface', async () => {
    const llms = await readFile(join(DIST_DIR, 'llms.txt'), 'utf8');
    const section = llms.slice(llms.indexOf('## Programmatic access'), llms.indexOf('## Principles'));
    expect(section).toContain('https://anc.dev/mcp');
    expect(section).toContain('https://anc.dev/.well-known/mcp/server-card.json');
    expect(section).toContain('https://anc.dev/mcp-skill.md');
  });

  test('only one Programmatic access section exists in llms.txt', async () => {
    const llms = await readFile(join(DIST_DIR, 'llms.txt'), 'utf8');
    const matches = llms.match(/## Programmatic access/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe('robots.txt Content Signals (built dist/)', () => {
  test('declares Content-Signal preferences under the wildcard agent group', async () => {
    const raw = await readFile(join(DIST_DIR, 'robots.txt'), 'utf8');
    expect(raw).toContain('User-agent: *');
    expect(raw).toMatch(/^Content-Signal:.*ai-train=/m);
    expect(raw).toMatch(/^Content-Signal:.*search=/m);
    expect(raw).toMatch(/^Content-Signal:.*ai-input=/m);
  });

  test('keeps the Sitemap directive intact', async () => {
    const raw = await readFile(join(DIST_DIR, 'robots.txt'), 'utf8');
    expect(raw).toContain('Sitemap: https://anc.dev/sitemap.xml');
  });
});

describe('.well-known/api-catalog (built dist/)', () => {
  test('is a valid RFC 9727 link set with the MCP endpoint as anchor', async () => {
    const raw = await readFile(join(DIST_DIR, '.well-known', 'api-catalog'), 'utf8');
    const parsed = JSON.parse(raw) as {
      linkset: Array<{
        anchor: string;
        'service-desc': Array<{ href: string }>;
        'service-doc': Array<{ href: string }>;
        status: Array<{ href: string }>;
      }>;
    };
    expect(Array.isArray(parsed.linkset)).toBe(true);
    expect(parsed.linkset.length).toBeGreaterThanOrEqual(1);
    const entry = parsed.linkset[0];
    expect(entry.anchor).toBe('https://anc.dev/mcp');
    expect(entry['service-desc'][0].href).toBe('https://anc.dev/.well-known/mcp/server-card.json');
    expect(entry['service-doc'][0].href).toBe('https://anc.dev/mcp-skill');
    expect(entry.status[0].href).toBe('https://anc.dev/.well-known/mcp/server-card.json');
  });
});

describe('.well-known/oauth-protected-resource (built dist/)', () => {
  test('declares the MCP endpoint as the protected resource', async () => {
    const raw = await readFile(join(DIST_DIR, '.well-known', 'oauth-protected-resource'), 'utf8');
    const parsed = JSON.parse(raw) as {
      resource: string;
      authorization_servers: string[];
      bearer_methods_supported: string[];
      resource_documentation: string;
    };
    expect(parsed.resource).toBe('https://anc.dev/mcp');
    expect(parsed.authorization_servers).toEqual(['https://anc.dev']);
    expect(parsed.bearer_methods_supported).toContain('header');
    expect(parsed.resource_documentation).toBe('https://anc.dev/auth.md');
  });
});

describe('.well-known/oauth-authorization-server (built dist/)', () => {
  test('carries OAuth discovery fields and an agent_auth anonymous block', async () => {
    const raw = await readFile(join(DIST_DIR, '.well-known', 'oauth-authorization-server'), 'utf8');
    const parsed = JSON.parse(raw) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      jwks_uri: string;
      service_documentation: string;
      grant_types_supported: string[];
      agent_auth: {
        skill: string;
        register_uri: string;
        identity_types_supported: string[];
        anonymous: { credential_types_supported: string[]; claim_uri: string };
      };
    };
    expect(parsed.issuer).toBe('https://anc.dev');
    expect(parsed.authorization_endpoint).toBe('https://anc.dev/auth.md');
    expect(parsed.token_endpoint).toBe('https://anc.dev/oauth2/token');
    expect(parsed.jwks_uri).toBe('https://anc.dev/.well-known/jwks.json');
    expect(parsed.service_documentation).toBe('https://anc.dev/auth.md');
    expect(parsed.grant_types_supported.length).toBeGreaterThanOrEqual(1);
    expect(parsed.agent_auth.skill).toBe('https://anc.dev/auth.md');
    expect(parsed.agent_auth.identity_types_supported).toContain('anonymous');
    expect(parsed.agent_auth.anonymous.claim_uri).toBe('https://anc.dev/auth.md');
  });
});

describe('.well-known/jwks.json (built dist/)', () => {
  test('is a valid JWKS document with an empty keys array', async () => {
    const raw = await readFile(join(DIST_DIR, '.well-known', 'jwks.json'), 'utf8');
    const parsed = JSON.parse(raw) as { keys: unknown[] };
    expect(Array.isArray(parsed.keys)).toBe(true);
    expect(parsed.keys.length).toBe(0);
  });
});

describe('.well-known/agent-skills/index.json (built dist/)', () => {
  test('is a v0.2.0 discovery index with a digest matching the served artifact', async () => {
    const raw = await readFile(join(DIST_DIR, '.well-known', 'agent-skills', 'index.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      $schema: string;
      skills: Array<{ name: string; type: string; description: string; url: string; digest: string }>;
    };
    expect(parsed.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json');
    expect(parsed.skills.length).toBeGreaterThanOrEqual(1);
    const skill = parsed.skills[0];
    expect(skill.name).toMatch(/^[a-z0-9-]+$/);
    expect(skill.type).toBe('skill-md');
    expect(skill.url).toBe('https://anc.dev/mcp-skill.md');
    // The digest must be the SHA-256 of the served (non-minified) markdown twin.
    const expected = createHash('sha256')
      .update(await readFile(join(DIST_DIR, 'mcp-skill.md')))
      .digest('hex');
    expect(skill.digest).toBe(`sha256:${expected}`);
  });
});

describe('auth.md (built dist/)', () => {
  test('has an H1 containing "auth.md" and declares the no-auth posture', async () => {
    const raw = await readFile(join(DIST_DIR, 'auth.md'), 'utf8');
    const h1 = raw.split('\n').find((l) => l.startsWith('# '));
    expect(h1).toBeDefined();
    expect((h1 ?? '').toLowerCase()).toContain('auth.md');
    expect(raw).toContain('no authentication');
    expect(raw).toContain('public_catalog');
    expect(raw).toContain('## CORS posture');
    expect(raw).toContain('authentication.required: false');
    expect(raw).toContain('https://anc.dev/mcp');
    expect(raw).toContain('oauth-protected-resource');
    expect(raw).toContain('oauth-authorization-server');
    expect(raw).toContain('/.well-known/mcp/server-card.json');
  });
});

describe('emitAgentReadiness() emits pure ASCII (isolation pass)', () => {
  test('round-tripped agent-readiness output through a temp dir is byte-for-byte ASCII', async () => {
    const tmp = join(tmpdir(), `anc-readiness-ascii-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmp, { recursive: true });
    try {
      await writeFile(join(tmp, 'mcp-skill.md'), '# Using the MCP server\n\nhello\n');
      const stats = await emitAgentReadiness({ distDir: tmp, baseUrl: 'https://example.test' });
      for (const path of [
        stats.apiCatalogPath,
        stats.oauthProtectedResourcePath,
        stats.oauthAuthorizationServerPath,
        stats.jwksPath,
        stats.agentSkillsPath,
        stats.authMdPath,
      ]) {
        const hit = await findNonAsciiByte(path);
        expect(hit).toBeNull();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('emitAgentReadiness() in isolation', () => {
  test('round-trips into an arbitrary distDir, digesting the local mcp-skill.md', async () => {
    const tmp = join(tmpdir(), `anc-readiness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmp, { recursive: true });
    try {
      await writeFile(join(tmp, 'mcp-skill.md'), '# Using the MCP server\n\nhello\n');
      const stats = await emitAgentReadiness({ distDir: tmp, baseUrl: 'https://example.test' });
      expect(stats.apiCatalogPath).toBe(join(tmp, '.well-known', 'api-catalog'));
      expect(stats.oauthProtectedResourcePath).toBe(join(tmp, '.well-known', 'oauth-protected-resource'));
      expect(stats.oauthAuthorizationServerPath).toBe(join(tmp, '.well-known', 'oauth-authorization-server'));
      expect(stats.jwksPath).toBe(join(tmp, '.well-known', 'jwks.json'));
      expect(stats.agentSkillsPath).toBe(join(tmp, '.well-known', 'agent-skills', 'index.json'));
      expect(stats.authMdPath).toBe(join(tmp, 'auth.md'));

      const catalog = JSON.parse(await readFile(stats.apiCatalogPath, 'utf8')) as {
        linkset: Array<{ anchor: string; 'service-desc': Array<{ href: string }> }>;
      };
      expect(catalog.linkset[0].anchor).toBe('https://example.test/mcp');
      expect(catalog.linkset[0]['service-desc'][0].href).toBe('https://example.test/.well-known/mcp/server-card.json');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// Operational discovery surfaces (.well-known/*, robots.txt, sitemap.xml)
// are consumed by tooling that may not advertise UTF-8 charset on
// download. A non-ASCII byte (em-dash, en-dash, curly quote, NBSP) in
// these files renders as mojibake (e.g. `# ai.txt â€" anc.dev`) under
// any client that falls back to Latin-1 / Windows-1252. The fix is to
// keep the source files pure ASCII; this gate is the regression test.
//
// HTML pages and markdown twins are exempt — both carry an explicit
// `charset=utf-8` in their Content-Type, so high-bit bytes render
// correctly. The exempt set lives in the test below as a hard list, not
// a glob, so adding a new operational surface forces an explicit
// decision about whether it joins the ASCII-only gate.
async function findNonAsciiByte(path: string): Promise<{ offset: number; byte: number } | null> {
  const buf = await readFile(path);
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7f) return { offset: i, byte: buf[i] };
  }
  return null;
}

function lineColumnForOffset(buf: Buffer, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (buf[i] === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

describe('operational discovery surfaces are pure ASCII (mojibake gate)', () => {
  const PATHS = [
    join(DIST_DIR, '_internal', 'mcp-server-card.json'),
    join(DIST_DIR, '.well-known', 'security.txt'),
    join(DIST_DIR, '.well-known', 'ai.txt'),
    join(DIST_DIR, '.well-known', 'api-catalog'),
    join(DIST_DIR, '.well-known', 'oauth-protected-resource'),
    join(DIST_DIR, '.well-known', 'oauth-authorization-server'),
    join(DIST_DIR, '.well-known', 'jwks.json'),
    join(DIST_DIR, '.well-known', 'agent-skills', 'index.json'),
    join(DIST_DIR, 'auth.md'),
    join(DIST_DIR, 'robots.txt'),
    join(DIST_DIR, 'sitemap.xml'),
  ] as const;

  for (const path of PATHS) {
    const rel = path.slice(DIST_DIR.length + 1);
    test(`${rel} contains no high-bit bytes`, async () => {
      const hit = await findNonAsciiByte(path);
      if (hit) {
        const buf = await readFile(path);
        const { line, column } = lineColumnForOffset(buf, hit.offset);
        throw new Error(
          `${rel}:${line}:${column} carries byte 0x${hit.byte.toString(16).padStart(2, '0')} (non-ASCII). ` +
            'Operational discovery surfaces must be pure ASCII to survive clients that fall back to Latin-1 / ' +
            'Windows-1252 decoding (e.g. `—` becomes `â€"`). Replace the glyph in the source emitter.',
        );
      }
      expect(hit).toBeNull();
    });
  }
});

describe('emitDiscovery() emits pure ASCII (isolation pass)', () => {
  test('round-tripped output through a temp dir is byte-for-byte ASCII', async () => {
    const tmp = join(tmpdir(), `anc-discovery-ascii-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmp, { recursive: true });
    try {
      const stats = await emitDiscovery({ distDir: tmp, baseUrl: 'https://example.test' });
      for (const path of [stats.mcpDescriptorSeedPath, stats.securityPath, stats.aiPath]) {
        const hit = await findNonAsciiByte(path);
        expect(hit).toBeNull();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
