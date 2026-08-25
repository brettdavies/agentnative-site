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
  listAllWebAudits,
  normalizeTargetUrl,
  patchStoredPublicListing,
  put,
  putAggregate,
  WEB_ALL_BOARD_DISPLAY_MAX_AGE_MS,
  type WebAggregateEntry,
  type WebCacheEnv,
} from '../src/worker/audit-web/cache';
import {
  flushHitMinPurge,
  invokeCachedPurge,
  queueHitMinPurge,
  runWithHitMinPurge,
} from '../src/worker/audit-web/hit-min-purge';
import { runWebPublicListingBackfill, type WebBackfillEnv } from '../src/worker/audit-web/public-listing-backfill';
import { resetWebSeedCacheForTests } from '../src/worker/audit-web/seed';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

type ListedObject = { key: string; customMetadata?: Record<string, string> };

type StubOpts = {
  throwOnGet?: boolean;
  throwOnPut?: boolean;
  throwOnList?: boolean;
  prefill?: Record<string, unknown>;
  listPages?: ListedObject[][];
};

type PutOptions = { customMetadata?: Record<string, string> };

function makeR2Stub(opts: StubOpts = {}): {
  env: WebCacheEnv;
  store: Map<string, string>;
  deletedKeys: string[];
  putOptions: Map<string, PutOptions | undefined>;
  listCalls: Array<{ cursor?: string }>;
} {
  const store = new Map<string, string>();
  const deletedKeys: string[] = [];
  const putOptions = new Map<string, PutOptions | undefined>();
  const listCalls: Array<{ cursor?: string }> = [];
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
      async put(key: string, value: unknown, options?: PutOptions) {
        if (opts.throwOnPut) throw new Error('r2_put_failed');
        store.set(key, typeof value === 'string' ? value : String(value));
        putOptions.set(key, options);
      },
      async delete(key: string) {
        deletedKeys.push(key);
        store.delete(key);
      },
      async list(options?: { cursor?: string }) {
        if (opts.throwOnList) throw new Error('r2_list_failed');
        listCalls.push({ cursor: options?.cursor });
        const pages = opts.listPages ?? [];
        const index = options?.cursor ? Number(options.cursor) : 0;
        const objects = pages[index] ?? [];
        const truncated = index + 1 < pages.length;
        return truncated ? { objects, truncated, cursor: String(index + 1) } : { objects, truncated: false };
      },
    } as unknown as R2Bucket,
  };
  return { env, store, deletedKeys, putOptions, listCalls };
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
    await expect(put(env, 'https://example.com/', sampleScorecard('https://example.com/'), SPEC_VERSION)).resolves.toBe(
      false,
    );
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
    await expect(putAggregate(env, 'leaderboard', ENTRIES, SPEC_VERSION)).resolves.toBe(false);
  });
});

describe('put custom metadata (board fields)', () => {
  test('put writes domain, name, scores, and scored_at into custom metadata', async () => {
    const { env, putOptions } = makeR2Stub();
    const url = 'https://example.com/';
    const scorecard = {
      ...sampleScorecard(url),
      tool: { name: 'Example', url },
      score_pct: 82,
      score: { relative: 82, global: 71 },
    };
    await put(env, url, scorecard, SPEC_VERSION);
    const key = await keyFor(url, SPEC_VERSION);
    const meta = putOptions.get(key)?.customMetadata;
    expect(meta?.domain).toBe('example.com');
    expect(meta?.name).toBe('Example');
    expect(meta?.score_pct).toBe('82');
    expect(meta?.relative).toBe('82');
    expect(meta?.global).toBe('71');
    expect(typeof meta?.scored_at).toBe('string');
    expect(Number.isNaN(Date.parse(meta?.scored_at as string))).toBe(false);
  });

  test('a scorecard without a usable tool.name stores the domain as name', async () => {
    const { env, putOptions } = makeR2Stub();
    const url = 'https://example.com/';
    const scorecard = { ...sampleScorecard(url), tool: { name: '', url }, score: { relative: 1, global: 1 } };
    await put(env, url, scorecard, SPEC_VERSION);
    const meta = putOptions.get(await keyFor(url, SPEC_VERSION))?.customMetadata;
    expect(meta?.name).toBe('example.com');
  });

  test('public_listing serializes to the string "true" / "false", defaulting to false when absent', async () => {
    const { env, putOptions } = makeR2Stub();

    const optedIn = 'https://opted-in.dev/';
    await put(env, optedIn, { ...sampleScorecard(optedIn), public_listing: true }, SPEC_VERSION);
    expect(putOptions.get(await keyFor(optedIn, SPEC_VERSION))?.customMetadata?.public_listing).toBe('true');

    const optedOut = 'https://opted-out.dev/';
    await put(env, optedOut, { ...sampleScorecard(optedOut), public_listing: false }, SPEC_VERSION);
    expect(putOptions.get(await keyFor(optedOut, SPEC_VERSION))?.customMetadata?.public_listing).toBe('false');

    const absent = 'https://absent.dev/';
    await put(env, absent, sampleScorecard(absent), SPEC_VERSION);
    expect(putOptions.get(await keyFor(absent, SPEC_VERSION))?.customMetadata?.public_listing).toBe('false');
  });

  test('put still refuses a half-state with metadata in play', async () => {
    const { env } = makeR2Stub();
    await expect(put(env, 'https://example.com/', sampleScorecard('https://example.com/'), '')).rejects.toThrow(
      /specVersion required/,
    );
    const bad = { ...sampleScorecard('https://example.com/'), target_url: undefined };
    await expect(put(env, 'https://example.com/', bad, SPEC_VERSION)).rejects.toThrow(/target_url/);
  });
});

