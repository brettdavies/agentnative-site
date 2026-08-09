// Web-audit MCP tool tests (plan U12 + U13): gate ordering and typed
// envelopes for get_website_audit / audit_website / list_website_audits /
// get_web_remediation, dispatched through the real MCP handler. The
// terminal-only fresh audit_website happy path is smoke-verified in e2e
// (U16); here the fresh path is exercised only up to its gates.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry, normalizeWebRemediation } from '../src/build/13-web-audit-registry.mjs';
import { keyFor } from '../src/worker/audit-web/cache';
import { resetWebAuditRegistryCacheForTests } from '../src/worker/audit-web/registry';
import { handleWebAudit, handleWebLeaderboard, type WebAuditRouteEnv } from '../src/worker/audit-web/route';
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
    const registry = normalizeWebAuditRegistry(
      yaml.load(await readFile(join(DATA, 'registry.yaml'), 'utf8')) as object,
    );
    const checks = registry.checks as Array<{ id: string }>;
    const remediation = normalizeWebRemediation(
      yaml.load(await readFile(join(DATA, 'remediation.yaml'), 'utf8')) as object,
      checks.map((c) => c.id),
    );
    assetsJson = { registry: JSON.stringify(registry), remediation: JSON.stringify(remediation) };
  }
  return assetsJson;
}

// One listed R2 object as the board enumeration sees it: key plus the board
// fields duplicated into custom metadata (the render path never reads bodies).
type ListedObject = { key: string; customMetadata?: Record<string, string> };

