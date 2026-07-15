// Web-rescore Workflow tests: seed fan-out (one step per domain), the
// final rebuild-aggregate step as the completion barrier, per-domain
// failure isolation, and the runtime seed loader. The Workflow body is
// exercised through runWebRescore with a fake step and an injected audit
// so no live network is touched.

import { beforeEach, describe, expect, test } from 'bun:test';
import { rebuildWebAggregates } from '../src/worker/audit-web/aggregate';
import {
  type CachedWebAudit,
  get as cacheGet,
  put as cachePut,
  getAggregate,
  keyFor,
} from '../src/worker/audit-web/cache';
import {
  type RescoreStep,
  runWebRescore,
  type WebRescoreEnv,
  WebRescoreWorkflow,
} from '../src/worker/audit-web/rescore-workflow';
import { isSeededDomain, loadWebSeed, resetWebSeedCacheForTests } from '../src/worker/audit-web/seed';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

function seedEntry(domain: string) {
  return { domain, url: `https://${domain}/`, name: domain, description: `about ${domain}` };
}

function makeEnv(seed: unknown): { env: WebRescoreEnv; store: Map<string, string> } {
  const store = new Map<string, string>();
  const env = {
    ASSETS: {
      async fetch(req: Request): Promise<Response> {
        const path = new URL(req.url).pathname;
        if (path === '/_internal/web-seed.json') {
          return new Response(JSON.stringify(seed), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher,
    SCORE_CACHE: {
      async get(key: string) {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return {
          async json() {
            return JSON.parse(raw);
          },
        };
      },
      async put(key: string, value: unknown) {
        store.set(key, typeof value === 'string' ? value : String(value));
      },
      async delete(key: string) {
        store.delete(key);
      },
    } as unknown as R2Bucket,
  } as WebRescoreEnv;
  return { env, store };
}

/** Fake WorkflowStep: records step names in execution order, runs closures inline. */
function makeStep(): { step: RescoreStep; names: string[] } {
  const names: string[] = [];
  const step = {
    async do<T>(name: string, configOrFn: unknown, maybeFn?: () => Promise<T>): Promise<T> {
      const fn = (typeof configOrFn === 'function' ? configOrFn : maybeFn) as () => Promise<T>;
      names.push(name);
      return fn();
    },
  } as RescoreStep;
  return { step, names };
}

function scorecardFor(domain: string, globalScore: number, relative = globalScore + 5) {
  return {
    schema_version: '0.2',
    spec_version: SPEC_VERSION,
    target_url: `https://${domain}/`,
    score_pct: relative,
    score: { relative, global: globalScore },
    results: [],
  };
}

/** Injected audit: caches a deterministic scorecard, throwing for listed domains. */
function stubAudit(scores: Record<string, number>, failFor: Set<string> = new Set()) {
  return async (env: WebRescoreEnv, targetUrl: string): Promise<void> => {
    const domain = new URL(targetUrl).host;
    if (failFor.has(domain)) throw new Error(`boom: ${domain}`);
    await cachePut(env, targetUrl, scorecardFor(domain, scores[domain] ?? 0), SPEC_VERSION);
  };
}

beforeEach(() => {
  resetWebSeedCacheForTests();
});

describe('loadWebSeed', () => {
  test('loads valid entries and defaults a missing description', async () => {
    const { env } = makeEnv([{ domain: 'a.dev', url: 'https://a.dev/', name: 'a.dev' }]);
    const entries = await loadWebSeed(env);
    expect(entries).toEqual([{ domain: 'a.dev', url: 'https://a.dev/', name: 'a.dev', description: '' }]);
  });

  test('skips malformed entries instead of failing the load', async () => {
    const { env } = makeEnv([seedEntry('a.dev'), { domain: 'no-url.dev' }, 'nonsense']);
    const entries = await loadWebSeed(env);
    expect(entries.map((e) => e.domain)).toEqual(['a.dev']);
  });

  test('throws when the seed asset is missing (fail-fast, not an empty board)', async () => {
    const env = {
      ASSETS: {
        async fetch() {
          return new Response('not found', { status: 404 });
        },
      },
    } as unknown as WebRescoreEnv;
    await expect(loadWebSeed(env)).rejects.toThrow(/web seed fetch failed/);
  });

  test('isSeededDomain matches by host', async () => {
    const { env } = makeEnv([seedEntry('a.dev')]);
    expect(await isSeededDomain(env, 'a.dev')).toBe(true);
    expect(await isSeededDomain(env, 'b.dev')).toBe(false);
  });
});

describe('runWebRescore', () => {
  test('audits every seeded domain and writes per-domain entries with scored_at', async () => {
    const { env } = makeEnv([seedEntry('a.dev'), seedEntry('b.dev'), seedEntry('c.dev')]);
    const { step } = makeStep();
    const result = await runWebRescore(env, step, { audit: stubAudit({ 'a.dev': 70, 'b.dev': 80, 'c.dev': 60 }) });
    expect(result.audited).toEqual(['a.dev', 'b.dev', 'c.dev']);
    expect(result.skipped).toEqual([]);
    for (const domain of ['a.dev', 'b.dev', 'c.dev']) {
      const cached = (await cacheGet(env, await keyFor(`https://${domain}/`, SPEC_VERSION))) as CachedWebAudit;
      expect(cached).not.toBeNull();
      expect(typeof cached.scored_at).toBe('string');
    }
  });

  test('the final step rebuilds both aggregates from the per-domain entries', async () => {
    const { env } = makeEnv([seedEntry('a.dev'), seedEntry('b.dev')]);
    const { step } = makeStep();
    await runWebRescore(env, step, { audit: stubAudit({ 'a.dev': 70, 'b.dev': 80 }) });
    const board = await getAggregate(env, 'leaderboard', SPEC_VERSION);
    expect(board?.entries.map((e) => e.domain)).toEqual(['b.dev', 'a.dev']);
    expect(board?.entries[0]).toMatchObject({
      domain: 'b.dev',
      url: 'https://b.dev/',
      name: 'b.dev',
      description: 'about b.dev',
      score_pct: 85,
      score: { relative: 85, global: 80 },
    });
    const frontpage = await getAggregate(env, 'leaderboard-frontpage', SPEC_VERSION);
    expect(frontpage?.entries.map((e) => e.domain)).toEqual(['b.dev', 'a.dev']);
  });

  test('leaderboard-frontpage is the top-N slice of the global-sorted board', async () => {
    const domains = ['a.dev', 'b.dev', 'c.dev', 'd.dev', 'e.dev', 'f.dev'];
    const scores = Object.fromEntries(domains.map((d, i) => [d, 10 * (i + 1)]));
    const { env } = makeEnv(domains.map(seedEntry));
    const { step } = makeStep();
    await runWebRescore(env, step, { audit: stubAudit(scores) });
    const board = await getAggregate(env, 'leaderboard', SPEC_VERSION);
    const frontpage = await getAggregate(env, 'leaderboard-frontpage', SPEC_VERSION);
    expect(board?.entries).toHaveLength(6);
    expect(frontpage?.entries).toHaveLength(5);
    expect(frontpage?.entries.map((e) => e.domain)).toEqual(['f.dev', 'e.dev', 'd.dev', 'c.dev', 'b.dev']);
  });

  test('a domain whose audit throws is skipped; the run completes and the board omits it', async () => {
    const { env } = makeEnv([seedEntry('a.dev'), seedEntry('bad.dev'), seedEntry('c.dev')]);
    const { step } = makeStep();
    const result = await runWebRescore(env, step, {
      audit: stubAudit({ 'a.dev': 70, 'c.dev': 60 }, new Set(['bad.dev'])),
    });
    expect(result.audited).toEqual(['a.dev', 'c.dev']);
    expect(result.skipped).toEqual(['bad.dev']);
    const board = await getAggregate(env, 'leaderboard', SPEC_VERSION);
    expect(board?.entries.map((e) => e.domain)).toEqual(['a.dev', 'c.dev']);
  });

  test('the aggregate rebuild runs after every audit step', async () => {
    const { env } = makeEnv([seedEntry('a.dev'), seedEntry('b.dev')]);
    const { step, names } = makeStep();
    await runWebRescore(env, step, { audit: stubAudit({ 'a.dev': 70, 'b.dev': 80 }) });
    expect(names).toEqual(['load-seed', 'audit:a.dev', 'audit:b.dev', 'rebuild-aggregate']);
  });

  test('an injected rebuild receives the env and spec version', async () => {
    const { env } = makeEnv([seedEntry('a.dev')]);
    const { step } = makeStep();
    const calls: string[] = [];
    await runWebRescore(env, step, {
      audit: stubAudit({ 'a.dev': 70 }),
      rebuild: async (_env, specVersion) => {
        calls.push(specVersion);
      },
    });
    expect(calls).toEqual([SPEC_VERSION]);
  });
});

describe('rebuildWebAggregates', () => {
  test('a seeded domain with no cached entry is omitted, not fatal', async () => {
    const { env } = makeEnv([seedEntry('a.dev'), seedEntry('never-scored.dev')]);
    await cachePut(env, 'https://a.dev/', scorecardFor('a.dev', 70), SPEC_VERSION);
    const result = await rebuildWebAggregates(env, SPEC_VERSION);
    expect(result).toEqual({ seeded: 2, scored: 1 });
    const board = await getAggregate(env, 'leaderboard', SPEC_VERSION);
    expect(board?.entries.map((e) => e.domain)).toEqual(['a.dev']);
  });

  test('an empty seed writes empty aggregates (cold-start shape, not an error)', async () => {
    const { env } = makeEnv([]);
    await rebuildWebAggregates(env, SPEC_VERSION);
    const board = await getAggregate(env, 'leaderboard', SPEC_VERSION);
    expect(board?.entries).toEqual([]);
  });
});

describe('WebRescoreWorkflow entrypoint', () => {
  test('run drives the same body: seed steps then the rebuild barrier', async () => {
    const { env } = makeEnv([seedEntry('a.dev')]);
    // The bun-test cloudflare:workers shim constructs with (ctx, env).
    const wf = new WebRescoreWorkflow({} as ExecutionContext, env);
    const { step, names } = makeStep();
    // Real audit would hit the network; the entrypoint path is exercised
    // with the seed load + rebuild only by letting the audit step fail.
    const result = (await wf.run({ payload: {}, timestamp: new Date(), instanceId: 'test' }, step as never)) as {
      audited: string[];
      skipped: string[];
    };
    expect(result.skipped).toEqual(['a.dev']);
    expect(names).toEqual(['load-seed', 'audit:a.dev', 'rebuild-aggregate']);
  });
});
