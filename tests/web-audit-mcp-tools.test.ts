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
import { getWorksheet } from '../src/client/webmcp-result';
import type { AuditEvent } from '../src/shared/audit-events';
import type { AuditJob } from '../src/worker/audit/job';
import { _resetResultCaches, handleResultRoute, type ResultEnv } from '../src/worker/audit/result';
import { resolveBoardEntries, type WebBoardEnv } from '../src/worker/audit-web/board';
import { keyFor, WEB_AUDIT_STALE_AFTER_MS } from '../src/worker/audit-web/cache';
import type { DomainBudgetEnv } from '../src/worker/audit-web/domain-budget';
import { FOLLOW_DISCLOSURE, FOLLOW_DISCLOSURE_SHORT } from '../src/worker/audit-web/follow-disclosure';
import { flushHitMinPurge, runWithHitMinPurge } from '../src/worker/audit-web/hit-min-purge';
import {
  registryFingerprintPrefix,
  resetWebAuditRegistryCacheForTests,
  type WebAuditRegistry,
} from '../src/worker/audit-web/registry';
import { buildWebSummaryMarkdown } from '../src/worker/audit-web/summary-markdown';
import { buildWebSummaryBody } from '../src/worker/audit-web/summary-render';
import { resetCatalogCacheForTests } from '../src/worker/mcp/catalog';
import type { McpEnv } from '../src/worker/mcp/server';
import { resetWebRemediationCacheForTests } from '../src/worker/mcp/tools/web-remediation';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';
import { webRegistryJson } from './helpers/audit-api-env';
import { countClaims, fakeJobNamespace } from './helpers/audit-job-state';
import {
  at,
  REGISTRY,
  REMEDIATION,
  row,
  scorecardOf,
  stripeShaped,
  twoAnchorShaped,
} from './helpers/declared-host-scorecards';
import { budgetKeyPrefix, memoryKv, memoryRateLimit } from './helpers/domain-budget-fakes';
import { aiCatalog, cardEntry, html, requestsTo, router, type Seen, sep2127Card } from './helpers/follow-fixtures';
import { parseHtml } from './helpers/html-elements';
import { withLogCapture } from './helpers/log-capture';
import { getJsonToolContent, type JsonRpcBody, mcpInitialize, mcpRpc, resetMcpTestState } from './helpers/mcp-rpc';
import { fakeRender } from './helpers/og-site-fakes';
import { stubFetch } from './helpers/stub-fetch';
import { webRecordBucket } from './helpers/web-record-bucket';

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
      Object.keys(registry.retired ?? {}),
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

// Zero checks and no discovery paths: the real engine completes after the
// single (stubbed) root fetch, so the fresh audit_website path runs offline.
const MINIMAL_REGISTRY = {
  version: 1,
  mcp_discovery: {
    ai_catalog: '/.well-known/ai-catalog.json',
    card_suffix: '/server-card',
    well_known: [],
    common_paths: [],
    protocol_version: '2025-06-18',
  },
  category_order: [],
  categories: {},
  checks: [],
};

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
  // Serve the zero-check registry so a fresh audit finishes without probing.
  minimalRegistry?: boolean;
  kvSeed?: Record<string, string>;
  /** Receives the key of every SCORE_KV write. */
  kvPuts?: string[];
  jobs?: DurableObjectNamespace<AuditJob>;
  /** The WEB_AUDIT_FOLLOW_ENABLED value; absent leaves the binding unset. */
  followSwitch?: string;
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
          if (opts.failRegistry) return new Response('boom', { status: 500 });
          return ok(opts.minimalRegistry ? JSON.stringify(MINIMAL_REGISTRY) : registry);
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
      async get(key: string) {
        return opts.kvSeed?.[key] ?? null;
      },
      async put(key: string) {
        opts.kvPuts?.push(key);
      },
      async delete() {},
    } as unknown as KVNamespace,
    AUDIT_JOB: opts.jobs,
    WEB_AUDIT_ENABLED: (opts.webEnabled ?? true) ? 'true' : undefined,
    WEB_AUDIT_FOLLOW_ENABLED: opts.followSwitch,
    MCP_ENABLED: (opts.mcpEnabled ?? true) ? 'true' : undefined,
    WEB_AUDIT_LIMITER_IP: {
      async limit() {
        return { success: opts.limiterOk ?? true };
      },
    },
  } as unknown as McpEnv;
}

type JsonRpcResult = {
  result?: {
    content?: Array<{ text: string }>;
    isError?: boolean;
    tools?: Array<{ name: string; description?: string }>;
  };
  error?: { code: number; message: string };
};

async function callTool(env: McpEnv, name: string, args: Record<string, unknown>, ip?: string): Promise<JsonRpcResult> {
  await mcpInitialize(env);

  const callHeaders: Record<string, string> = {};
  if (ip) callHeaders['cf-connecting-ip'] = ip;

  const { status, body } = await mcpRpc(
    env,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    callHeaders,
  );
  expect(status).toBe(200);
  return body as JsonRpcResult;
}

function jsonContent(body: JsonRpcResult): Record<string, unknown> {
  return getJsonToolContent(body as JsonRpcBody) as Record<string, unknown>;
}

beforeEach(() => {
  resetMcpTestState();
  resetWebAuditRegistryCacheForTests();
  resetWebRemediationCacheForTests();
});
afterEach(() => {
  resetMcpTestState();
  resetCatalogCacheForTests();
  resetWebAuditRegistryCacheForTests();
  resetWebRemediationCacheForTests();
});

