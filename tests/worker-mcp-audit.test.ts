// score_cli MCP tool tests (U5a).
//
// Exercises the full score_cli flow end-to-end: kill switch, validate,
// lookupOnly, cf-connecting-ip presence check, MCP_AUDIT_LIMITER burst,
// KV per-hour, runFreshOnly result mapping. Dispatches through
// buildMcpHandler so the MCP envelope shaping (CallToolResult content
// blocks, isError flag) is exercised against the real SDK.
//
// Mocks mirror the binding shape per the cloudflare-workers-do-mock-
// must-mirror-binding-shape solutions doc: SCORE.idFromName → get →
// {fetch} chain so getRandom resolves the same way it would in workerd.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AuditEvent } from '../src/shared/audit-events';
import type { AuditJob } from '../src/worker/audit/job';
import type { McpEnv } from '../src/worker/mcp/server';
import { _resetHintsIndexCache } from '../src/worker/score/orchestrate';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';
import { fakeJobNamespace } from './helpers/audit-job-state';
import { getJsonToolContent, mcpInitialize, mcpRpc, resetMcpTestState } from './helpers/mcp-rpc';

const FIXTURE_CATALOG = {
  generated_at: '2026-06-05T18:00:00.000Z',
  spec_version: SPEC_VERSION,
  registry: [
    {
      slug: 'curl',
      name: 'curl',
      binary: 'curl',
      install: 'brew install curl',
      version: '8.20.0',
      anc_version: ANC_VERSION,
      scorecard_url: '/score/curl',
      score_pct: 73,
      repo: 'curl/curl',
    },
  ],
  principles: [],
  spec_sections: [],
};

const FIXTURE_REGISTRY_INDEX = {
  by_slug: {
    curl: {
      name: 'curl',
      binary: 'curl',
      install: 'brew install curl',
      version: '8.20.0',
      anc_version: ANC_VERSION,
      scorecard_url: '/score/curl',
      score_pct: 73,
      repo: 'curl/curl',
    },
  },
  by_owner_repo: {
    'curl/curl': {
      name: 'curl',
      binary: 'curl',
      install: 'brew install curl',
      version: '8.20.0',
      anc_version: ANC_VERSION,
      scorecard_url: '/score/curl',
      score_pct: 73,
      repo: 'curl/curl',
    },
  },
};

const FIXTURE_HINTS_INDEX = { by_owner_repo: {} };

interface RateStub {
  calls: number;
  shouldSucceed: boolean;
  lastKey?: string;
}

interface KvStub {
  store: Map<string, string>;
  getCalls: number;
  putCalls: number;
}

interface DoFetchSpy {
  calls: Array<{ url: string; body: string }>;
  response: Response;
  idFromNameCalls: number;
}

interface CacheStub {
  store: Map<string, string>;
  getCalls: number;
}

interface MakeEnvOpts {
  liveScoringEnabled?: boolean;
  auditLimiter?: RateStub;
  kv?: KvStub;
  scoreBinding?: boolean;
  doResponse?: Response;
  cacheContent?: Record<string, unknown>;
  // Bind MCP_CACHE_BYPASS_ALLOWED on the synthetic env. Pass "true" to enable
  // the score_cli `bypass_cache` arg; pass undefined / a different string to
  // verify the silent-ignore behavior that protects prod (where the binding is
  // absent).
  cacheBypassAllowed?: string;
  jobs?: DurableObjectNamespace<AuditJob>;
}

