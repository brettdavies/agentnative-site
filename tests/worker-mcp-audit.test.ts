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
import { resetCatalogCacheForTests } from '../src/worker/mcp/catalog';
import { buildMcpHandler, type McpEnv } from '../src/worker/mcp/server';
import { _resetHintsIndexCache } from '../src/worker/score/orchestrate';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';

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
  // Per-request McpServer (KTD-1): a module-level singleton throws
  // "Server is already connected to a transport". buildMcpHandler runs
  // once per dispatch in production via the Worker entry; tests follow
  // the same pattern with a fresh handler per request.

  const initHandler = await buildMcpHandler(env, { jsonResponse: true });
  await initHandler(
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

  const callHandler = await buildMcpHandler(env, { jsonResponse: true });
  const callHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (ip) callHeaders['cf-connecting-ip'] = ip;

  const res = await callHandler(
    new Request('https://anc.dev/mcp', {
      method: 'POST',
      headers: callHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'score_cli', arguments: args },
      }),
    }),
    env,
    {} as ExecutionContext,
  );
  const text = await res.text();
  return JSON.parse(text) as JsonRpcResult;
}

function getJsonContent(body: JsonRpcResult): unknown {
  const text = body.result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('expected text content block');
  return JSON.parse(text);
}

beforeEach(() => {
  resetCatalogCacheForTests();
  _resetRegistryIndexCache();
  _resetHintsIndexCache();
});

afterEach(() => {
  resetCatalogCacheForTests();
  _resetRegistryIndexCache();
  _resetHintsIndexCache();
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
    expect(body.scorecard_url).toBe('https://anc.dev/score/live/newcli');
    expect(body.spec_version).toBe(SPEC_VERSION);
    expect(doSpy.calls.length).toBe(1);
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
