// The render pipeline a RenderJob's alarm runs, and the on-demand card the
// site asks for, against fake R2, Media and network.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { drawCard, type JobStub } from '../src/og-render/draw-card';
import { type RenderEnv, runRender } from '../src/og-render/render-job';
import type { RenderInputs, RenderJobStatus } from '../src/shared/og-render';
import { SCORE_OG_TEMPLATE } from '../src/shared/score-og';
import { SCORE_OG_MOTION, type ScoreOgMotion } from '../src/shared/score-og-motion';
import { sha256Hex } from '../src/worker/audit-web/cache';
import { type CapturedLog, captureLogs, type LogCapture } from './helpers/log-capture';
import { cardFonts, FAKE_MP4, type FakeBucket, fakeBucket, fakeMedia, fakeQueue } from './helpers/og-render-fakes';
import { stubFetch } from './helpers/stub-fetch';

const KEY = `s64-v0.6.0-d20261026-r${SCORE_OG_TEMPLATE}`;
const SCORED_AT = '2026-10-26T10:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

const INPUTS: RenderInputs = {
  target: 'railway.com',
  key: KEY,
  card: {
    name: 'Railway',
    subtitle: 'railway.com',
    lane: 'web',
    scorePct: 64,
    pending: false,
    specVersion: '0.6.0',
    edition: { token: 'd20261026', label: '2026-10-26' },
  },
  pages: [],
  scoredAt: SCORED_AT,
};

const SHORT: ScoreOgMotion = { ...SCORE_OG_MOTION, holdStart: 1, drain: 1, climb: 2, holdEnd: 1 };

function makeEnv(overrides: Partial<RenderEnv> = {}): RenderEnv & { SCORE_CACHE: FakeBucket } {
  return {
    SCORE_CACHE: fakeBucket(),
    MEDIA: fakeMedia(),
    OG_RENDERED: fakeQueue(),
    RENDER_JOB: {} as RenderEnv['RENDER_JOB'],
    ...overrides,
  } as RenderEnv & { SCORE_CACHE: FakeBucket };
}

async function objectName(kind: 'score' | 'clip', target: string, key: string): Promise<string> {
  return `og/${kind}/${await sha256Hex(target)}/${key}.${kind === 'score' ? 'png' : 'mp4'}`;
}

const deps = async () => ({ fonts: await cardFonts(), motion: SHORT, yieldFrame: async () => {} });
const marked = async () => true;
const unreachable = stubFetch(() => {
  throw new TypeError('network down');
});

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

function renderRecords(): CapturedLog['record'][] {
  return logs.records.map((entry) => entry.record).filter((record) => record.scope === 'og.render');
}

