// orchestrate.ts tests — both intents (lookupOnly + runFreshOnly).
//
// U3 landed lookupOnly as a thin wrapper around lookupScorecard; this
// file exercises both intents end-to-end against stubbed DO + R2 + KV
// per the cloudflare-workers-do-mock-must-mirror-binding-shape solutions
// doc. The mock chain has the call-site shape (idFromName -> get ->
// {fetch}) so getRandom resolves the same way it would in workerd.
//
// Scope: orchestrate.ts pipeline only. The metered gates (Turnstile,
// session, SCORE_LIMITER on the human form; MCP_AUDIT_LIMITER + KV
// hourly window on the MCP form) live in the callers (handler.ts and
// scorecard-audit.ts) and are tested there.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _resetHintsIndexCache, lookupOnly, type OrchestrateEnv, runFreshOnly } from '../src/worker/score/orchestrate';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import type { ValidatedInput } from '../src/worker/score/validate';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

const FIXTURE_REGISTRY_INDEX = {
  by_slug: {
    curl: {
      name: 'curl',
      binary: 'curl',
      install: 'brew install curl',
      version: '8.20.0',
      anc_version: SPEC_VERSION,
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
      anc_version: SPEC_VERSION,
      scorecard_url: '/score/curl',
      score_pct: 73,
      repo: 'curl/curl',
    },
  },
};

const FIXTURE_HINTS_INDEX = { by_owner_repo: {} };

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
  scoreBinding?: boolean;
  doResponse?: Response;
  cacheContent?: Record<string, unknown>;
}

function makeOrchestrateEnv(opts: MakeEnvOpts = {}): {
  env: OrchestrateEnv;
  doSpy: DoFetchSpy;
  cache: CacheStub;
} {
  const doSpy: DoFetchSpy = {
    calls: [],
    response:
      opts.doResponse ??
      new Response(
        JSON.stringify({
          scorecard: { tool: { binary: 'newcli' }, results: [] },
          anc_version: SPEC_VERSION,
          install_ms: 12_345,
          anc_audit_ms: 6789,
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

  const env: OrchestrateEnv = {
    ASSETS: {
      async fetch(req: Request): Promise<Response> {
        const path = new URL(req.url).pathname;
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
      async put() {
        // Not exercised — runFreshOnly never writes the cache; the DO
        // does that via writeCacheBestEffort.
      },
      async delete() {
        // cache.get's corrupted_payload path calls delete; provide a
        // no-op so the test mock doesn't throw if the schema check
        // unexpectedly fires.
      },
    } as unknown as R2Bucket,
    SCORE: scoreBinding,
  };

  return { env, doSpy, cache: cacheStub };
}

beforeEach(() => {
  _resetRegistryIndexCache();
  _resetHintsIndexCache();
});

afterEach(() => {
  _resetRegistryIndexCache();
  _resetHintsIndexCache();
});

describe('lookupOnly: thin wrapper over lookupScorecard', () => {
  test('curated slug returns the registry entry', async () => {
    const { env } = makeOrchestrateEnv();
    const input: ValidatedInput = { kind: 'slug', slug: 'curl' };
    const result = await lookupOnly(input, env, FIXTURE_REGISTRY_INDEX, FIXTURE_HINTS_INDEX, {
      specVersion: SPEC_VERSION,
    });
    expect(result.kind).toBe('curated');
    if (result.kind === 'curated') {
      expect(result.entry.name).toBe('curl');
    }
  });

  test('unknown slug returns miss', async () => {
    const { env } = makeOrchestrateEnv();
    const input: ValidatedInput = { kind: 'slug', slug: 'unknown' };
    const result = await lookupOnly(input, env, FIXTURE_REGISTRY_INDEX, FIXTURE_HINTS_INDEX, {
      specVersion: SPEC_VERSION,
    });
    expect(result.kind).toBe('miss');
  });
});

describe('runFreshOnly: resolveSpec failure exits before any DO call', () => {
  test('bare slug that misses the registry returns resolution_error chain_no_resolve; DO untouched', async () => {
    const { env, doSpy } = makeOrchestrateEnv();
    const input: ValidatedInput = { kind: 'slug', slug: 'never-seen' };
    const result = await runFreshOnly(input, env, FIXTURE_HINTS_INDEX, {
      specVersion: SPEC_VERSION,
      inputHash: 'deadbeef',
    });
    expect(result.kind).toBe('resolution_error');
    if (result.kind === 'resolution_error') {
      expect(result.error).toBe('chain_no_resolve');
    }
    expect(doSpy.calls.length).toBe(0);
    expect(doSpy.idFromNameCalls).toBe(0);
  });
});

describe('runFreshOnly: sandbox_unavailable when SCORE binding is missing', () => {
  test('missing SCORE returns sandbox_unavailable kind with spec attribution', async () => {
    const { env, doSpy } = makeOrchestrateEnv({ scoreBinding: false });
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'npm', package: 'fakepkg', binary: 'fakepkg' },
    };
    const result = await runFreshOnly(input, env, FIXTURE_HINTS_INDEX, {
      specVersion: SPEC_VERSION,
      inputHash: 'deadbeef',
    });
    expect(result.kind).toBe('sandbox_unavailable');
    // spec is threaded onto the error variant so handler.ts can preserve
    // AE-row attribution (binary/pm/resolved_step) on sandbox errors.
    if (result.kind === 'sandbox_unavailable') {
      expect(result.spec?.binary).toBe('fakepkg');
      expect(result.spec?.pm).toBe('npm');
    }
    expect(doSpy.calls.length).toBe(0);
  });
});

describe('runFreshOnly: post-discovery cache lookup', () => {
  test('cache hit at the post-discovery tier returns cache_post_hit; DO untouched', async () => {
    const cachedScorecard = { tool: { binary: 'fakepkg' }, results: [] };
    const { env, doSpy } = makeOrchestrateEnv({
      cacheContent: {
        [`scores/fakepkg/${SPEC_VERSION}.json`]: {
          spec_version: SPEC_VERSION,
          scorecard: cachedScorecard,
          anc_version: SPEC_VERSION,
          tool_version: '1.2.3',
        },
      },
    });
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'npm', package: 'fakepkg', binary: 'fakepkg' },
    };
    const result = await runFreshOnly(input, env, FIXTURE_HINTS_INDEX, {
      specVersion: SPEC_VERSION,
      inputHash: 'deadbeef',
    });
    expect(result.kind).toBe('cache_post_hit');
    if (result.kind === 'cache_post_hit') {
      expect(result.spec.binary).toBe('fakepkg');
      expect((result.scorecard as { tool: { binary: string } }).tool.binary).toBe('fakepkg');
    }
    expect(doSpy.calls.length).toBe(0);
  });

  test('skipCachePost flag bypasses the post-discovery cache read', async () => {
    const cachedScorecard = { tool: { binary: 'fakepkg' }, results: [] };
    const { env, doSpy, cache } = makeOrchestrateEnv({
      cacheContent: {
        [`scores/fakepkg/${SPEC_VERSION}.json`]: {
          spec_version: SPEC_VERSION,
          scorecard: cachedScorecard,
          anc_version: SPEC_VERSION,
          tool_version: '1.2.3',
        },
      },
    });
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'npm', package: 'fakepkg', binary: 'fakepkg' },
    };
    const result = await runFreshOnly(input, env, FIXTURE_HINTS_INDEX, {
      specVersion: SPEC_VERSION,
      inputHash: 'deadbeef',
      skipCachePost: true,
    });
    expect(result.kind).toBe('fresh');
    expect(cache.getCalls).toBe(0);
    expect(doSpy.calls.length).toBe(1);
  });
});

