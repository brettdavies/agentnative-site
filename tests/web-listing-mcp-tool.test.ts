// set_website_public_listing, dispatched through the real MCP handler over
// in-memory R2, KV, and limiter fakes: the answer in each state, the order the
// gates apply in, the bytes a change stores, and what a failure leaves behind.
// The deployed bindings are covered by the staging e2e.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { keyFor } from '../src/worker/audit-web/cache';
import { flushHitMinPurge, runWithHitMinPurge } from '../src/worker/audit-web/hit-min-purge';
import { FLIP_CEILING, HOURLY_AUDIT_CEILING, hourWindowEndsAt } from '../src/worker/audit-web/limiter';
import { enforcePublicListingFlipLimit } from '../src/worker/audit-web/public-listing';
import { resetWebSeedCacheForTests } from '../src/worker/audit-web/seed';
import { resetCatalogCacheForTests } from '../src/worker/mcp/catalog';
import type { McpEnv } from '../src/worker/mcp/server';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';
import { type CapturedLog, withLogCapture } from './helpers/log-capture';
import { getJsonToolContent, type JsonRpcBody, mcpInitialize, mcpRpc, resetMcpTestState } from './helpers/mcp-rpc';
import { type StoredWebRecord, webRecordBucket } from './helpers/web-record-bucket';

const IP = '203.0.113.21';
const TARGET = 'https://example.com/';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FIXTURE_CATALOG = {
  generated_at: '2026-07-09T00:00:00.000Z',
  spec_version: SPEC_VERSION,
  registry: [],
  principles: [],
  spec_sections: [],
};

type KvHooks = {
  /** Runs before a write lands; throw to fail it. */
  onPut?: (key: string) => void | Promise<void>;
};

function hookedKv(seed: Record<string, string> = {}, hooks: KvHooks = {}) {
  const store = new Map(Object.entries(seed));
  const puts: string[] = [];
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      await hooks.onPut?.(key);
      puts.push(key);
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  const takes = (prefix: string) => puts.filter((key) => key.startsWith(prefix)).length;
  return { kv, store, puts, hooks, takes };
}

type Gates = ReturnType<typeof hookedKv>;

type Fixture = Awaited<ReturnType<typeof fixture>>;

type FixtureOpts = {
  webEnabled?: boolean;
  burstOk?: boolean;
  seed?: 'ok' | 'fails';
  kvSeed?: Record<string, string>;
  kvHooks?: KvHooks;
  /** The records to store, by https origin. */
  records?: Record<string, { scoredAt?: string | null; listing?: boolean; extra?: Record<string, unknown> }>;
};

function recordOf(
  url: string,
  spec: { scoredAt?: string | null; listing?: boolean; extra?: Record<string, unknown> },
): StoredWebRecord {
  const scorecard: Record<string, unknown> = {
    schema_version: '0.2',
    target_url: url,
    score_pct: 64,
    results: [{ id: 'r1', status: 'pass' }],
    ...spec.extra,
  };
  if (spec.listing !== undefined) scorecard.public_listing = spec.listing;
  const record: StoredWebRecord = { spec_version: SPEC_VERSION, target_url: url, scorecard };
  if (spec.scoredAt !== null) record.scored_at = spec.scoredAt ?? new Date(Date.now() - 600_000).toISOString();
  return record;
}

async function fixture(opts: FixtureOpts = {}) {
  const bucket = webRecordBucket();
  for (const [url, spec] of Object.entries(opts.records ?? { [TARGET]: { listing: false } })) {
    await bucket.set(url, recordOf(url, spec));
  }
  const gates: Gates = hookedKv(opts.kvSeed, opts.kvHooks);
  const burst = { takes: 0 };
  const env = {
    ASSETS: {
      async fetch(req: Request) {
        const path = new URL(req.url).pathname;
        if (path === '/_internal/mcp-catalog.json') return Response.json(FIXTURE_CATALOG);
        if (path === '/_internal/web-seed.json') {
          if (opts.seed === 'fails') return new Response('boom', { status: 500 });
          return Response.json([{ domain: 'anc.dev', url: 'https://anc.dev/', name: 'anc.dev', description: 'x' }]);
        }
        return new Response('not found', { status: 404 });
      },
    },
    SCORE_CACHE: bucket.bucket,
    SCORE_KV: gates.kv,
    WEB_AUDIT_ENABLED: (opts.webEnabled ?? true) ? 'true' : undefined,
    MCP_ENABLED: 'true',
    WEB_AUDIT_LIMITER_IP: {
      async limit() {
        burst.takes += 1;
        return { success: opts.burstOk ?? true };
      },
    },
  } as unknown as McpEnv;
  return { env, bucket, gates, burst };
}

