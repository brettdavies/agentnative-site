// The site's two ends of a render: asking the render Worker for a finished
// card's clip, gated by the OG_VIDEO_ENABLED switch, and purging the page
// that should name the clip once og-rendered says it landed.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OgRenderedMessage } from '../src/shared/og-render';
import { requestRender } from '../src/worker/og/render-request';
import { handleOgRendered } from '../src/worker/og/rendered-consumer';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
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

function batch(messages: OgRenderedMessage[]) {
  const acked: OgRenderedMessage[] = [];
  return {
    acked,
    batch: {
      messages: messages.map((body) => ({ body, ack: () => acked.push(body) })),
    } as unknown as MessageBatch<OgRenderedMessage>,
  };
}

function purgeCtx() {
  const purged: string[][] = [];
  const ctx = {
    exports: {
      Cached: {
        async purgeHitMinTags(tags: string[]) {
          purged.push(tags);
          return { success: true, errors: [] };
        },
      },
    },
  };
  return { ctx, purged };
}

describe('og-rendered consumer', () => {
  test("a landed clip purges its page's tag: web:<host> for a site, cli:<slug> for a tool", async () => {
    const { ctx, purged } = purgeCtx();
    const { batch: web, acked } = batch([
      { target: 'railway.com', lane: 'web', key: WEB_KEY },
      { target: 'ripgrep', lane: 'cli', key: CURATED_KEY },
    ]);
    await handleOgRendered(web, ctx);
    expect(purged).toEqual([['web:railway.com'], ['cli:ripgrep']]);
    expect(acked).toHaveLength(2);
  });
});