// Map-backed R2 stub: a store-owning bucket lets a test assert no-write and
// read a patched envelope directly.
function makeBucket(store: Map<string, string>): R2Bucket {
  return {
    async get(key: string) {
      const value = store.get(key);
      if (!value) return null;
      return {
        async json() {
          return JSON.parse(value);
        },
      };
    },
    async put(key: string, value: string) {
      store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as R2Bucket;
}

interface WebEnvOpts {
  webEnabled?: boolean;
  mcpEnabled?: boolean;
  cachePrefill?: Record<string, unknown>;
  // Pages the bucket's list() returns, cursor-paginated like production R2 so
  // listAllWebAudits (and thus list_website_audits view=all) can enumerate
  // user-submitted rows from custom metadata alone.
  listPages?: ListedObject[][];
  limiterOk?: boolean;
  failRegistry?: boolean;
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
        if (path === '/_internal/web-audit-registry.json') {
          return opts.failRegistry ? new Response('boom', { status: 500 }) : ok(registry);
        }
        if (path === '/_internal/web-remediation.json') return ok(remediation);
        if (path === '/_internal/web-seed.json') {
          return ok(
            JSON.stringify([{ domain: 'anc.dev', url: 'https://anc.dev/', name: 'anc.dev', description: 'x' }]),
          );
        }
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
      async list(options?: { cursor?: string }) {
        const pages = opts.listPages ?? [];
        const index = options?.cursor ? Number(options.cursor) : 0;
        const objects = pages[index] ?? [];
        const truncated = index + 1 < pages.length;
        return truncated ? { objects, truncated, cursor: String(index + 1) } : { objects, truncated: false };
      },
    } as unknown as R2Bucket,
    SCORE_KV: {
      async get() {
        return null;
      },
      async put() {},
    } as unknown as KVNamespace,
    WEB_AUDIT_ENABLED: (opts.webEnabled ?? true) ? 'true' : undefined,
    MCP_ENABLED: (opts.mcpEnabled ?? true) ? 'true' : undefined,
    WEB_AUDIT_LIMITER_IP: {
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

  test('a board domain with no R2 entry is a miss (no committed fallback)', async () => {
    const env = await makeEnv();
    const body = jsonContent(await callTool(env, 'get_website_audit', { url: 'anc.dev' }));
    expect(body.found).toBe(false);
    expect(body.next_tool).toBe('audit_website');
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

describe('get_website_audit read-time enrichment', () => {
  const OLD_SHAPE = {
    schema_version: '0.2',
    target_url: 'https://example.com/',
    score_pct: 60,
    score: { relative: 60, global: 48 },
    summary: { pass: 2, broken: 1, absent: 1, n_a: 0, skip: 0, error: 0 },
    categories: [{ id: 'mcp-api', name: 'MCP & API', passed: 2, counted: 4 }],
    results: [
      { id: 'openapi', category: 'mcp-api', keyword: 'must', status: 'absent', evidence: 'openapi.json -> 404' },
      { id: 'mcp-initialize', category: 'mcp-api', keyword: 'must', status: 'pass', evidence: 'ok' },
      { id: 'mcp-tools-list', category: 'mcp-api', keyword: 'should', status: 'broken', evidence: 'no tools array' },
      { id: 'llms-txt', category: 'mcp-api', keyword: 'should', status: 'pass', evidence: 'llms.txt -> 200' },
    ],
  };

  async function oldShapeEnv(extra: WebEnvOpts = {}) {
    const key = await keyFor('https://example.com/', SPEC_VERSION);
    return makeEnv({
      cachePrefill: {
        [key]: { spec_version: SPEC_VERSION, target_url: 'https://example.com/', scorecard: OLD_SHAPE },
      },
      ...extra,
    });
  }

  type EnrichedRow = { id: string; category: string; result?: string; remediation?: { skill_url: string } };

  test('a cache hit on an old-shape scorecard returns the current category split with rows re-tagged', async () => {
    const env = await oldShapeEnv();
    const body = jsonContent(await callTool(env, 'get_website_audit', { url: 'example.com' }));
    expect(body.found).toBe(true);
    const scorecard = body.scorecard as {
      categories: Array<{ id: string }>;
      results: EnrichedRow[];
    };
    const catIds = scorecard.categories.map((c) => c.id);
    expect(catIds).not.toContain('mcp-api');
    expect(catIds).toEqual(expect.arrayContaining(['api', 'mcp', 'content-for-agents']));
    const byId = new Map(scorecard.results.map((r) => [r.id, r]));
    expect(byId.get('openapi')?.category).toBe('api');
    expect(byId.get('mcp-initialize')?.category).toBe('mcp');
    expect(byId.get('llms-txt')?.category).toBe('content-for-agents');
  });

  test('a cache hit carries a result line on every row and remediation on non-passing rows only', async () => {
    const env = await oldShapeEnv();
    const body = jsonContent(await callTool(env, 'get_website_audit', { url: 'example.com' }));
    const scorecard = body.scorecard as { results: EnrichedRow[] };
    const byId = new Map(scorecard.results.map((r) => [r.id, r]));

    expect(byId.get('openapi')?.result).toContain('Not found');
    expect(byId.get('openapi')?.remediation?.skill_url).toBe('https://anc.dev/web-audit/skill/openapi');

    expect(byId.get('mcp-tools-list')?.result).toContain('Present but broken');
    expect(byId.get('mcp-tools-list')?.remediation?.skill_url).toBe('https://anc.dev/web-audit/skill/mcp-tools-list');

    const pass = byId.get('llms-txt');
    expect(pass?.result).toContain('Verified');
    expect(pass?.remediation).toBeUndefined();
  });

  test('a registry-load failure still returns the scorecard (remediation-only, not an error)', async () => {
    const env = await oldShapeEnv({ failRegistry: true });
    const res = await callTool(env, 'get_website_audit', { url: 'example.com' });
    expect(res.result?.isError).toBeFalsy();
    const body = jsonContent(res);
    expect(body.found).toBe(true);
    const scorecard = body.scorecard as { categories: Array<{ id: string }>; results: EnrichedRow[] };
    // No registry -> stored category shape is preserved.
    expect(scorecard.categories.map((c) => c.id)).toEqual(['mcp-api']);
    // Remediation still attaches from the catalog.
    const byId = new Map(scorecard.results.map((r) => [r.id, r]));
    expect(byId.get('openapi')?.remediation?.skill_url).toBe('https://anc.dev/web-audit/skill/openapi');
  });

  test('the minimal-payload guard passes a badge-only scorecard through unchanged', async () => {
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
    expect((body.scorecard as { badge: { score_pct: number } }).badge.score_pct).toBe(88);
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
          scored_at: new Date().toISOString(),
        },
      },
    });
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, '203.0.113.4'));
    expect(body.audited).toBe(false);
    expect(body.source).toBe('cache');
  });

  test('a warm cache is served even when the kill switch is off (cache-as-data)', async () => {
    const key = await keyFor('https://example.com/', SPEC_VERSION);
    const env = await makeEnv({
      webEnabled: false,
      cachePrefill: {
        [key]: {
          spec_version: SPEC_VERSION,
          target_url: 'https://example.com/',
          scorecard: { badge: { score_pct: 88 } },
          scored_at: new Date().toISOString(),
        },
      },
    });
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, '203.0.113.4'));
    expect(body.audited).toBe(false);
    expect(body.source).toBe('cache');
    expect(String(body.message ?? '')).not.toContain('disabled');
  });

  test('kill switch off + stale hit still serves the cached entry as data', async () => {
    const key = await keyFor('https://example.com/', SPEC_VERSION);
    const env = await makeEnv({
      webEnabled: false,
      cachePrefill: {
        [key]: {
          spec_version: SPEC_VERSION,
          target_url: 'https://example.com/',
          scorecard: { badge: { score_pct: 88 } },
          scored_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        },
      },
    });
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, '203.0.113.4'));
    expect(body.audited).toBe(false);
    expect(body.source).toBe('cache');
  });

  test('a stale hit falls through to the gate chain (limiter breach surfaces, cache does not mask it)', async () => {
    const key = await keyFor('https://example.com/', SPEC_VERSION);
    const env = await makeEnv({
      limiterOk: false,
      cachePrefill: {
        [key]: {
          spec_version: SPEC_VERSION,
          target_url: 'https://example.com/',
          scorecard: { badge: { score_pct: 88 } },
          scored_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        },
      },
    });
    const res = await callTool(env, 'audit_website', { url: 'example.com' }, '203.0.113.4');
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text ?? '').toContain('rate limit');
  });

  test('a legacy cached entry without scored_at reads as stale and falls through', async () => {
    const key = await keyFor('https://example.com/', SPEC_VERSION);
    const env = await makeEnv({
      limiterOk: false,
      cachePrefill: {
        [key]: {
          spec_version: SPEC_VERSION,
          target_url: 'https://example.com/',
          scorecard: { badge: { score_pct: 88 } },
        },
      },
    });
    const res = await callTool(env, 'audit_website', { url: 'example.com' }, '203.0.113.4');
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text ?? '').toContain('rate limit');
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

const CURATED_AGGREGATE_KEY = `audits/web/leaderboard/${SPEC_VERSION}.json`;

function curatedAggregate(domains: string[]) {
  return {
    spec_version: SPEC_VERSION,
    generated_at: new Date().toISOString(),
    entries: domains.map((domain) => ({
      domain,
      url: `https://${domain}/`,
      name: domain,
      description: 'x',
      score_pct: 67,
      score: { relative: 67, global: 62 },
    })),
  };
}

// A per-domain audit as the board enumeration sees it: a valid hex key plus the
// board fields in custom metadata. An omitted publicListing models an
// unmigrated object, which parses back as not-opted-in.
let listedRowSeq = 0;
function listedRow(domain: string, publicListing?: boolean): ListedObject {
  const key = `audits/web/${String(listedRowSeq++).padStart(64, '0')}/${SPEC_VERSION}.json`;
  const customMetadata: Record<string, string> = {
    domain,
    name: domain,
    scored_at: new Date().toISOString(),
    score_pct: '80',
    relative: '80',
    global: '70',
  };
  if (publicListing !== undefined) customMetadata.public_listing = String(publicListing);
  return { key, customMetadata };
}

// The domains rendered as user (on-demand) rows on the /web markdown board,
// pulled from the /web/<domain> link in each on-demand table row.
function onDemandDomainsFromMarkdown(md: string): string[] {
  return md
    .split('\n')
    .filter((line) => line.includes('| on-demand |'))
    .map((line) => {
      const m = line.match(/\/web\/([^)]+)\)/);
      if (!m) throw new Error(`no domain link in on-demand row: ${line}`);
      return m[1];
    });
}

