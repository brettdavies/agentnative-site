// GET and HEAD /og/clip/<target>/<key>.mp4: the stored clip, straight from R2.
// The route never draws or renders; a byte range is the edge cache's to cut.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseScoreOgClipPath, scoreOgClipPath } from '../src/shared/score-og';
import { sha256Hex } from '../src/worker/audit-web/cache';
import { handleScoreOgClip } from '../src/worker/og/clip-route';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import { FAKE_MP4 } from './helpers/og-render-fakes';
import { CURATED_KEY, fakeRender, type SiteEnv, STALE_KEY, siteEnv, WEB_KEY, webEnv } from './helpers/og-site-fakes';

const ORIGIN = 'https://anc.dev';

async function storeClipFor(env: SiteEnv, target: string, key: string): Promise<void> {
  env.SCORE_CACHE.objects.set(`og/clip/${await sha256Hex(target)}/${key}.mp4`, {
    bytes: FAKE_MP4,
    contentType: 'video/mp4',
    meta: { target, key },
    uploaded: new Date(),
  });
}

function serve(env: SiteEnv, path: string, init: RequestInit = {}) {
  return handleScoreOgClip(new Request(`${ORIGIN}${path}`, init), env as never);
}

beforeEach(() => _resetRegistryIndexCache());
afterEach(() => _resetRegistryIndexCache());

describe('clip paths', () => {
  test('a clip path round-trips through the parser', () => {
    const path = scoreOgClipPath('o/r@feature', WEB_KEY);
    expect(path).toBe(`/og/clip/o/r@feature/${WEB_KEY}.mp4`);
    expect(parseScoreOgClipPath(path)).toEqual({ target: 'o/r@feature', key: WEB_KEY });
    expect(parseScoreOgClipPath(`/og/score/anc.dev/${WEB_KEY}.png`)).toBeNull();
    expect(parseScoreOgClipPath(`/og/clip/anc.dev/${WEB_KEY}.png`)).toBeNull();
  });
});

describe('clip route', () => {
  test('GET returns the whole clip as video/mp4, cached immutably and kept out of the index', async () => {
    const env = await webEnv();
    await storeClipFor(env, 'anc.dev', WEB_KEY);
    const res = await serve(env, scoreOgClipPath('anc.dev', WEB_KEY));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(FAKE_MP4.byteLength));
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FAKE_MP4);
  });

  test('a Range request still gets the whole clip as a 200, for the edge cache to slice', async () => {
    const env = await webEnv();
    await storeClipFor(env, 'anc.dev', WEB_KEY);
    const res = await serve(env, scoreOgClipPath('anc.dev', WEB_KEY), { headers: { Range: 'bytes=-4' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-range')).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FAKE_MP4);
  });

  test('HEAD returns the headers without a body', async () => {
    const env = await webEnv();
    await storeClipFor(env, 'anc.dev', WEB_KEY);
    const res = await serve(env, scoreOgClipPath('anc.dev', WEB_KEY), { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe(String(FAKE_MP4.byteLength));
    expect(await res.text()).toBe('');
  });

  test('a missing clip is a 404 the edge does not cache, and the route asks for no render', async () => {
    const render = fakeRender();
    const res = await serve(await webEnv({ render }), scoreOgClipPath('anc.dev', WEB_KEY));
    expect(res.status).toBe(404);
    expect(res.headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
    expect(render.calls).toEqual([]);
  });

  test("a stale key 301s to the current key when that key's clip exists, and is a 404 otherwise", async () => {
    const env = await webEnv();
    const stale = scoreOgClipPath('anc.dev', STALE_KEY);
    expect((await serve(env, stale)).status).toBe(404);
    await storeClipFor(env, 'anc.dev', WEB_KEY);
    const res = await serve(env, stale);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(scoreOgClipPath('anc.dev', WEB_KEY));
  });

  test('a binary alias 301s to the slug when the curated clip exists', async () => {
    const env = siteEnv();
    await storeClipFor(env, 'ripgrep', CURATED_KEY);
    const res = await serve(env, scoreOgClipPath('rg', CURATED_KEY));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(scoreOgClipPath('ripgrep', CURATED_KEY));
  });

  test('an R2 outage is a 503 with retry-after', async () => {
    const res = await serve(siteEnv({ failReads: true }), scoreOgClipPath('anc.dev', WEB_KEY));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
  });

  test('a pending card has no clip', async () => {
    const env = siteEnv({
      kv: {
        'inflight:web:railway.com': JSON.stringify({ started_at: '2026-10-14T00:00:00.000Z', job: 'web:railway.com' }),
      },
    });
    expect((await serve(env, '/og/clip/railway.com/pending.mp4')).status).toBe(404);
  });

  test('POST is rejected', async () => {
    expect((await serve(siteEnv(), scoreOgClipPath('anc.dev', WEB_KEY), { method: 'POST' })).status).toBe(405);
  });
});
