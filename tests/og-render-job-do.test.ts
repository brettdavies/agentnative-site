// RenderJob: one card's render, claimed once, run and retried on the object's
// alarm, and tracked until its cleanup alarm deletes it. The alarm is fired
// by hand; the render runs for real against fake R2, Media and queue.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import OgRender from '../src/og-render/index';
import type { RenderDeps, RenderEnv } from '../src/og-render/render-job';
import { DONE_GRACE_MS, FAILED_GRACE_MS, MAX_ALARM_RETRIES, RenderJob } from '../src/og-render/render-job-do';
import type { RenderInputs, RenderJobStatus } from '../src/shared/og-render';
import { SCORE_OG_TEMPLATE } from '../src/shared/score-og';
import { SCORE_OG_MOTION } from '../src/shared/score-og-motion';
import { sha256Hex } from '../src/worker/audit-web/cache';
import { captureLogs, type LogCapture } from './helpers/log-capture';
import {
  cardFonts,
  type FakeBucket,
  type FakeDoState,
  type FakeMedia,
  type FakeQueue,
  fakeBucket,
  fakeDoState,
  fakeMedia,
  fakeQueue,
} from './helpers/og-render-fakes';

const KEY = `s64-v0.6.0-d20261026-r${SCORE_OG_TEMPLATE}`;

function inputsFor(target: string, key = KEY): RenderInputs {
  return {
    target,
    key,
    card: {
      name: target,
      subtitle: null,
      lane: 'web',
      scorePct: 64,
      pending: false,
      specVersion: '0.6.0',
      edition: { token: 'd20261026', label: '2026-10-26' },
    },
    pages: [],
    scoredAt: '2026-10-26T10:00:00.000Z',
  };
}

const INPUTS = inputsFor('railway.com');

type Harness = {
  env: RenderEnv & { SCORE_CACHE: FakeBucket; MEDIA: FakeMedia; OG_RENDERED: FakeQueue };
  jobs: Map<string, { job: TestJob; state: FakeDoState }>;
  job(target?: string, key?: string): { job: TestJob; state: FakeDoState };
};

let renderDeps: RenderDeps = {};

class TestJob extends RenderJob {
  protected override renderDeps(): RenderDeps {
    return renderDeps;
  }
}

function harness(media: FakeMedia = fakeMedia()): Harness {
  const jobs = new Map<string, { job: TestJob; state: FakeDoState }>();
  const env = {
    SCORE_CACHE: fakeBucket(),
    MEDIA: media,
    OG_RENDERED: fakeQueue(),
  } as unknown as Harness['env'];
  const entry = (name: string) => {
    let found = jobs.get(name);
    if (!found) {
      const state = fakeDoState();
      found = { job: new TestJob(state as unknown as DurableObjectState, env), state };
      jobs.set(name, found);
    }
    return found;
  };
  env.RENDER_JOB = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => entry(id.name).job,
  } as unknown as RenderEnv['RENDER_JOB'];
  return { env, jobs, job: (target = INPUTS.target, key = KEY) => entry(`${target}:${key}`) };
}

function fire(job: RenderJob, retryCount = 0): Promise<void> {
  return job.alarm({ retryCount, isRetry: retryCount > 0, scheduledTime: Date.now() });
}

function live(status: RenderJobStatus): Exclude<RenderJobStatus, { state: 'none' }> {
  if (status.state === 'none') throw new Error('expected a job');
  return status;
}

let logs: LogCapture;
beforeEach(async () => {
  logs = captureLogs();
  renderDeps = {
    fonts: await cardFonts(),
    motion: { ...SCORE_OG_MOTION, holdStart: 1, drain: 1, climb: 2, holdEnd: 1 },
    yieldFrame: async () => {},
  };
});
afterEach(() => logs.restore());

const renderRecords = () => logs.records.map((entry) => entry.record).filter((record) => record.scope === 'og.render');