describe('list_website_audits', () => {
  test('returns board summaries from the leaderboard aggregate with share_urls', async () => {
    const env = await makeEnv({
      cachePrefill: {
        [`audits/web/leaderboard/${SPEC_VERSION}.json`]: {
          spec_version: SPEC_VERSION,
          generated_at: new Date().toISOString(),
          entries: [
            {
              domain: 'anc.dev',
              url: 'https://anc.dev/',
              name: 'anc.dev',
              description: 'x',
              score_pct: 67,
              score: { relative: 67, global: 62 },
            },
          ],
        },
      },
    });
    const body = jsonContent(await callTool(env, 'list_website_audits', {}));
    expect(body.count).toBe(1);
    const entries = body.entries as Array<{ domain: string; share_url: string; score_pct: number }>;
    expect(entries[0].domain).toBe('anc.dev');
    expect(entries[0].score_pct).toBe(67);
    expect(entries[0].share_url).toBe('https://anc.dev/web/anc.dev');
  });

  test('an absent aggregate returns an empty list, not an error', async () => {
    const env = await makeEnv();
    const body = jsonContent(await callTool(env, 'list_website_audits', {}));
    expect(body.count).toBe(0);
    expect(body.entries).toEqual([]);
  });

  // The default view stays curated-only: user-submitted rows in R2 are never
  // enumerated, so an opted-in cached audit is absent unless view=all asks.
  test('view=curated (default) omits user rows even when opted-in ones exist in R2', async () => {
    const env = await makeEnv({
      cachePrefill: { [CURATED_AGGREGATE_KEY]: curatedAggregate(['first.dev']) },
      listPages: [[listedRow('opted-in.dev', true)]],
    });
    const body = jsonContent(await callTool(env, 'list_website_audits', {}));
    expect(body.count).toBe(1);
    expect((body.entries as Array<{ domain: string }>).map((e) => e.domain)).toEqual(['first.dev']);
  });

  // An opted-in user row surfaces under view=all — the point of the opt-in
  // listing — alongside the curated rows.
  test('an opted-in cached audit appears under view=all', async () => {
    const env = await makeEnv({
      cachePrefill: { [CURATED_AGGREGATE_KEY]: curatedAggregate(['first.dev']) },
      listPages: [[listedRow('opted-in.dev', true)]],
    });
    const body = jsonContent(await callTool(env, 'list_website_audits', { view: 'all' }));
    const domains = (body.entries as Array<{ domain: string }>).map((e) => e.domain);
    expect(domains).toContain('first.dev');
    expect(domains).toContain('opted-in.dev');
    expect(body.count).toBe(2);
  });

  // The shared opt-in predicate: a row that did not opt in (flag false or
  // absent) stays off view=all exactly as it does on /web.
  test('opted-out and flag-absent cached audits stay off view=all', async () => {
    const env = await makeEnv({
      cachePrefill: { [CURATED_AGGREGATE_KEY]: curatedAggregate(['first.dev']) },
      listPages: [[listedRow('opted-out.dev', false), listedRow('no-flag.dev')]],
    });
    const body = jsonContent(await callTool(env, 'list_website_audits', { view: 'all' }));
    expect((body.entries as Array<{ domain: string }>).map((e) => e.domain)).toEqual(['first.dev']);
  });

  // excludeDomains dedup: a domain that is both curated and present as a user
  // row in R2 appears exactly once (as curated), never twice.
  test('a curated domain does not appear twice under view=all', async () => {
    const env = await makeEnv({
      cachePrefill: { [CURATED_AGGREGATE_KEY]: curatedAggregate(['dup.dev']) },
      listPages: [[listedRow('dup.dev', true)]],
    });
    const body = jsonContent(await callTool(env, 'list_website_audits', { view: 'all' }));
    const domains = (body.entries as Array<{ domain: string }>).map((e) => e.domain);
    expect(domains.filter((d) => d === 'dup.dev')).toEqual(['dup.dev']);
    expect(body.count).toBe(1);
  });

  // Cross-surface parity: for one shared fixture, view=all's user-row set is
  // identical to /web?view=all's, because both build excludeDomains the same
  // way (aggregate domains unioned with the seed) and filter through the same
  // isBoardListable predicate. This is the divergence the unit exists to close.
  test('view=all returns the same user-row set as /web?view=all', async () => {
    const listPages: ListedObject[][] = [
      [listedRow('opted-in.dev', true), listedRow('opted-out.dev', false)],
      [listedRow('another-in.dev', true), listedRow('no-flag.dev')],
    ];
    const env = await makeEnv({
      cachePrefill: { [CURATED_AGGREGATE_KEY]: curatedAggregate(['anc.dev', 'curated-two.dev']) },
      listPages,
    });
    const curated = ['anc.dev', 'curated-two.dev'];

    const mcpBody = jsonContent(await callTool(env, 'list_website_audits', { view: 'all' }));
    const mcpUserRows = (mcpBody.entries as Array<{ domain: string }>)
      .map((e) => e.domain)
      .filter((d) => !curated.includes(d))
      .sort();

    const res = await handleWebLeaderboard(
      new Request('https://anc.dev/web.md?view=all'),
      env as unknown as WebAuditRouteEnv,
    );
    const webUserRows = onDemandDomainsFromMarkdown(await res.text()).sort();

    expect(mcpUserRows).toEqual(webUserRows);
    expect(mcpUserRows).toEqual(['another-in.dev', 'opted-in.dev']);
  });

  test('the tool description presents the board as curated + opted-in', async () => {
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
    const body = JSON.parse(await res.text()) as { result: { tools: Array<{ name: string; description: string }> } };
    const tool = body.result.tools.find((t) => t.name === 'list_website_audits');
    expect(tool?.description).toContain('curated + opted-in');
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
      cachePrefill: {
        [key]: {
          spec_version: SPEC_VERSION,
          target_url: 'https://example.com/',
          scorecard,
          scored_at: new Date().toISOString(),
        },
      },
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

  test('a warm cache hit carries the current category split (parity with the fresh path)', async () => {
    const key = await keyFor('https://example.com/', SPEC_VERSION);
    const env = await makeEnv({
      cachePrefill: {
        [key]: {
          spec_version: SPEC_VERSION,
          target_url: 'https://example.com/',
          scored_at: new Date().toISOString(),
          scorecard: {
            schema_version: '0.2',
            target_url: 'https://example.com/',
            score_pct: 50,
            categories: [{ id: 'mcp-api', name: 'MCP & API', passed: 1, counted: 2 }],
            results: [
              {
                id: 'openapi',
                category: 'mcp-api',
                keyword: 'must',
                status: 'absent',
                evidence: 'openapi.json -> 404',
              },
              { id: 'mcp-initialize', category: 'mcp-api', keyword: 'must', status: 'pass', evidence: 'ok' },
            ],
          },
        },
      },
    });
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, '203.0.113.9'));
    const scorecard = body.scorecard as {
      categories: Array<{ id: string }>;
      results: Array<{ id: string; category: string }>;
    };
    expect(scorecard.categories.map((c) => c.id)).not.toContain('mcp-api');
    expect(scorecard.results.find((r) => r.id === 'openapi')?.category).toBe('api');
    expect(scorecard.results.find((r) => r.id === 'mcp-initialize')?.category).toBe('mcp');
  });
});