async function call(f: Fixture, args: Record<string, unknown>, ip: string | undefined = IP) {
  await mcpInitialize(f.env);
  const { status, body } = await mcpRpc(
    f.env,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'set_website_public_listing', arguments: args } },
    ip ? { 'cf-connecting-ip': ip } : {},
  );
  expect(status).toBe(200);
  const result = (body as JsonRpcBody).result;
  const text = result?.content?.[0]?.text ?? '';
  return { isError: result?.isError === true, text, data: () => getJsonToolContent(body as JsonRpcBody) };
}

type Answer = Record<string, unknown> & { changed: boolean };

async function answer(f: Fixture, args: Record<string, unknown>, ip?: string): Promise<Answer> {
  const out = await call(f, args, ip);
  expect(out.isError).toBe(false);
  return out.data() as Answer;
}

/** Every unit a call can take: the burst limiter, the hourly window, the flip budget. */
function spent(f: Fixture) {
  return {
    burst: f.burst.takes,
    hourly: f.gates.takes('audit:web:'),
    flip: f.gates.takes('web_audit_flip:'),
  };
}

const NOTHING_SPENT = { burst: 0, hourly: 0, flip: 0 };

function bodyOf(f: Fixture, url = TARGET) {
  return f.bucket.recordOf(url);
}

beforeEach(() => {
  resetMcpTestState();
  resetWebSeedCacheForTests();
});
afterEach(() => {
  resetMcpTestState();
  resetCatalogCacheForTests();
  resetWebSeedCacheForTests();
});

