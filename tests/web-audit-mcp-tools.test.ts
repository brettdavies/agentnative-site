// Web-audit MCP tool tests (plan U12 + U13): gate ordering and typed
// envelopes for get_website_audit / audit_website / list_website_audits /
// get_web_remediation, dispatched through the real MCP handler. The
// terminal-only fresh audit_website happy path is smoke-verified in e2e
// (U16); here the fresh path is exercised only up to its gates.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { normalizeWebAuditRegistry, normalizeWebRemediation } from '../src/build/13-web-audit-registry.mjs';
import { keyFor } from '../src/worker/audit-web/cache';
import { resetWebAuditRegistryCacheForTests } from '../src/worker/audit-web/registry';
import { resetCatalogCacheForTests } from '../src/worker/mcp/catalog';
import { buildMcpHandler, type McpEnv } from '../src/worker/mcp/server';
import { resetWebRemediationCacheForTests } from '../src/worker/mcp/tools/web-remediation';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const DATA = join(REPO_ROOT, 'src', 'data', 'web-audit');

const FIXTURE_CATALOG = {
  generated_at: '2026-07-09T00:00:00.000Z',
  spec_version: SPEC_VERSION,
  registry: [],
  principles: [],
  spec_sections: [],
};

let assetsJson: { registry: string; remediation: string } | null = null;
async function projections() {
  if (!assetsJson) {
    const registry = normalizeWebAuditRegistry(yaml.load(await readFile(join(DATA, 'registry.yaml'), 'utf8')));
    const remediation = normalizeWebRemediation(
      yaml.load(await readFile(join(DATA, 'remediation.yaml'), 'utf8')),
      registry.checks.map((c: { id: string }) => c.id),
    );
    assetsJson = { registry: JSON.stringify(registry), remediation: JSON.stringify(remediation) };
  }
  return assetsJson;
}

const CURATED_INDEX = [
  { domain: 'anc.dev', url: 'https://anc.dev/', name: 'anc.dev', description: 'x', score_pct: 67 },
];
const CURATED_ANC = {
  schema_version: '0.1',
  target_url: 'https://anc.dev/',
  tool: { name: 'anc.dev', url: 'https://anc.dev/' },
  badge: { score_pct: 67, eligible: false },
  results: [],
};

interface WebEnvOpts {
  webEnabled?: boolean;
  mcpEnabled?: boolean;
  cachePrefill?: Record<string, unknown>;
  limiterOk?: boolean;
}