describe('runRender', () => {
  test('stores the PNG and the clip under the card key with their metadata', async () => {
    const env = makeEnv();
    const outcome = await runRender(env, INPUTS, marked, await deps());
    expect(outcome).toEqual({ outcome: 'rendered', logo: 'tile' });
    for (const kind of ['score', 'clip'] as const) {
      const stored = env.SCORE_CACHE.objects.get(await objectName(kind, INPUTS.target, KEY));
      expect(stored?.meta).toEqual({
        target: 'railway.com',
        key: KEY,
        scored_at: SCORED_AT,
        template: String(SCORE_OG_TEMPLATE),
        logo: 'tile',
      });
      expect(stored?.contentType).toBe(kind === 'score' ? 'image/png' : 'video/mp4');
    }
    const clip = env.SCORE_CACHE.objects.get(await objectName('clip', INPUTS.target, KEY));
    expect(clip?.bytes).toEqual(FAKE_MP4);
  });

  test('the Media binding gets the GIF with an explicit 1200x630 size and a silent video output', async () => {
    const media = fakeMedia();
    await runRender(makeEnv({ MEDIA: media }), INPUTS, marked, await deps());
    expect(media.calls).toHaveLength(1);
    expect(new TextDecoder().decode(media.calls[0].input.slice(0, 6))).toBe('GIF89a');
    expect(media.calls[0].transform).toEqual({ width: 1200, height: 630 });
    expect(media.calls[0].output).toEqual({ mode: 'video', audio: false });
  });

  test('a clip uploaded 3 days ago ends the job without a binding call', async () => {
    const media = fakeMedia();
    const env = makeEnv({ MEDIA: media });
    const name = await objectName('clip', INPUTS.target, KEY);
    env.SCORE_CACHE.objects.set(name, { bytes: FAKE_MP4, meta: {}, uploaded: new Date(Date.now() - 3 * DAY_MS) });
    expect(await runRender(env, INPUTS, marked, await deps())).toEqual({ outcome: 'fresh' });
    expect(media.calls).toHaveLength(0);
  });

  test('a clip uploaded 25 days ago renders again', async () => {
    const media = fakeMedia();
    const env = makeEnv({ MEDIA: media });
    const name = await objectName('clip', INPUTS.target, KEY);
    env.SCORE_CACHE.objects.set(name, { bytes: FAKE_MP4, meta: {}, uploaded: new Date(Date.now() - 25 * DAY_MS) });
    expect((await runRender(env, INPUTS, marked, await deps())).outcome).toBe('rendered');
    expect(media.calls).toHaveLength(1);
  });

  test('inputs drawn for another template version render nothing', async () => {
    const media = fakeMedia();
    const env = makeEnv({ MEDIA: media });
    const skewed = { ...INPUTS, key: `s64-v0.6.0-d20261026-r${SCORE_OG_TEMPLATE + 1}` };
    expect(await runRender(env, skewed, marked, await deps())).toEqual({ outcome: 'skew' });
    expect(env.SCORE_CACHE.objects.size).toBe(0);
    expect(media.calls).toHaveLength(0);
  });

  test('the PNG is stored and marked before the first frame draws', async () => {
    const env = makeEnv();
    const pngName = await objectName('score', INPUTS.target, KEY);
    let markedPng = false;
    const seenAtFirstFrame: boolean[] = [];
    await runRender(
      env,
      INPUTS,
      async () => {
        markedPng = true;
        return true;
      },
      {
        ...(await deps()),
        yieldFrame: async () => {
          if (seenAtFirstFrame.length === 0) seenAtFirstFrame.push(markedPng, env.SCORE_CACHE.objects.has(pngName));
        },
      },
    );
    expect(seenAtFirstFrame).toEqual([true, true]);
  });

  test('a run taken over before its PNG is marked stops before drawing frames', async () => {
    const media = fakeMedia();
    let frames = 0;
    const run = runRender(makeEnv({ MEDIA: media }), INPUTS, async () => false, {
      ...(await deps()),
      yieldFrame: async () => {
        frames += 1;
      },
    });
    await expect(run).rejects.toThrow('taken over');
    expect(frames).toBe(0);
    expect(media.calls).toHaveLength(0);
  });

  test('a binding error leaves the PNG stored and no clip, and carries the binding code', async () => {
    const env = makeEnv({ MEDIA: fakeMedia({ code: 9402, message: 'input too large' }) });
    const error = await runRender(env, INPUTS, marked, await deps()).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 9402 });
    expect(env.SCORE_CACHE.objects.has(await objectName('score', INPUTS.target, KEY))).toBe(true);
    expect(env.SCORE_CACHE.objects.has(await objectName('clip', INPUTS.target, KEY))).toBe(false);
  });

  test('a logo lookup cut short draws the tile, stores no logo miss and no PNG, and still stores the clip', async () => {
    const env = makeEnv();
    const withHomepage = { ...INPUTS, pages: ['https://railway.com/'] };
    const outcome = await runRender(env, withHomepage, marked, { ...(await deps()), fetchImpl: unreachable });
    expect(outcome).toEqual({ outcome: 'rendered', logo: 'tile' });
    const names = [...env.SCORE_CACHE.objects.keys()];
    expect(names.some((name) => name.startsWith('og/logo/'))).toBe(false);
    expect(names).not.toContain(await objectName('score', INPUTS.target, KEY));
    expect(names).toContain(await objectName('clip', INPUTS.target, KEY));
  });

  test('with LOCAL_MEDIA_STANDIN set, the committed sample clip is stored and the binding is never called', async () => {
    const media = fakeMedia();
    const env = makeEnv({ MEDIA: media, LOCAL_MEDIA_STANDIN: 'true' });
    await runRender(env, INPUTS, marked, await deps());
    const standin = new Uint8Array(await readFile(new URL('../src/og-render/fixtures/standin.mp4', import.meta.url)));
    expect(env.SCORE_CACHE.objects.get(await objectName('clip', INPUTS.target, KEY))?.bytes).toEqual(standin);
    expect(media.calls).toHaveLength(0);
  });

  test('without LOCAL_MEDIA_STANDIN, any other value still calls the binding', async () => {
    const media = fakeMedia();
    await runRender(makeEnv({ MEDIA: media, LOCAL_MEDIA_STANDIN: 'false' }), INPUTS, marked, await deps());
    expect(media.calls).toHaveLength(1);
  });
});