describe('listAllWebAudits', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);
  const HASH_C = 'c'.repeat(64);

  function listedEntry(hash: string, domain: string, ageMs: number, overrides: Record<string, string> = {}) {
    return {
      key: `audits/web/${hash}/${SPEC_VERSION}.json`,
      customMetadata: {
        domain,
        name: domain,
        score_pct: '80',
        relative: '80',
        global: '70',
        scored_at: new Date(NOW - ageMs).toISOString(),
        ...overrides,
      },
    };
  }

  const NOW = Date.parse('2026-08-03T00:00:00Z');

  test('returns only per-domain keys at the current spec (aggregates and other specs excluded)', async () => {
    const { env } = makeR2Stub({
      listPages: [
        [
          listedEntry(HASH_A, 'fresh.dev', 60_000),
          { key: `audits/web/leaderboard/${SPEC_VERSION}.json` },
          { key: `audits/web/leaderboard-frontpage/${SPEC_VERSION}.json` },
          { ...listedEntry(HASH_B, 'old-spec.dev', 60_000), key: `audits/web/${HASH_B}/0.0.1.json` },
        ],
      ],
    });
    const got = await listAllWebAudits(env, { specVersion: SPEC_VERSION, excludeDomains: new Set(), now: NOW });
    expect(got.map((e) => e.domain)).toEqual(['fresh.dev']);
    expect(got[0]).toEqual({
      domain: 'fresh.dev',
      name: 'fresh.dev',
      score_pct: 80,
      score: { relative: 80, global: 70 },
      scored_at: new Date(NOW - 60_000).toISOString(),
      public_listing: false,
    });
  });

  test('a spec version with regex metacharacters never wildcard-matches another version', async () => {
    const { env } = makeR2Stub({
      listPages: [[{ ...listedEntry(HASH_A, 'sneaky.dev', 60_000), key: `audits/web/${HASH_A}/0x5x0.json` }]],
    });
    const got = await listAllWebAudits(env, { specVersion: '0.5.0', excludeDomains: new Set(), now: NOW });
    expect(got).toEqual([]);
  });

  test('excludes domains in excludeDomains', async () => {
    const { env } = makeR2Stub({
      listPages: [[listedEntry(HASH_A, 'seeded.dev', 60_000), listedEntry(HASH_B, 'user.dev', 60_000)]],
    });
    const got = await listAllWebAudits(env, {
      specVersion: SPEC_VERSION,
      excludeDomains: new Set(['seeded.dev']),
      now: NOW,
    });
    expect(got.map((e) => e.domain)).toEqual(['user.dev']);
  });

  test('drops entries past the display window and keeps ones within it', async () => {
    const { env } = makeR2Stub({
      listPages: [
        [
          listedEntry(HASH_A, 'recent.dev', WEB_ALL_BOARD_DISPLAY_MAX_AGE_MS - 60_000),
          listedEntry(HASH_B, 'expired.dev', WEB_ALL_BOARD_DISPLAY_MAX_AGE_MS + 60_000),
        ],
      ],
    });
    const got = await listAllWebAudits(env, { specVersion: SPEC_VERSION, excludeDomains: new Set(), now: NOW });
    expect(got.map((e) => e.domain)).toEqual(['recent.dev']);
  });

  test('a custom maxAgeMs overrides the default window', async () => {
    const { env } = makeR2Stub({ listPages: [[listedEntry(HASH_A, 'recent.dev', 120_000)]] });
    const got = await listAllWebAudits(env, {
      specVersion: SPEC_VERSION,
      excludeDomains: new Set(),
      now: NOW,
      maxAgeMs: 60_000,
    });
    expect(got).toEqual([]);
  });

  test('skips entries with missing or unparseable metadata instead of throwing', async () => {
    const { env } = makeR2Stub({
      listPages: [
        [
          { key: `audits/web/${HASH_A}/${SPEC_VERSION}.json` },
          listedEntry(HASH_B, 'no-score.dev', 60_000, { score_pct: '', relative: 'NaN' }),
          listedEntry(HASH_C, 'good.dev', 60_000),
        ],
      ],
    });
    const got = await listAllWebAudits(env, { specVersion: SPEC_VERSION, excludeDomains: new Set(), now: NOW });
    expect(got.map((e) => e.domain)).toEqual(['good.dev']);
  });

  test('parses public_listing: "true" -> true, "false" -> false, missing -> false', async () => {
    const { env } = makeR2Stub({
      listPages: [
        [
          listedEntry(HASH_A, 'opted-in.dev', 60_000, { public_listing: 'true' }),
          listedEntry(HASH_B, 'opted-out.dev', 60_000, { public_listing: 'false' }),
          listedEntry(HASH_C, 'legacy.dev', 60_000),
        ],
      ],
    });
    const got = await listAllWebAudits(env, { specVersion: SPEC_VERSION, excludeDomains: new Set(), now: NOW });
    const byDomain = Object.fromEntries(got.map((e) => [e.domain, e.public_listing]));
    expect(byDomain['opted-in.dev']).toBe(true);
    expect(byDomain['opted-out.dev']).toBe(false);
    expect(byDomain['legacy.dev']).toBe(false);
  });

  test('paginates through truncated pages and unions the results', async () => {
    const { env, listCalls } = makeR2Stub({
      listPages: [[listedEntry(HASH_A, 'page-one.dev', 60_000)], [listedEntry(HASH_B, 'page-two.dev', 60_000)]],
    });
    const got = await listAllWebAudits(env, { specVersion: SPEC_VERSION, excludeDomains: new Set(), now: NOW });
    expect(got.map((e) => e.domain).sort()).toEqual(['page-one.dev', 'page-two.dev']);
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1].cursor).toBe('1');
  });

  test('returns [] instead of throwing when list rejects', async () => {
    const { env } = makeR2Stub({ throwOnList: true });
    await expect(
      listAllWebAudits(env, { specVersion: SPEC_VERSION, excludeDomains: new Set(), now: NOW }),
    ).resolves.toEqual([]);
  });
});

