// R2 web-audit cache tests (plan U6). Complete-only, keyed by a
// SHA-256 of the normalized URL, mirroring src/worker/score/cache.ts.

import { describe, expect, test } from 'bun:test';
import {
  aggregateKeyFor,
  type CachedWebAudit,
  get,
  getAggregate,
  isStale,
  keyFor,
  normalizeTargetUrl,
  put,
  putAggregate,
  type WebAggregateEntry,
  type WebCacheEnv,
} from '../src/worker/audit-web/cache';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

type StubOpts = { throwOnGet?: boolean; throwOnPut?: boolean; prefill?: Record<string, unknown> };

function makeR2Stub(opts: StubOpts = {}): { env: WebCacheEnv; store: Map<string, string>; deletedKeys: string[] } {
  const store = new Map<string, string>();
  const deletedKeys: string[] = [];
  if (opts.prefill) {
    for (const [k, v] of Object.entries(opts.prefill)) {
      store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  }
  const env: WebCacheEnv = {
    SCORE_CACHE: {
      async get(key: string) {
        if (opts.throwOnGet) throw new Error('r2_get_failed');
        const raw = store.get(key);
        if (raw === undefined) return null;
        return {
          async json() {
            return JSON.parse(raw);
          },
          async text() {
            return raw;
          },
        };
      },
      async put(key: string, value: unknown) {
        if (opts.throwOnPut) throw new Error('r2_put_failed');
        store.set(key, typeof value === 'string' ? value : String(value));
      },
      async delete(key: string) {
        deletedKeys.push(key);
        store.delete(key);
      },
    } as unknown as R2Bucket,
  };
  return { env, store, deletedKeys };
}

function sampleScorecard(url: string) {
  return {
    schema_version: '0.1',
    spec_version: SPEC_VERSION,
    target_url: url,
    mcp_endpoint: null,
    tool: { name: 'example.com', url },
    badge: { score_pct: 82, eligible: false },
    results: [],
    coverage_summary: {
      must: { total: 0, verified: 0 },
      should: { total: 0, verified: 0 },
      may: { total: 0, verified: 0 },
    },
    summary: { pass: 0, fail: 0, n_a: 0, skip: 0, error: 0 },
  };
}

describe('normalizeTargetUrl', () => {
  test('lowercases the host and canonicalizes the scheme + trailing slash', () => {
    expect(normalizeTargetUrl('HTTPS://Example.COM')).toBe('https://example.com/');
    expect(normalizeTargetUrl('https://example.com')).toBe('https://example.com/');
  });

  test('two URLs differing only by trailing slash normalize identically', () => {
    expect(normalizeTargetUrl('https://example.com/')).toBe(normalizeTargetUrl('https://example.com'));
  });

  test('drops the fragment but keeps a meaningful path', () => {
    expect(normalizeTargetUrl('https://example.com/docs#intro')).toBe('https://example.com/docs');
  });
});

describe('cache.keyFor', () => {
  test('is a hex-hash key under audits/web/ with the spec-version slot', async () => {
    const key = await keyFor('https://example.com/', '9.9.9');
    expect(key).toMatch(/^audits\/web\/[0-9a-f]{64}\/9\.9\.9\.json$/);
  });

  test('trailing-slash and case variants collapse to the same key (no split)', async () => {
    const a = await keyFor('https://example.com', '9.9.9');
    const b = await keyFor('https://Example.com/', '9.9.9');
    expect(a).toBe(b);
  });

  test('distinct hosts key distinctly', async () => {
    const a = await keyFor('https://a.dev/', '9.9.9');
    const b = await keyFor('https://b.dev/', '9.9.9');
    expect(a).not.toBe(b);
  });
});

describe('cache.put / get', () => {
  test('put then get round-trips a complete scorecard', async () => {
    const { env } = makeR2Stub();
    const url = 'https://example.com/';
    await put(env, url, sampleScorecard(url), SPEC_VERSION);
    const got = await get(env, await keyFor(url, SPEC_VERSION));
    expect(got?.target_url).toBe(url);
    expect((got?.scorecard as { badge: { score_pct: number } }).badge.score_pct).toBe(82);
  });

  test('put refuses a half-state (empty spec_version)', async () => {
    const { env } = makeR2Stub();
    await expect(put(env, 'https://example.com/', sampleScorecard('https://example.com/'), '')).rejects.toThrow(
      /specVersion required/,
    );
  });

  test('put refuses a scorecard missing target_url', async () => {
    const { env } = makeR2Stub();
    const bad = { ...sampleScorecard('https://example.com/'), target_url: undefined };
    await expect(put(env, 'https://example.com/', bad, SPEC_VERSION)).rejects.toThrow(/target_url/);
  });

  test('a write failure never throws to the caller', async () => {
    const { env } = makeR2Stub({ throwOnPut: true });
    await expect(
      put(env, 'https://example.com/', sampleScorecard('https://example.com/'), SPEC_VERSION),
    ).resolves.toBeUndefined();
  });

  test('corrupted stored JSON returns null and best-effort deletes', async () => {
    const url = 'https://example.com/';
    const key = await keyFor(url, SPEC_VERSION);
    const { env, deletedKeys } = makeR2Stub({ prefill: { [key]: '{not json' } });
    expect(await get(env, key)).toBeNull();
    expect(deletedKeys).toContain(key);
  });

  test('a schema-corrupted entry (missing scorecard) returns null', async () => {
    const url = 'https://example.com/';
    const key = await keyFor(url, SPEC_VERSION);
    const { env } = makeR2Stub({ prefill: { [key]: { spec_version: SPEC_VERSION, target_url: url } } });
    expect(await get(env, key)).toBeNull();
  });

  test('a read failure returns null instead of throwing', async () => {
    const { env } = makeR2Stub({ throwOnGet: true });
    expect(await get(env, await keyFor('https://example.com/', SPEC_VERSION))).toBeNull();
  });

  test('CachedWebAudit type carries target_url + spec_version + scorecard', async () => {
    const { env } = makeR2Stub();
    const url = 'https://example.com/';
    await put(env, url, sampleScorecard(url), SPEC_VERSION);
    const got = (await get(env, await keyFor(url, SPEC_VERSION))) as CachedWebAudit;
    expect(got.spec_version).toBe(SPEC_VERSION);
    expect(got.target_url).toBe(url);
  });

  test('put stamps scored_at with ISO-8601 now; get round-trips it', async () => {
    const { env } = makeR2Stub();
    const url = 'https://example.com/';
    const before = Date.now();
    await put(env, url, sampleScorecard(url), SPEC_VERSION);
    const got = (await get(env, await keyFor(url, SPEC_VERSION))) as CachedWebAudit;
    expect(typeof got.scored_at).toBe('string');
    const stamped = Date.parse(got.scored_at as string);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('a legacy payload without scored_at reads back intact (stale, not corrupt)', async () => {
    const url = 'https://example.com/';
    const key = await keyFor(url, SPEC_VERSION);
    const legacy = { spec_version: SPEC_VERSION, target_url: url, scorecard: sampleScorecard(url) };
    const { env, deletedKeys } = makeR2Stub({ prefill: { [key]: legacy } });
    const got = await get(env, key);
    expect(got).not.toBeNull();
    expect(got?.scored_at).toBeUndefined();
    expect(deletedKeys).toHaveLength(0);
    expect(isStale(got?.scored_at, 5 * 60_000)).toBe(true);
  });
});

describe('isStale', () => {
  const FIVE_MIN = 5 * 60_000;

  test('false within the threshold, true past it', () => {
    const now = Date.now();
    expect(isStale(new Date(now - FIVE_MIN + 10_000).toISOString(), FIVE_MIN, now)).toBe(false);
    expect(isStale(new Date(now - FIVE_MIN - 10_000).toISOString(), FIVE_MIN, now)).toBe(true);
  });

  test('true when scored_at is absent or unparseable', () => {
    expect(isStale(undefined, FIVE_MIN)).toBe(true);
    expect(isStale('not-a-date', FIVE_MIN)).toBe(true);
  });
});

describe('aggregate cache', () => {
  const ENTRIES: WebAggregateEntry[] = [
    {
      domain: 'anc.dev',
      url: 'https://anc.dev/',
      name: 'anc.dev',
      description: 'the auditor itself',
      score_pct: 76,
      score: { relative: 76, global: 71 },
    },
  ];

  test('aggregateKeyFor slots the kind where per-domain keys carry the hash', () => {
    expect(aggregateKeyFor('leaderboard', '9.9.9')).toBe('audits/web/leaderboard/9.9.9.json');
    expect(aggregateKeyFor('leaderboard-frontpage', '9.9.9')).toBe('audits/web/leaderboard-frontpage/9.9.9.json');
  });

  test('getAggregate returns null on a miss', async () => {
    const { env } = makeR2Stub();
    expect(await getAggregate(env, 'leaderboard', SPEC_VERSION)).toBeNull();
  });

  test('putAggregate then getAggregate round-trips the board entries', async () => {
    const { env } = makeR2Stub();
    await putAggregate(env, 'leaderboard', ENTRIES, SPEC_VERSION);
    const got = await getAggregate(env, 'leaderboard', SPEC_VERSION);
    expect(got?.spec_version).toBe(SPEC_VERSION);
    expect(typeof got?.generated_at).toBe('string');
    expect(got?.entries).toEqual(ENTRIES);
  });

  test('the two kinds key distinct objects', async () => {
    const { env } = makeR2Stub();
    await putAggregate(env, 'leaderboard', ENTRIES, SPEC_VERSION);
    expect(await getAggregate(env, 'leaderboard-frontpage', SPEC_VERSION)).toBeNull();
  });

  test('a malformed aggregate object is deleted and returns null', async () => {
    const key = aggregateKeyFor('leaderboard', SPEC_VERSION);
    const { env, deletedKeys } = makeR2Stub({ prefill: { [key]: { spec_version: SPEC_VERSION, entries: 'nope' } } });
    expect(await getAggregate(env, 'leaderboard', SPEC_VERSION)).toBeNull();
    expect(deletedKeys).toContain(key);
  });

  test('putAggregate refuses an empty spec version', async () => {
    const { env } = makeR2Stub();
    await expect(putAggregate(env, 'leaderboard', ENTRIES, '')).rejects.toThrow(/specVersion required/);
  });

  test('an aggregate write failure never throws to the caller', async () => {
    const { env } = makeR2Stub({ throwOnPut: true });
    await expect(putAggregate(env, 'leaderboard', ENTRIES, SPEC_VERSION)).resolves.toBeUndefined();
  });
});