describe('set_website_public_listing: a change', () => {
  test('AE12: rewrites only the listing, at a scorecard ten minutes old, with one board purge and no outbound request', async () => {
    const scoredAt = new Date(Date.now() - 600_000).toISOString();
    const f = await fixture({ records: { [TARGET]: { listing: false, scoredAt } } });
    const before = (await bodyOf(f)) as StoredWebRecord;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('x');
    }) as unknown as typeof fetch;
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
    let out: Answer;
    try {
      out = await runWithHitMinPurge(ctx, async () => {
        const result = await answer(f, { url: 'example.com', public_listing: true });
        await flushHitMinPurge();
        return result;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(out).toMatchObject({
      changed: true,
      target: 'example.com',
      public_listing: true,
      scored_at: scoredAt,
      listed_until: new Date(Date.parse(scoredAt) + 30 * DAY_MS).toISOString(),
      board_url: 'https://anc.dev/scorecards?lane=web&view=all',
      scorecard_url: 'https://anc.dev/score/example.com',
    });
    expect(out).not.toHaveProperty('next_tool');
    const after = (await bodyOf(f)) as StoredWebRecord;
    expect(after).toEqual({ ...before, scorecard: { ...before.scorecard, public_listing: true } });
    expect(after.scored_at).toBe(scoredAt);
    expect((await f.bucket.metadataOf(TARGET))?.public_listing).toBe('true');
    expect(f.bucket.puts).toHaveLength(1);
    expect(purged).toEqual([['web']]);
    expect(requests).toBe(0);
  });

  test('AE12: a scorecard older than the display window is written, and the answer points at audit_website', async () => {
    const scoredAt = new Date(Date.now() - 31 * DAY_MS).toISOString();
    const f = await fixture({ records: { [TARGET]: { listing: false, scoredAt } } });
    const out = await answer(f, { url: 'example.com', public_listing: true });
    expect(out).toMatchObject({ changed: true, public_listing: true, next_tool: 'audit_website' });
    expect(Date.parse(out.listed_until as string)).toBeLessThan(Date.now());
    expect((await bodyOf(f))?.scorecard.public_listing).toBe(true);
  });

  test('AE12: unlisting reports no listed_until and stores the flag in the body and the board metadata', async () => {
    const f = await fixture({ records: { [TARGET]: { listing: true } } });
    const out = await answer(f, { url: 'example.com', public_listing: false });
    expect(out).toMatchObject({ changed: true, public_listing: false, listed_until: null });
    expect(out).not.toHaveProperty('next_tool');
    expect((await bodyOf(f))?.scorecard.public_listing).toBe(false);
    expect((await f.bucket.metadataOf(TARGET))?.public_listing).toBe('false');
  });

  test('a listing change spends one burst unit, one hourly unit, and one flip unit', async () => {
    const f = await fixture();
    await answer(f, { url: 'example.com', public_listing: true });
    expect(spent(f)).toEqual({ burst: 1, hourly: 1, flip: 1 });
  });

  test('www.<domain> with the fold recorded on <domain> changes the <domain> record', async () => {
    const f = await fixture({
      records: {
        [TARGET]: { listing: false, extra: { site_hosts: ['example.com', 'www.example.com'] } },
      },
    });
    const out = await answer(f, { url: 'www.example.com', public_listing: true });
    expect(out).toMatchObject({
      changed: true,
      target: 'example.com',
      scorecard_url: 'https://anc.dev/score/example.com',
    });
    expect((await bodyOf(f))?.scorecard.public_listing).toBe(true);
  });

  test('www.<domain> with no fold and no record of its own is a miss', async () => {
    const f = await fixture({ records: { [TARGET]: { listing: false } } });
    const out = await answer(f, { url: 'www.example.com', public_listing: true });
    expect(out).toMatchObject({ changed: false, found: false, next_tool: 'audit_website' });
    expect(f.bucket.puts).toEqual([]);
  });

  test('audit_website and get_website_audit both read the listing this tool stored', async () => {
    const f = await fixture({ records: { [TARGET]: { listing: false, scoredAt: new Date().toISOString() } } });
    await answer(f, { url: 'example.com', public_listing: true });
    const read = await mcpRpc(f.env, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_website_audit', arguments: { url: 'example.com' } },
    });
    const envelope = getJsonToolContent(read.body as JsonRpcBody) as { scorecard: { public_listing: boolean } };
    expect(envelope.scorecard.public_listing).toBe(true);
    const cached = await mcpRpc(
      f.env,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'audit_website', arguments: { url: 'example.com' } },
      },
      { 'cf-connecting-ip': IP },
    );
    const served = getJsonToolContent(cached.body as JsonRpcBody) as { scorecard: { public_listing: boolean } };
    expect(served.scorecard.public_listing).toBe(true);
  });
});

