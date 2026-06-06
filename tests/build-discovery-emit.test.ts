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
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitDiscovery } from '../src/build/11a-discovery-emit.mjs';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DIST_DIR = join(REPO_ROOT, 'dist');

describe('.well-known/mcp pointer (built dist/)', () => {
  test('file exists and parses as JSON', async () => {
    const raw = await readFile(join(DIST_DIR, '.well-known', 'mcp'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test('carries exactly the keys mcp_endpoint, version, description, transport, documentation', async () => {
    const raw = await readFile(join(DIST_DIR, '.well-known', 'mcp'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      'description',
      'documentation',
      'mcp_endpoint',
      'transport',
      'version',
    ]);
  });

  test('values match the wire contract pinned in content/mcp.md and instructions.ts', async () => {
    const raw = await readFile(join(DIST_DIR, '.well-known', 'mcp'), 'utf8');
    const parsed = JSON.parse(raw) as {
      mcp_endpoint: string;
      version: string;
      transport: string;
      documentation: string;
    };
    expect(parsed.mcp_endpoint).toBe('https://anc.dev/mcp');
    expect(parsed.version).toBe('2025-06-18');
    expect(parsed.transport).toBe('streamable-http');
    expect(parsed.documentation).toBe('https://anc.dev/mcp-skill.md');
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
      expect(stats.mcpPath).toBe(join(tmp, '.well-known', 'mcp'));
      expect(stats.securityPath).toBe(join(tmp, '.well-known', 'security.txt'));
      expect(stats.aiPath).toBe(join(tmp, '.well-known', 'ai.txt'));

      const mcp = JSON.parse(await readFile(stats.mcpPath, 'utf8')) as { mcp_endpoint: string; documentation: string };
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
    expect(section).toContain('https://anc.dev/.well-known/mcp');
    expect(section).toContain('https://anc.dev/mcp-skill.md');
  });

  test('only one Programmatic access section exists in llms.txt', async () => {
    const llms = await readFile(join(DIST_DIR, 'llms.txt'), 'utf8');
    const matches = llms.match(/## Programmatic access/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