describe('RenderJob: claim', () => {
  test('two requests for one card set one alarm; the second returns the live job and its run id', async () => {
    const { job, state } = harness().job();
    const first = live(await job.request(INPUTS));
    expect(first.state).toBe('queued');
    const alarm = state.alarm;
    expect(alarm).not.toBeNull();
    const second = await job.request(INPUTS);
    expect(second).toEqual(first);
    expect(state.alarm).toBe(alarm);
  });

  test('requests for two different cards each claim and set an alarm', async () => {
    const h = harness();
    await h.job('railway.com').job.request(INPUTS);
    await h.job('anc.dev').job.request(inputsFor('anc.dev'));
    expect(h.job('railway.com').state.alarm).not.toBeNull();
    expect(h.job('anc.dev').state.alarm).not.toBeNull();
  });

  test('a claim past the deadline takes over with a new run id', async () => {
    const { job, state } = harness().job();
    const first = live(await job.request(INPUTS));
    const record = state.values.get('job') as { deadline: number };
    state.values.set('job', { ...record, state: 'rendering', deadline: Date.now() - 1 });
    expect(live(await job.status()).state).toBe('failed');
    const second = live(await job.request(INPUTS));
    expect(second.state).toBe('queued');
    expect(second.run).not.toBe(first.run);
  });

  test('a failed job is claimed again; a done job is not', async () => {
    const h = harness(fakeMedia({ code: 9400, message: 'bad input' }));
    const { job } = h.job();
    const first = live(await job.request(INPUTS));
    await fire(job, MAX_ALARM_RETRIES);
    expect(live(await job.status()).state).toBe('failed');
    const again = live(await job.request(INPUTS));
    expect(again.state).toBe('queued');
    expect(again.run).not.toBe(first.run);

    const ok = harness().job();
    await ok.job.request(INPUTS);
    await fire(ok.job);
    expect(live(await ok.job.request(INPUTS)).state).toBe('done');
  });
});

describe('RenderJob: alarm', () => {
  test('renders, stores the PNG and the clip, sends one og-rendered, and deletes itself 60 s after done', async () => {
    const h = harness();
    const { job, state } = h.job();
    const { run } = live(await job.request(INPUTS));
    const before = Date.now();
    await fire(job);
    expect(await job.status()).toEqual({ state: 'done', run, attempt: 1 });
    const prefix = await sha256Hex(INPUTS.target);
    expect(h.env.SCORE_CACHE.objects.has(`og/score/${prefix}/${KEY}.png`)).toBe(true);
    expect(h.env.SCORE_CACHE.objects.has(`og/clip/${prefix}/${KEY}.mp4`)).toBe(true);
    expect(h.env.OG_RENDERED.sent).toEqual([{ target: 'railway.com', lane: 'web', key: KEY }]);
    expect(state.alarm).toBeGreaterThanOrEqual(before + DONE_GRACE_MS);
    await fire(job);
    expect(state.values.size).toBe(0);
    expect(await job.status()).toEqual({ state: 'none' });
  });

  test('the job reads png while its frames draw', async () => {
    const { job } = harness().job();
    await job.request(INPUTS);
    const seen: string[] = [];
    renderDeps = {
      ...renderDeps,
      yieldFrame: async () => {
        seen.push(live(await job.status()).state);
      },
    };
    await fire(job);
    expect(new Set(seen)).toEqual(new Set(['png']));
  });

  test('a binding error rethrows so the alarm retries; the job reads queued and sends nothing', async () => {
    const h = harness(fakeMedia({ code: 9402, message: 'input too large' }));
    const { job } = h.job();
    const { run } = live(await job.request(INPUTS));
    await expect(fire(job, 2)).rejects.toThrow('input too large');
    expect(await job.status()).toEqual({ state: 'queued', run, attempt: 3 });
    expect(h.env.OG_RENDERED.sent).toEqual([]);
    expect(renderRecords().at(-1)).toMatchObject({ outcome: 'retry', run, attempt: 3, binding_error: 9402 });
  });

  test('the same error on the last retry marks the job failed without throwing, and keeps it 24 hours', async () => {
    const h = harness(fakeMedia({ code: 9402, message: 'input too large' }));
    const { job, state } = h.job();
    const { run } = live(await job.request(INPUTS));
    const before = Date.now();
    await fire(job, MAX_ALARM_RETRIES);
    expect(await job.status()).toEqual({ state: 'failed', run, attempt: MAX_ALARM_RETRIES + 1 });
    expect(state.alarm).toBeGreaterThanOrEqual(before + FAILED_GRACE_MS);
    expect(renderRecords().at(-1)).toMatchObject({ outcome: 'failed', run, binding_error: 9402 });
    await fire(job);
    expect(state.values.size).toBe(0);
  });

  test('a template mismatch releases the claim without rendering and logs the skew', async () => {
    const h = harness();
    const skewKey = `s64-v0.6.0-d20261026-r${SCORE_OG_TEMPLATE + 1}`;
    const { job, state } = h.job(INPUTS.target, skewKey);
    await job.request(inputsFor(INPUTS.target, skewKey));
    await fire(job);
    expect(state.values.size).toBe(0);
    expect(h.env.MEDIA.calls).toHaveLength(0);
    expect(renderRecords().at(-1)).toMatchObject({ outcome: 'skew', key: skewKey });
  });

  test('a fresh clip marks the job done without a binding call or a message', async () => {
    const h = harness();
    const name = `og/clip/${await sha256Hex(INPUTS.target)}/${KEY}.mp4`;
    h.env.SCORE_CACHE.objects.set(name, { bytes: new Uint8Array([1]), meta: {}, uploaded: new Date() });
    const { job } = h.job();
    await job.request(INPUTS);
    await fire(job);
    expect(live(await job.status()).state).toBe('done');
    expect(h.env.MEDIA.calls).toHaveLength(0);
    expect(h.env.OG_RENDERED.sent).toEqual([]);
    expect(renderRecords().at(-1)).toMatchObject({ outcome: 'fresh' });
  });

  test('a run taken over mid-render cannot write into the run that took it over', async () => {
    const h = harness();
    const { job, state } = h.job();
    await job.request(INPUTS);
    let takeover: RenderJobStatus | null = null;
    renderDeps = {
      ...renderDeps,
      yieldFrame: async () => {
        if (takeover) return;
        const record = state.values.get('job') as { deadline: number };
        state.values.set('job', { ...record, deadline: Date.now() - 1 });
        takeover = await job.request(INPUTS);
      },
    };
    await fire(job);
    const now = live(await job.status());
    expect(now).toEqual(live(takeover ?? { state: 'none' }));
    expect(now.state).toBe('queued');
    expect(h.env.OG_RENDERED.sent).toEqual([]);
  });

  test('every alarm outcome logs one og.render record with the run, the attempt and the key, never the host', async () => {
    const h = harness();
    const { job } = h.job();
    const { run } = live(await job.request(INPUTS));
    await fire(job);
    const records = renderRecords();
    expect(records).toEqual([
      expect.objectContaining({ outcome: 'rendered', run, attempt: 1, key: KEY, lane: 'web', logo: 'tile' }),
    ]);
    expect(JSON.stringify(records)).not.toContain('railway.com');
  });
});

