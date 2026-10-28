// The site's two ends of a render: asking the render Worker for a finished
// card's clip, gated by the OG_VIDEO_ENABLED switch, and purging the page
// that should name the clip once og-rendered says it landed.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OgRenderedMessage } from '../src/shared/og-render';
import { requestRender } from '../src/worker/og/render-request';
import { handleOgRendered, OG_RENDERED_MAX_ATTEMPTS } from '../src/worker/og/rendered-consumer';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import { withLogCapture } from './helpers/log-capture';
import { CURATED_KEY, fakeRender, SCORED_AT, siteEnv, WEB_KEY, webEnv } from './helpers/og-site-fakes';

beforeEach(() => _resetRegistryIndexCache());
afterEach(() => _resetRegistryIndexCache());

describe('requestRender', () => {
  test('with the switch unset, no render is requested', async () => {
    const render = fakeRender();
    await requestRender(await webEnv({ render }), 'anc.dev');
    expect(render.calls).toEqual([]);
  });

  test("with the switch on, a finished card's inputs go out in one request", async () => {
    const render = fakeRender();
    await requestRender(await webEnv({ render, ogVideo: 'true' }), 'anc.dev');
    expect(render.calls).toEqual([
      {
        method: 'request',
        inputs: {
          target: 'anc.dev',
          key: WEB_KEY,
          card: expect.objectContaining({ name: 'Anc', lane: 'web', scorePct: 64 }),
          pages: ['https://anc.dev/'],
          scoredAt: SCORED_AT,
        },
      },
    ]);
    const [call] = render.calls;
    expect(call.method === 'request' && 'logo' in call.inputs.card).toBe(false);
  });

  test('a curated CLI slug requests its curated card', async () => {
    const render = fakeRender();
    await requestRender(siteEnv({ render, ogVideo: 'true' }), 'ripgrep');
    expect(render.calls).toEqual([{ method: 'request', inputs: expect.objectContaining({ key: CURATED_KEY }) }]);
  });

  test('a pending card requests nothing', async () => {
    const render = fakeRender();
    const env = siteEnv({
      render,
      ogVideo: 'true',
      kv: {
        'inflight:web:railway.com': JSON.stringify({ started_at: '2026-10-14T00:00:00.000Z', job: 'web:railway.com' }),
      },
    });
    await requestRender(env, 'railway.com');
    expect(render.calls).toEqual([]);
  });

  test('a render Worker that never answers holds the caller no longer than the bound', async () => {
    const render = fakeRender({ request: () => new Promise(() => {}) });
    const started = Date.now();
    await requestRender(await webEnv({ render, ogVideo: 'true' }), 'anc.dev');
    expect(Date.now() - started).toBeLessThan(7_000);
  }, 10_000);

  test('a render Worker that fails the call does not fail the caller', async () => {
    const render = fakeRender({
      request: async () => {
        throw new Error('service binding unavailable');
      },
    });
    await expect(requestRender(await webEnv({ render, ogVideo: 'true' }), 'anc.dev')).resolves.toBeUndefined();
  });
});

type Settled =
  | { body: OgRenderedMessage; outcome: 'ack' }
  | { body: OgRenderedMessage; outcome: 'retry'; delaySeconds?: number };

function batch(messages: OgRenderedMessage[], attempts = 1) {
  const settled: Settled[] = [];
  return {
    settled,
    batch: {
      messages: messages.map((body) => ({
        body,
        attempts,
        ack: () => settled.push({ body, outcome: 'ack' }),
        retry: (options?: { delaySeconds?: number }) =>
          settled.push({ body, outcome: 'retry', delaySeconds: options?.delaySeconds }),
      })),
    } as unknown as MessageBatch<OgRenderedMessage>,
  };
}

function purgeCtx(succeed: (tags: string[]) => boolean = () => true) {
  const purged: string[][] = [];
  const ctx = {
    exports: {
      Cached: {
        async purgeHitMinTags(tags: string[]) {
          purged.push(tags);
          return succeed(tags)
            ? { success: true, errors: [] }
            : { success: false, errors: [{ message: 'Unable to purge, rate limit reached', code: 1134 }] };
        },
      },
    },
  };
  return { ctx, purged };
}

function web(n: number): OgRenderedMessage {
  return { target: `site-${n}.example`, lane: 'web', key: WEB_KEY };
}

describe('og-rendered consumer', () => {
  test("a batch purges every landed clip's page tag in one call: web:<host> for a site, cli:<slug> for a tool", async () => {
    const { ctx, purged } = purgeCtx();
    const { batch: landed, settled } = batch([
      { target: 'railway.com', lane: 'web', key: WEB_KEY },
      { target: 'ripgrep', lane: 'cli', key: CURATED_KEY },
      { target: 'railway.com', lane: 'web', key: WEB_KEY },
    ]);
    await handleOgRendered(landed, ctx);
    expect(purged).toEqual([['web:railway.com', 'cli:ripgrep']]);
    expect(settled.map((s) => s.outcome)).toEqual(['ack', 'ack', 'ack']);
  });

  test('a batch with more page tags than one purge takes splits into calls of at most 100', async () => {
    const { ctx, purged } = purgeCtx();
    const { batch: landed, settled } = batch(Array.from({ length: 130 }, (_, n) => web(n)));
    await handleOgRendered(landed, ctx);
    expect(purged.map((tags) => tags.length)).toEqual([100, 30]);
    expect(settled.every((s) => s.outcome === 'ack')).toBe(true);
  });

  test('a refused purge retries its messages after a delay that grows with each attempt, and acks the rest', async () => {
    const { ctx } = purgeCtx((tags) => tags.length === 30);
    const { batch: first, settled } = batch(Array.from({ length: 130 }, (_, n) => web(n)));
    await handleOgRendered(first, ctx);
    expect(settled.filter((s) => s.outcome === 'retry')).toHaveLength(100);
    expect(settled.filter((s) => s.outcome === 'ack')).toHaveLength(30);

    const delays: Array<number | undefined> = [];
    for (let attempts = 1; attempts < OG_RENDERED_MAX_ATTEMPTS; attempts++) {
      const refused = batch([web(1)], attempts);
      await handleOgRendered(refused.batch, purgeCtx(() => false).ctx);
      const [only] = refused.settled;
      expect(only.outcome).toBe('retry');
      delays.push(only.outcome === 'retry' ? only.delaySeconds : undefined);
    }
    expect(delays[0]).toBeGreaterThanOrEqual(60);
    expect(delays).toEqual([...delays].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  test('on its last attempt a refused purge is acknowledged and logged as given up, and the page refreshes at its TTL', async () => {
    const { result, records } = await withLogCapture(async () => {
      const last = batch([web(7)], OG_RENDERED_MAX_ATTEMPTS);
      await handleOgRendered(last.batch, purgeCtx(() => false).ctx);
      return last.settled;
    });
    expect(result).toEqual([{ body: web(7), outcome: 'ack' }]);
    expect(records.map((r) => r.record)).toContainEqual(
      expect.objectContaining({ scope: 'hit-min-purge', error: 'og_rendered_gave_up', tags: ['web:site-7.example'] }),
    );
  });
});