function idleJob(): JobStub {
  return { status: async () => ({ state: 'none' }), wait: async () => ({ state: 'none' }) };
}

describe('drawCard', () => {
  test('draws the card for its inputs and stores it under the card key', async () => {
    const env = makeEnv();
    const drawn = await drawCard(env, INPUTS, idleJob(), await deps());
    if (drawn.outcome !== 'card') throw new Error('expected a card');
    expect(drawn).toMatchObject({ card: 'drawn', logo: 'tile', settled: true });
    expect(drawn.png.slice(1, 4)).toEqual(new TextEncoder().encode('PNG'));
    const stored = env.SCORE_CACHE.objects.get(await objectName('score', INPUTS.target, KEY));
    expect(stored?.bytes).toEqual(drawn.png);
    expect(stored?.meta.logo).toBe('tile');
  });

  test('a card whose logo lookup was cut short is returned unsettled and not stored', async () => {
    const env = makeEnv();
    const withHomepage = { ...INPUTS, pages: ['https://railway.com/'] };
    const drawn = await drawCard(env, withHomepage, idleJob(), { ...(await deps()), fetchImpl: unreachable });
    expect(drawn).toMatchObject({ outcome: 'card', card: 'drawn', logo: 'tile', settled: false });
    expect([...env.SCORE_CACHE.objects.keys()].some((name) => name.startsWith('og/score/'))).toBe(false);
    expect(renderRecords().at(-1)).toMatchObject({ outcome: 'card-unsettled', key: KEY });
  });

  test('a pending card is drawn and never stored', async () => {
    const env = makeEnv();
    const pending = { ...INPUTS, key: 'pending', card: { ...INPUTS.card, scorePct: null, pending: true } };
    expect(await drawCard(env, pending, idleJob(), await deps())).toMatchObject({ outcome: 'card', settled: true });
    expect(env.SCORE_CACHE.objects.size).toBe(0);
  });

  test('inputs drawn for another template version return skew and log it under their own outcome', async () => {
    const env = makeEnv();
    const skewed = { ...INPUTS, key: `s64-v0.6.0-d20261026-r${SCORE_OG_TEMPLATE + 1}` };
    expect(await drawCard(env, skewed, idleJob(), await deps())).toEqual({ outcome: 'skew' });
    expect(env.SCORE_CACHE.objects.size).toBe(0);
    expect(renderRecords()).toEqual([expect.objectContaining({ outcome: 'card-skew', key: skewed.key })]);
  });

  test("returns the running job's PNG when it lands inside the wait", async () => {
    const env = makeEnv();
    const pngName = await objectName('score', INPUTS.target, KEY);
    const jobPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    let waitedUntil: number | null = null;
    const job: JobStub = {
      status: async () => ({ state: 'rendering', run: 'run-1', attempt: 1 }),
      async wait(deadline): Promise<RenderJobStatus> {
        waitedUntil = deadline;
        env.SCORE_CACHE.objects.set(pngName, { bytes: jobPng, meta: { logo: 'brand' }, uploaded: new Date() });
        return { state: 'png', run: 'run-1', attempt: 1 };
      },
    };
    const started = Date.now();
    const drawn = await drawCard(env, INPUTS, job, await deps());
    expect(drawn).toEqual({ outcome: 'card', png: jobPng, card: 'stored', logo: 'brand', settled: true });
    expect(waitedUntil).toBeGreaterThanOrEqual(started + 2_000);
    expect(waitedUntil).toBeLessThanOrEqual(Date.now() + 2_000);
    expect(renderRecords().at(-1)).toMatchObject({ outcome: 'card-job', run: 'run-1', attempt: 1, key: KEY });
  });

  test("draws its own card when the job's PNG does not land inside the wait", async () => {
    const env = makeEnv();
    const job: JobStub = {
      status: async () => ({ state: 'queued', run: 'run-2', attempt: 0 }),
      wait: async () => ({ state: 'rendering', run: 'run-2', attempt: 1 }),
    };
    const drawn = await drawCard(env, INPUTS, job, await deps());
    expect(drawn).toMatchObject({ outcome: 'card', card: 'drawn', settled: true });
  });

  test('every record names the card key and never the host', async () => {
    const env = makeEnv();
    await drawCard(env, INPUTS, idleJob(), await deps());
    const records = renderRecords();
    expect(records).toEqual([expect.objectContaining({ outcome: 'card-drawn', key: KEY, lane: 'web', logo: 'tile' })]);
    expect(JSON.stringify(records)).not.toContain('railway.com');
  });
});