describe('cross-tool result parity', () => {
  test('get_website_audit and audit_website return a byte-identical scorecard object for the same stored entry', async () => {
    const key = await keyFor('https://example.com/', SPEC_VERSION);
    const stored = {
      schema_version: '0.2',
      target_url: 'https://example.com/',
      score_pct: 55,
      score: { relative: 55, global: 44 },
      summary: { pass: 1, broken: 1, absent: 1, n_a: 0, skip: 0, error: 0 },
      categories: [{ id: 'mcp-api', name: 'MCP & API', passed: 1, counted: 3 }],
      results: [
        { id: 'openapi', category: 'mcp-api', keyword: 'must', status: 'absent', evidence: 'openapi.json -> 404' },
        { id: 'mcp-tools-list', category: 'mcp-api', keyword: 'should', status: 'broken', evidence: 'no tools' },
        { id: 'llms-txt', category: 'mcp-api', keyword: 'should', status: 'pass', evidence: 'llms.txt -> 200' },
      ],
    };
    const env = await makeEnv({
      cachePrefill: {
        [key]: {
          spec_version: SPEC_VERSION,
          target_url: 'https://example.com/',
          scored_at: new Date().toISOString(),
          scorecard: stored,
        },
      },
    });
    const getBody = jsonContent(await callTool(env, 'get_website_audit', { url: 'example.com' }));
    const auditBody = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, '203.0.113.9'));
    // The scorecard payload is identical across the two tools; the
    // enclosing envelopes (found/share_url vs audited/source) differ.
    expect(getBody.scorecard).toEqual(auditBody.scorecard);
    expect(getBody.found).toBe(true);
    expect(auditBody.source).toBe('cache');
  });
});

