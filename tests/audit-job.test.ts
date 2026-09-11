import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { AuditEvent } from '../src/shared/audit-events';
import { ATTACH_PATH, AuditJob, JOB_GRACE_MS, JOB_LOG_LIMIT } from '../src/worker/audit/job';

// A Durable Object state over bun:sqlite: the job's SQL runs against a real
// SQLite engine, and the alarm is a value the test fires by hand.
function fakeState() {
  let db = new Database(':memory:');
  const state = {
    alarm: null as number | null,
    deleted: 0,
    storage: {
      sql: {
        exec(query: string, ...bindings: Array<string | number | null>) {
          const rows = db.query(query).all(...bindings) as Array<Record<string, string | number | null>>;
          return {
            toArray: () => rows,
            one: () => {
              if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
              return rows[0];
            },
            [Symbol.iterator]: () => rows[Symbol.iterator](),
          };
        },
      },
      async setAlarm(at: number) {
        state.alarm = at;
      },
      // Mirrors the platform: deleteAll clears the database, not the alarm.
      async deleteAll() {
        db.close();
        db = new Database(':memory:');
        state.deleted += 1;
      },
    },
  };
  return state;
}

function makeJob() {
  const state = fakeState();
  const job = new AuditJob(state as unknown as DurableObjectState, {} as never);
  return { job, state };
}

const at = '2026-09-11T00:00:00.000Z';
const accepted: AuditEvent = { type: 'accepted', lane: 'cli', target: 'ouch', started_at: at };
const installing: AuditEvent = { type: 'phase', phase: 'installing', at };
const auditing: AuditEvent = { type: 'phase', phase: 'auditing', at };
const complete = {
  type: 'complete',
  kind: 'cli',
  tier: 'live',
  target: 'ouch',
  scorecard_url: 'https://anc.dev/score/ouch',
  markdown_url: 'https://anc.dev/score/ouch/md',
  json_url: 'https://anc.dev/score/ouch/json',
  freshness: { cached: false, scored_at: at, refresh_after: null },
  spec_version: '0.4.0',
  scorecard: { badge: { score_pct: 71 } },
} as unknown as AuditEvent;

async function claimed(job: AuditJob): Promise<string> {
  const claim = await job.claim(at, 90_000);
  if (!claim.claimed) throw new Error('expected a fresh claim');
  return claim.run;
}

function attach(job: AuditJob, from = 0): Promise<Response> {
  return job.fetch(new Request(`https://job.internal${ATTACH_PATH}?from=${from}`));
}

