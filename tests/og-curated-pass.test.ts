// The curated pass: after each deploy and on the weekly cron, every curated
// CLI card and seeded website card whose clip is missing or older than 21
// days is asked for in one batch, so curated pages keep a fresh clip.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { RenderInputs } from '../src/shared/og-render';
import { sha256Hex, keyFor as webKeyFor } from '../src/worker/audit-web/cache';
import { resetWebSeedCacheForTests } from '../src/worker/audit-web/seed';
import { handleCuratedPass, runCuratedPass } from '../src/worker/og/curated-pass';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';
import { FAKE_MP4 } from './helpers/og-render-fakes';
import { CURATED_KEY, fakeRender, type SiteEnv, siteEnv, webRecord } from './helpers/og-site-fakes';

const DAY_MS = 24 * 60 * 60 * 1000;
const SECRET = 'rescore-secret';

beforeEach(() => {
  _resetRegistryIndexCache();
  resetWebSeedCacheForTests();
});
afterEach(() => {
  _resetRegistryIndexCache();
  resetWebSeedCacheForTests();
});

async function seededEnv(domains: string[], ogVideo = 'true'): Promise<SiteEnv & { WEB_RESCORE_SECRET: string }> {
  const records: Record<string, unknown> = {};
  for (const [i, domain] of domains.entries()) {
    records[await webKeyFor(`https://${domain}/`, SPEC_VERSION)] = webRecord(domain, 40 + (i % 60));
  }
  return { ...siteEnv({ seed: domains, records, ogVideo, render: fakeRender() }), WEB_RESCORE_SECRET: SECRET };
}

async function clipAged(env: SiteEnv, target: string, key: string, days: number): Promise<void> {
  env.SCORE_CACHE.objects.set(`og/clip/${await sha256Hex(target)}/${key}.mp4`, {
    bytes: FAKE_MP4,
    meta: {},
    uploaded: new Date(Date.now() - days * DAY_MS),
  });
}

function batches(env: SiteEnv): RenderInputs[][] {
  const render = env.RENDER as ReturnType<typeof fakeRender>;
  return render.calls.flatMap((call) => (call.method === 'requestMany' ? [call.inputs] : []));
}

describe('runCuratedPass', () => {
  test('asks for a curated card with no clip and one whose clip is 22 days old, not one 2 days old', async () => {
    const env = await seededEnv(['fresh.example', 'stale.example']);
    const probe = fakeRender();
    await runCuratedPass({ ...env, RENDER: probe });
    const all = probe.calls.flatMap((call) => (call.method === 'requestMany' ? call.inputs : []));
    const keyFor = (target: string) => all.find((input) => input.target === target)?.key ?? '';
    await clipAged(env, 'fresh.example', keyFor('fresh.example'), 2);
    await clipAged(env, 'stale.example', keyFor('stale.example'), 22);

    const result = await runCuratedPass(env);
    expect(batches(env)).toHaveLength(1);
    expect(
      batches(env)[0]
        .map((input) => input.target)
        .sort(),
    ).toEqual(['ripgrep', 'stale.example']);
    expect(batches(env)[0].find((input) => input.target === 'ripgrep')?.key).toBe(CURATED_KEY);
    expect(result).toEqual({ enabled: true, requested: 2, fresh: 1, skipped: 0 });
  });

  test('with the switch off, asks for nothing', async () => {
    const env = await seededEnv(['site.example'], '');
    expect(await runCuratedPass(env)).toEqual({ enabled: false, requested: 0, fresh: 0, skipped: 0 });
    expect((env.RENDER as ReturnType<typeof fakeRender>).calls).toEqual([]);
  });

  test('150 stale seeded sites and the curated tool go out in one batch of 151', async () => {
    const env = await seededEnv(Array.from({ length: 150 }, (_, i) => `site-${i}.example`));
    await runCuratedPass(env);
    expect(batches(env)).toHaveLength(1);
    expect(batches(env)[0]).toHaveLength(151);
  });
});

describe('POST /api/og-curated-pass', () => {
  const post = (headers: Record<string, string> = {}) =>
    new Request('https://anc.dev/api/og-curated-pass', { method: 'POST', headers });

  test('rejects a missing or wrong secret and runs nothing', async () => {
    const env = await seededEnv(['site.example']);
    expect((await handleCuratedPass(post(), env)).status).toBe(401);
    expect((await handleCuratedPass(post({ 'x-web-rescore-secret': 'wrong' }), env)).status).toBe(401);
    expect((env.RENDER as ReturnType<typeof fakeRender>).calls).toEqual([]);
  });

  test('runs the pass for the right secret and reports what it asked for', async () => {
    const env = await seededEnv(['site.example']);
    const res = await handleCuratedPass(post({ 'x-web-rescore-secret': SECRET }), env);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ enabled: true, requested: 2, fresh: 0, skipped: 0 });
  });
});