describe('set_website_public_listing: answers that cost nothing', () => {
  test('AE6: a value equal to the stored one writes nothing and spends no unit', async () => {
    const f = await fixture({ records: { [TARGET]: { listing: true } } });
    const out = await answer(f, { url: 'example.com', public_listing: true });
    expect(out).toMatchObject({ changed: false, target: 'example.com', public_listing: true });
    expect(out).not.toHaveProperty('disabled');
    expect(f.bucket.puts).toEqual([]);
    expect(spent(f)).toEqual(NOTHING_SPENT);
  });

  test('AE6: a record with no flag key reads as unlisted, so false writes nothing', async () => {
    const f = await fixture({ records: { [TARGET]: {} } });
    const out = await answer(f, { url: 'example.com', public_listing: false });
    expect(out).toMatchObject({ changed: false, public_listing: false });
    expect(f.bucket.puts).toEqual([]);
    expect(spent(f)).toEqual(NOTHING_SPENT);
  });

  test('two identical calls: the second finds the value stored and takes no unit', async () => {
    const f = await fixture();
    expect(await answer(f, { url: 'example.com', public_listing: true })).toMatchObject({ changed: true });
    const after = spent(f);
    expect(await answer(f, { url: 'example.com', public_listing: true })).toMatchObject({ changed: false });
    expect(spent(f)).toEqual(after);
    expect(f.bucket.puts).toHaveLength(1);
  });

  test('AE4: no stored audit points at audit_website, with nothing written or spent', async () => {
    const f = await fixture({ records: {} });
    const out = await answer(f, { url: 'example.com', public_listing: true });
    expect(out).toMatchObject({ changed: false, found: false, next_tool: 'audit_website' });
    expect(f.bucket.puts).toEqual([]);
    expect(spent(f)).toEqual(NOTHING_SPENT);
  });

  test('AE5: a stored audit with no scored_at points at audit_website, with nothing written', async () => {
    const f = await fixture({ records: { [TARGET]: { listing: false, scoredAt: null } } });
    const out = await answer(f, { url: 'example.com', public_listing: true });
    expect(out).toMatchObject({ changed: false, found: true, next_tool: 'audit_website' });
    expect(f.bucket.puts).toEqual([]);
    expect(spent(f)).toEqual(NOTHING_SPENT);
  });

  test('AE3: a curated site writes nothing, spends nothing, and says it is always listed', async () => {
    const f = await fixture({ records: { 'https://anc.dev/': { listing: false } } });
    const out = await answer(f, { url: 'anc.dev', public_listing: false });
    expect(out).toMatchObject({ changed: false, curated: true, target: 'anc.dev', public_listing: true });
    expect(f.bucket.puts).toEqual([]);
    expect(spent(f)).toEqual(NOTHING_SPENT);
  });

  test('a seed that fails to load counts as not curated, so the change is written', async () => {
    const f = await fixture({ seed: 'fails', records: { 'https://anc.dev/': { listing: false } } });
    const out = await answer(f, { url: 'anc.dev', public_listing: true });
    expect(out).toMatchObject({ changed: true, public_listing: true });
    expect(out).not.toHaveProperty('curated');
  });

  test('AE7: with WEB_AUDIT_ENABLED unset a change is refused as data, and the no-op answer is not', async () => {
    const f = await fixture({ webEnabled: false, records: { [TARGET]: { listing: false } } });
    const refused = await answer(f, { url: 'example.com', public_listing: true });
    expect(refused).toMatchObject({ changed: false, disabled: true, target: 'example.com', public_listing: false });
    expect(String(refused.message)).toContain('switched listing changes off');
    expect(String(refused.message)).toContain('nothing was changed');
    expect(f.bucket.puts).toEqual([]);
    expect(spent(f)).toEqual(NOTHING_SPENT);
    const noop = await answer(f, { url: 'example.com', public_listing: false });
    expect(noop).toMatchObject({ changed: false });
    expect(noop).not.toHaveProperty('disabled');
  });

  test('AE1: an invalid url, a scheme other than http(s), and a refused host are tool errors', async () => {
    const f = await fixture();
    for (const url of ['not a url://', 'ftp://example.com/', 'http://127.0.0.1/']) {
      const out = await call(f, { url, public_listing: true });
      expect(out.isError).toBe(true);
    }
    expect(f.bucket.puts).toEqual([]);
    expect(spent(f)).toEqual(NOTHING_SPENT);
  });

  test('AE2: a site record that cannot be read answers cache_unavailable and writes nothing', async () => {
    const f = await fixture();
    f.bucket.hooks.onGet = () => {
      throw new Error('r2 unavailable');
    };
    const out = await call(f, { url: 'example.com', public_listing: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('cache_unavailable');
    expect(out.text).toContain('nothing was changed');
    expect(out.text).toContain('Retry set_website_public_listing in 30 seconds');
    expect(f.bucket.puts).toEqual([]);
    expect(spent(f)).toEqual(NOTHING_SPENT);
  });

  test('AE2: the <domain> record behind a www.<domain> host that cannot be read names <domain>', async () => {
    const f = await fixture();
    f.bucket.hooks.onGet = () => {
      throw new Error('r2 unavailable');
    };
    const out = await call(f, { url: 'www.example.com', public_listing: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('stored scorecard for example.com');
    expect(out.text).toContain('nothing was changed');
    expect(f.bucket.puts).toEqual([]);
  });
});

describe('set_website_public_listing: the gates', () => {
  test('AE8: a missing cf-connecting-ip answers the audit_website message and writes nothing', async () => {
    const f = await fixture();
    const out = await call(f, { url: 'example.com', public_listing: true }, '');
    expect(out.isError).toBe(true);
    expect(out.text).toContain('-32099');
    expect(out.text).toContain('missing cf-connecting-ip is not rate-limit-keyable');
    expect(f.bucket.puts).toEqual([]);
    expect(spent(f)).toEqual(NOTHING_SPENT);
  });

  test('AE9: a refused burst limiter answers -32099 after taking only the burst attempt', async () => {
    const f = await fixture({ burstOk: false });
    const out = await call(f, { url: 'example.com', public_listing: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('-32099');
    expect(out.text).toContain('burst window');
    expect(f.bucket.puts).toEqual([]);
    expect(spent(f)).toEqual({ burst: 1, hourly: 0, flip: 0 });
  });

  test('AE9: a full hourly window answers -32099 and writes nothing', async () => {
    const bucket = Math.floor(Date.now() / HOUR_MS);
    const f = await fixture({ kvSeed: { [`audit:web:${IP}:${bucket}`]: String(HOURLY_AUDIT_CEILING) } });
    const out = await call(f, { url: 'example.com', public_listing: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('-32099');
    expect(out.text).toContain(`${HOURLY_AUDIT_CEILING} fresh audits per hour per source`);
    expect(f.bucket.puts).toEqual([]);
    expect(spent(f)).toEqual({ burst: 1, hourly: 0, flip: 0 });
  });

  test('AE9: a contended hourly window answers the contention message and writes nothing', async () => {
    const f = await fixture({
      kvHooks: {
        onPut: (key) => {
          if (key.startsWith('audit:web:')) throw new Error('KV PUT failed: 429 Too Many Requests');
        },
      },
    });
    const out = await call(f, { url: 'example.com', public_listing: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('-32099');
    expect(out.text).toContain('Several audits started at once');
    expect(f.bucket.puts).toEqual([]);
    expect(f.gates.takes('web_audit_flip:')).toBe(0);
  });

  test('AE10: five changes on one domain succeed and the sixth is refused with the end of the hour', async () => {
    const f = await fixture({ records: { [TARGET]: { listing: false } } });
    for (let i = 0; i < FLIP_CEILING; i++) {
      const out = await answer(f, { url: 'example.com', public_listing: i % 2 === 0 });
      expect(out.changed).toBe(true);
    }
    const afterFive = f.bucket.objects.get(await keyFor(TARGET, SPEC_VERSION));
    const refused = await call(f, { url: 'example.com', public_listing: false });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('-32099');
    expect(refused.text).toContain('flip_rate_limited');
    expect(refused.text).toContain(`${FLIP_CEILING} per hour across all callers`);
    expect(refused.text).toContain(hourWindowEndsAt(Date.now()));
    expect(f.bucket.objects.get(await keyFor(TARGET, SPEC_VERSION))).toEqual(afterFive);
    expect(spent(f).flip).toBe(FLIP_CEILING);
  });

  test('AE10: a flip budget spent through the shared meter blocks the tool for that domain', async () => {
    const f = await fixture({ records: { [TARGET]: { listing: false } } });
    for (let i = 0; i < FLIP_CEILING; i++) {
      const outcome = await enforcePublicListingFlipLimit({
        write: { path: 'audit', value: i % 2 === 0, flagChanges: true },
        kv: f.gates.kv,
        domain: 'example.com',
      });
      expect(outcome).toBe('allowed');
    }
    const refused = await call(f, { url: 'example.com', public_listing: true }, '203.0.113.99');
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('flip_rate_limited');
    expect(f.bucket.puts).toEqual([]);
  });
});

describe('set_website_public_listing: a write that does not land', () => {
  test('AE11: a refused R2 put is a tool error that says nothing changed and no success fields', async () => {
    const f = await fixture();
    f.bucket.hooks.failPuts = true;
    const out = await call(f, { url: 'example.com', public_listing: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('patch_failed');
    expect(out.text).toContain('nothing was changed');
    expect(out.text).toContain(`${FLIP_CEILING} listing changes this hour`);
    expect(out.text).not.toContain('"changed"');
    expect((await bodyOf(f))?.scorecard.public_listing).toBe(false);
  });

  test('AE11: a record deleted between the first read and the re-read answers patch_failed with nothing written', async () => {
    const f = await fixture({
      kvHooks: {
        onPut: async (key) => {
          if (key.startsWith('web_audit_flip:')) await f.bucket.drop(TARGET);
        },
      },
    });
    const out = await call(f, { url: 'example.com', public_listing: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('patch_failed');
    expect(f.bucket.puts).toEqual([]);
    expect(await bodyOf(f)).toBeNull();
  });

  test('R17: an audit saved while the change waited on its gates keeps its scorecard and scored_at', async () => {
    const newer = recordOf(TARGET, {
      listing: false,
      scoredAt: new Date().toISOString(),
      extra: { score_pct: 91, results: [{ id: 'r2', status: 'fail' }] },
    });
    const f = await fixture({
      kvHooks: {
        onPut: async (key) => {
          if (key.startsWith('audit:web:')) await f.bucket.set(TARGET, newer);
        },
      },
    });
    const out = await answer(f, { url: 'example.com', public_listing: true });
    expect(out).toMatchObject({ changed: true, scored_at: newer.scored_at });
    const stored = (await bodyOf(f)) as StoredWebRecord;
    expect(stored.scored_at).toBe(newer.scored_at);
    expect(stored.scorecard).toEqual({ ...newer.scorecard, public_listing: true });
    expect((await f.bucket.metadataOf(TARGET))?.public_listing).toBe('true');
  });

  test('a record that already stores the value at the re-read is not written again, and its units stay spent', async () => {
    const f = await fixture({
      kvHooks: {
        onPut: async (key) => {
          if (key.startsWith('web_audit_flip:')) await f.bucket.set(TARGET, recordOf(TARGET, { listing: true }));
        },
      },
    });
    const out = await answer(f, { url: 'example.com', public_listing: true });
    expect(out).toMatchObject({ changed: false, public_listing: true });
    expect(f.bucket.puts).toEqual([]);
    expect(spent(f)).toEqual({ burst: 1, hourly: 1, flip: 1 });
  });

  test('AE13: a flip counter that throws fails the call before the write, leaving the store unchanged', async () => {
    const f = await fixture({
      kvHooks: {
        onPut: (key) => {
          if (key.startsWith('web_audit_flip:')) throw new Error('KV PUT failed: 500 Internal Error');
        },
      },
    });
    const out = await call(f, { url: 'example.com', public_listing: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('500 Internal Error');
    expect(f.bucket.puts).toEqual([]);
    expect((await bodyOf(f))?.scorecard.public_listing).toBe(false);
  });
});

describe('set_website_public_listing: the log record', () => {
  const LISTING_SCOPE = 'web-listing.change';

  function changeRecords(records: CapturedLog[]) {
    return records.filter(({ record }) => record.scope === LISTING_SCOPE);
  }

  test('a change writes one record naming the site, the new value, and the MCP surface, and no caller detail', async () => {
    const f = await fixture({ records: { [TARGET]: { listing: false } } });
    const { result, records } = await withLogCapture(() => answer(f, { url: 'example.com', public_listing: true }));
    expect(result.changed).toBe(true);
    const written = changeRecords(records);
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({
      level: 'log',
      record: { scope: LISTING_SCOPE, target: 'example.com', public_listing: true, surface: 'mcp' },
    });
    expect(JSON.stringify(records)).not.toContain(IP);
  });

  test('an unlisting writes its own record carrying false', async () => {
    const f = await fixture({ records: { [TARGET]: { listing: true } } });
    const { records } = await withLogCapture(() => answer(f, { url: 'example.com', public_listing: false }));
    expect(changeRecords(records).map(({ record }) => record.public_listing)).toEqual([false]);
  });

  test('www.<domain> folded onto <domain> logs the <domain> record it changed', async () => {
    const f = await fixture({
      records: { [TARGET]: { listing: false, extra: { site_hosts: ['example.com', 'www.example.com'] } } },
    });
    const { records } = await withLogCapture(() => answer(f, { url: 'www.example.com', public_listing: true }));
    expect(changeRecords(records).map(({ record }) => record.target)).toEqual(['example.com']);
  });

  test('a record that already stores the value at the re-read writes no record', async () => {
    const f = await fixture({
      kvHooks: {
        onPut: async (key) => {
          if (key.startsWith('web_audit_flip:')) await f.bucket.set(TARGET, recordOf(TARGET, { listing: true }));
        },
      },
    });
    const { result, records } = await withLogCapture(() => answer(f, { url: 'example.com', public_listing: true }));
    expect(result.changed).toBe(false);
    expect(changeRecords(records)).toEqual([]);
  });

  test('a call refused by the flip budget writes no record', async () => {
    const f = await fixture({ records: { [TARGET]: { listing: false } } });
    for (let i = 0; i < FLIP_CEILING; i++) {
      await answer(f, { url: 'example.com', public_listing: i % 2 === 0 });
    }
    const { result, records } = await withLogCapture(() => call(f, { url: 'example.com', public_listing: false }));
    expect(result.text).toContain('flip_rate_limited');
    expect(changeRecords(records)).toEqual([]);
  });

  test('a write that does not land writes no record', async () => {
    const f = await fixture();
    f.bucket.hooks.failPuts = true;
    const { result, records } = await withLogCapture(() => call(f, { url: 'example.com', public_listing: true }));
    expect(result.text).toContain('patch_failed');
    expect(changeRecords(records)).toEqual([]);
  });
});

describe('set_website_public_listing: the input and what it advertises', () => {
  type Listed = {
    name: string;
    title?: string;
    description?: string;
    annotations?: Record<string, unknown>;
    inputSchema: { properties: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };
  };

  async function listed(): Promise<Listed> {
    const f = await fixture();
    const { body } = await mcpRpc(f.env, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const tools = (body.result?.tools ?? []) as unknown as Listed[];
    const tool = tools.find((t) => t.name === 'set_website_public_listing');
    if (!tool) throw new Error('set_website_public_listing is not listed');
    return tool;
  }

  test('a missing public_listing, a non-boolean one, and an extra key are refused and write nothing', async () => {
    const f = await fixture();
    for (const args of [
      { url: 'example.com' },
      { url: 'example.com', public_listing: 'true' },
      { url: 'example.com', public_listing: 1 },
      { url: 'example.com', public_listing: true, site_type: 'content' },
    ]) {
      const out = await call(f, args);
      expect(out.isError).toBe(true);
      expect(out.text).toContain('Input validation error');
    }
    expect(f.bucket.puts).toEqual([]);
    expect(spent(f)).toEqual(NOTHING_SPENT);
  });

  test('tools/list: both arguments are required, nothing else is accepted, and the hints say a repeatable overwrite', async () => {
    const tool = await listed();
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['url', 'public_listing']);
    expect(tool.inputSchema.required).toEqual(['url', 'public_listing']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.title).toBe("Set a website's public listing");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test('the description leads with what the tool does, then says to call it only when the user asks', async () => {
    const description = (await listed()).description ?? '';
    expect(description.startsWith('Opt a website in to or out of the public website leaderboard at ')).toBe(true);
    expect(description.indexOf('and change nothing else.')).toBeLessThan(
      description.indexOf('Call it only when the user'),
    );
    expect(description).toContain('Call it only when the user explicitly asks to list or unlist a site');
    expect(description).toContain('anc does not check who owns the site');
    expect(description).toContain(`one of the ${HOURLY_AUDIT_CEILING} fresh audits per 60 minutes per IP`);
    expect(description).toContain(`one of ${FLIP_CEILING} listing changes per hour per site across all callers`);
    expect(description).toContain('under 30 days old');
    expect(description).not.toContain('MCP_ENABLED');
  });
});
