// R2 cache wrapper unit tests.
//
// Plan U7 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md
// "Test scenarios" under U7). Exercises cache.get / cache.put / cache.keyFor
// against an in-memory R2 stub. Real R2 round-trips are covered by staging
// verification, not bun-test (workerd-only behavior).
//
// SPEC_VERSION coupling: any test whose mocked cache key has to match the
// runtime's key construction reads SPEC_VERSION from spec-version.gen. The
// pure keyFor() shape tests use a literal sentinel ('9.9.9') so they stay
// stable across SPEC_VERSION bumps and exercise the function itself rather
// than its coupling.

import { describe, expect, test } from 'bun:test';
import { type CachedScorecard, type CacheEnv, get, keyFor, put } from '../src/worker/score/cache';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

// ---------------------------------------------------------------------------
// In-memory R2 stub
// ---------------------------------------------------------------------------

type StubOpts = {
  throwOnGet?: boolean;
  throwOnPut?: boolean;
  throwOnDelete?: boolean;
  // Override get() to return a raw value (used to inject corrupted
  // payloads that wouldn't go through put()'s validation).
  prefill?: Record<string, unknown>;
};

function makeR2Stub(opts: StubOpts = {}): { env: CacheEnv; store: Map<string, string>; deletedKeys: string[] } {
  const store = new Map<string, string>();
  const deletedKeys: string[] = [];
  if (opts.prefill) {
    for (const [k, v] of Object.entries(opts.prefill)) {
      store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  }
  const env: CacheEnv = {
    SCORE_CACHE: {
      async get(key: string) {
        if (opts.throwOnGet) throw new Error('r2_get_failed');
        const raw = store.get(key);
        if (raw === undefined) return null;
        // R2's `get(key)` returns an R2ObjectBody. The minimum surface
        // our cache helper uses is `.json()` — that's what we mock.
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
        if (opts.throwOnDelete) throw new Error('r2_delete_failed');
        deletedKeys.push(key);
        store.delete(key);
      },
    } as unknown as R2Bucket,
  };
  return { env, store, deletedKeys };
}

// ---------------------------------------------------------------------------
// keyFor — pure shape tests; intentionally use a literal sentinel version
// so they exercise the function itself rather than coupling to SPEC_VERSION.
// ---------------------------------------------------------------------------

describe('cache.keyFor', () => {
  test('returns the canonical scores/{binary}/{ancVersion}.json shape', () => {
    expect(keyFor('rg', '9.9.9')).toBe('scores/rg/9.9.9.json');
    expect(keyFor('cowsay', '9.9.9')).toBe('scores/cowsay/9.9.9.json');
  });

  test('passes through hyphens and dots in binary names', () => {
    expect(keyFor('chrome-launcher', '9.9.9')).toBe('scores/chrome-launcher/9.9.9.json');
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('cache.get', () => {
  test('miss returns null', async () => {
    const { env } = makeR2Stub();
    expect(await get(env, keyFor('rg', SPEC_VERSION))).toBeNull();
  });

  test('hit returns the cached payload (shape validated)', async () => {
    const payload: CachedScorecard = {
      spec_version: SPEC_VERSION,
      anc_version: '0.3.1',
      tool_version: '15.1.0',
      scorecard: { tool: { name: 'ripgrep' }, score: { value: 88 } },
    };
    const key = keyFor('rg', SPEC_VERSION);
    const { env } = makeR2Stub({ prefill: { [key]: payload } });
    const result = await get(env, key);
    expect(result).toEqual(payload);
  });

  test('corrupted payload (missing anc_version) → miss + best-effort delete', async () => {
    const corrupted = { spec_version: SPEC_VERSION, tool_version: '15.1.0', scorecard: {} };
    const key = keyFor('rg', SPEC_VERSION);
    const { env, deletedKeys } = makeR2Stub({ prefill: { [key]: corrupted } });
    expect(await get(env, key)).toBeNull();
    // Drain microtasks so the .catch() chain on delete settles.
    await new Promise((r) => setTimeout(r, 0));
    expect(deletedKeys).toContain(key);
  });

  test('corrupted payload (missing tool_version) → miss', async () => {
    const corrupted = { spec_version: SPEC_VERSION, anc_version: '0.3.1', scorecard: {} };
    const key = keyFor('rg', SPEC_VERSION);
    const { env } = makeR2Stub({ prefill: { [key]: corrupted } });
    expect(await get(env, key)).toBeNull();
  });

  test('corrupted payload (missing scorecard field) → miss', async () => {
    const corrupted = { spec_version: SPEC_VERSION, anc_version: '0.3.1', tool_version: '15.1.0' };
    const key = keyFor('rg', SPEC_VERSION);
    const { env } = makeR2Stub({ prefill: { [key]: corrupted } });
    expect(await get(env, key)).toBeNull();
  });

  test('empty-string fields treated as corrupted', async () => {
    const corrupted = { spec_version: SPEC_VERSION, anc_version: '', tool_version: '15.1.0', scorecard: {} };
    const key = keyFor('rg', SPEC_VERSION);
    const { env } = makeR2Stub({ prefill: { [key]: corrupted } });
    expect(await get(env, key)).toBeNull();
  });

  test('R2 throws on read → treated as miss (best-effort)', async () => {
    const { env } = makeR2Stub({ throwOnGet: true });
    expect(await get(env, keyFor('rg', SPEC_VERSION))).toBeNull();
  });

  test('delete failure on corrupted payload does not throw', async () => {
    const corrupted = { spec_version: SPEC_VERSION, anc_version: '0.3.1', tool_version: '', scorecard: {} };
    const key = keyFor('rg', SPEC_VERSION);
    const { env } = makeR2Stub({ prefill: { [key]: corrupted }, throwOnDelete: true });
    // Still returns null without surfacing the delete error.
    expect(await get(env, key)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// put
// ---------------------------------------------------------------------------

describe('cache.put', () => {
  test('happy path writes a well-formed payload', async () => {
    const { env, store } = makeR2Stub();
    const key = keyFor('rg', SPEC_VERSION);
    await put(env, key, { tool: { name: 'ripgrep' } }, '0.3.1', '15.1.0', SPEC_VERSION);
    const raw = store.get(key);
    expect(raw).toBeTruthy();
    if (!raw) return;
    const parsed = JSON.parse(raw) as CachedScorecard;
    expect(parsed.spec_version).toBe(SPEC_VERSION);
    expect(parsed.anc_version).toBe('0.3.1');
    expect(parsed.tool_version).toBe('15.1.0');
    expect(parsed.scorecard).toEqual({ tool: { name: 'ripgrep' } });
  });

  test('refusal-to-cache-half-state: missing ancVersion throws', async () => {
    const { env } = makeR2Stub();
    await expect(put(env, keyFor('rg', SPEC_VERSION), {}, '', '15.1.0', SPEC_VERSION)).rejects.toThrow(/ancVersion/);
  });

  test('refusal-to-cache-half-state: missing toolVersion throws', async () => {
    const { env } = makeR2Stub();
    await expect(put(env, keyFor('rg', SPEC_VERSION), {}, '0.3.1', '', SPEC_VERSION)).rejects.toThrow(/toolVersion/);
  });

  test('refusal-to-cache-half-state: missing specVersion throws', async () => {
    const { env } = makeR2Stub();
    await expect(put(env, keyFor('rg', SPEC_VERSION), {}, '0.3.1', '15.1.0', '')).rejects.toThrow(/specVersion/);
  });

  test('R2 write failure is best-effort: logs but does not throw', async () => {
    const { env } = makeR2Stub({ throwOnPut: true });
    // Should not throw — the user's response must not depend on the cache.
    await put(env, keyFor('rg', SPEC_VERSION), {}, '0.3.1', '15.1.0', SPEC_VERSION);
  });

  test('round-trip: put then get returns the same payload', async () => {
    const { env } = makeR2Stub();
    const scorecard = { tool: { name: 'ripgrep', version: '15.1.0' }, score: { value: 88 } };
    const key = keyFor('rg', SPEC_VERSION);
    await put(env, key, scorecard, '0.3.1', '15.1.0', SPEC_VERSION);
    const result = await get(env, key);
    expect(result).toEqual({
      spec_version: SPEC_VERSION,
      anc_version: '0.3.1',
      tool_version: '15.1.0',
      scorecard,
    });
  });
});