async function makeEnv(opts: WebEnvOpts = {}): Promise<McpEnv> {
  const { registry, remediation } = await projections();
  const cacheStore = new Map<string, string>();
  for (const [k, v] of Object.entries(opts.cachePrefill ?? {})) {
    cacheStore.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return {
    ASSETS: {
      async fetch(req: Request): Promise<Response> {
        const path = new URL(req.url).pathname;
        const ok = (body: string) =>
          new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
        if (path === '/_internal/mcp-catalog.json') return ok(JSON.stringify(FIXTURE_CATALOG));
        if (path === '/_internal/web-audit-registry.json') return ok(registry);
        if (path === '/_internal/web-remediation.json') return ok(remediation);
        if (path === '/_internal/web-scorecards/index.json') return ok(JSON.stringify(CURATED_INDEX));
        if (path === '/_internal/web-scorecards/anc.dev.json') return ok(JSON.stringify(CURATED_ANC));
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher,
    SCORE_CACHE: {
      async get(key: string) {
        const value = cacheStore.get(key);
        if (!value) return null;
        return {
          async json() {
            return JSON.parse(value);
          },
        };
      },
      async put(key: string, value: string) {
        cacheStore.set(key, value);
      },
      async delete() {},
    } as unknown as R2Bucket,
    SCORE_KV: {
      async get() {
        return null;
      },
      async put() {},
    } as unknown as KVNamespace,
    WEB_AUDIT_ENABLED: (opts.webEnabled ?? true) ? 'true' : undefined,
    MCP_ENABLED: (opts.mcpEnabled ?? true) ? 'true' : undefined,
    WEB_AUDIT_LIMITER: {
      async limit() {
        return { success: opts.limiterOk ?? true };
      },
    },
  } as unknown as McpEnv;
}

type JsonRpcResult = { result?: { content?: Array<{ text: string }>; isError?: boolean } };

async function callTool(env: McpEnv, name: string, args: Record<string, unknown>, ip?: string): Promise<JsonRpcResult> {
  const init = await buildMcpHandler(env, { jsonResponse: true });
  await init(
    new Request('https://anc.dev/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    }),
    env,
    {} as ExecutionContext,
  );
  const handler = await buildMcpHandler(env, { jsonResponse: true });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (ip) headers['cf-connecting-ip'] = ip;
  const res = await handler(
    new Request('https://anc.dev/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    }),
    env,
    {} as ExecutionContext,
  );
  return JSON.parse(await res.text()) as JsonRpcResult;
}

function jsonContent(body: JsonRpcResult): Record<string, unknown> {
  const text = body.result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('no content');
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(() => {
  resetCatalogCacheForTests();
  resetWebAuditRegistryCacheForTests();
  resetWebRemediationCacheForTests();
});
afterEach(() => {
  resetCatalogCacheForTests();
  resetWebAuditRegistryCacheForTests();
  resetWebRemediationCacheForTests();
});

describe('get_website_audit', () => {
  test('cache hit returns found:true with the scorecard and share_url', async () => {
    const key = await keyFor('https://example.com/', SPEC_VERSION);
    const env = await makeEnv({
      cachePrefill: {
        [key]: {
          spec_version: SPEC_VERSION,
          target_url: 'https://example.com/',
          scorecard: { badge: { score_pct: 88 } },
        },
      },
    });
    const body = jsonContent(await callTool(env, 'get_website_audit', { url: 'example.com' }));
    expect(body.found).toBe(true);
    expect(body.share_url).toBe('https://anc.dev/web/example.com');
    expect((body.scorecard as { badge: { score_pct: number } }).badge.score_pct).toBe(88);
  });

  test('curated projection resolves when R2 misses', async () => {
    const env = await makeEnv();
    const body = jsonContent(await callTool(env, 'get_website_audit', { url: 'anc.dev' }));
    expect(body.found).toBe(true);
    expect(body.share_url).toBe('https://anc.dev/web/anc.dev');
  });

  test('miss returns found:false + next_tool audit_website', async () => {
    const env = await makeEnv();
    const body = jsonContent(await callTool(env, 'get_website_audit', { url: 'never-seen.dev' }));
    expect(body.found).toBe(false);
    expect(body.next_tool).toBe('audit_website');
  });

  test('SSRF-blocked url returns isError', async () => {
    const env = await makeEnv();
    const res = await callTool(env, 'get_website_audit', { url: 'http://169.254.169.254/' });
    expect(res.result?.isError).toBe(true);
  });
});

describe('audit_website gates', () => {
  test('kill switch off returns audited:false disabled message', async () => {
    const env = await makeEnv({ webEnabled: false });
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, '203.0.113.4'));
    expect(body.audited).toBe(false);
    expect(String(body.message).toLowerCase()).toContain('disabled');
  });

  test('cache hit short-circuits without running a fresh audit', async () => {
    const key = await keyFor('https://example.com/', SPEC_VERSION);
    const env = await makeEnv({
      cachePrefill: {
        [key]: {
          spec_version: SPEC_VERSION,
          target_url: 'https://example.com/',
          scorecard: { badge: { score_pct: 91 } },
        },
      },
    });
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, '203.0.113.4'));
    expect(body.audited).toBe(false);
    expect(body.source).toBe('cache');
  });

  test('missing cf-connecting-ip returns the -32099 envelope (no anon fallback)', async () => {
    const env = await makeEnv();
    const res = await callTool(env, 'audit_website', { url: 'never-seen.dev' });
    expect(res.result?.isError).toBe(true);
    const body = jsonContent(res) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32099);
  });

  test('SSRF-blocked url returns isError before any probe', async () => {
    const env = await makeEnv();
    const res = await callTool(env, 'audit_website', { url: 'http://127.0.0.1/' }, '203.0.113.4');
    expect(res.result?.isError).toBe(true);
  });
});

describe('list_website_audits', () => {
  test('returns curated board summaries with share_urls', async () => {
    const env = await makeEnv();
    const body = jsonContent(await callTool(env, 'list_website_audits', {}));
    expect(body.count).toBe(1);
    const entries = body.entries as Array<{ domain: string; share_url: string; score_pct: number }>;
    expect(entries[0].domain).toBe('anc.dev');
    expect(entries[0].share_url).toBe('https://anc.dev/web/anc.dev');
  });
});

describe('tool registration', () => {
  test('all four web tools appear in tools/list after the existing tools', async () => {
    const env = await makeEnv();
    const handler = await buildMcpHandler(env, { jsonResponse: true });
    const res = await handler(
      new Request('https://anc.dev/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      env,
      {} as ExecutionContext,
    );
    const body = JSON.parse(await res.text()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    for (const name of ['audit_website', 'get_website_audit', 'list_website_audits', 'get_web_remediation']) {
      expect(names).toContain(name);
    }
  });
});

describe('audit_website site_type argument (U7)', () => {
  test('an invalid site_type is rejected by input validation', async () => {
    const env = await makeEnv();
    const res = await callTool(env, 'audit_website', { url: 'example.com', site_type: 'commerce' }, '203.0.113.9');
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text ?? '').toContain('site_type');
  });

  test('a valid site_type passes schema validation and reaches the gate chain', async () => {
    const env = await makeEnv({ limiterOk: false });
    const res = await callTool(env, 'audit_website', { url: 'example.com', site_type: 'content' }, '203.0.113.9');
    const text = res.result?.content?.[0]?.text ?? '';
    expect(text).toContain('rate limit');
  });
});

describe('get_web_remediation (reshaped, U13)', () => {
  test('returns the static goal/fix/skill_url/resources/prompt object by check id', async () => {
    const env = await makeEnv();
    const body = jsonContent(await callTool(env, 'get_web_remediation', { check_id: 'openapi' }));
    expect(body.found).toBe(true);
    const remediation = body.remediation as Record<string, unknown>;
    expect(remediation.check_id).toBe('openapi');
    expect(typeof remediation.goal).toBe('string');
    expect(typeof remediation.fix).toBe('string');
    expect(remediation.skill_url).toBe('https://anc.dev/web-audit/skill/openapi');
    expect(Array.isArray(remediation.resources)).toBe(true);
    expect(String(remediation.prompt)).toContain('Issue: the check did not pass in the latest audit');
  });

  test('an evidence arg becomes the prompt Issue line', async () => {
    const env = await makeEnv();
    const body = jsonContent(
      await callTool(env, 'get_web_remediation', { check_id: 'openapi', evidence: 'x.dev/openapi.json -> 404' }),
    );
    const remediation = body.remediation as { prompt: string };
    expect(remediation.prompt).toContain('Issue: x.dev/openapi.json -> 404');
  });

  test('an unknown check id returns found:false', async () => {
    const env = await makeEnv();
    const body = jsonContent(await callTool(env, 'get_web_remediation', { check_id: 'nope' }));
    expect(body.found).toBe(false);
  });
});

describe('audit_website inline remediation (U13)', () => {
  async function cachedScorecardEnv() {
    const key = await keyFor('https://example.com/', SPEC_VERSION);
    const scorecard = {
      schema_version: '0.2',
      target_url: 'https://example.com/',
      score_pct: 50,
      score: { relative: 50, global: 40 },
      results: [
        { id: 'llms-txt', status: 'pass', evidence: 'https://example.com/llms.txt -> 200' },
        { id: 'openapi', status: 'absent', evidence: 'https://example.com/openapi.json -> 404' },
        { id: 'mcp-tools-list', status: 'broken', evidence: 'no tools array' },
        { id: 'dns-aid', status: 'n_a', na_reason: 'optional-absent', evidence: 'no DNS-AID records' },
      ],
    };
    return makeEnv({
      cachePrefill: { [key]: { spec_version: SPEC_VERSION, target_url: 'https://example.com/', scorecard } },
    });
  }

  test('non-passing rows carry result + the inline remediation object; pass and n_a rows carry none', async () => {
    const env = await cachedScorecardEnv();
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, '203.0.113.9'));
    const scorecard = body.scorecard as {
      results: Array<{ id: string; result?: string; remediation?: { prompt: string; skill_url: string } }>;
    };
    const byId = new Map(scorecard.results.map((r) => [r.id, r]));

    const pass = byId.get('llms-txt');
    expect(pass?.result).toContain('Verified');
    expect(pass?.remediation).toBeUndefined();

    const absent = byId.get('openapi');
    expect(absent?.result).toContain('Not found');
    expect(absent?.remediation?.skill_url).toBe('https://anc.dev/web-audit/skill/openapi');
    expect(absent?.remediation?.prompt).toContain('Issue: https://example.com/openapi.json -> 404');

    const broken = byId.get('mcp-tools-list');
    expect(broken?.result).toContain('Present but broken');
    expect(broken?.remediation?.prompt).toContain('Issue: no tools array');

    const na = byId.get('dns-aid');
    expect(na?.result).toContain('Not implemented, optional');
    expect(na?.remediation).toBeUndefined();
  });
});
