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

const HOUR_MS = 60 * 60_000;

/** Pre-populate a domain's cache entry with a chosen audit age, bypassing put's now-stamp. */
async function primeCache(store: Map<string, string>, domain: string, agoMs: number, globalScore = 50): Promise<void> {
  const url = `https://${domain}/`;
  const payload = {
    spec_version: SPEC_VERSION,
    target_url: url,
    scorecard: scorecardFor(domain, globalScore),
    scored_at: new Date(Date.now() - agoMs).toISOString(),
  };
  store.set(await keyFor(url, SPEC_VERSION), JSON.stringify(payload));
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

  test('leaderboard-frontpage is the top-N slice by site score (relative)', async () => {
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

  test('a cycle selects, audits its batch, rebuilds, then a final empty select ends the run', async () => {
    const { env } = makeEnv([seedEntry('a.dev'), seedEntry('b.dev')]);
    const { step, names } = makeStep();
    await runWebRescore(env, step, { audit: stubAudit({ 'a.dev': 70, 'b.dev': 80 }) });
    expect(names).toEqual(['load-seed', 'select:0', 'audit:a.dev', 'audit:b.dev', 'rebuild:0', 'select:1']);
  });

  test('skips a domain audited within the eligibility window; audits the stale one', async () => {
    const { env, store } = makeEnv([seedEntry('fresh.dev'), seedEntry('stale.dev')]);
    await primeCache(store, 'fresh.dev', 60_000, 40); // audited 1 minute ago
    const { step } = makeStep();
    const result = await runWebRescore(env, step, { audit: stubAudit({ 'stale.dev': 80 }) });
    expect(result.audited).toEqual(['stale.dev']);
    expect(result.skipped).toEqual([]);
    const cached = (await cacheGet(env, await keyFor('https://fresh.dev/', SPEC_VERSION))) as CachedWebAudit;
    expect((cached.scorecard as { score: { global: number } }).score.global).toBe(40); // untouched
  });

  test('drains a queue larger than the batch, oldest-first, in bounded cycles', async () => {
    const domains = ['d1.dev', 'd2.dev', 'd3.dev', 'd4.dev', 'd5.dev'];
    const { env } = makeEnv(domains.map(seedEntry));
    const { step } = makeStep();
    const result = await runWebRescore(env, step, {
      audit: stubAudit(Object.fromEntries(domains.map((d) => [d, 50]))),
      batchSize: 2,
    });
    expect(result.audited).toEqual(domains);
    expect(result.cycles).toBe(3); // 2 + 2 + 1
  });

  test('audits the stalest domains first', async () => {
    const { env, store } = makeEnv([seedEntry('new.dev'), seedEntry('old.dev'), seedEntry('mid.dev')]);
    await primeCache(store, 'new.dev', 3 * HOUR_MS);
    await primeCache(store, 'old.dev', 5 * HOUR_MS);
    await primeCache(store, 'mid.dev', 4 * HOUR_MS);
    const { step } = makeStep();
    const result = await runWebRescore(env, step, {
      audit: stubAudit({ 'new.dev': 10, 'old.dev': 20, 'mid.dev': 30 }),
      batchSize: 1,
    });
    expect(result.audited).toEqual(['old.dev', 'mid.dev', 'new.dev']);
  });

  test('a permanently failing domain is attempted once and cannot spin the loop', async () => {
    const { env } = makeEnv([seedEntry('a.dev'), seedEntry('bad.dev'), seedEntry('c.dev')]);
    const { step } = makeStep();
    const result = await runWebRescore(env, step, {
      audit: stubAudit({ 'a.dev': 70, 'c.dev': 60 }, new Set(['bad.dev'])),
      batchSize: 1,
    });
    expect(result.audited).toEqual(['a.dev', 'c.dev']);
    expect(result.skipped).toEqual(['bad.dev']);
    expect(result.cycles).toBe(3); // a, bad, c — then empty; bad never re-fills
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

  test('/web ranks by global; the homepage pane ranks by site score (relative)', async () => {
    const { env } = makeEnv([seedEntry('a.dev'), seedEntry('b.dev')]);
    // b leads on global, a leads on relative — the two boards disagree on order.
    await cachePut(env, 'https://a.dev/', scorecardFor('a.dev', 60, 90), SPEC_VERSION);
    await cachePut(env, 'https://b.dev/', scorecardFor('b.dev', 80, 70), SPEC_VERSION);
    await rebuildWebAggregates(env, SPEC_VERSION);
    const board = await getAggregate(env, 'leaderboard', SPEC_VERSION);
    const frontpage = await getAggregate(env, 'leaderboard-frontpage', SPEC_VERSION);
    expect(board?.entries.map((e) => e.domain)).toEqual(['b.dev', 'a.dev']);
    expect(frontpage?.entries.map((e) => e.domain)).toEqual(['a.dev', 'b.dev']);
  });

  test('anc.dev always appears in the homepage pane, in score order, even when low-scoring', async () => {
    const highs = ['x1.dev', 'x2.dev', 'x3.dev', 'x4.dev', 'x5.dev'];
    const { env } = makeEnv([...highs.map(seedEntry), seedEntry('anc.dev')]);
    for (const [i, d] of highs.entries()) {
      await cachePut(env, `https://${d}/`, scorecardFor(d, 90 - i, 90 - i), SPEC_VERSION);
    }
    await cachePut(env, 'https://anc.dev/', scorecardFor('anc.dev', 10, 10), SPEC_VERSION);
    await rebuildWebAggregates(env, SPEC_VERSION);
    const frontpage = await getAggregate(env, 'leaderboard-frontpage', SPEC_VERSION);
    const domains = frontpage?.entries.map((e) => e.domain) ?? [];
    expect(domains).toHaveLength(5);
    expect(domains).toContain('anc.dev');
    expect(domains[domains.length - 1]).toBe('anc.dev'); // lowest score sorts last
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
    expect(names).toEqual(['load-seed', 'select:0', 'audit:a.dev', 'rebuild:0', 'select:1']);
  });
});