describe('RenderJob: wait', () => {
  test("wait for png resolves once the job's PNG is stored", async () => {
    const { job } = harness().job();
    await job.request(INPUTS);
    const waiting = job.wait(Date.now() + 5_000, 'png');
    await fire(job);
    expect(live(await waiting).state).toMatch(/^(png|done)$/);
  });

  test('wait for a terminal state resolves on done and on failed', async () => {
    const ok = harness().job();
    await ok.job.request(INPUTS);
    const done = ok.job.wait(Date.now() + 5_000, 'terminal');
    await fire(ok.job);
    expect(live(await done).state).toBe('done');

    const bad = harness(fakeMedia({ code: 9400, message: 'bad input' })).job();
    await bad.job.request(INPUTS);
    const failed = bad.job.wait(Date.now() + 5_000, 'terminal');
    await fire(bad.job, MAX_ALARM_RETRIES);
    expect(live(await failed).state).toBe('failed');
  });

  test('both waits resolve with the current state at their deadline', async () => {
    const { job } = harness().job();
    await job.request(INPUTS);
    for (const until of ['png', 'terminal'] as const) {
      const started = Date.now();
      expect(live(await job.wait(started + 50, until)).state).toBe('queued');
      expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    }
  });

  test('a job with no claim answers at once', async () => {
    const { job } = harness().job();
    expect(await job.wait(Date.now() + 5_000, 'png')).toEqual({ state: 'none' });
  });
});

describe('render Worker entrypoint', () => {
  function entrypoint(h: Harness): OgRender {
    return new OgRender({} as ExecutionContext, h.env);
  }

  test('request and status reach the card named by target and key', async () => {
    const h = harness();
    const rpc = entrypoint(h);
    const claimed = live(await rpc.request(INPUTS));
    expect(await rpc.status(INPUTS.target, KEY)).toEqual(claimed);
    expect(h.jobs.has(`railway.com:${KEY}`)).toBe(true);
  });

  test('requestMany claims 151 jobs and sets their alarms 400 ms apart', async () => {
    const h = harness();
    const inputs = Array.from({ length: 151 }, (_, i) => inputsFor(`site-${i}.example`));
    const before = Date.now();
    const states = await entrypoint(h).requestMany(inputs);
    expect(states.map((status) => status.state)).toEqual(Array(151).fill('queued'));
    const alarms = inputs.map((input) => h.job(input.target).state.alarm ?? Number.NaN);
    for (const [i, alarm] of alarms.entries()) {
      expect(alarm - before).toBeGreaterThanOrEqual(i * 400);
      expect(alarm - before).toBeLessThan(i * 400 + 1_000);
    }
    expect(alarms[150] - alarms[0]).toBeGreaterThanOrEqual(150 * 400 - 50);
  });
});