function makeEnv(opts: MakeEnvOpts = {}): {
  env: McpEnv;
  audit: RateStub | undefined;
  kv: KvStub;
  doSpy: DoFetchSpy;
  cache: CacheStub;
} {
  const liveScoringEnabled = opts.liveScoringEnabled ?? true;

  const doSpy: DoFetchSpy = {
    calls: [],
    response:
      opts.doResponse ??
      new Response(
        JSON.stringify({
          scorecard: { tool: { binary: 'newcli' }, results: [] },
          anc_version: SPEC_VERSION,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    idFromNameCalls: 0,
  };

  const cacheStore = new Map<string, string>();
  for (const [k, v] of Object.entries(opts.cacheContent ?? {})) {
    cacheStore.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const cacheStub: CacheStub = { store: cacheStore, getCalls: 0 };

  const kvStub: KvStub = opts.kv ?? { store: new Map(), getCalls: 0, putCalls: 0 };

  const scoreBinding =
    opts.scoreBinding !== false
      ? ({
          idFromName(_name: string) {
            doSpy.idFromNameCalls += 1;
            return { name: 'stub' };
          },
          get(_id: unknown) {
            return {
              async fetch(req: Request): Promise<Response> {
                const body = await req.clone().text();
                doSpy.calls.push({ url: req.url, body });
                return doSpy.response.clone();
              },
            };
          },
        } as unknown as DurableObjectNamespace)
      : undefined;

  const env: McpEnv = {
    ASSETS: {
      async fetch(req: Request): Promise<Response> {
        const path = new URL(req.url).pathname;
        if (path === '/_internal/mcp-catalog.json') {
          return new Response(JSON.stringify(FIXTURE_CATALOG), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (path === '/registry-index.json') {
          return new Response(JSON.stringify(FIXTURE_REGISTRY_INDEX), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (path === '/discovery-hints-index.json') {
          return new Response(JSON.stringify(FIXTURE_HINTS_INDEX), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher,
    SCORE_CACHE: {
      async get(key: string) {
        cacheStub.getCalls += 1;
        const value = cacheStore.get(key);
        if (!value) return null;
        return {
          async json() {
            return JSON.parse(value);
          },
        };
      },
      async put() {},
      async delete() {},
    } as unknown as R2Bucket,
    SCORE: scoreBinding,
    AUDIT_JOB: opts.jobs,
    SCORE_KV: {
      async get(key: string) {
        kvStub.getCalls += 1;
        return kvStub.store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kvStub.putCalls += 1;
        kvStub.store.set(key, value);
      },
    } as unknown as KVNamespace,
    MCP_LIVE_SCORING_ENABLED: liveScoringEnabled ? 'true' : 'false',
    MCP_CACHE_BYPASS_ALLOWED: opts.cacheBypassAllowed,
    MCP_AUDIT_LIMITER: opts.auditLimiter
      ? {
          async limit({ key }) {
            const stub = opts.auditLimiter as RateStub;
            stub.calls += 1;
            stub.lastKey = key;
            return { success: stub.shouldSucceed };
          },
        }
      : undefined,
  };

  return { env, audit: opts.auditLimiter, kv: kvStub, doSpy, cache: cacheStub };
}

type JsonRpcResult = {
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
};

async function callScoreCli(env: McpEnv, args: Record<string, unknown>, ip?: string): Promise<JsonRpcResult> {
  await mcpInitialize(env);

  const callHeaders: Record<string, string> = {};
  if (ip) callHeaders['cf-connecting-ip'] = ip;

  const { status, body } = await mcpRpc(
    env,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'score_cli', arguments: args },
    },
    callHeaders,
  );
  expect(status).toBe(200);
  return body as JsonRpcResult;
}

function getJsonContent(body: JsonRpcResult): unknown {
  return getJsonToolContent(body as import('./helpers/mcp-rpc').JsonRpcBody);
}

beforeEach(() => {
  resetMcpTestState();
  _resetRegistryIndexCache();
  _resetHintsIndexCache();
});

afterEach(() => {
  resetMcpTestState();
  _resetRegistryIndexCache();
  _resetHintsIndexCache();
});

async function callGetScorecard(env: McpEnv, args: Record<string, unknown>): Promise<JsonRpcResult> {
  await mcpInitialize(env);
  const { status, body } = await mcpRpc(env, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'get_scorecard', arguments: args },
  });
  expect(status).toBe(200);
  return body as JsonRpcResult;
}

// R18: the read tool hands back the shared envelope, so the URLs it mints are
// the route module's and an agent can follow json_url to the identical body.
describe('get_scorecard: the shared envelope', () => {
  test('a curated slug returns tier registry with the three result URLs and the committed scorecard', async () => {
    const { env } = makeEnv();
    const body = getJsonContent(await callGetScorecard(env, { slug: 'curl' })) as Record<string, unknown>;
    expect(body).toMatchObject({
      found: true,
      kind: 'cli',
      tier: 'registry',
      target: 'curl',
      scorecard_url: 'https://anc.dev/score/curl',
      markdown_url: 'https://anc.dev/score/curl/md',
      json_url: 'https://anc.dev/score/curl/json',
    });
    expect(body).not.toHaveProperty('source');
    expect(body.freshness).toEqual({ cached: true, scored_at: null, refresh_after: null });
  });

  test('an R2 cached binary returns tier cache and no retired live path', async () => {
    const { env } = makeEnv({
      cacheContent: {
        [`scores/somelib/${SPEC_VERSION}.json`]: {
          spec_version: SPEC_VERSION,
          scorecard: { tool: { binary: 'somelib' }, results: [] },
          anc_version: ANC_VERSION,
          tool_version: '1.0.0',
        },
      },
    });
    const body = getJsonContent(await callGetScorecard(env, { install: 'npm install -g somelib' })) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      found: true,
      kind: 'cli',
      tier: 'cache',
      target: 'somelib',
      scorecard_url: 'https://anc.dev/score/somelib',
      tool_version: '1.0.0',
    });
    expect(JSON.stringify(body)).not.toContain('/score/live/');
  });

  // A run that has not written yet is not an absence. Answering `next_tool:
  // score_cli` here would send the agent to start a second audit of a target
  // the job already has in hand.
  test('a target already being audited reads as in_progress, not a miss', async () => {
    const startedAt = '2026-09-11T00:00:00.000Z';
    const kv: KvStub = {
      store: new Map([
        [
          'inflight:cli:npm install -g somelib',
          JSON.stringify({ started_at: startedAt, job: 'cli:npm install -g somelib' }),
        ],
      ]),
      getCalls: 0,
      putCalls: 0,
    };
    const { env } = makeEnv({ kv });
    const body = getJsonContent(await callGetScorecard(env, { install: 'npm install -g somelib' })) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ found: false, in_progress: true, started_at: startedAt });
    expect(body).not.toHaveProperty('next_tool');
  });

  test('a miss with nothing in flight still points at score_cli', async () => {
    const { env } = makeEnv();
    const body = getJsonContent(await callGetScorecard(env, { install: 'npm install -g somelib' })) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ found: false, next_tool: 'score_cli' });
    expect(body).not.toHaveProperty('in_progress');
  });
});

describe('score_cli: MCP_LIVE_SCORING_ENABLED kill switch', () => {
  test('disabled returns isError: false + audited: false + disabled message; downstream never runs', async () => {
    const { env, doSpy, kv } = makeEnv({ liveScoringEnabled: false });
    const result = await callScoreCli(env, { slug: 'curl' }, '198.51.100.7');
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as { audited: boolean; message: string };
    expect(body.audited).toBe(false);
    expect(body.message.toLowerCase()).toContain('disabled');
    expect(doSpy.calls.length).toBe(0);
    expect(kv.getCalls).toBe(0);
  });
});

describe('score_cli: lookupOnly cache-state outcomes', () => {
  test('curated slug returns audited: false + source: registry + next_tool: get_scorecard', async () => {
    const { env, doSpy } = makeEnv();
    const result = await callScoreCli(env, { slug: 'curl' }, '198.51.100.7');
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as {
      audited: boolean;
      source: string;
      next_tool: string;
      scorecard_url: string;
    };
    expect(body.audited).toBe(false);
    expect(body.source).toBe('registry');
    expect(body.next_tool).toBe('get_scorecard');
    expect(body.scorecard_url).toBe('https://anc.dev/score/curl');
    expect(doSpy.calls.length).toBe(0);
  });

  test('R2 cached binary returns audited: false + source: live-cache + next_tool: get_scorecard', async () => {
    const { env, doSpy } = makeEnv({
      cacheContent: {
        [`scores/somelib/${SPEC_VERSION}.json`]: {
          spec_version: SPEC_VERSION,
          scorecard: { tool: { binary: 'somelib' }, results: [] },
          anc_version: SPEC_VERSION,
          tool_version: '1.0.0',
        },
      },
    });
    const result = await callScoreCli(env, { install: 'npm install -g somelib' }, '198.51.100.7');
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as { audited: boolean; source: string; next_tool: string };
    expect(body.audited).toBe(false);
    expect(body.source).toBe('live-cache');
    expect(body.next_tool).toBe('get_scorecard');
    expect(doSpy.calls.length).toBe(0);
  });
});

describe('score_cli: bypass_cache argument (staging-only escape hatch)', () => {
  // Fixture: a cached scorecard for `somelib`. Without bypass, lookupOnly's
  // R2 tier short-circuits to live-cache. With bypass + the staging env
  // binding, lookupOnly skips R2 and the audit path runs through to the DO.
  function makeBypassEnv(cacheBypassAllowed?: string) {
    return makeEnv({
      cacheContent: {
        [`scores/somelib/${SPEC_VERSION}.json`]: {
          spec_version: SPEC_VERSION,
          scorecard: { tool: { binary: 'somelib' }, results: [] },
          anc_version: SPEC_VERSION,
          tool_version: '1.0.0',
        },
      },
      cacheBypassAllowed,
    });
  }

  test('bypass_cache: true WITH MCP_CACHE_BYPASS_ALLOWED="true" skips R2 and dispatches DO', async () => {
    const { env, doSpy } = makeBypassEnv('true');
    const result = await callScoreCli(env, { install: 'npm install -g somelib', bypass_cache: true }, '198.51.100.7');
    expect(result.result?.isError).toBeFalsy();
    // With bypass + binding, the cached scorecard is ignored. The DO dispatches
    // through runFreshOnly and returns the fixture's fresh-audit envelope.
    expect(doSpy.calls.length).toBe(1);
  });

  test('bypass_cache: true WITHOUT MCP_CACHE_BYPASS_ALLOWED is silently ignored (prod parity)', async () => {
    const { env, doSpy } = makeBypassEnv(undefined);
    const result = await callScoreCli(env, { install: 'npm install -g somelib', bypass_cache: true }, '198.51.100.7');
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as { audited: boolean; source: string };
    // Bypass arg ignored: cache wins.
    expect(body.audited).toBe(false);
    expect(body.source).toBe('live-cache');
    expect(doSpy.calls.length).toBe(0);
  });

  test('bypass_cache: true WITH MCP_CACHE_BYPASS_ALLOWED="false" (typo / wrong value) is silently ignored', async () => {
    const { env, doSpy } = makeBypassEnv('false');
    const result = await callScoreCli(env, { install: 'npm install -g somelib', bypass_cache: true }, '198.51.100.7');
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as { audited: boolean; source: string };
    // Strict env-var match: only the literal string "true" enables the bypass.
    expect(body.source).toBe('live-cache');
    expect(doSpy.calls.length).toBe(0);
  });

  test('bypass_cache: false WITH MCP_CACHE_BYPASS_ALLOWED="true" respects cache (unchanged baseline)', async () => {
    const { env, doSpy } = makeBypassEnv('true');
    const result = await callScoreCli(env, { install: 'npm install -g somelib', bypass_cache: false }, '198.51.100.7');
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as { source: string };
    expect(body.source).toBe('live-cache');
    expect(doSpy.calls.length).toBe(0);
  });

  test('bypass_cache absent WITH MCP_CACHE_BYPASS_ALLOWED="true" respects cache (unchanged baseline)', async () => {
    const { env, doSpy } = makeBypassEnv('true');
    const result = await callScoreCli(env, { install: 'npm install -g somelib' }, '198.51.100.7');
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as { source: string };
    expect(body.source).toBe('live-cache');
    expect(doSpy.calls.length).toBe(0);
  });

  test('bypass_cache: true does NOT override a curated registry slug (registry always wins)', async () => {
    const { env, doSpy } = makeEnv({ cacheBypassAllowed: 'true' });
    const result = await callScoreCli(env, { slug: 'curl', bypass_cache: true }, '198.51.100.7');
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as { source: string };
    // Curated entries are upstream of the R2 cache tier; bypass cannot reach them.
    expect(body.source).toBe('registry');
    expect(doSpy.calls.length).toBe(0);
  });
});

describe('score_cli: validateInput security gate', () => {
  test('rejected input returns isError: true with the typed validator error', async () => {
    const { env, doSpy } = makeEnv();
    const result = await callScoreCli(env, { install: 'apt-get install evil' }, '198.51.100.7');
    expect(result.result?.isError).toBe(true);
    expect(doSpy.calls.length).toBe(0);
  });
});

describe('score_cli: cf-connecting-ip presence check (no anon fallback)', () => {
  test('missing cf-connecting-ip on cache-miss returns isError: true with -32099', async () => {
    const { env, audit, doSpy } = makeEnv({
      auditLimiter: { calls: 0, shouldSucceed: true },
    });
    // install-command miss path so the cache-miss tier is reached
    const result = await callScoreCli(env, { install: 'npm install -g neverseen' });
    expect(result.result?.isError).toBe(true);
    const text = result.result?.content?.[0]?.text ?? '';
    expect(text).toContain('-32099');
    expect(text.toLowerCase()).toContain('cf-connecting-ip');
    expect(audit?.calls).toBe(0);
    expect(doSpy.calls.length).toBe(0);
  });
});

describe('score_cli: MCP_AUDIT_LIMITER burst gate', () => {
  test('burst-limiter denial returns isError: true with -32099 burst message', async () => {
    const audit: RateStub = { calls: 0, shouldSucceed: false };
    const { env, doSpy } = makeEnv({ auditLimiter: audit });
    const result = await callScoreCli(env, { install: 'npm install -g foo' }, '198.51.100.7');
    expect(result.result?.isError).toBe(true);
    const text = result.result?.content?.[0]?.text ?? '';
    expect(text).toContain('-32099');
    expect(text.toLowerCase()).toContain('burst');
    expect(audit.calls).toBe(1);
    expect(doSpy.calls.length).toBe(0);
  });
});

describe('score_cli: KV-backed per-hour window', () => {
  test('hourly counter at the ceiling returns isError: true with -32099 hourly message', async () => {
    const audit: RateStub = { calls: 0, shouldSucceed: true };
    const kv: KvStub = { store: new Map(), getCalls: 0, putCalls: 0 };
    const ip = '198.51.100.7';
    const bucket = Math.floor(Date.now() / 3_600_000);
    kv.store.set(`mcp_audit:${ip}:${bucket}`, '5');
    const { env, doSpy } = makeEnv({ auditLimiter: audit, kv });
    const result = await callScoreCli(env, { install: 'npm install -g newlib' }, ip);
    expect(result.result?.isError).toBe(true);
    const text = result.result?.content?.[0]?.text ?? '';
    expect(text).toContain('-32099');
    expect(text.toLowerCase()).toContain('5 per hour');
    expect(audit.calls).toBe(1); // burst gate ran but passed
    expect(doSpy.calls.length).toBe(0); // hourly gate blocked before DO dispatch
  });

  test('passing hourly gate increments the KV counter and proceeds to DO dispatch', async () => {
    const audit: RateStub = { calls: 0, shouldSucceed: true };
    const kv: KvStub = { store: new Map(), getCalls: 0, putCalls: 0 };
    const ip = '198.51.100.8';
    const { env, doSpy } = makeEnv({ auditLimiter: audit, kv });
    const result = await callScoreCli(env, { install: 'npm install -g newlib2' }, ip);
    expect(result.result?.isError).toBeFalsy();
    expect(kv.putCalls).toBe(1);
    const bucket = Math.floor(Date.now() / 3_600_000);
    const stored = kv.store.get(`mcp_audit:${ip}:${bucket}`);
    expect(stored).toBe('1');
    expect(doSpy.calls.length).toBe(1);
  });
});

describe('score_cli: happy path fresh audit', () => {
  test('cache miss + passing gates triggers DO dispatch and returns audited: true + source: fresh-audit', async () => {
    const audit: RateStub = { calls: 0, shouldSucceed: true };
    const { env, doSpy } = makeEnv({ auditLimiter: audit });
    const result = await callScoreCli(env, { install: 'npm install -g newcli' }, '198.51.100.9');
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as {
      audited: boolean;
      source: string;
      scorecard_url: string;
      spec_version: string;
    };
    expect(body.audited).toBe(true);
    expect(body.source).toBe('fresh-audit');
    expect(body.scorecard_url).toBe('https://anc.dev/score/newcli');
    expect(body.spec_version).toBe(SPEC_VERSION);
    expect(doSpy.calls.length).toBe(1);
  });

  test('a branch-scoped fresh run names the branch page and carries the SHA it scored', async () => {
    const audit: RateStub = { calls: 0, shouldSucceed: true };
    const { env } = makeEnv({
      auditLimiter: audit,
      doResponse: new Response(
        JSON.stringify({
          scorecard: { tool: { name: 'r', binary: 'r' } },
          anc_version: SPEC_VERSION,
          source_sha: 'e'.repeat(40),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    });
    const result = await callScoreCli(env, { github_url: 'https://github.com/o/r/tree/feature' }, '198.51.100.11');
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as { scorecard_url: string; source_sha?: string };
    expect(body.scorecard_url).toBe('https://anc.dev/score/o/r@feature');
    expect(body.source_sha).toBe('e'.repeat(40));
  });

  test('DO dispatch uses getRandom pool pattern (idFromName called once per request)', async () => {
    const audit: RateStub = { calls: 0, shouldSucceed: true };
    const { env, doSpy } = makeEnv({ auditLimiter: audit });
    await callScoreCli(env, { install: 'npm install -g pooltest' }, '198.51.100.10');
    expect(doSpy.idFromNameCalls).toBe(1);
  });

  test('DO body carries spec + sha256 of raw input as hash', async () => {
    const audit: RateStub = { calls: 0, shouldSucceed: true };
    const { env, doSpy } = makeEnv({ auditLimiter: audit });
    await callScoreCli(env, { install: 'npm install -g hashtest' }, '198.51.100.11');
    expect(doSpy.calls.length).toBe(1);
    const parsed = JSON.parse(doSpy.calls[0].body) as { spec: { binary: string }; hash: string };
    expect(parsed.spec.binary).toBe('hashtest');
    expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('score_cli: post-discovery cache hit', () => {
  test('discovery-resolved binary that matches an R2 entry returns audited: false + cache_post', async () => {
    const audit: RateStub = { calls: 0, shouldSucceed: true };
    const { env, doSpy } = makeEnv({
      auditLimiter: audit,
      cacheContent: {
        [`scores/cachedlib/${SPEC_VERSION}.json`]: {
          spec_version: SPEC_VERSION,
          scorecard: { tool: { binary: 'cachedlib' }, results: [] },
          anc_version: SPEC_VERSION,
          tool_version: '1.0.0',
        },
      },
    });
    // install-command path that resolves to spec.binary === 'cachedlib'.
    // Pre-discovery lookup misses because lookupScorecard derives binary
    // from spec.binary (already known for install-command) and consults
    // the R2 cache there. So this test exercises lookupOnly's cached
    // branch rather than the post-discovery branch — both paths return
    // the same shape.
    const result = await callScoreCli(env, { install: 'npm install -g cachedlib' }, '198.51.100.12');
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as { audited: boolean; source: string; next_tool: string };
    expect(body.audited).toBe(false);
    expect(body.source).toBe('live-cache');
    expect(body.next_tool).toBe('get_scorecard');
    expect(doSpy.calls.length).toBe(0);
  });
});

describe('score_cli: DO error paths', () => {
  test('DO returns error envelope -> isError: true with do_error stage', async () => {
    const audit: RateStub = { calls: 0, shouldSucceed: true };
    const { env } = makeEnv({
      auditLimiter: audit,
      doResponse: new Response(JSON.stringify({ error: 'chain_resolved_install_failed', details: 'apt not on path' }), {
        status: 200,
      }),
    });
    const result = await callScoreCli(env, { install: 'npm install -g errlib' }, '198.51.100.13');
    expect(result.result?.isError).toBe(true);
    const text = result.result?.content?.[0]?.text ?? '';
    expect(text).toContain('chain_resolved_install_failed');
    expect(text).toContain('sandbox');
  });
});

describe('score_cli: a run already in flight', () => {
  const AT = '2026-09-11T00:00:00.000Z';
  const complete = {
    type: 'complete',
    kind: 'cli',
    tier: 'live',
    target: 'newcli',
    scorecard_url: 'https://anc.dev/score/newcli',
    markdown_url: 'https://anc.dev/score/newcli/md',
    json_url: 'https://anc.dev/score/newcli/json',
    freshness: { cached: false, scored_at: AT, refresh_after: null },
    spec_version: SPEC_VERSION,
    anc_version: ANC_VERSION,
    scorecard: { tool: { binary: 'newcli' }, results: [] },
  } as unknown as AuditEvent;

  test('an in-flight binary attaches after the source gates, with no second run and no hourly budget', async () => {
    const jobs = fakeJobNamespace();
    const job = jobs.get(jobs.idFromName('cli:npm install -g somelib'));
    const claim = await job.claim(AT, 90_000);
    if (!claim.claimed) throw new Error('expected a fresh claim');
    await job.append(claim.run, { type: 'accepted', lane: 'cli', target: 'newcli', started_at: AT });
    const kv: KvStub = {
      store: new Map([
        ['inflight:cli:npm install -g somelib', JSON.stringify({ started_at: AT, job: 'cli:npm install -g somelib' })],
      ]),
      getCalls: 0,
      putCalls: 0,
    };
    const audit: RateStub = { calls: 0, shouldSucceed: true };
    const { env, doSpy } = makeEnv({ jobs, kv, auditLimiter: audit });
    setTimeout(() => void job.append(claim.run, complete), 20);
    const result = await callScoreCli(env, { install: 'npm install -g somelib' }, '198.51.100.7');
    expect(result.result?.isError).toBeFalsy();
    expect(getJsonContent(result)).toMatchObject({
      audited: true,
      attached: true,
      source: 'fresh-audit',
      scorecard_url: 'https://anc.dev/score/newcli',
      spec_version: SPEC_VERSION,
    });
    expect(doSpy.calls.length).toBe(0);
    // Attaching holds a request open for the rest of someone else's run, so
    // it passes the per-source burst gate first. The hourly audit budget sits
    // behind the attach and stays untouched.
    expect(audit.calls).toBe(1);
    expect(kv.putCalls).toBe(0);
  });

  test('a caller with no client IP cannot attach to the run in flight', async () => {
    const jobs = fakeJobNamespace();
    const job = jobs.get(jobs.idFromName('cli:npm install -g somelib'));
    const claim = await job.claim(AT, 90_000);
    if (!claim.claimed) throw new Error('expected a fresh claim');
    await job.append(claim.run, complete);
    const kv: KvStub = {
      store: new Map([
        ['inflight:cli:npm install -g somelib', JSON.stringify({ started_at: AT, job: 'cli:npm install -g somelib' })],
      ]),
      getCalls: 0,
      putCalls: 0,
    };
    const { env, doSpy } = makeEnv({ jobs, kv });
    const result = await callScoreCli(env, { install: 'npm install -g somelib' });
    expect(result.result?.isError).toBe(true);
    expect(result.result?.content?.[0]?.text).toContain('cf-connecting-ip');
    expect(doSpy.calls.length).toBe(0);
  });

  test('bypass_cache runs its own audit rather than attaching to the one in flight', async () => {
    const jobs = fakeJobNamespace();
    const job = jobs.get(jobs.idFromName('cli:npm install -g somelib'));
    const claim = await job.claim(AT, 90_000);
    if (!claim.claimed) throw new Error('expected a fresh claim');
    await job.append(claim.run, complete);
    const kv: KvStub = {
      store: new Map([
        ['inflight:cli:npm install -g somelib', JSON.stringify({ started_at: AT, job: 'cli:npm install -g somelib' })],
      ]),
      getCalls: 0,
      putCalls: 0,
    };
    const audit: RateStub = { calls: 0, shouldSucceed: true };
    const { env, doSpy } = makeEnv({ jobs, kv, auditLimiter: audit, cacheBypassAllowed: 'true' });
    const result = await callScoreCli(env, { install: 'npm install -g somelib', bypass_cache: true }, '198.51.100.7');
    // The flag exists to exercise the container path, so it may not be served
    // by another run's result.
    expect(doSpy.calls.length).toBe(1);
    expect(getJsonContent(result)).not.toMatchObject({ attached: true });
  });

  test('an attached run that bounced is a tool error naming the code', async () => {
    const jobs = fakeJobNamespace();
    const job = jobs.get(jobs.idFromName('cli:npm install -g somelib'));
    const claim = await job.claim(AT, 90_000);
    if (!claim.claimed) throw new Error('expected a fresh claim');
    await job.append(claim.run, {
      type: 'bounce',
      error: { code: 'chain_no_resolve', message: 'x', cta: 'y' },
    });
    const kv: KvStub = {
      store: new Map([
        ['inflight:cli:npm install -g somelib', JSON.stringify({ started_at: AT, job: 'cli:npm install -g somelib' })],
      ]),
      getCalls: 0,
      putCalls: 0,
    };
    const { env, doSpy } = makeEnv({ jobs, kv });
    const result = await callScoreCli(env, { install: 'npm install -g somelib' }, '198.51.100.7');
    expect(result.result?.isError).toBe(true);
    expect(getJsonContent(result)).toMatchObject({ error: 'chain_no_resolve', stage: 'attached' });
    expect(doSpy.calls.length).toBe(0);
  });
});