describe('get_website_audit', () => {
  test('cache hit returns found:true with the result envelope and its three URLs', async () => {
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
    expect(body).toMatchObject({
      kind: 'web',
      tier: 'cache',
      target: 'example.com',
      scorecard_url: 'https://anc.dev/score/example.com',
      markdown_url: 'https://anc.dev/score/example.com/md',
      json_url: 'https://anc.dev/score/example.com/json',
    });
    expect(body).not.toHaveProperty('share_url');
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
    expect(byId.get('openapi')?.remediation?.skill_url).toBe('https://anc.dev/fix/openapi');

    expect(byId.get('mcp-tools-list')?.result).toContain('Present but broken');
    expect(byId.get('mcp-tools-list')?.remediation?.skill_url).toBe('https://anc.dev/fix/mcp-tools-list');

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
    expect(byId.get('openapi')?.remediation?.skill_url).toBe('https://anc.dev/fix/openapi');
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

  test('missing cf-connecting-ip returns the rate-limit envelope with -32099 (no anon fallback)', async () => {
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
describe('list_website_audits', () => {
  test('returns board summaries from the leaderboard aggregate with scorecard_urls', async () => {
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
    const entries = body.entries as Array<{ domain: string; scorecard_url: string; score_pct: number }>;
    expect(entries[0].domain).toBe('anc.dev');
    expect(entries[0].score_pct).toBe(67);
    expect(entries[0].scorecard_url).toBe('https://anc.dev/score/anc.dev');
    expect(entries[0]).not.toHaveProperty('share_url');
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

    // The board's own resolver is the other side of the comparison: both the
    // rendered board and this tool read their non-curated rows from it, so a
    // divergence here is a divergence on the page.
    const board = await resolveBoardEntries(env as unknown as WebBoardEnv, 'all');
    const boardUserRows = board.entries
      .filter((e) => !e.curated)
      .map((e) => e.domain)
      .sort();

    expect(mcpUserRows).toEqual(boardUserRows);
    expect(mcpUserRows).toEqual(['another-in.dev', 'opted-in.dev']);
  });

  test('the tool description presents the board as curated + opted-in', async () => {
    const env = await makeEnv();
    const { body } = await mcpRpc(env, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    const tools = body.result?.tools as Array<{ name: string; description: string }> | undefined;
    const tool = tools?.find((t) => t.name === 'list_website_audits');
    expect(tool?.description).toContain('curated + opted-in');
  });
});

describe('tool registration', () => {
  test('all five web tools appear in tools/list after the existing tools', async () => {
    const env = await makeEnv();
    const { body } = await mcpRpc(env, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    const names = (body.result?.tools as Array<{ name: string }> | undefined)?.map((t) => t.name) ?? [];
    for (const name of [
      'audit_website',
      'get_website_audit',
      'list_website_audits',
      'set_website_public_listing',
      'get_web_remediation',
    ]) {
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
    expect(remediation.skill_url).toBe('https://anc.dev/fix/openapi');
    expect(Array.isArray(remediation.resources)).toBe(true);
    expect(String(remediation.prompt)).toContain('Goal: ');
  });

  test('caller-supplied evidence is appended as a delimited block, not as instruction prose', async () => {
    const env = await makeEnv();
    const body = jsonContent(
      await callTool(env, 'get_web_remediation', { check_id: 'openapi', evidence: 'x.dev/openapi.json -> 404' }),
    );
    const remediation = body.remediation as { prompt: string };
    expect(remediation.prompt).toContain('--- begin evidence ---\nx.dev/openapi.json -> 404\n--- end evidence ---');
    // Omitting it leaves the catalog text alone.
    const bare = jsonContent(await callTool(env, 'get_web_remediation', { check_id: 'openapi' }));
    expect((bare.remediation as { prompt: string }).prompt).not.toContain('begin evidence');
  });

  test('an unknown check id returns found:false', async () => {
    const env = await makeEnv();
    const body = jsonContent(await callTool(env, 'get_web_remediation', { check_id: 'nope' }));
    expect(body.found).toBe(false);
  });

  test('a check id that names an inherited object property returns found:false', async () => {
    for (const check_id of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const env = await makeEnv();
      const result = await callTool(env, 'get_web_remediation', { check_id });
      expect((result.result as { isError?: boolean }).isError).not.toBe(true);
      const body = jsonContent(result);
      expect(body.found).toBe(false);
      expect(body.message).toBe(`no remediation for check id: ${check_id}`);
    }
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
    // The evidence rides the result line; the prompt is site-owned
    // catalog text and carries no target-controlled string (R19).
    expect(absent?.result).toContain('Not found (https://example.com/openapi.json -> 404)');
    expect(absent?.remediation?.skill_url).toBe('https://anc.dev/fix/openapi');
    expect(absent?.remediation?.prompt).toContain('--- begin evidence ---');
    expect(absent?.remediation?.prompt?.split('Observed (')[0]).not.toContain('openapi.json -> 404');

    const broken = byId.get('mcp-tools-list');
    expect(broken?.result).toContain('Present but broken (no tools array)');
    expect(broken?.remediation?.prompt?.split('Observed (')[0]).not.toContain('no tools array');

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

// audit_website runs or returns an audit and never changes a site's listing.
// A call that still sends public_listing, or any other argument the tool does
// not declare, is refused by input validation before a gate, an audit, or a
// limit unit is spent. The routing of a stale record is asserted at the gate
// chain; a fresh audit runs offline against a stubbed fetch.
describe('audit_website never changes the listing', () => {
  const TARGET = 'https://example.com/';
  const IP = '203.0.113.7';
  const freshStamp = () => new Date().toISOString();
  const staleStamp = () => new Date(Date.now() - 10 * 60_000).toISOString();

  function record(scoredAt: string, stored?: boolean) {
    const scorecard: Record<string, unknown> = {
      schema_version: '0.2',
      target_url: TARGET,
      score_pct: 64,
      results: [],
    };
    if (stored !== undefined) scorecard.public_listing = stored;
    return { spec_version: SPEC_VERSION, target_url: TARGET, scorecard, scored_at: scoredAt };
  }

  // An env over a bucket holding the example.com record, with the units the
  // call takes counted: the burst limiter, KV writes, and outbound requests.
  async function metered(opts: { scoredAt?: string; stored?: boolean } & WebEnvOpts = {}) {
    const { scoredAt, stored, ...envOpts } = opts;
    const bucket = webRecordBucket();
    if (scoredAt !== undefined) await bucket.set(TARGET, record(scoredAt, stored));
    const kvPuts: string[] = [];
    const env = await makeEnv({ ...envOpts, kvPuts });
    let burstTakes = 0;
    Object.assign(env, {
      SCORE_CACHE: bucket.bucket,
      WEB_AUDIT_LIMITER_IP: {
        async limit() {
          burstTakes += 1;
          return { success: true };
        },
      },
    });
    return { env, bucket, kvPuts, burstTakes: () => burstTakes };
  }

  async function offline<T>(fn: () => Promise<T>): Promise<{ result: T; requests: number }> {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    try {
      return { result: await fn(), requests };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test('omitted param serves cached, does not erase a stored true, and writes nothing', async () => {
    const { env, bucket } = await metered({ scoredAt: freshStamp(), stored: true });
    const before = (await bucket.recordOf(TARGET)) as unknown;
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, IP));
    expect(body.audited).toBe(false);
    expect(body.source).toBe('cache');
    expect((body.scorecard as { public_listing: boolean }).public_listing).toBe(true);
    expect(bucket.puts).toEqual([]);
    expect(await bucket.recordOf(TARGET)).toEqual(before as never);
  });

  test('public_listing on a fresh record is refused by name, and the store and every limit stay as they were', async () => {
    const { env, bucket, kvPuts, burstTakes } = await metered({ scoredAt: freshStamp(), stored: false });
    const before = bucket.objects.get(await keyFor(TARGET, SPEC_VERSION));
    const res = await callTool(env, 'audit_website', { url: 'example.com', public_listing: true }, IP);
    expect(res.result?.isError).toBe(true);
    const text = res.result?.content?.[0]?.text ?? '';
    expect(text).toContain('public_listing is not an audit_website argument');
    expect(text).toContain('set_website_public_listing');
    expect(bucket.objects.get(await keyFor(TARGET, SPEC_VERSION))).toEqual(before);
    expect(bucket.puts).toEqual([]);
    expect(kvPuts).toEqual([]);
    expect(burstTakes()).toBe(0);
  });

  test('public_listing on a stale record is refused with the same text, and no request leaves anc', async () => {
    const { env, bucket, kvPuts, burstTakes } = await metered({ scoredAt: staleStamp(), stored: true });
    const { result, requests } = await offline(() =>
      callTool(env, 'audit_website', { url: 'example.com', public_listing: false }, IP),
    );
    expect(result.result?.isError).toBe(true);
    expect(result.result?.content?.[0]?.text ?? '').toContain('set_website_public_listing');
    expect(requests).toBe(0);
    expect(bucket.puts).toEqual([]);
    expect(kvPuts).toEqual([]);
    expect(burstTakes()).toBe(0);
  });

  test('every value of public_listing is refused, a non-boolean one included', async () => {
    const { env, bucket } = await metered({ scoredAt: freshStamp(), stored: false });
    for (const value of [true, false, 'false', 1, null]) {
      const res = await callTool(env, 'audit_website', { url: 'example.com', public_listing: value }, IP);
      expect(res.result?.isError).toBe(true);
      expect(res.result?.content?.[0]?.text ?? '').toContain('set_website_public_listing');
    }
    expect(bucket.puts).toEqual([]);
  });

  test('public_listing beside another undeclared key shows only the public_listing message', async () => {
    const { env } = await metered({ scoredAt: freshStamp(), stored: false });
    const res = await callTool(env, 'audit_website', { url: 'example.com', public_listing: true, siteType: 'x' }, IP);
    expect(res.result?.isError).toBe(true);
    const text = res.result?.content?.[0]?.text ?? '';
    expect(text).toContain('set_website_public_listing');
    expect(text).not.toContain('siteType');
  });

  test('any other undeclared argument is refused by input validation, and nothing is spent', async () => {
    const { env, kvPuts, burstTakes } = await metered({ scoredAt: staleStamp(), stored: false });
    const res = await callTool(env, 'audit_website', { url: 'example.com', siteType: 'content' }, IP);
    expect(res.result?.isError).toBe(true);
    const text = res.result?.content?.[0]?.text ?? '';
    expect(text).toContain('siteType');
    expect(text).not.toContain('set_website_public_listing');
    expect(kvPuts).toEqual([]);
    expect(burstTakes()).toBe(0);
  });

  test('stale hit + omit falls through to the gate chain (re-audit carries prior, not serve-cached)', async () => {
    const { env } = await metered({ scoredAt: staleStamp(), stored: true, limiterOk: false });
    Object.assign(env, { WEB_AUDIT_LIMITER_IP: { limit: async () => ({ success: false }) } });
    const res = await callTool(env, 'audit_website', { url: 'example.com' }, IP);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text ?? '').toContain('rate limit');
  });

  test('a first-ever audit saves the site unlisted, in the body and in the board metadata', async () => {
    const { env, bucket } = await metered({ minimalRegistry: true });
    await offline(() => withLogCapture(() => callTool(env, 'audit_website', { url: 'example.com' }, IP)));
    expect((await bucket.recordOf(TARGET))?.scorecard.public_listing).toBe(false);
    expect((await bucket.metadataOf(TARGET))?.public_listing).toBe('false');
  });

  test('a later audit keeps a stored listing, in the body and in the board metadata', async () => {
    const { env, bucket } = await metered({ minimalRegistry: true, scoredAt: staleStamp(), stored: true });
    await offline(() => withLogCapture(() => callTool(env, 'audit_website', { url: 'example.com' }, IP)));
    expect((await bucket.recordOf(TARGET))?.scorecard.public_listing).toBe(true);
    expect((await bucket.metadataOf(TARGET))?.public_listing).toBe('true');
  });

  test('a listing stored while the audit runs is the listing the save keeps', async () => {
    const { env, bucket } = await metered({ minimalRegistry: true, scoredAt: staleStamp(), stored: true });
    const originalFetch = globalThis.fetch;
    let rewrote = false;
    globalThis.fetch = (async () => {
      if (!rewrote) {
        rewrote = true;
        await bucket.set(TARGET, record(staleStamp(), false));
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    let body: Record<string, unknown>;
    try {
      body = jsonContent(
        (await withLogCapture(() => callTool(env, 'audit_website', { url: 'example.com' }, IP))).result,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(rewrote).toBe(true);
    expect(body.audited).toBe(true);
    expect((body.scorecard as { public_listing: boolean }).public_listing).toBe(false);
    expect((await bucket.recordOf(TARGET))?.scorecard.public_listing).toBe(false);
    expect((await bucket.metadataOf(TARGET))?.public_listing).toBe('false');
  });

  test('tools/list: audit_website declares no public_listing and says an audit never lists', async () => {
    const env = await makeEnv();
    const { body } = await mcpRpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const tools = (body.result?.tools ?? []) as Array<{
      name: string;
      description?: string;
      inputSchema: { properties: Record<string, unknown> };
    }>;
    const tool = tools.find((t) => t.name === 'audit_website');
    expect(tool?.inputSchema.properties).not.toHaveProperty('public_listing');
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['url', 'site_type', 'follow_declarations']);
    expect(tool?.description).toContain(
      `${FOLLOW_DISCLOSURE_SHORT} An audit never changes the site's leaderboard listing: a first audit saves the site unlisted, and later audits keep the stored choice; set_website_public_listing changes it.`,
    );
  });
});

// R10-R14 on the regular MCP surface. Every scorecard-bearing result carries
// `cached`, `scored_at`, and `refresh_after` beside the scorecard, byte-identical
// to what the browser API returns for the same stored state; misses,
// disabled-without-cache, and gate errors carry none.
// AE5 (R17, R18): the JSON representation and the MCP read tool are the same
// envelope over the same record. Deep equality is the assertion, not a field
// list: a new field on one surface has to reach the other or this fails.
describe('AE5: get_website_audit and /score/<host>/json are one envelope', () => {
  const HOST = 'example.com';

  test('both surfaces return deep-equal scorecard, freshness, and result URLs for one stored record', async () => {
    const key = await keyFor(`https://${HOST}/`, SPEC_VERSION);
    const record = {
      spec_version: SPEC_VERSION,
      target_url: `https://${HOST}/`,
      scored_at: '2026-09-10T20:00:00.000Z',
      scorecard: {
        schema_version: '0.2',
        target_url: `https://${HOST}/`,
        score_pct: 64,
        score: { relative: 82, global: 64 },
        results: [
          { id: 'llms-txt', status: 'pass', label: 'llms.txt', evidence: '200' },
          { id: 'openapi', status: 'absent', label: 'OpenAPI', evidence: 'no /openapi.json' },
        ],
      },
    };
    const env = await makeEnv({ cachePrefill: { [key]: record } });

    const tool = jsonContent(await callTool(env, 'get_website_audit', { url: HOST }));

    _resetResultCaches();
    const res = await handleResultRoute(new Request(`https://anc.dev/score/${HOST}/json`), env as unknown as ResultEnv);
    expect(res.status).toBe(200);
    const route = (await res.json()) as Record<string, unknown>;

    expect(tool.scorecard).toEqual(route.scorecard);
    expect(tool.freshness).toEqual(route.freshness);
    expect({
      kind: tool.kind,
      tier: tool.tier,
      target: tool.target,
      scorecard_url: tool.scorecard_url,
      markdown_url: tool.markdown_url,
      json_url: tool.json_url,
      spec_version: tool.spec_version,
      score_pct: tool.score_pct,
    }).toEqual({
      kind: route.kind,
      tier: route.tier,
      target: route.target,
      scorecard_url: route.scorecard_url,
      markdown_url: route.markdown_url,
      json_url: route.json_url,
      spec_version: route.spec_version,
      score_pct: route.score_pct,
    });
    // The equality is over an enriched body, not two empty ones: the row the
    // run marked absent carries its fix on both surfaces.
    const rows = (tool.scorecard as { results: Array<{ id: string; remediation?: { skill_url: string } }> }).results;
    expect(rows.find((r) => r.id === 'openapi')?.remediation?.skill_url).toBe('https://anc.dev/fix/openapi');
  });
});

describe('web-audit MCP freshness envelope', () => {
  const TARGET = 'https://example.com/';
  const IP = '203.0.113.21';

  // Derived from the shared window constant, not a literal: the cache test
  // owns the one assertion that pins the window's value.
  const refreshAfter = (scoredAt: string) => new Date(Date.parse(scoredAt) + WEB_AUDIT_STALE_AFTER_MS).toISOString();

  type Freshness = { cached: unknown; scored_at: unknown; refresh_after: unknown };
  const freshnessOf = (body: Record<string, unknown>): Freshness => body.freshness as Freshness;

  function storedEntry(opts: { scoredAt?: string; stored?: boolean } = {}): string {
    const scorecard: Record<string, unknown> = {
      schema_version: '0.2',
      target_url: TARGET,
      score_pct: 64,
      results: [],
    };
    if (opts.stored !== undefined) scorecard.public_listing = opts.stored;
    const entry: Record<string, unknown> = { spec_version: SPEC_VERSION, target_url: TARGET, scorecard };
    if (opts.scoredAt !== undefined) entry.scored_at = opts.scoredAt;
    return JSON.stringify(entry);
  }

  async function envWith(opts: { scoredAt?: string; stored?: boolean } & WebEnvOpts = {}) {
    const { scoredAt, stored, ...envOpts } = opts;
    const store = new Map<string, string>();
    const key = await keyFor(TARGET, SPEC_VERSION);
    store.set(key, storedEntry({ scoredAt, stored }));
    const env = await makeEnv(envOpts);
    (env as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = makeBucket(store);
    return { env, store, key };
  }

  test('get_website_audit reports cached:true with the stored instant and a refresh one stale window later', async () => {
    const scoredAt = new Date().toISOString();
    const { env } = await envWith({ scoredAt });
    const body = jsonContent(await callTool(env, 'get_website_audit', { url: 'example.com' }));
    expect(body.found).toBe(true);
    expect(freshnessOf(body)).toEqual({ cached: true, scored_at: scoredAt, refresh_after: refreshAfter(scoredAt) });
  });

  // AE8.
  test('get_website_audit reports null instants for a legacy entry', async () => {
    for (const scoredAt of [undefined, '', 'not-a-date']) {
      const { env } = await envWith({ scoredAt });
      const body = jsonContent(await callTool(env, 'get_website_audit', { url: 'example.com' }));
      expect(body.found).toBe(true);
      expect(freshnessOf(body)).toEqual({ cached: true, scored_at: null, refresh_after: null });
    }
  });

  test('get_website_audit misses carry no freshness fields', async () => {
    const env = await makeEnv();
    const body = jsonContent(await callTool(env, 'get_website_audit', { url: 'never-seen.dev' }));
    expect(body.found).toBe(false);
    expect(body).not.toHaveProperty('cached');
    expect(body).not.toHaveProperty('freshness');
  });

  test('audit_website serve-cached reports cached:true with the stored instant', async () => {
    const scoredAt = new Date().toISOString();
    const { env } = await envWith({ scoredAt });
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, IP));
    expect(body.source).toBe('cache');
    expect(freshnessOf(body)).toEqual({ cached: true, scored_at: scoredAt, refresh_after: refreshAfter(scoredAt) });
  });

  // AE7.
  test('audit_website serves a stale hit while disabled with a refresh_after in the past', async () => {
    const scoredAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const { env } = await envWith({ scoredAt, webEnabled: false });
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, IP));
    expect(body.source).toBe('cache');
    expect(freshnessOf(body)).toEqual({ cached: true, scored_at: scoredAt, refresh_after: refreshAfter(scoredAt) });
    expect(Date.parse(freshnessOf(body).refresh_after as string)).toBeLessThan(Date.now());
  });

  // AE6 on the MCP surface: one scoring instant reaches both R2 and the response.
  test('a fresh audit_website completion reports cached:false and the exact instant persisted to R2', async () => {
    const store = new Map<string, string>();
    const env = await makeEnv({ minimalRegistry: true });
    (env as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = makeBucket(store);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    let body: Record<string, unknown>;
    try {
      body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, IP));
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(body.audited).toBe(true);
    expect(body.source).toBe('fresh-audit');
    const stored = JSON.parse(store.get(await keyFor(TARGET, SPEC_VERSION)) as string) as { scored_at: string };
    expect(freshnessOf(body)).toEqual({
      cached: false,
      scored_at: stored.scored_at,
      refresh_after: refreshAfter(stored.scored_at),
    });
  });

  test('the disabled-without-cache message carries no freshness fields', async () => {
    const env = await makeEnv({ webEnabled: false });
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'never-seen.dev' }, IP));
    expect(body.audited).toBe(false);
    expect(body).not.toHaveProperty('cached');
    expect(body).not.toHaveProperty('freshness');
  });

  test('list_website_audits carries no freshness fields', async () => {
    const env = await makeEnv({ cachePrefill: { [CURATED_AGGREGATE_KEY]: curatedAggregate(['first.dev']) } });
    const body = jsonContent(await callTool(env, 'list_website_audits', {}));
    expect(body).not.toHaveProperty('cached');
    expect(body).not.toHaveProperty('freshness');
  });

  // AE5 across surfaces: one stored entry, three read paths, identical values.
  test('both MCP read tools and the result JSON report byte-identical freshness for one stored entry', async () => {
    const scoredAt = new Date().toISOString();
    const store = new Map<string, string>();
    store.set(await keyFor(TARGET, SPEC_VERSION), storedEntry({ scoredAt, stored: true }));
    const env = await makeEnv();
    (env as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = makeBucket(store);

    const getBody = jsonContent(await callTool(env, 'get_website_audit', { url: 'example.com' }));
    const auditBody = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, IP));

    _resetResultCaches();
    const res = await handleResultRoute(
      new Request('https://anc.dev/score/example.com/json'),
      env as unknown as ResultEnv,
    );
    expect(res.status).toBe(200);
    const routeBody = (await res.json()) as Record<string, unknown>;

    const expected = { cached: true, scored_at: scoredAt, refresh_after: refreshAfter(scoredAt) };
    expect(freshnessOf(getBody)).toEqual(expected);
    expect(freshnessOf(auditBody)).toEqual(expected);
    expect(freshnessOf(routeBody)).toEqual(expected);
  });

  test('both read-tool descriptions document the fields and the eligibility caveat', async () => {
    const env = await makeEnv();
    const { body } = await mcpRpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const tools = (body.result?.tools as Array<{ name: string; description: string }>) ?? [];
    for (const name of ['get_website_audit', 'audit_website']) {
      const description = tools.find((t) => t.name === name)?.description ?? '';
      expect(description).toContain('cached');
      expect(description).toContain('scored_at');
      expect(description).toContain('refresh_after');
      expect(description).toContain('not a promise');
    }
  });
});

describe('audit_website: a run already in flight', () => {
  const AT = '2026-09-11T00:00:00.000Z';
  const complete = {
    type: 'complete',
    kind: 'web',
    tier: 'live',
    target: 'example.com',
    scorecard_url: 'https://anc.dev/score/example.com',
    markdown_url: 'https://anc.dev/score/example.com/md',
    json_url: 'https://anc.dev/score/example.com/json',
    freshness: { cached: false, scored_at: AT, refresh_after: '2026-09-11T00:01:00.000Z' },
    spec_version: SPEC_VERSION,
    target_url: 'https://example.com/',
    scorecard: { target_url: 'https://example.com/', score_pct: 64, results: [] },
  } as unknown as AuditEvent;

  async function inFlightEnv(limiterOk: boolean): Promise<McpEnv> {
    const jobs = fakeJobNamespace();
    const job = jobs.get(jobs.idFromName('web:example.com'));
    const claim = await job.claim(AT, 90_000);
    if (!claim.claimed) throw new Error('expected a fresh claim');
    await job.append(claim.run, { type: 'accepted', lane: 'web', target: 'example.com', started_at: AT });
    setTimeout(() => void job.append(claim.run, complete), 20);
    return makeEnv({
      jobs,
      limiterOk,
      kvSeed: { 'inflight:web:example.com': JSON.stringify({ started_at: AT, job: 'web:example.com' }) },
    });
  }

  test('a caller the burst limiter denies cannot attach to the run in flight', async () => {
    // Attaching holds a request open for the rest of someone else's run, so
    // it waits behind the same per-source gate a fresh audit does.
    const env = await inFlightEnv(false);
    const res = await callTool(env, 'audit_website', { url: 'example.com' }, '203.0.113.9');
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toContain('-32099');
  });

  test('a caller with no client IP cannot attach to the run in flight', async () => {
    const env = await inFlightEnv(true);
    const res = await callTool(env, 'audit_website', { url: 'example.com' });
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toContain('-32099');
  });

  test('an in-flight domain attaches once the caller passes the source gates', async () => {
    const env = await inFlightEnv(true);
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'example.com' }, '203.0.113.9'));
    expect(body).toMatchObject({
      audited: true,
      attached: true,
      source: 'fresh-audit',
      freshness: { cached: false, scored_at: AT },
      spec_version: SPEC_VERSION,
    });
    expect(String(body.scorecard_url)).toContain('example.com');
    expect((body.scorecard as { score_pct: number }).score_pct).toBe(64);
  });
});

describe('audit_website: the follow kill switch', () => {
  const IP = '203.0.113.31';

  async function freshRun(followSwitch: string | undefined) {
    const store = new Map<string, string>();
    const env = await makeEnv({ minimalRegistry: true, followSwitch });
    (env as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = makeBucket(store);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    try {
      const { result, records } = await withLogCapture(() =>
        callTool(env, 'audit_website', { url: 'example.com' }, IP),
      );
      const stored = JSON.parse(store.get(await keyFor('https://example.com/', SPEC_VERSION)) as string) as {
        scorecard: { follow_declarations?: boolean };
      };
      const run = records.map((r) => r.record).find((r) => r.scope === 'web-audit.run');
      return { body: jsonContent(result), stored: stored.scorecard, run };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test('an absent or off switch stores and logs follow_declarations false; "true" stores and logs true', async () => {
    for (const followSwitch of [undefined, 'false']) {
      const { body, stored, run } = await freshRun(followSwitch);
      expect(body.audited).toBe(true);
      expect({ followSwitch, stored: stored.follow_declarations, run: run?.follow_declarations }).toEqual({
        followSwitch,
        stored: false,
        run: false,
      });
    }
    const on = await freshRun('true');
    expect(on.stored.follow_declarations).toBe(true);
    expect(on.run?.follow_declarations).toBe(true);
  });
});

describe('audit_website: the declared-domain budget', () => {
  const IP = '203.0.113.51';
  const ENDPOINT = 'https://mcp.example.net/mcp';

  async function freshRun(env: McpEnv) {
    const store = new Map<string, string>();
    (env as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = makeBucket(store);
    const seen: Seen[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = router(
      {
        'GET https://example.com/': () => html(),
        'GET https://example.com/.well-known/ai-catalog.json': () =>
          aiCatalog(cardEntry({ data: sep2127Card(ENDPOINT) })),
      },
      seen,
    );
    try {
      await withLogCapture(() => callTool(env, 'audit_website', { url: 'example.com' }, IP));
      const stored = JSON.parse(store.get(await keyFor('https://example.com/', SPEC_VERSION)) as string) as {
        scorecard: { declared_hosts?: Array<Record<string, unknown>> };
      };
      return { trail: stored.scorecard.declared_hosts ?? [], sent: requestsTo(seen, 'mcp.example.net').length };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("a fresh run reserves one unit of the declared domain's hour before reaching it", async () => {
    const log: string[] = [];
    const env = await makeEnv({ minimalRegistry: true, followSwitch: 'true' });
    (env as { SCORE_KV: KVNamespace }).SCORE_KV = memoryKv(log);
    const { sent } = await freshRun(env);
    const prefix = await budgetKeyPrefix('example.net');
    expect(log.filter((line) => line.startsWith(`kv:put ${prefix}`))).toHaveLength(1);
    expect(sent).toBeGreaterThan(0);
  });

  // A call over a saved scorecard ten minutes old, with example.net's hour and the next one spent.
  async function spentRun(args: Record<string, unknown>, savedScorecard: Record<string, unknown> = {}) {
    const prefix = await budgetKeyPrefix('example.net');
    const hour = Math.floor(Date.now() / 3_600_000);
    const env = await makeEnv({
      followSwitch: 'true',
      kvSeed: { [`${prefix}${hour}`]: '9999', [`${prefix}${hour + 1}`]: '9999' },
    });
    const key = await keyFor('https://example.com/', SPEC_VERSION);
    const saved = {
      spec_version: SPEC_VERSION,
      target_url: 'https://example.com/',
      scorecard: { target_url: 'https://example.com/', score_pct: 64, results: [], ...savedScorecard },
      scored_at: new Date(Date.now() - 600_000).toISOString(),
    };
    const store = new Map([[key, JSON.stringify(saved)]]);
    (env as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = makeBucket(store);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = router(
      {
        'GET https://example.com/': () => html(),
        'GET https://example.com/.well-known/ai-catalog.json': () =>
          aiCatalog(cardEntry({ data: sep2127Card(ENDPOINT) })),
      },
      [],
    );
    try {
      const body = jsonContent(
        (await withLogCapture(() => callTool(env, 'audit_website', { url: 'example.com', ...args }, IP))).result,
      );
      return { body, saved, stored: JSON.parse(store.get(key) ?? 'null') as unknown };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("a run a declared domain's spent hour limited returns in place and keeps the saved scorecard", async () => {
    const { body, saved, stored } = await spentRun({});
    expect(body).toMatchObject({ audited: true, scorecard_url: null, markdown_url: null, json_url: null });
    expect(String(body.summary_html)).toContain("Not saved: example.net reached anc's hourly probe limit;");
    expect(stored).toEqual(saved);
  });

  test('a declared domain over its burst floor is budget-exceeded and receives nothing', async () => {
    const env = await makeEnv({ minimalRegistry: true, followSwitch: 'true' });
    (env as McpEnv & DomainBudgetEnv).WEB_AUDIT_DOMAIN_LIMITER = memoryRateLimit(0);
    const { trail, sent } = await freshRun(env);
    expect(trail[0]).toMatchObject({ outcome: 'budget-exceeded', cause: 'domain-budget' });
    expect(sent).toBe(0);
  });
});

describe('audit_website: the registry a saved run ran under', () => {
  test('a saved fresh run carries the same registry prefix the transact endpoint records', async () => {
    const env = await makeEnv();
    const store = new Map<string, string>();
    (env as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = makeBucket(store);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = router({ 'GET https://example.com/': () => html() }, []);
    try {
      await withLogCapture(() => callTool(env, 'audit_website', { url: 'example.com' }, '203.0.113.61'));
    } finally {
      globalThis.fetch = originalFetch;
    }
    const stored = JSON.parse(store.get(await keyFor('https://example.com/', SPEC_VERSION)) as string) as {
      scorecard: { registry_fingerprint?: string };
    };
    const registry = JSON.parse(await webRegistryJson()) as WebAuditRegistry;
    expect(stored.scorecard.registry_fingerprint).toBe(await registryFingerprintPrefix(registry));
  });
});

describe('audit_website with follow_declarations false', () => {
  const IP = '203.0.113.41';
  const NOT_SAVED = 'Not saved: declared hosts were not followed for this run.';

  // A bucket that records every write, seeded with `prefill`.
  function recordingBucket(prefill: Record<string, string> = {}) {
    const store = new Map(Object.entries(prefill));
    const puts: string[] = [];
    const bucket = makeBucket(store);
    const put = bucket.put.bind(bucket);
    bucket.put = ((key: string, value: string) => {
      puts.push(key);
      return put(key, value);
    }) as unknown as R2Bucket['put'];
    return { bucket, store, puts };
  }

  function purgeContext() {
    const purged: string[][] = [];
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
      exports: {
        Cached: {
          async purgeHitMinTags(tags: string[]) {
            purged.push(tags);
            return { success: true, errors: [] };
          },
        },
      },
    } as unknown as ExecutionContext;
    return { ctx, purged };
  }

  async function offline<T>(fn: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  async function seeded(scoredAt: string, stored = false): Promise<Record<string, string>> {
    const record = {
      spec_version: SPEC_VERSION,
      target_url: 'https://anc.dev/',
      scorecard: {
        schema_version: '0.2',
        target_url: 'https://anc.dev/',
        score_pct: 64,
        results: [],
        public_listing: stored,
      },
      scored_at: scoredAt,
    };
    return { [await keyFor('https://anc.dev/', SPEC_VERSION)]: JSON.stringify(record) };
  }

  // anc.dev is the env's seeded domain, so a saved run would also rebuild both board aggregates.
  async function run(args: Record<string, unknown>, opts: WebEnvOpts & { prefill?: Record<string, string> } = {}) {
    const { prefill, ...envOpts } = opts;
    const recorded = recordingBucket(prefill);
    const env = await makeEnv({ minimalRegistry: true, followSwitch: 'true', ...envOpts });
    (env as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = recorded.bucket;
    const render = fakeRender();
    Object.assign(env, { RENDER: render, OG_VIDEO_ENABLED: 'true' });
    const purge = purgeContext();
    const { result, records } = await offline(() =>
      withLogCapture(() =>
        runWithHitMinPurge(purge.ctx, async () => {
          const body = await callTool(env, 'audit_website', { url: 'anc.dev', ...args }, IP);
          await flushHitMinPurge();
          return body;
        }),
      ),
    );
    const runRecord = records.map((r) => r.record).find((r) => r.scope === 'web-audit.run');
    return {
      result,
      body: result.result?.isError ? null : jsonContent(result),
      puts: recorded.puts,
      purged: purge.purged,
      renders: render.calls,
      runRecord,
    };
  }

  test('a saved run asks the render Worker for one clip through the same hook as the endpoint', async () => {
    const saved = await run({});
    expect(saved.renders).toEqual([{ method: 'request', inputs: expect.objectContaining({ target: 'anc.dev' }) }]);
    expect((await run({ follow_declarations: false })).renders).toEqual([]);
  });

  test('returns a scorecard recording follow_declarations false with no result URLs, and writes, purges, and rebuilds nothing', async () => {
    const out = await run({ follow_declarations: false });
    expect(out.body).toMatchObject({ audited: true, scorecard_url: null, markdown_url: null, json_url: null });
    expect((out.body?.scorecard as { follow_declarations: boolean } | undefined)?.follow_declarations).toBe(false);
    expect(String(out.body?.summary_html)).toContain(NOT_SAVED);
    expect(out.puts).toEqual([]);
    expect(out.purged).toEqual([]);
    expect(out.runRecord?.follow_declarations).toBe(false);
    // Control: the same audit following its declarations writes the domain and both board aggregates.
    const saved = await run({});
    expect(saved.puts).toEqual(
      expect.arrayContaining([
        await keyFor('https://anc.dev/', SPEC_VERSION),
        `audits/web/leaderboard/${SPEC_VERSION}.json`,
        `audits/web/leaderboard-frontpage/${SPEC_VERSION}.json`,
      ]),
    );
    expect(saved.purged.length).toBeGreaterThan(0);
    expect(saved.runRecord?.follow_declarations).toBe(true);
  });

  test('a stored scorecard inside the serve window does not answer it, and with audits disabled it is told so', async () => {
    const fresh = await run({ follow_declarations: false }, { prefill: await seeded(new Date().toISOString()) });
    expect(fresh.body).toMatchObject({ audited: true, source: 'fresh-audit', scorecard_url: null });
    for (const scoredAt of [new Date().toISOString(), new Date(Date.now() - 600_000).toISOString()]) {
      const disabled = await run(
        { follow_declarations: false },
        { webEnabled: false, prefill: await seeded(scoredAt) },
      );
      expect(disabled.body).toMatchObject({ audited: false });
      expect(String(disabled.body?.message)).toContain('disabled');
      expect(disabled.body).not.toHaveProperty('scorecard');
    }
  });

  test('with no cf-connecting-ip it is refused with -32099 and runs no audit', async () => {
    const recorded = recordingBucket();
    const env = await makeEnv({ minimalRegistry: true, followSwitch: 'true' });
    (env as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = recorded.bucket;
    const { result, records } = await offline(() =>
      withLogCapture(() => callTool(env, 'audit_website', { url: 'anc.dev', follow_declarations: false })),
    );
    expect(result.result?.isError).toBe(true);
    expect(result.result?.content?.[0]?.text).toContain('-32099');
    expect(result.result?.content?.[0]?.text).toContain('cf-connecting-ip');
    expect(records.filter((r) => r.record.scope === 'web-audit.run')).toEqual([]);
  });

  test('with the hourly window exhausted it is refused and runs no audit', async () => {
    const bucket = Math.floor(Date.now() / 3_600_000);
    const out = await run({ follow_declarations: false }, { kvSeed: { [`audit:web:${IP}:${bucket}`]: '30' } });
    expect(out.result.result?.isError).toBe(true);
    expect(out.result.result?.content?.[0]?.text).toContain('30 fresh audits per hour');
    expect(out.runRecord).toBeUndefined();
  });

  test('beside a followed run in flight it runs its own transient audit and never attaches', async () => {
    const startedAt = new Date().toISOString();
    const jobs = fakeJobNamespace();
    const job = jobs.get(jobs.idFromName('web:anc.dev'));
    const claim = await job.claim(startedAt, 90_000);
    if (!claim.claimed) throw new Error('expected a fresh claim');
    await job.append(claim.run, { type: 'accepted', lane: 'web', target: 'anc.dev', started_at: startedAt });
    const followed = {
      type: 'complete',
      kind: 'web',
      tier: 'live',
      target: 'anc.dev',
      scorecard_url: 'https://anc.dev/score/anc.dev',
      markdown_url: 'https://anc.dev/score/anc.dev/md',
      json_url: 'https://anc.dev/score/anc.dev/json',
      freshness: { cached: false, scored_at: startedAt, refresh_after: null },
      spec_version: SPEC_VERSION,
      scorecard: { target_url: 'https://anc.dev/', score_pct: 64, results: [], follow_declarations: true },
    } as unknown as AuditEvent;
    setTimeout(() => void job.append(claim.run, followed), 20);
    const out = await run(
      { follow_declarations: false },
      { jobs, kvSeed: { 'inflight:web:anc.dev': JSON.stringify({ started_at: startedAt, job: 'web:anc.dev' }) } },
    );
    expect(out.body).toMatchObject({
      audited: true,
      source: 'fresh-audit',
      scorecard_url: null,
      markdown_url: null,
      json_url: null,
    });
    expect(out.body).not.toHaveProperty('attached');
    expect((out.body?.scorecard as { follow_declarations: boolean } | undefined)?.follow_declarations).toBe(false);
    expect(out.runRecord?.follow_declarations).toBe(false);
  });

  test('it claims no job and writes no in-flight flag, so no followed caller can join it', async () => {
    const jobs = fakeJobNamespace();
    const claims = countClaims(jobs);
    const kvPuts: string[] = [];
    const out = await run({ follow_declarations: false }, { jobs, kvPuts });
    expect(out.body).toMatchObject({ audited: true, scorecard_url: null });
    expect(claims).toEqual([]);
    expect(jobs.jobs.size).toBe(0);
    expect(kvPuts.filter((key) => key.startsWith('inflight:'))).toEqual([]);
    // Control: the same call following its declarations claims the site's job and marks its flag.
    const followedJobs = fakeJobNamespace();
    const followedClaims = countClaims(followedJobs);
    const followedPuts: string[] = [];
    await run({}, { jobs: followedJobs, kvPuts: followedPuts });
    expect(followedClaims).toEqual(['web:anc.dev']);
    expect(followedPuts).toContain('inflight:web:anc.dev');
  });

  test('with public_listing omitted it runs against a stored opt-in, carries that listing, and writes nothing', async () => {
    const out = await run(
      { follow_declarations: false },
      { prefill: await seeded(new Date(Date.now() - 600_000).toISOString(), true) },
    );
    expect(out.body).toMatchObject({ audited: true, source: 'fresh-audit', scorecard_url: null });
    expect((out.body?.scorecard as { public_listing: boolean } | undefined)?.public_listing).toBe(true);
    expect(out.puts).toEqual([]);
    expect(out.purged).toEqual([]);
  });

  test('a non-boolean follow_declarations is rejected by input validation', async () => {
    const env = await makeEnv();
    const res = await callTool(env, 'audit_website', { url: 'example.com', follow_declarations: 'no' }, IP);
    const rejected = res.error !== undefined || res.result?.isError === true;
    expect(rejected).toBe(true);
    expect(JSON.stringify(res)).toContain('follow_declarations');
  });
});

describe('audit_website: a followed fresh run that fails', () => {
  const IP = '203.0.113.61';

  async function failedCall(opts: WebEnvOpts, answer: (url: string) => Response) {
    const env = await makeEnv({ minimalRegistry: true, followSwitch: 'true', ...opts });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(answer);
    try {
      return await callTool(env, 'audit_website', { url: 'example.com' }, IP);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test('an unreachable target says the audit failed, gives the reason, and ends by asking to check the address', async () => {
    const res = await failedCall({}, () => new Response('', { status: 530 }));
    expect(res.result?.isError).toBe(true);
    const text = res.result?.content?.[0]?.text ?? '';
    expect(text).toStartWith(
      'the audit failed; nothing was cached. https://example.com/ did not answer any probe (every response was a Cloudflare edge error',
    );
    expect(text).toEndWith(' Check the address and try again.');
  });

  test('an unreachable target whose www sibling answered names the sibling once, in the closing instruction', async () => {
    const res = await failedCall({}, (url) =>
      new URL(url).host === 'www.example.com'
        ? new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response('', { status: 530 }),
    );
    expect(res.result?.isError).toBe(true);
    const text = res.result?.content?.[0]?.text ?? '';
    expect(text).toContain(' www.example.com answered. Audit https://www.example.com/ instead.');
    expect(text.split('https://www.example.com/').length - 1).toBe(1);
  });

  test('an engine that throws says the audit failed, gives the error as a sentence, and ends by asking to retry', async () => {
    const res = await failedCall({ failRegistry: true }, () => new Response('not found', { status: 404 }));
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toBe(
      'the audit failed; nothing was cached. web-audit registry fetch failed: 500. Try again in a moment.',
    );
  });
});

describe('audit_website discloses third-party probing', () => {
  type ToolEntry = {
    name: string;
    description: string;
    inputSchema: { properties: Record<string, { type?: string; description?: string }> };
  };

  async function auditWebsite(): Promise<ToolEntry | undefined> {
    const env = await makeEnv();
    const { body } = await mcpRpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    return (body.result?.tools as ToolEntry[] | undefined)?.find((t) => t.name === 'audit_website');
  }

  test('the follow_declarations parameter carries the full disclosure: caps, probe split, opt-out, and the unsaved result', async () => {
    const tool = await auditWebsite();
    const parameter = tool?.inputSchema.properties.follow_declarations;
    const description = parameter?.description ?? '';
    expect(parameter?.type).toBe('boolean');
    expect(description).toContain(FOLLOW_DISCLOSURE);
    expect(description).toContain('also contacts third-party hosts the site declares');
    expect(description).toContain(
      "wire-probed (JSON-RPC POSTs, a CORS preflight) only after one of those documents on the endpoint's own host names the endpoint",
    );
    expect(description).toContain("one GET to a nonsense path on the site's declaration alone");
    expect(description).toContain(
      'at most 4 off-origin hosts with at most 12 follow-phase document requests inside a 6-second follow window',
    );
    expect(description).toContain("following lengthens an audit's wall time");
    expect(description).toContain('capped at about 30 audits per hour per declared registrable domain');
    expect(description).toContain("an audit past that cap leaves that domain's hosts unprobed");
    expect(description).toContain(
      'when the site has a saved scorecard from the last 24 hours that audit is returned without replacing it, with no scorecard_url, markdown_url, or json_url',
    );
    expect(description).toContain('anc sends no plaintext request');
    expect(description).toContain('WEB_AUDIT_FOLLOW_ENABLED');
  });

  test('the follow_declarations parameter still says what it is and what false changes', async () => {
    const description = (await auditWebsite())?.inputSchema.properties.follow_declarations?.description ?? '';
    expect(description.startsWith('Follow the hosts the site declares')).toBe(true);
    expect(description).toContain('By default (follow_declarations true)');
    expect(description).toContain(
      "With false the result is also never listed and never joined to another caller's run, and it carries no scorecard_url, markdown_url, or json_url",
    );
    expect(description).not.toContain('public_listing');
  });

  test('the follow_declarations parameter states each fact once where the two pieces join', async () => {
    const description = (await auditWebsite())?.inputSchema.properties.follow_declarations?.description ?? '';
    expect(description).not.toContain('defaults to true');
    expect(description).not.toContain('transient');
  });

  test('the audit_website description carries the short disclosure and not the full one', async () => {
    const description = (await auditWebsite())?.description ?? '';
    expect(description).toContain(FOLLOW_DISCLOSURE_SHORT);
    expect(description).not.toContain(FOLLOW_DISCLOSURE);
    expect(description).toContain('MCP_ENABLED');
    expect(description).not.toContain('\u2014');
  });

  test('the audit_website description names the freshness fields and what each refusal looks like', async () => {
    const description = (await auditWebsite())?.description ?? '';
    for (const field of ['freshness.cached', 'freshness.scored_at', 'freshness.refresh_after']) {
      expect(description).toContain(field);
    }
    expect(description).toContain('isError: false with audited: false');
    expect(description).toContain(
      "freshness.cached (false for a fresh run's result, including a run this call attached to)",
    );
    expect(description).toContain('isError: true with a JSON-RPC -32099 error in the text');
    expect(description).toContain('read get_website_audit');
  });

  test('the short disclosure states the caps, the wire probes, and the opt-out in fixed text', () => {
    expect(FOLLOW_DISCLOSURE_SHORT).toContain('at most 4 hosts per audit');
    expect(FOLLOW_DISCLOSURE_SHORT).toContain('about 30 audits per hour per declared domain across all callers');
    expect(FOLLOW_DISCLOSURE_SHORT).toContain('JSON-RPC POSTs');
    expect(FOLLOW_DISCLOSURE_SHORT).toContain('follow_declarations: false audits only the site');
  });
});

describe('a website is audited and read at its https origin', () => {
  const IP = '203.0.113.51';

  async function stored(url: string, scorePct: number, scoredAt = new Date().toISOString()) {
    return {
      [await keyFor(url, SPEC_VERSION)]: {
        spec_version: SPEC_VERSION,
        target_url: url,
        scorecard: { target_url: url, score_pct: scorePct, results: [] },
        scored_at: scoredAt,
      },
    };
  }

  // A fresh audit_website call against an offline engine; every fetched URL is recorded.
  async function freshCall(url: string, prefill: Map<string, string> = new Map()) {
    const jobs = fakeJobNamespace();
    const claims = countClaims(jobs);
    const env = await makeEnv({ minimalRegistry: true, jobs });
    (env as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = makeBucket(prefill);
    const fetched: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch((requested) => {
      fetched.push(requested);
      return new Response('not found', { status: 404 });
    });
    try {
      const body = jsonContent(await callTool(env, 'audit_website', { url }, IP));
      return { body, store: prefill, claims, fetched };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test('audit_website with an http:// URL audits https://<host>/, caches under the https key, and claims the job a transact run claims', async () => {
    const { body, store, claims, fetched } = await freshCall('http://example.com/docs');
    expect(body).toMatchObject({
      audited: true,
      source: 'fresh-audit',
      target: 'example.com',
      scorecard_url: 'https://anc.dev/score/example.com',
    });
    expect((body.scorecard as { target_url: string }).target_url).toBe('https://example.com/');
    expect([...store.keys()]).toContain(await keyFor('https://example.com/', SPEC_VERSION));
    expect([...store.keys()]).not.toContain(await keyFor('http://example.com/', SPEC_VERSION));
    expect(fetched[0]).toBe('https://example.com/');
    expect(fetched.filter((requested) => requested.startsWith('http://example.com'))).toEqual([]);
    // The transact endpoint keys its job on the bare host too, so the two surfaces share one run.
    expect(claims).toEqual(['web:example.com']);
  });

  test('a fresh record under the http key does not answer audit_website', async () => {
    const httpKey = await keyFor('http://example.com/', SPEC_VERSION);
    const prefill = new Map([[httpKey, JSON.stringify((await stored('http://example.com/', 12))[httpKey])]]);
    const { body, store } = await freshCall('http://example.com/', prefill);
    expect(body).toMatchObject({ audited: true, source: 'fresh-audit' });
    expect(JSON.parse(store.get(httpKey) ?? '{}').scorecard.score_pct).toBe(12);
  });

  test('get_website_audit reads an http:// URL from the https record', async () => {
    const env = await makeEnv({ cachePrefill: await stored('https://example.com/', 71) });
    const body = jsonContent(await callTool(env, 'get_website_audit', { url: 'http://example.com/' }));
    expect(body).toMatchObject({
      found: true,
      target: 'example.com',
      scorecard_url: 'https://anc.dev/score/example.com',
    });
    expect((body.scorecard as { score_pct: number }).score_pct).toBe(71);
  });

  test('a record stored under an http key is never returned', async () => {
    const env = await makeEnv({ cachePrefill: await stored('http://example.com/', 12) });
    for (const url of ['example.com', 'http://example.com/', 'https://example.com/']) {
      const body = jsonContent(await callTool(env, 'get_website_audit', { url }));
      expect({ url, found: body.found }).toEqual({ url, found: false });
    }
  });

  test('a scheme other than http or https is refused, not upgraded', async () => {
    const env = await makeEnv();
    for (const tool of ['get_website_audit', 'audit_website']) {
      const res = await callTool(env, tool, { url: 'ftp://example.com/' }, IP);
      expect(res.result?.isError).toBe(true);
      expect(res.result?.content?.[0]?.text).toBe('scheme ftp: is not http(s)');
    }
  });
});

describe('provenance reaches every reader of a stored website result', () => {
  const STORED_AT = '2026-09-10T17:20:00.000Z';

  async function storedEnv(host: string, scorecard: unknown) {
    const key = await keyFor(`https://${host}/`, SPEC_VERSION);
    return makeEnv({
      cachePrefill: {
        [key]: { spec_version: SPEC_VERSION, target_url: `https://${host}/`, scored_at: STORED_AT, scorecard },
      },
    });
  }

  type ReadRow = {
    id: string;
    host?: string;
    hosts?: Array<{ host: string; status?: string }>;
    na_reason?: string;
    evidence: string | null;
    result: string;
    access_remedy?: string;
    remediation?: { prompt: string; host: string | null };
  };
  type Read = {
    scorecard: { results: ReadRow[]; access_note?: string; declared_hosts?: unknown; follow_declarations?: unknown };
  };

  async function read(host: string, scorecard: unknown): Promise<Read & { env: McpEnv }> {
    const env = await storedEnv(host, scorecard);
    return { env, ...(jsonContent(await callTool(env, 'get_website_audit', { url: host })) as unknown as Read) };
  }

  function rendered(host: string, scorecard: unknown) {
    const input = {
      scorecard: scorecard as never,
      domain: host,
      targetUrl: `https://${host}/`,
      remediation: REMEDIATION,
      registry: REGISTRY,
      origin: 'https://anc.dev',
    };
    return { html: buildWebSummaryBody(input), md: buildWebSummaryMarkdown(input) };
  }

  // Two API hosts, so no single host heads the category and each row names its own.
  function twoHostScorecard() {
    return scorecardOf('example.com', [
      row('openapi', 'pass', { evidence: 'https://api.example.net/openapi.json -> 200', ...at('api.example.net') }),
      row('rate-limit-headers', 'n_a', {
        na_reason: 'optional-absent',
        evidence: 'https://files.example.net/x -> 404',
        ...at('files.example.net'),
      }),
      row('json-errors', 'n_a', { na_reason: 'declared-host-unreachable', ...at('files.example.net') }),
    ]);
  }

  test('for a followed-host check, the twin, the page, the MCP read, and the worksheet name the same host and reason', async () => {
    const stored = twoHostScorecard();
    const { scorecard } = await read('example.com', stored);
    const { html, md } = rendered('example.com', stored);
    const worksheet = JSON.parse(getWorksheet(await parseHtml(html), { statuses: ['n_a'], limit: 25 })) as {
      items: Array<{ id: string; host: string | null; result: string | null }>;
    };
    for (const [id, phrase] of [
      ['rate-limit-headers', 'Not implemented, optional'],
      ['json-errors', 'Not evaluated: files.example.net did not answer'],
    ] as const) {
      const mcp = scorecard.results.find((r) => r.id === id);
      const item = worksheet.items.find((i) => i.id === id);
      expect({ id, host: mcp?.host, result: mcp?.result.startsWith(phrase) }).toEqual({
        id,
        host: 'files.example.net',
        result: true,
      });
      expect({ id, host: item?.host, result: item?.result }).toEqual({
        id,
        host: 'files.example.net',
        result: mcp?.result ?? '',
      });
      expect(html).toMatch(new RegExp(`data-id="${id}"[^>]*data-host="files\\.example\\.net"`));
      expect(md).toContain(`- Result: ${mcp?.result}`);
    }
    const section = md.slice(md.indexOf('API responses advertise rate-limit headers'), md.indexOf('API client errors'));
    expect(section).toContain('- Host: `files.example.net`');
  });

  /** What get_web_remediation answers for a row read through get_website_audit, given the inputs its docs name. */
  async function standaloneFor(env: McpEnv, row: ReadRow | undefined) {
    const host = row?.remediation?.host;
    return jsonContent(
      await callTool(env, 'get_web_remediation', {
        check_id: row?.id,
        evidence: row?.evidence,
        ...(host === null || host === undefined ? {} : { host }),
      }),
    ) as { remediation: { prompt: string; host: string | null } };
  }

  test("get_web_remediation given the row's remediation host returns the inline prompt byte for byte", async () => {
    const { env, scorecard } = await read('stripe.dev', stripeShaped());
    const inline = scorecard.results.find((r) => r.id === 'rate-limit-headers');
    expect(inline?.remediation?.prompt).toContain('Host: api.stripe.com');
    const standalone = await standaloneFor(env, inline);
    expect(standalone.remediation.prompt).toBe(inline?.remediation?.prompt ?? '');
    expect(standalone.remediation.host).toBe('api.stripe.com');
    const carrier = /data-id="rate-limit-headers"[\s\S]*?data-copy-text="([^"]*)"/.exec(
      rendered('stripe.dev', stripeShaped()).html,
    );
    expect(
      (await parseHtml(`<p data-x="${carrier?.[1]}"></p>`)).querySelector('[data-x]')?.getAttribute('data-x'),
    ).toBe(standalone.remediation.prompt);
  });

  test('a fixable row stored before provenance gets its inline prompt back from its remediation host and evidence', async () => {
    const stored = stripeShaped();
    const old = { ...stored, results: stored.results.map(({ hosts: _h, host: _x, ...r }) => r) };
    const { env, scorecard } = await read('stripe.dev', old);
    const inline = scorecard.results.find((r) => r.id === 'rate-limit-headers');
    expect({ host: inline?.host, remediationHost: inline?.remediation?.host }).toEqual({
      host: 'stripe.dev',
      remediationHost: null,
    });
    expect(inline?.remediation?.prompt).not.toContain('Host:');
    expect((await standaloneFor(env, inline)).remediation.prompt).toBe(inline?.remediation?.prompt ?? '');
  });

  test('a fixable row over two hosts gets its inline prompt back from its remediation host and evidence', async () => {
    const { env, scorecard } = await read('example.com', twoAnchorShaped());
    const inline = scorecard.results.find((r) => r.id === 'json-errors');
    expect(inline?.hosts?.map((h) => h.host)).toEqual(['api.example.net', 'files.example.net']);
    expect(inline?.remediation?.host).toBeNull();
    expect((await standaloneFor(env, inline)).remediation.prompt).toBe(inline?.remediation?.prompt ?? '');
  });

  test('a row over two hosts carries each host with its own outcome in the MCP read', async () => {
    const { scorecard } = await read('example.com', twoAnchorShaped());
    const jsonErrors = scorecard.results.find((r) => r.id === 'json-errors');
    expect(jsonErrors?.hosts).toEqual([
      { host: 'api.example.net', status: 'pass' },
      { host: 'files.example.net', status: 'broken' },
    ]);
    expect(jsonErrors?.result).toBe(
      'Present but broken (https://files.example.net/x -> 404 (HTML)); api.example.net: pass, files.example.net: broken',
    );
  });

  test('the MCP read carries the not-run sentences the page and the twin show', async () => {
    const { scorecard } = await read('stripe.dev', stripeShaped());
    const { md } = rendered('stripe.dev', stripeShaped());
    expect(scorecard.access_note).toBe('Global keeps the 18 checks this audit could not run in its maximum.');
    expect(md).toContain(scorecard.access_note ?? 'missing');
    const corsActual = scorecard.results.find((r) => r.id === 'mcp-cors-actual');
    expect(corsActual?.access_remedy).toBe("anc's public audit holds no sign-in for mcp.stripe.com.");
    expect(md).toContain(`- Note: ${corsActual?.access_remedy}`);
    expect(scorecard.results.filter((r) => r.access_remedy !== undefined)).toHaveLength(18);
  });

  test('a scorecard stored before provenance reads with no trail, no follow state, and no host on any surface', async () => {
    const stored = stripeShaped() as Record<string, unknown> & { results: Array<Record<string, unknown>> };
    const { follow_declarations: _f, declared_hosts: _d, ...rest } = stored;
    const old = { ...rest, results: stored.results.map(({ hosts: _h, host: _x, ...r }) => r) };
    const { scorecard } = await read('stripe.dev', old);
    expect('declared_hosts' in scorecard).toBe(false);
    expect('follow_declarations' in scorecard).toBe(false);
    for (const r of scorecard.results) expect(r.remediation?.prompt ?? '').not.toContain('Host:');
    const { html, md } = rendered('stripe.dev', old);
    for (const text of [html, md]) {
      expect(text).toContain('Declared hosts: not recorded for this audit.');
      expect(text).not.toContain('Evaluated at');
      expect(text).not.toContain('Host:');
    }
    const context = (await parseHtml(html)).querySelector('[data-web-audit-context]');
    expect(context?.getAttribute('data-follow-declarations')).toBeNull();
    expect(context?.getAttribute('data-declared-hosts')).toBeNull();
  });

  test('a trail carrying markup reads as data in the MCP read and as escaped text on the page and the twin', async () => {
    const hostile = [
      {
        surface: '/<script>x</script>',
        kind: 'mcp-endpoint',
        url: 'https://{tenant}.example.org/<img src=x>',
        host: '{tenant}.example.org',
        outcome: 'not-followed',
        reason: 'templated-url',
      },
    ];
    const stored = { ...twoHostScorecard(), follow_declarations: true, declared_hosts: hostile };
    const { scorecard } = await read('example.com', stored);
    expect(scorecard.declared_hosts).toEqual(hostile);
    const { html, md } = rendered('example.com', stored);
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(md).toContain('(`https://{tenant}.example.org/<img src=x>`)');
  });

  test('a declaration over http reads "not followed: not https" on the page and the twin, and insecure-scheme in the MCP read', async () => {
    const trail = [
      {
        surface: '/.well-known/mcp.json',
        kind: 'mcp-endpoint',
        url: 'http://mcp.example.net/mcp',
        host: 'mcp.example.net',
        outcome: 'not-followed',
        reason: 'insecure-scheme',
      },
    ];
    const stored = { ...twoHostScorecard(), follow_declarations: true, declared_hosts: trail };
    const { scorecard } = await read('example.com', stored);
    expect(scorecard.declared_hosts).toEqual(trail);
    const { html, md } = rendered('example.com', stored);
    expect(html).toContain('<p class="declared-hosts__outcome">not followed: not https</p>');
    expect(md).toContain('- server card: `mcp.example.net` (`http://mcp.example.net/mcp`), not followed: not https\n');
  });
});

describe('web MCP tools: a host and its www sibling', () => {
  const IP = '203.0.113.71';
  const FOLD = ['cnn.com', 'www.cnn.com'];

  type ToolList = Array<{
    name: string;
    description: string;
    inputSchema: { properties: Record<string, { description?: string }> };
  }>;

  async function listedTools(): Promise<ToolList> {
    const env = await makeEnv();
    const { body } = await mcpRpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    return (body.result?.tools as ToolList | undefined) ?? [];
  }

  test('the tool descriptions state the fold: get_website_audit and audit_website on the url, list_website_audits on the tool', async () => {
    const tools = await listedTools();
    const named = (name: string) => tools.find((t) => t.name === name);
    const readUrl = named('get_website_audit')?.inputSchema.properties.url?.description ?? '';
    expect(readUrl).toContain(
      'www.<domain> reads the <domain> scorecard when that scorecard records that one of the two hosts redirects to the other (its site_hosts lists both); target and scorecard_url then name <domain>',
    );
    expect(readUrl).toContain('a miss there may mean the pair has not been audited since folds were recorded');
    const auditUrl = named('audit_website')?.inputSchema.properties.url?.description ?? '';
    expect(auditUrl).toContain(
      'The audit first checks whether <domain> or www.<domain> redirects to the other. If one does, they are one site named <domain>',
    );
    expect(auditUrl).toContain('scorecard.target_url is the origin the checks ran at');
    expect(auditUrl).toContain('scorecard.site_hosts lists both hosts');
    expect(auditUrl).toContain('A www. host with no such redirect is audited as its own site');
    expect(named('list_website_audits')?.description).toContain(
      'A site whose bare or www. host redirects to the other is listed once, under the bare domain.',
    );
  });

  test('get_website_audit names its isError:true outcomes, invalid or refused url and cache_unavailable', async () => {
    const description = (await listedTools()).find((t) => t.name === 'get_website_audit')?.description ?? '';
    expect(description).toContain(
      'a hit, a target already being audited, and a miss, and isError:true for an invalid or refused url and with cache_unavailable when a www.<domain> read cannot reach the <domain> record.',
    );
    expect(description).not.toContain('Returns isError:false for every outcome:');
  });

  const foldedRecord = (staleMs = 0) => ({
    spec_version: SPEC_VERSION,
    target_url: 'https://cnn.com/',
    scored_at: new Date(Date.now() - staleMs).toISOString(),
    scorecard: {
      target_url: 'https://www.cnn.com/',
      tool: { name: 'cnn.com', url: 'https://cnn.com/' },
      site_hosts: FOLD,
      badge: { score_pct: 70 },
    },
  });

  // A bucket that records every read and refuses the keys in `unreadable`.
  function watchedBucket(store: Map<string, string>, unreadable: string[] = []) {
    const gets: string[] = [];
    const bucket = makeBucket(store);
    const get = bucket.get.bind(bucket);
    bucket.get = (async (key: string) => {
      gets.push(key);
      if (unreadable.includes(key)) throw new Error('get: We encountered an internal error. Please try again. (10001)');
      return get(key);
    }) as R2Bucket['get'];
    return { bucket, gets };
  }

  async function withStore(prefill: Record<string, unknown>, unreadable: string[] = [], opts: WebEnvOpts = {}) {
    const env = await makeEnv(opts);
    const store = new Map<string, string>();
    for (const [key, value] of Object.entries(prefill)) store.set(key, JSON.stringify(value));
    const watched = watchedBucket(store, unreadable);
    (env as { SCORE_CACHE: R2Bucket }).SCORE_CACHE = watched.bucket;
    return { env, store, gets: watched.gets };
  }

  async function underFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test('get_website_audit for the www host of a folded site answers with the site', async () => {
    const { env } = await withStore({ [await keyFor('https://cnn.com/', SPEC_VERSION)]: foldedRecord() });
    const body = jsonContent(await callTool(env, 'get_website_audit', { url: 'https://www.cnn.com/' }));
    expect(body).toMatchObject({
      found: true,
      target: 'cnn.com',
      scorecard_url: 'https://anc.dev/score/cnn.com',
      target_url: 'https://www.cnn.com/',
    });
  });

  test('get_website_audit for a www host nothing records names the www host in its miss', async () => {
    const { env } = await withStore({});
    const body = jsonContent(await callTool(env, 'get_website_audit', { url: 'www.x.test' }));
    expect(body).toMatchObject({ found: false, next_tool: 'audit_website' });
    expect(String(body.message)).toContain('www.x.test');
  });

  test('get_website_audit reads the www record for a bare record that records no fold', async () => {
    const own = {
      spec_version: SPEC_VERSION,
      target_url: 'https://www.x.test/',
      scorecard: { badge: { score_pct: 55 } },
    };
    const bare = { ...foldedRecord(), target_url: 'https://x.test/', scorecard: { badge: { score_pct: 40 } } };
    const { env } = await withStore({
      [await keyFor('https://x.test/', SPEC_VERSION)]: bare,
      [await keyFor('https://www.x.test/', SPEC_VERSION)]: own,
    });
    const body = jsonContent(await callTool(env, 'get_website_audit', { url: 'www.x.test' }));
    expect(body).toMatchObject({ found: true, target: 'www.x.test' });
  });

  test('get_website_audit with an unreadable record of the bare host is an error, and the www record is never read', async () => {
    const bareKey = await keyFor('https://cnn.com/', SPEC_VERSION);
    const wwwKey = await keyFor('https://www.cnn.com/', SPEC_VERSION);
    const { env, gets } = await withStore({ [bareKey]: foldedRecord(), [wwwKey]: foldedRecord() }, [bareKey]);
    const res = await callTool(env, 'get_website_audit', { url: 'www.cnn.com' });
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toBe(
      'cache_unavailable: the stored scorecard for cnn.com could not be read right now; it has not been removed. Retry get_website_audit in 30 seconds.',
    );
    expect(gets).not.toContain(wwwKey);
  });

  test('audit_website for the www host of a fresh folded site serves the site from cache', async () => {
    const { env, gets } = await withStore({ [await keyFor('https://cnn.com/', SPEC_VERSION)]: foldedRecord() });
    const body = jsonContent(await callTool(env, 'audit_website', { url: 'www.cnn.com' }, IP));
    expect(body).toMatchObject({ audited: false, source: 'cache', target: 'cnn.com' });
    expect(gets).not.toContain(await keyFor('https://www.cnn.com/', SPEC_VERSION));
  });

  test('audit_website for a www host with an unreadable bare record audits, folds, and writes the bare host', async () => {
    const bareKey = await keyFor('https://a.test/', SPEC_VERSION);
    const wwwKey = await keyFor('https://www.a.test/', SPEC_VERSION);
    const { env, store } = await withStore(
      {
        [wwwKey]: {
          ...foldedRecord(10 * 60_000),
          target_url: 'https://www.a.test/',
          scorecard: { badge: { score_pct: 40 } },
        },
      },
      [bareKey],
      {
        minimalRegistry: true,
      },
    );
    const body = jsonContent(
      await underFetch(
        router(
          {
            'GET https://www.a.test/': () =>
              new Response(null, { status: 301, headers: { location: 'https://a.test/' } }),
            'GET https://a.test/': () => html(),
          },
          [],
        ),
        () => callTool(env, 'audit_website', { url: 'www.a.test' }, IP),
      ),
    );
    expect(body).toMatchObject({ audited: true, target: 'a.test' });
    const written = JSON.parse(store.get(bareKey) as string) as { scorecard: { site_hosts?: string[] } };
    expect(written.scorecard.site_hosts).toEqual(['a.test', 'www.a.test']);
    expect(store.has(wwwKey)).toBe(false);
  });

  test('audit_website with follow_declarations false for a www host that folds answers with the site and saves nothing', async () => {
    const { env, store } = await withStore({}, [], { minimalRegistry: true });
    const body = jsonContent(
      await underFetch(
        router(
          {
            'GET https://www.a.test/': () =>
              new Response(null, { status: 301, headers: { location: 'https://a.test/' } }),
            'GET https://a.test/': () => html(),
          },
          [],
        ),
        () => callTool(env, 'audit_website', { url: 'www.a.test', follow_declarations: false }, IP),
      ),
    );
    expect(body).toMatchObject({ audited: true, target: 'a.test', scorecard_url: null });
    expect(store.size).toBe(0);
  });
});