describe('patchStoredPublicListing (scored_at-preserving dual-writer)', () => {
  const PRIOR_SCORED_AT = '2026-08-01T00:00:00.000Z';

  function cachedFixture(url: string, publicListing: boolean | undefined): CachedWebAudit {
    const base = {
      ...sampleScorecard(url),
      tool: { name: 'Example', url },
      score_pct: 82,
      score: { relative: 82, global: 71 },
    };
    const scorecard = publicListing === undefined ? base : { ...base, public_listing: publicListing };
    return { spec_version: SPEC_VERSION, target_url: url, scorecard, scored_at: PRIOR_SCORED_AT };
  }

  test('flips the flag in both the envelope and the metadata, preserving scored_at', async () => {
    const { env, store, putOptions } = makeR2Stub();
    const url = 'https://example.com/';
    expect(await patchStoredPublicListing(env, cachedFixture(url, false), true)).toBe(true);

    const key = await keyFor(url, SPEC_VERSION);
    const stored = JSON.parse(store.get(key) as string) as CachedWebAudit;
    expect((stored.scorecard as { public_listing: boolean }).public_listing).toBe(true);
    expect(stored.scored_at).toBe(PRIOR_SCORED_AT);

    const meta = putOptions.get(key)?.customMetadata;
    expect(meta?.public_listing).toBe('true');
    expect(meta?.scored_at).toBe(PRIOR_SCORED_AT);
  });

  test('flips an opted-in entry back to false without restamping scored_at', async () => {
    const { env, store, putOptions } = makeR2Stub();
    const url = 'https://example.com/';
    await patchStoredPublicListing(env, cachedFixture(url, true), false);

    const key = await keyFor(url, SPEC_VERSION);
    const stored = JSON.parse(store.get(key) as string) as CachedWebAudit;
    expect((stored.scorecard as { public_listing: boolean }).public_listing).toBe(false);
    expect(stored.scored_at).toBe(PRIOR_SCORED_AT);
    expect(putOptions.get(key)?.customMetadata?.public_listing).toBe('false');
    expect(putOptions.get(key)?.customMetadata?.scored_at).toBe(PRIOR_SCORED_AT);
  });

  test('leaves every other envelope and scorecard field intact', async () => {
    const { env, store } = makeR2Stub();
    const url = 'https://example.com/';
    const cached = cachedFixture(url, false);
    await patchStoredPublicListing(env, cached, true);

    const stored = JSON.parse(store.get(await keyFor(url, SPEC_VERSION)) as string) as CachedWebAudit;
    expect(stored.spec_version).toBe(SPEC_VERSION);
    expect(stored.target_url).toBe(url);
    // Only public_listing changes; every other scorecard field is carried through verbatim.
    expect(stored.scorecard).toEqual({ ...(cached.scorecard as Record<string, unknown>), public_listing: true });
  });

  test('a round-trip through get sees the patched flag and the preserved scored_at', async () => {
    const { env } = makeR2Stub();
    const url = 'https://example.com/';
    await patchStoredPublicListing(env, cachedFixture(url, false), true);

    const got = await get(env, await keyFor(url, SPEC_VERSION));
    expect((got?.scorecard as { public_listing: boolean }).public_listing).toBe(true);
    expect(got?.scored_at).toBe(PRIOR_SCORED_AT);
  });

  test('a write failure resolves false instead of throwing', async () => {
    const { env } = makeR2Stub({ throwOnPut: true });
    await expect(patchStoredPublicListing(env, cachedFixture('https://example.com/', false), true)).resolves.toBe(
      false,
    );
  });

  test('an entry that never carried scored_at gets stamped now, body and metadata agreeing', async () => {
    const { env, store, putOptions } = makeR2Stub();
    const url = 'https://example.com/';
    const unstamped: CachedWebAudit = { ...cachedFixture(url, false) };
    delete unstamped.scored_at;
    expect(await patchStoredPublicListing(env, unstamped, true)).toBe(true);

    const key = await keyFor(url, SPEC_VERSION);
    const stored = JSON.parse(store.get(key) as string) as CachedWebAudit;
    expect(typeof stored.scored_at).toBe('string');
    expect(putOptions.get(key)?.customMetadata?.scored_at).toBe(stored.scored_at);
    expect((stored.scorecard as { public_listing: boolean }).public_listing).toBe(true);
  });
});