describe('runFreshOnly: DO dispatch', () => {
  test('happy path returns kind: fresh with scorecard + anc_version + spec + timings', async () => {
    const { env, doSpy } = makeOrchestrateEnv();
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'npm', package: 'newcli', binary: 'newcli' },
    };
    const result = await runFreshOnly(input, env, FIXTURE_HINTS_INDEX, {
      specVersion: SPEC_VERSION,
      inputHash: 'beefcafe',
    });
    expect(result.kind).toBe('fresh');
    if (result.kind === 'fresh') {
      expect((result.scorecard as { tool: { binary: string } }).tool.binary).toBe('newcli');
      expect(result.anc_version).toBe(SPEC_VERSION);
      expect(result.spec.binary).toBe('newcli');
      expect(result.install_ms).toBe(12_345);
      expect(result.anc_audit_ms).toBe(6789);
    }
    expect(doSpy.calls.length).toBe(1);
    // DO body shape matches handler.ts's body shape: { spec, hash }.
    const bodyParsed = JSON.parse(doSpy.calls[0].body) as { spec: { binary: string }; hash: string };
    expect(bodyParsed.spec.binary).toBe('newcli');
    expect(bodyParsed.hash).toBe('beefcafe');
  });

  test('DO dispatch uses idFromName via getRandom (pool pattern); never the single-instance idFromName', async () => {
    const { env, doSpy } = makeOrchestrateEnv();
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'npm', package: 'pooltest', binary: 'pooltest' },
    };
    await runFreshOnly(input, env, FIXTURE_HINTS_INDEX, {
      specVersion: SPEC_VERSION,
      inputHash: 'deadbeef',
    });
    // getRandom calls idFromName once per dispatch — the pool pattern
    // wraps it. The orchestrator itself never calls idFromName directly,
    // so a single call here is the signature of getRandom-via-pool.
    expect(doSpy.idFromNameCalls).toBe(1);
  });

  test('DO returns sandbox_stub_until_u6 envelope → kind: sandbox_stub_until_u6 with spec attribution', async () => {
    const { env } = makeOrchestrateEnv({
      doResponse: new Response(JSON.stringify({ error: 'sandbox_stub_until_u6' }), { status: 200 }),
    });
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'npm', package: 'pkg', binary: 'pkg' },
    };
    const result = await runFreshOnly(input, env, FIXTURE_HINTS_INDEX, {
      specVersion: SPEC_VERSION,
      inputHash: 'd',
    });
    expect(result.kind).toBe('sandbox_stub_until_u6');
    if (result.kind === 'sandbox_stub_until_u6') {
      expect(result.spec?.binary).toBe('pkg');
      expect(result.spec?.pm).toBe('npm');
    }
  });

  test('DO returns error envelope → kind: do_error', async () => {
    const { env } = makeOrchestrateEnv({
      doResponse: new Response(JSON.stringify({ error: 'chain_resolved_install_failed', details: 'apt not on path' }), {
        status: 200,
      }),
    });
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'npm', package: 'pkg', binary: 'pkg' },
    };
    const result = await runFreshOnly(input, env, FIXTURE_HINTS_INDEX, {
      specVersion: SPEC_VERSION,
      inputHash: 'd',
    });
    expect(result.kind).toBe('do_error');
    if (result.kind === 'do_error') {
      expect(result.error).toBe('chain_resolved_install_failed');
      expect(result.details).toBe('apt not on path');
      expect(result.spec.binary).toBe('pkg');
    }
  });

  test('DO returns non-JSON body → kind: incomplete_response_contract reason non_json_body with spec attribution', async () => {
    const { env } = makeOrchestrateEnv({
      doResponse: new Response('not json', { status: 200 }),
    });
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'npm', package: 'pkg', binary: 'pkg' },
    };
    const result = await runFreshOnly(input, env, FIXTURE_HINTS_INDEX, {
      specVersion: SPEC_VERSION,
      inputHash: 'd',
    });
    expect(result.kind).toBe('incomplete_response_contract');
    if (result.kind === 'incomplete_response_contract') {
      expect(result.reason).toBe('non_json_body');
      expect(result.spec?.binary).toBe('pkg');
      expect(result.spec?.pm).toBe('npm');
    }
  });

  test('DO returns unrecognized JSON shape → kind: incomplete_response_contract reason unrecognized_envelope with spec attribution', async () => {
    const { env } = makeOrchestrateEnv({
      doResponse: new Response(JSON.stringify({ ok: true, payload: 42 }), { status: 200 }),
    });
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'npm', package: 'pkg', binary: 'pkg' },
    };
    const result = await runFreshOnly(input, env, FIXTURE_HINTS_INDEX, {
      specVersion: SPEC_VERSION,
      inputHash: 'd',
    });
    expect(result.kind).toBe('incomplete_response_contract');
    if (result.kind === 'incomplete_response_contract') {
      expect(result.reason).toBe('unrecognized_envelope');
      expect(result.spec?.binary).toBe('pkg');
      expect(result.spec?.pm).toBe('npm');
    }
  });
});

describe('runFreshOnly: git-clone branch-scoped specs skip the post-discovery cache', () => {
  test('branch-scoped spec proceeds straight to DO without consulting cache.get', async () => {
    const cachedShouldNotBeRead = { tool: { binary: 'repo' }, results: [] };
    const { env, doSpy, cache } = makeOrchestrateEnv({
      cacheContent: {
        [`scores/repo/${SPEC_VERSION}.json`]: {
          spec_version: SPEC_VERSION,
          scorecard: cachedShouldNotBeRead,
          anc_version: SPEC_VERSION,
          tool_version: '1.0.0',
        },
      },
    });
    const input: ValidatedInput = {
      kind: 'github-url',
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
    };
    const result = await runFreshOnly(input, env, FIXTURE_HINTS_INDEX, {
      specVersion: SPEC_VERSION,
      inputHash: 'd',
    });
    expect(result.kind).toBe('fresh');
    // Cache read was skipped because spec.pm === 'git-clone'; DO was
    // invoked instead.
    expect(cache.getCalls).toBe(0);
    expect(doSpy.calls.length).toBe(1);
  });
});