// The audit_website tool mirrors the POST /api/audit-web inbound semantics —
// a store-owning bucket lets these assert no-write and read the patched
// envelope directly. The re-audit engine path stays e2e-smoke-only (this
// file's header), so the stale rows are asserted at the routing level (they
// fall through to the same gate chain a fresh MCP audit passes).
describe('audit_website public_listing', () => {
  const TARGET = 'https://example.com/';
  const IP = '203.0.113.7';
  const freshStamp = () => new Date().toISOString();
  const staleStamp = () => new Date(Date.now() - 10 * 60_000).toISOString();

  async function seed(store: Map<string, string>, opts: { scoredAt: string; stored?: boolean }): Promise<string> {
    const key = await keyFor(TARGET, SPEC_VERSION);
    const scorecard: Record<string, unknown> = {
      schema_version: '0.2',
      target_url: TARGET,
      score_pct: 64,
      results: [],
    };
    if (opts.stored !== undefined) scorecard.public_listing = opts.stored;
    store.set(
      key,
      JSON.stringify({ spec_version: SPEC_VERSION, target_url: TARGET, scorecard, scored_at: opts.scoredAt }),
    );
    return key;
  }

  async function envWithStore(store: Map<string, string>, opts: WebEnvOpts = {}): Promise<McpEnv> {
    const env = await makeEnv(opts);
    (env as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = makeBucket(store);
    return env;
  }

  test('omitted param serves cached, does not erase a stored true, and writes nothing', async () => {
    const store = new Map<string, string>();
    const key = await seed(store, { scoredAt: freshStamp(), stored: true });
    const before = store.get(key);
    const env = await envWithStore(store);
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, IP));
    expect(body.audited).toBe(false);
    expect(body.source).toBe('cache');
    expect((body.scorecard as { public_listing: boolean }).public_listing).toBe(true);
    expect(store.get(key)).toBe(before);
  });

  test('fresh hit + stored false + explicit true patches to true, preserves scored_at, behind gates', async () => {
    const store = new Map<string, string>();
    const scoredAt = freshStamp();
    const key = await seed(store, { scoredAt, stored: false });
    const env = await envWithStore(store);
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com', public_listing: true }, IP));
    expect((body.scorecard as { public_listing: boolean }).public_listing).toBe(true);
    expect(body.share_url).toBe('https://anc.dev/web/example.com');
    const stored = JSON.parse(store.get(key) as string) as {
      scorecard: { public_listing: boolean };
      scored_at: string;
    };
    expect(stored.scorecard.public_listing).toBe(true);
    expect(stored.scored_at).toBe(scoredAt);
  });

  test('fresh hit + stored true + explicit true serves cached (redundant, no write)', async () => {
    const store = new Map<string, string>();
    const key = await seed(store, { scoredAt: freshStamp(), stored: true });
    const before = store.get(key);
    const env = await envWithStore(store);
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com', public_listing: true }, IP));
    expect(body.source).toBe('cache');
    expect(store.get(key)).toBe(before);
  });

  test('kill switch off blocks an explicit-differing fresh patch: no write, unpatched served', async () => {
    const store = new Map<string, string>();
    const key = await seed(store, { scoredAt: freshStamp(), stored: false });
    const before = store.get(key);
    const env = await envWithStore(store, { webEnabled: false });
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com', public_listing: true }, IP));
    expect(body.source).toBe('cache');
    expect((body.scorecard as { public_listing: boolean }).public_listing).toBe(false);
    expect(store.get(key)).toBe(before);
  });

  test('a breached limiter blocks the patch (rate-limit error, no write)', async () => {
    const store = new Map<string, string>();
    const key = await seed(store, { scoredAt: freshStamp(), stored: false });
    const before = store.get(key);
    const env = await envWithStore(store, { limiterOk: false });
    const res = await callTool(env, 'audit_website', { url: 'example.com', public_listing: true }, IP);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text ?? '').toContain('rate limit');
    expect(store.get(key)).toBe(before);
  });

  test('a failed patch write surfaces a tool error, not fabricated success', async () => {
    const store = new Map<string, string>();
    await seed(store, { scoredAt: freshStamp(), stored: false });
    const env = await makeEnv();
    const bucket = makeBucket(store);
    (env as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = {
      get: bucket.get.bind(bucket),
      async put() {
        throw new Error('r2 unavailable');
      },
      delete: bucket.delete.bind(bucket),
    } as unknown as R2Bucket;
    const res = await callTool(env, 'audit_website', { url: 'example.com', public_listing: true }, IP);
    expect(res.result?.isError).toBe(true);
    expect((res.result?.content?.[0]?.text ?? '').toLowerCase()).toContain('public_listing');
  });

  test('stale hit + explicit differing falls through to the gate chain (re-audit routing, not serve-cached)', async () => {
    const store = new Map<string, string>();
    const key = await seed(store, { scoredAt: staleStamp(), stored: true });
    const before = store.get(key);
    const env = await envWithStore(store, { limiterOk: false });
    const res = await callTool(env, 'audit_website', { url: 'example.com', public_listing: false }, IP);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text ?? '').toContain('rate limit');
    // No patch on the stale path: the object is untouched (a re-audit would
    // rewrite it only after the gate chain, which the breached limiter blocks).
    expect(store.get(key)).toBe(before);
  });

  test('stale hit + omit falls through to the gate chain (re-audit carries prior, not serve-cached)', async () => {
    const store = new Map<string, string>();
    await seed(store, { scoredAt: staleStamp(), stored: true });
    const env = await envWithStore(store, { limiterOk: false });
    const res = await callTool(env, 'audit_website', { url: 'example.com' }, IP);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text ?? '').toContain('rate limit');
  });

  test('a non-boolean public_listing is rejected by input validation', async () => {
    const store = new Map<string, string>();
    const key = await seed(store, { scoredAt: freshStamp(), stored: false });
    const before = store.get(key);
    const env = await envWithStore(store);
    for (const bad of ['false', 1, null] as const) {
      const res = await callTool(env, 'audit_website', { url: 'example.com', public_listing: bad }, IP);
      expect(res.result?.isError).toBe(true);
      expect(res.result?.content?.[0]?.text ?? '').toContain('public_listing');
    }
    // A rejected request never writes.
    expect(store.get(key)).toBe(before);
  });

  test('audit_website and get_website_audit both surface the stored public_listing', async () => {
    const store = new Map<string, string>();
    await seed(store, { scoredAt: freshStamp(), stored: true });
    const env = await envWithStore(store);
    const readBody = jsonContent(await callTool(env, 'get_website_audit', { url: 'example.com' }));
    const auditBody = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, IP));
    expect((readBody.scorecard as { public_listing: boolean }).public_listing).toBe(true);
    expect((auditBody.scorecard as { public_listing: boolean }).public_listing).toBe(true);
  });
});