describe('runWebPublicListingBackfill', () => {
  const CURATED = { domain: 'curated.example', url: 'https://curated.example/', name: 'Curated' };
  const SEED = [CURATED];

  type StoreRec = { body: string; meta?: Record<string, string> };

  function bodyFor(url: string, opts: { flag?: boolean; scoredAt?: string } = {}) {
    const base = sampleScorecard(url);
    const scorecard = opts.flag === undefined ? base : { ...base, public_listing: opts.flag };
    return {
      spec_version: SPEC_VERSION,
      target_url: url,
      scorecard,
      scored_at: opts.scoredAt ?? '2020-01-01T00:00:00.000Z',
    };
  }

  function readStored(store: Map<string, StoreRec>, key: string): CachedWebAudit {
    return JSON.parse((store.get(key) as StoreRec).body) as CachedWebAudit;
  }

  function readMeta(store: Map<string, StoreRec>, key: string): Record<string, string> | undefined {
    return (store.get(key) as StoreRec).meta;
  }

  function flagOf(store: Map<string, StoreRec>, key: string): unknown {
    return (readStored(store, key).scorecard as Record<string, unknown>).public_listing;
  }

  // Realistic R2 stub whose list() reflects prior writes, so the same body
  // is never re-filled once its metadata carries the flag — the property the
  // fill-if-absent + re-run-until-zero protocol relies on. `pageSize` forces
  // multi-page pagination for the drain test.
  function makeEnv(setup: {
    entries: Array<{ key: string; body?: unknown; meta?: Record<string, string> }>;
    seed?: Array<{ domain: string; url: string; name: string }> | null;
    pageSize?: number;
    throwOnPut?: boolean;
    throwOnList?: boolean;
  }): { env: WebBackfillEnv; store: Map<string, StoreRec>; putKeys: string[] } {
    resetWebSeedCacheForTests();
    const store = new Map<string, StoreRec>();
    for (const e of setup.entries) {
      store.set(e.key, { body: e.body === undefined ? '' : JSON.stringify(e.body), meta: e.meta });
    }
    const putKeys: string[] = [];
    const pageSize = setup.pageSize ?? 1000;
    const seed = setup.seed === undefined ? SEED : setup.seed;
    const env: WebBackfillEnv = {
      SCORE_CACHE: {
        async get(key: string) {
          const rec = store.get(key);
          if (!rec || rec.body === '') return null;
          return {
            async json() {
              return JSON.parse(rec.body);
            },
            async text() {
              return rec.body;
            },
          };
        },
        async put(key: string, value: unknown, options?: { customMetadata?: Record<string, string> }) {
          if (setup.throwOnPut) throw new Error('r2_put_failed');
          putKeys.push(key);
          store.set(key, { body: typeof value === 'string' ? value : String(value), meta: options?.customMetadata });
        },
        async delete(key: string) {
          store.delete(key);
        },
        async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
          if (setup.throwOnList) throw new Error('r2_list_failed');
          const keys = [...store.keys()].filter((k) => !options?.prefix || k.startsWith(options.prefix)).sort();
          const start = options?.cursor ? Number(options.cursor) : 0;
          const size = Math.min(options?.limit ?? pageSize, pageSize);
          const slice = keys.slice(start, start + size);
          const objects = slice.map((k) => ({ key: k, customMetadata: store.get(k)?.meta }));
          const next = start + size;
          return next < keys.length
            ? { objects, truncated: true, cursor: String(next) }
            : { objects, truncated: false };
        },
      } as unknown as R2Bucket,
      ASSETS: {
        async fetch() {
          if (seed === null) return new Response('seed unavailable', { status: 500 });
          return new Response(JSON.stringify(seed), { status: 200 });
        },
      } as unknown as Fetcher,
    };
    return { env, store, putKeys };
  }

  test('a user object with no stored flag gets false; a curated seed gets true', async () => {
    const userKey = await keyFor('https://user-a.com/', SPEC_VERSION);
    const curatedKey = await keyFor('https://curated.example/', SPEC_VERSION);
    const { env, store } = makeEnv({
      entries: [
        { key: userKey, body: bodyFor('https://user-a.com/') },
        { key: curatedKey, body: bodyFor('https://curated.example/') },
      ],
    });

    const r = await runWebPublicListingBackfill(env);

    expect(r.written).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.done).toBe(true);
    expect(r.cursor).toBeNull();
    expect(flagOf(store, userKey)).toBe(false);
    expect(flagOf(store, curatedKey)).toBe(true);
    expect(readMeta(store, userKey)?.public_listing).toBe('false');
    expect(readMeta(store, curatedKey)?.public_listing).toBe('true');
  });

  test('an object already carrying an explicit flag is left untouched', async () => {
    const key = await keyFor('https://opted-in.com/', SPEC_VERSION);
    const { env, store, putKeys } = makeEnv({
      entries: [
        {
          key,
          body: bodyFor('https://opted-in.com/', { flag: true, scoredAt: '2019-05-05T00:00:00.000Z' }),
          meta: { public_listing: 'true' },
        },
      ],
    });

    const r = await runWebPublicListingBackfill(env);

    expect(r.written).toBe(0);
    expect(r.skipped).toBe(1);
    expect(putKeys).toEqual([]);
    expect(flagOf(store, key)).toBe(true);
    expect(readStored(store, key).scored_at).toBe('2019-05-05T00:00:00.000Z');
  });

  test('a second full run over freshly filled objects writes nothing (idempotent)', async () => {
    const key = await keyFor('https://user-b.com/', SPEC_VERSION);
    const { env } = makeEnv({ entries: [{ key, body: bodyFor('https://user-b.com/') }] });

    const first = await runWebPublicListingBackfill(env);
    expect(first.written).toBe(1);

    const second = await runWebPublicListingBackfill(env);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.done).toBe(true);
  });

  test('aggregate and off-version keys are skipped', async () => {
    const userKey = await keyFor('https://user-c.com/', SPEC_VERSION);
    const offVersionKey = await keyFor('https://user-c.com/', '9.9.9');
    const aggKey = aggregateKeyFor('leaderboard', SPEC_VERSION);
    const { env, store, putKeys } = makeEnv({
      entries: [
        { key: userKey, body: bodyFor('https://user-c.com/') },
        { key: offVersionKey, body: bodyFor('https://user-c.com/') },
        { key: aggKey, body: { spec_version: SPEC_VERSION, generated_at: 'x', entries: [] } },
      ],
    });

    const r = await runWebPublicListingBackfill(env);

    expect(r.scanned).toBe(1);
    expect(r.written).toBe(1);
    expect(putKeys).toEqual([userKey]);
    expect(readMeta(store, offVersionKey)?.public_listing).toBeUndefined();
    expect(readMeta(store, aggKey)?.public_listing).toBeUndefined();
  });

  test('scored_at is preserved on every re-put', async () => {
    const key = await keyFor('https://user-d.com/', SPEC_VERSION);
    const { env, store } = makeEnv({
      entries: [{ key, body: bodyFor('https://user-d.com/', { scoredAt: '2018-03-03T12:00:00.000Z' }) }],
    });

    await runWebPublicListingBackfill(env);

    expect(readStored(store, key).scored_at).toBe('2018-03-03T12:00:00.000Z');
    expect(readMeta(store, key)?.scored_at).toBe('2018-03-03T12:00:00.000Z');
  });

  test('a batch larger than one page drains across calls until a run reports zero writes', async () => {
    const urls = ['https://p1.com/', 'https://p2.com/', 'https://p3.com/'];
    const entries: Array<{ key: string; body: unknown }> = [];
    for (const u of urls) entries.push({ key: await keyFor(u, SPEC_VERSION), body: bodyFor(u) });
    const { env, putKeys } = makeEnv({ entries, pageSize: 1 });

    let cursor: string | undefined;
    let totalWritten = 0;
    let calls = 0;
    for (;;) {
      const r = await runWebPublicListingBackfill(env, { cursor, maxWrites: 1 });
      totalWritten += r.written;
      calls++;
      if (r.done && r.written === 0) break;
      cursor = r.cursor ?? undefined;
      if (calls > 20) throw new Error('backfill did not converge');
    }

    expect(totalWritten).toBe(3);
    expect(putKeys).toHaveLength(3);
    expect(new Set(putKeys).size).toBe(3);
    expect(calls).toBeGreaterThan(1);
  });

  test('a dry run is bounded by the same budget and cursors forward to done', async () => {
    const urls = ['https://q1.com/', 'https://q2.com/', 'https://q3.com/'];
    const entries: Array<{ key: string; body: unknown }> = [];
    for (const u of urls) entries.push({ key: await keyFor(u, SPEC_VERSION), body: bodyFor(u) });
    const { env, putKeys } = makeEnv({ entries, pageSize: 1 });

    let cursor: string | undefined;
    let totalWouldWrite = 0;
    let calls = 0;
    for (;;) {
      const r = await runWebPublicListingBackfill(env, { cursor, dryRun: true, maxWrites: 1 });
      expect(r.written).toBe(0);
      expect(r.diffs.length).toBeLessThanOrEqual(1);
      totalWouldWrite += r.would_write;
      calls++;
      if (r.done) break;
      cursor = r.cursor ?? undefined;
      if (calls > 20) throw new Error('dry run did not converge');
    }

    expect(totalWouldWrite).toBe(3);
    expect(putKeys).toEqual([]);
    expect(calls).toBeGreaterThan(1);
  });

  test('a seed-load failure aborts the batch with nothing written', async () => {
    const key = await keyFor('https://user-e.com/', SPEC_VERSION);
    const { env, store, putKeys } = makeEnv({
      entries: [{ key, body: bodyFor('https://user-e.com/') }],
      seed: null,
    });

    await expect(runWebPublicListingBackfill(env)).rejects.toThrow();
    expect(putKeys).toEqual([]);
    expect(readMeta(store, key)?.public_listing).toBeUndefined();
  });

  // The seed load is guarded up front, before the enumeration, so a broken
  // seed aborts even when no object needs a fill (nothing would call
  // isSeededDomain). A late per-object check would report a false clean run.
  test('a seed-load failure aborts even when every object is already flagged', async () => {
    const key = await keyFor('https://all-flagged.com/', SPEC_VERSION);
    const { env } = makeEnv({
      entries: [{ key, body: bodyFor('https://all-flagged.com/', { flag: false }), meta: { public_listing: 'false' } }],
      seed: null,
    });

    await expect(runWebPublicListingBackfill(env)).rejects.toThrow();
  });

  test('a dry run writes nothing and reports the intended diff and tally', async () => {
    const userKey = await keyFor('https://user-f.com/', SPEC_VERSION);
    const curatedKey = await keyFor('https://curated.example/', SPEC_VERSION);
    const { env, store, putKeys } = makeEnv({
      entries: [
        { key: userKey, body: bodyFor('https://user-f.com/') },
        { key: curatedKey, body: bodyFor('https://curated.example/') },
      ],
    });

    const r = await runWebPublicListingBackfill(env, { dryRun: true });

    expect(r.dry_run).toBe(true);
    expect(r.written).toBe(0);
    expect(r.would_write).toBe(2);
    expect(putKeys).toEqual([]);
    expect(r.diffs).toEqual(
      expect.arrayContaining([
        { key: userKey, domain: 'user-f.com', public_listing: false },
        { key: curatedKey, domain: 'curated.example', public_listing: true },
      ]),
    );
    expect(flagOf(store, userKey)).toBeUndefined();
  });

  test('a failed re-put counts as failed, not written or skipped', async () => {
    const key = await keyFor('https://user-g.com/', SPEC_VERSION);
    const { env } = makeEnv({ entries: [{ key, body: bodyFor('https://user-g.com/') }], throwOnPut: true });

    const r = await runWebPublicListingBackfill(env);

    expect(r.written).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.would_write).toBe(1);
  });

  test('a legacy object with metadata but no public_listing key is still filled', async () => {
    const key = await keyFor('https://user-h.com/', SPEC_VERSION);
    const { env, store } = makeEnv({
      entries: [
        {
          key,
          body: bodyFor('https://user-h.com/'),
          meta: { domain: 'user-h.com', name: 'user-h.com', scored_at: '2020-01-01T00:00:00.000Z' },
        },
      ],
    });

    const r = await runWebPublicListingBackfill(env);

    expect(r.written).toBe(1);
    expect(readMeta(store, key)?.public_listing).toBe('false');
  });
});