async function lines(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe('AuditJob: claim', () => {
  test('the first claim starts a run and arms the alarm at the deadline plus the grace', async () => {
    const { job, state } = makeJob();
    const before = Date.now();
    const claim = await job.claim(at, 90_000);
    expect(claim.claimed).toBe(true);
    expect(state.alarm).toBeGreaterThanOrEqual(before + 90_000 + JOB_GRACE_MS);
  });

  test('a claim while a run is inside its deadline is refused with the running start time', async () => {
    const { job } = makeJob();
    await claimed(job);
    const second = await job.claim('2026-09-11T00:00:05.000Z', 90_000);
    expect(second).toEqual({ claimed: false, started_at: at });
  });

  test('a claim after the terminal line starts a fresh run with an empty log', async () => {
    const { job } = makeJob();
    const run = await claimed(job);
    await job.append(run, accepted);
    await job.append(run, complete);
    const next = await job.claim('2026-09-11T00:01:00.000Z', 90_000);
    if (!next.claimed) throw new Error('expected a fresh claim');
    await job.append(next.run, complete);
    expect((await lines(await attach(job))).map((l) => l.type)).toEqual(['complete']);
  });

  test('a claim past the running deadline takes the job over; the old run can no longer append and its readers time out', async () => {
    const { job } = makeJob();
    // A deadline already in the past: the run is overdue as soon as it starts.
    const overdue = await job.claim(at, -1);
    if (!overdue.claimed) throw new Error('expected a fresh claim');
    await job.append(overdue.run, accepted);
    const reader = await attach(job);
    const takeover = await job.claim('2026-09-11T00:05:00.000Z', 90_000);
    expect(takeover.claimed).toBe(true);
    expect(await job.append(overdue.run, installing)).toBe(false);
    const received = await lines(reader);
    expect(received.map((l) => l.type)).toEqual(['accepted', 'error']);
    expect((received[1] as { error: { code: string } }).error.code).toBe('timeout');
  });
});

describe('AuditJob: append and attach', () => {
  test('two attachers receive the same replayed lines in sequence order and the same live tail', async () => {
    const { job } = makeJob();
    const run = await claimed(job);
    await job.append(run, accepted);
    await job.append(run, installing);
    const first = await attach(job);
    const second = await attach(job);
    await job.append(run, auditing);
    await job.append(run, complete);
    const a = await lines(first);
    const b = await lines(second);
    expect(a.map((l) => (l.type === 'phase' ? l.phase : l.type))).toEqual([
      'accepted',
      'installing',
      'auditing',
      'complete',
    ]);
    expect(b).toEqual(a);
  });

  test('an attach after completion replays the log ending in complete and closes', async () => {
    const { job } = makeJob();
    const run = await claimed(job);
    for (const event of [accepted, installing, auditing, complete]) await job.append(run, event);
    const replay = await lines(await attach(job));
    expect(replay.map((l) => l.type)).toEqual(['accepted', 'phase', 'phase', 'complete']);
    expect(replay.at(-1)).toMatchObject({ type: 'complete', scorecard_url: 'https://anc.dev/score/ouch' });
  });

  test('an attach from a sequence replays from that line on', async () => {
    const { job } = makeJob();
    const run = await claimed(job);
    for (const event of [accepted, installing, auditing, complete]) await job.append(run, event);
    const tail = await lines(await attach(job, 3));
    expect(tail.map((l) => l.type)).toEqual(['phase', 'complete']);
  });

  test('a heartbeat is neither kept nor fanned out: each reader has its own', async () => {
    const { job } = makeJob();
    const run = await claimed(job);
    await job.append(run, accepted);
    await job.append(run, { type: 'heartbeat', at });
    await job.append(run, complete);
    expect((await lines(await attach(job))).map((l) => l.type)).toEqual(['accepted', 'complete']);
  });

  test('lines past the log limit reach live readers but not a replay; the terminal line is always kept', async () => {
    const { job } = makeJob();
    const run = await claimed(job);
    const live = await attach(job);
    for (let i = 0; i < JOB_LOG_LIMIT + 5; i += 1) await job.append(run, installing);
    await job.append(run, complete);
    expect((await lines(live)).length).toBe(JOB_LOG_LIMIT + 6);
    const replay = await lines(await attach(job));
    expect(replay.length).toBe(JOB_LOG_LIMIT + 1);
    expect(replay.at(-1)?.type).toBe('complete');
  });

  test('an append after the terminal line is refused', async () => {
    const { job } = makeJob();
    const run = await claimed(job);
    await job.append(run, complete);
    expect(await job.append(run, installing)).toBe(false);
  });

  test('an attach to a job that was never claimed is 404', async () => {
    const { job } = makeJob();
    expect((await attach(job)).status).toBe(404);
  });

  test('a request other than GET on the attach path is 404', async () => {
    const { job } = makeJob();
    await claimed(job);
    const res = await job.fetch(new Request(`https://job.internal${ATTACH_PATH}`, { method: 'POST', body: '{}' }));
    expect(res.status).toBe(404);
  });
});

describe('AuditJob: cleanup alarm', () => {
  test('after the terminal line the alarm moves to the grace, then deletes the job; a later attach is 404', async () => {
    const { job, state } = makeJob();
    const run = await claimed(job);
    await job.append(run, accepted);
    const before = Date.now();
    await job.append(run, complete);
    expect(state.alarm).toBeGreaterThanOrEqual(before + JOB_GRACE_MS);
    expect(state.alarm).toBeLessThan(before + 90_000);
    await job.alarm();
    expect(state.deleted).toBe(1);
    expect((await attach(job)).status).toBe(404);
  });

  test('an alarm on a run that never finished ends every live reader with a timeout error, then deletes the job', async () => {
    const { job } = makeJob();
    const run = await claimed(job);
    await job.append(run, accepted);
    const live = await attach(job);
    await job.alarm();
    const received = await lines(live);
    expect(received.map((l) => l.type)).toEqual(['accepted', 'error']);
    expect((received[1] as { error: { code: string } }).error.code).toBe('timeout');
    expect((await attach(job)).status).toBe(404);
  });

  test('the job is claimable again after cleanup', async () => {
    const { job } = makeJob();
    const run = await claimed(job);
    await job.append(run, complete);
    await job.alarm();
    expect((await job.claim(at, 90_000)).claimed).toBe(true);
  });
});
