// GET /og/score/<target>/<key>.png against stubbed bindings. The route reads a
// stored card or asks the render Worker to draw one; the RENDER binding here
// is a fake that records its calls.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DrawnCard } from '../src/shared/og-render';
import { scoreOgPath } from '../src/shared/score-og';
import { sha256Hex } from '../src/worker/audit-web/cache';
import { handleScoreOg } from '../src/worker/og/route';
import { keyFor as cliKeyFor } from '../src/worker/score/cache';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';
import { captureLogs, type LogCapture } from './helpers/log-capture';
import {
  CURATED_KEY,
  DEFAULT_CARD,
  DRAWN_PNG,
  fakeRender,
  R,
  SCORED_AT,
  type SiteEnv,
  STALE_KEY,
  siteEnv,
  WEB_KEY,
  webEnv,
} from './helpers/og-site-fakes';

const ORIGIN = 'https://anc.dev';

function request(path: string, method = 'GET'): Request {
  return new Request(`${ORIGIN}${path}`, { method });
}

function serve(env: SiteEnv, path: string, method = 'GET') {
  return handleScoreOg(request(path, method), env as never, { timeoutMs: 50 });
}

function cardObjects(env: SiteEnv): string[] {
  return [...env.SCORE_CACHE.objects.keys()].filter((key) => key.startsWith('og/score/'));
}

async function storeCardFor(env: SiteEnv, target: string, key: string, logo: string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 4]);
  env.SCORE_CACHE.objects.set(`og/score/${await sha256Hex(target)}/${key}.png`, {
    bytes,
    contentType: 'image/png',
    meta: { target, key, logo },
    uploaded: new Date(),
  });
  return bytes;
}

const drawCalls = (env: SiteEnv) =>
  (env.RENDER as ReturnType<typeof fakeRender>).calls.filter((call) => call.method === 'drawCard');

let logs: LogCapture;
beforeEach(() => {
  _resetRegistryIndexCache();
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  _resetRegistryIndexCache();
});

const ogRecords = () => logs.records.map((entry) => entry.record).filter((record) => record.scope === 'score.og');