// The per-domain flip budget is enforced inside the shared flag-resolution
// helper both surfaces call, so the MCP tool and the web route draw from one
// budget per domain. These tests use Map-backed R2 + KV so the stored flag and
// the budget accumulate across calls.
describe('audit_website public_listing flip budget', () => {
  const TARGET = 'https://example.com/';
  const IP = '203.0.113.12';
  const freshStamp = () => new Date().toISOString();

  function makeKvStore(store: Map<string, string>): KVNamespace {
    return {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
    } as unknown as KVNamespace;
  }

  async function seed(store: Map<string, string>, stored: boolean, scoredAt: string): Promise<string> {
    const key = await keyFor(TARGET, SPEC_VERSION);
    const scorecard = { schema_version: '0.2', target_url: TARGET, score_pct: 64, results: [], public_listing: stored };
    store.set(key, JSON.stringify({ spec_version: SPEC_VERSION, target_url: TARGET, scorecard, scored_at: scoredAt }));
    return key;
  }

  test('flips within budget patch; the sixth returns a flip_rate_limited tool error and writes nothing', async () => {
    const r2 = new Map<string, string>();
    const kv = new Map<string, string>();
    const key = await seed(r2, false, freshStamp());
    const env = await makeEnv();
    (env as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = makeBucket(r2);
    (env as { SCORE_KV: KVNamespace }).SCORE_KV = makeKvStore(kv);
    for (let i = 0; i < 5; i++) {
      const want = i % 2 === 0;
      const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com', public_listing: want }, IP));
      expect((body.scorecard as { public_listing: boolean }).public_listing).toBe(want);
    }
    const afterFive = r2.get(key);
    const res = await callTool(env, 'audit_website', { url: 'example.com', public_listing: false }, IP);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text ?? '').toContain('flip_rate_limited');
    // Rejected before the write: the stored object is untouched.
    expect(r2.get(key)).toBe(afterFive);
  });

  test('a budget exhausted through the web route blocks the MCP tool for the same domain', async () => {
    const r2 = new Map<string, string>();
    const kv = new Map<string, string>();
    const key = await seed(r2, false, freshStamp());
    const alwaysPass = { limit: async () => ({ success: true }) };
    const turnstileFetch = (async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const throwingProbe = (() => {
      throw new Error('engine must not run on a flag-only patch');
    }) as unknown as typeof fetch;
    const makeCtx = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;
    // The web-route patch path needs no ASSETS or registry, only shared R2 + KV.
    const webEnv = {
      ASSETS: {
        async fetch() {
          return new Response('not found', { status: 404 });
        },
      } as unknown as Fetcher,
      SCORE_CACHE: makeBucket(r2),
      SCORE_KV: makeKvStore(kv),
      WEB_AUDIT_ENABLED: 'true',
      TURNSTILE_SECRET: 'test-turnstile-secret',
      SESSION_HMAC_SECRET: 'test-session-secret',
      WEB_AUDIT_LIMITER: alwaysPass,
      WEB_AUDIT_LIMITER_IP: alwaysPass,
    } as unknown as WebAuditRouteEnv;
    // Exhaust the budget through the web route (five flips, F -> T, F, T, F, T).
    for (let i = 0; i < 5; i++) {
      const req = new Request('https://anc.dev/api/audit-web', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.13' },
        body: JSON.stringify({ url: 'example.com', turnstile_token: 'x', public_listing: i % 2 === 0 }),
      });
      const resp = await handleWebAudit(req, webEnv, makeCtx(), { turnstileFetch, probeFetch: throwingProbe });
      expect(resp.status).toBe(200);
    }
    // The MCP tool (fresh IP, same domain) draws from the same exhausted
    // per-domain budget: its sixth flip is rejected and writes nothing.
    const mcpEnv = await makeEnv();
    (mcpEnv as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = makeBucket(r2);
    (mcpEnv as { SCORE_KV: KVNamespace }).SCORE_KV = makeKvStore(kv);
    const before = r2.get(key);
    const res = await callTool(mcpEnv, 'audit_website', { url: 'example.com', public_listing: false }, '203.0.113.14');
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text ?? '').toContain('flip_rate_limited');
    expect(r2.get(key)).toBe(before);
  });
});