describe('HIT-min tag purge', () => {
  function makePurgeCtx() {
    const calls: Array<{ tags?: string[]; pathPrefixes?: string[] }> = [];
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
      exports: {
        Cached: {
          async purgeHitMinTags(tags: string[]) {
            calls.push({ tags });
            return { success: true, errors: [] };
          },
        },
      },
    } as unknown as ExecutionContext;
    return { ctx, calls };
  }

  test('queued tags flush once with the union, never a path prefix', async () => {
    const { ctx, calls } = makePurgeCtx();
    await runWithHitMinPurge(ctx, async () => {
      queueHitMinPurge(['home', 'web']);
      queueHitMinPurge(['web', 'web:example.com']);
      await flushHitMinPurge();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tags?.sort()).toEqual(['home', 'web', 'web:example.com']);
    expect(calls[0]?.pathPrefixes).toBeUndefined();
  });

  test('invokeCachedPurge sends tags only', async () => {
    const { ctx, calls } = makePurgeCtx();
    await invokeCachedPurge(ctx, ['web:other.dev', 'web']);
    expect(calls).toEqual([{ tags: ['web:other.dev', 'web'] }]);
  });

  test('invokeCachedPurge does not fall back to gateway ctx.cache.purge', async () => {
    const cacheCalls: unknown[] = [];
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
      cache: {
        async purge(opts: unknown) {
          cacheCalls.push(opts);
          return { success: true };
        },
      },
    } as unknown as ExecutionContext;
    await invokeCachedPurge(ctx, ['web']);
    expect(cacheCalls).toEqual([]);
  });

  test('put does not purge on its own', async () => {
    const { ctx, calls } = makePurgeCtx();
    const { env } = makeR2Stub();
    await runWithHitMinPurge(ctx, async () => {
      await put(env, 'https://example.com/', sampleScorecard('https://example.com/'), SPEC_VERSION);
      await flushHitMinPurge();
    });
    expect(calls).toEqual([]);
  });
});