describe('scorecard OG route: canonical keys', () => {
  test('a key that is not the stored score 301s to the key that is', async () => {
    const res = await serve(await webEnv(), `/og/score/anc.dev/${STALE_KEY}.png`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(scoreOgPath('anc.dev', WEB_KEY));
    expect(res.headers.get('cache-control')).not.toContain('immutable');
  });

  test('a query string 301s to the bare canonical path', async () => {
    const res = await serve(await webEnv(), `/og/score/anc.dev/${WEB_KEY}.png?v=1`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(scoreOgPath('anc.dev', WEB_KEY));
  });

  test('a binary alias 301s once, to the slug and the stored score', async () => {
    const res = await serve(siteEnv(), `/og/score/rg/${STALE_KEY}.png`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(scoreOgPath('ripgrep', CURATED_KEY));
  });

  test('a branch card keys on its short source sha', async () => {
    const env = siteEnv({
      records: {
        [cliKeyFor('o/r@feature', SPEC_VERSION)]: {
          spec_version: SPEC_VERSION,
          anc_version: ANC_VERSION,
          tool_version: '',
          source_sha: 'abcdef1234567890abcdef1234567890abcdef12',
          scorecard: { badge: { score_pct: 51 }, run: { started_at: '2026-10-21T09:00:00.000Z' } },
        },
      },
    });
    const res = await serve(env, `/og/score/o/r@feature/${STALE_KEY}.png`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(scoreOgPath('o/r@feature', `s51-v${SPEC_VERSION}-gabcdef1${R}`));
  });

  test('an unknown target, a malformed path and a key in the earlier grammar are 404s', async () => {
    expect((await serve(siteEnv(), `/og/score/not-a-tool.example/${STALE_KEY}.png`)).status).toBe(404);
    expect((await serve(siteEnv(), '/og/score/anc.dev')).status).toBe(404);
    expect((await serve(await webEnv(), `/og/score/anc.dev/s64-v${SPEC_VERSION}.png`)).status).toBe(404);
  });

  test('a registry outage is a 503 with retry-after', async () => {
    const res = await serve(siteEnv({ failRegistry: true }), `/og/score/ripgrep/${CURATED_KEY}.png`);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
  });

  test('POST is rejected', async () => {
    expect((await serve(siteEnv(), `/og/score/anc.dev/${WEB_KEY}.png`, 'POST')).status).toBe(405);
  });
});

describe('scorecard OG route: serving the card', () => {
  test('a stored card is served without a render call, with its logo source from metadata', async () => {
    const env = await webEnv();
    const bytes = await storeCardFor(env, 'anc.dev', WEB_KEY, 'brand');
    const res = await serve(env, `/og/score/anc.dev/${WEB_KEY}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('x-anc-card')).toBe('stored');
    expect(res.headers.get('x-anc-card-logo')).toBe('brand');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(drawCalls(env)).toHaveLength(0);
  });

  test('a missing card is drawn by one render call and cached immutably', async () => {
    const env = await webEnv();
    const res = await serve(env, `/og/score/anc.dev/${WEB_KEY}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('x-anc-card')).toBe('drawn');
    expect(res.headers.get('x-anc-card-logo')).toBe('tile');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(DRAWN_PNG);
    const calls = drawCalls(env);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      inputs: {
        target: 'anc.dev',
        key: WEB_KEY,
        pages: ['https://anc.dev/'],
        scoredAt: SCORED_AT,
        card: { name: 'Anc', subtitle: 'anc.dev', lane: 'web', scorePct: 64, pending: false },
      },
    });
    expect(cardObjects(env)).toEqual([]);
  });

  test.each([
    ['a curated CLI card', 'ripgrep', CURATED_KEY, {}, '2026-10-05T18:42:23.480Z'],
    [
      'a live CLI card',
      'livetool',
      `s70-v${SPEC_VERSION}-t1.0.0${R}`,
      {
        [cliKeyFor('livetool', SPEC_VERSION)]: {
          spec_version: SPEC_VERSION,
          anc_version: ANC_VERSION,
          tool_version: '1.0.0',
          scorecard: { badge: { score_pct: 70 }, run: { started_at: '2026-10-20T09:00:00.000Z' } },
        },
      },
      '2026-10-20T09:00:00.000Z',
    ],
  ])('%s is drawn with the time its scorecard ran', async (_label, target, key, records, scoredAt) => {
    const env = siteEnv({ records });
    const res = await serve(env, `/og/score/${target}/${key}.png`);
    expect(res.status).toBe(200);
    expect(drawCalls(env)[0]).toMatchObject({ inputs: { target, key, scoredAt } });
  });

  test('a card whose logo lookup was cut short is served on the short cache', async () => {
    const env = await webEnv({
      render: fakeRender({
        drawCard: async () => ({ outcome: 'card', png: DRAWN_PNG, card: 'drawn', logo: 'tile', settled: false }),
      }),
    });
    const res = await serve(env, `/og/score/anc.dev/${WEB_KEY}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).not.toContain('immutable');
    expect(res.headers.get('cloudflare-cdn-cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('x-anc-card')).toBe('drawn');
    expect(res.headers.get('x-anc-card-logo')).toBe('tile');
  });

  test('an in-flight audit with no record redirects to pending.png, which is drawn and not immutable', async () => {
    const env = siteEnv({
      kv: {
        'inflight:web:railway.com': JSON.stringify({ started_at: '2026-10-14T00:00:00.000Z', job: 'web:railway.com' }),
      },
    });
    const wrong = await serve(env, `/og/score/railway.com/${STALE_KEY}.png`);
    expect(wrong.status).toBe(301);
    expect(wrong.headers.get('location')).toBe('/og/score/railway.com/pending.png');
    const res = await serve(env, '/og/score/railway.com/pending.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).not.toContain('immutable');
    expect(drawCalls(env)[0]).toMatchObject({ inputs: { key: 'pending', card: { pending: true } } });
  });

  test('a render Worker draw for another template version is a 503 and stores nothing', async () => {
    const env = await webEnv({
      render: fakeRender({ drawCard: async (): Promise<DrawnCard> => ({ outcome: 'skew' }) }),
    });
    const res = await serve(env, `/og/score/anc.dev/${WEB_KEY}.png`);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(cardObjects(env)).toEqual([]);
  });
});

describe('scorecard OG route: render Worker unavailable', () => {
  test.each([
    [
      'a failed call',
      async (): Promise<DrawnCard> => {
        throw new Error('service binding unavailable');
      },
    ],
    ['a call slower than the timeout', () => new Promise<DrawnCard>(() => {})],
  ])('%s serves the default card on the short cache and stores nothing', async (_label, drawCard) => {
    const env = await webEnv({ render: fakeRender({ drawCard }) });
    const res = await serve(env, `/og/score/anc.dev/${WEB_KEY}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('cache-control')).not.toContain('immutable');
    expect(res.headers.get('cloudflare-cdn-cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('x-anc-card')).toBe('fallback');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(DEFAULT_CARD);
    expect(cardObjects(env)).toEqual([]);
    expect(ogRecords().at(-1)).toMatchObject({ outcome: 'fallback' });
  });
});
