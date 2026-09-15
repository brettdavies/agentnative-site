import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuditEvent } from '../src/shared/audit-events';
import { ndjsonValues } from '../src/shared/ndjson';
import type { AuditJob } from '../src/worker/audit/job';
import { _resetIndexCache } from '../src/worker/score/core';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';
import { ANC_VERSION } from '../src/worker/spec-version.gen';
import { call, makeEnv, ndjson, newTracker, post, probeFetchFor } from './helpers/audit-api-env';
import { fakeJobNamespace } from './helpers/audit-job-state';

// A second reader of an input already in flight attaches to the running
// audit's job instead of starting a second run: it receives the job's log,
// then its live tail, and the one run serves every reader.

beforeEach(() => {
  _resetIndexCache();
  _resetKillSwitchCache();
});

const CLI = 'cargo binstall ouch';
const STREAM = { accept: 'application/x-ndjson' };
const AT = '2026-09-11T00:00:00.000Z';

type Line = Record<string, unknown>;

// A Durable Object body that writes one phase, then holds the result line
// until the test releases it, so a second request lands mid-run.
function gatedSandbox() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const doFetch = async () => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const line = (payload: unknown) => writer.write(encoder.encode(`${JSON.stringify(payload)}\n`));
    void (async () => {
      await line({ type: 'phase', phase: 'installing', at: AT });
      await gate;
      await line({
        scorecard: { tool: { name: 'ouch', binary: 'ouch', version: '0.5.0' }, badge: { score_pct: 71 } },
        anc_version: ANC_VERSION,
      });
      // The relay's line reader cancels its side once it has the result
      // line, as it does against the real object, whose close tolerates it.
      await writer.close().catch(() => {});
    })();
    return new Response(readable, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  };
  return { doFetch, release };
}

// Read a streamed response incrementally: `until` consumes lines up to the
// first match, `rest` drains what remains.
function lineReader(res: Response) {
  const body = res.body;
  if (!body) throw new Error('response has no body');
  const values = ndjsonValues(body);
  const seen: Line[] = [];
  return {
    async until(match: (line: Line) => boolean): Promise<void> {
      for (;;) {
        const next = await values.next();
        if (next.done) throw new Error('stream ended before the expected line');
        seen.push(next.value as Line);
        if (match(next.value as Line)) return;
      }
    },
    async rest(): Promise<Line[]> {
      for await (const value of values) seen.push(value as Line);
      return seen;
    },
  };
}

const shape = (lines: Line[]) =>
  lines.filter((l) => l.type !== 'heartbeat').map((l) => (l.type === 'phase' ? `phase:${l.phase}` : String(l.type)));

const isInstalling = (l: Line) => l.type === 'phase' && l.phase === 'installing';

async function settle(...ctxs: Array<{ _promises: Promise<unknown>[] }>): Promise<void> {
  await Promise.all(ctxs.flatMap((ctx) => ctx._promises));
}

describe('POST /api/score: attach to a run in flight', () => {
  test('a second tokened POST for an in-flight input attaches, and one sandbox run serves both callers', async () => {
    const tracker = newTracker();
    const sandbox = gatedSandbox();
    const env = makeEnv({ tracker, doFetch: sandbox.doFetch });
    const first = await call(post({ target: CLI, turnstile_token: 'x' }, STREAM), env);
    const initiator = lineReader(first.res);
    await initiator.until(isInstalling);
    const second = await call(post({ target: CLI, turnstile_token: 'x' }, STREAM), env);
    const attached = lineReader(second.res);
    await attached.until(isInstalling);
    sandbox.release();
    const a = await initiator.rest();
    const b = await attached.rest();
    await settle(first.ctx, second.ctx);
    expect(tracker.doCalls).toBe(1);
    expect(shape(a)).toEqual(['accepted', 'phase:resolving', 'phase:installing', 'complete']);
    expect(shape(b)).toEqual(shape(a));
    expect(b.at(-1)?.scorecard_url).toBe(a.at(-1)?.scorecard_url);
  });

  test('a tokenless stream POST during a run receives the replay and the live tail, passing only the per-IP burst limiter', async () => {
    const tracker = newTracker();
    const sandbox = gatedSandbox();
    const env = makeEnv({ tracker, doFetch: sandbox.doFetch });
    const first = await call(post({ target: CLI, turnstile_token: 'x' }, STREAM), env);
    const initiator = lineReader(first.res);
    await initiator.until(isInstalling);
    const verifiesBefore = tracker.siteverifyCalls;
    const limitsBefore = tracker.limiterCalls.length;
    const second = await call(post({ target: CLI }, STREAM), env);
    expect(second.res.status).toBe(200);
    expect(second.res.headers.get('content-type')).toContain('application/x-ndjson');
    const attached = lineReader(second.res);
    await attached.until(isInstalling);
    sandbox.release();
    await initiator.rest();
    const b = await attached.rest();
    await settle(first.ctx, second.ctx);
    expect(shape(b)).toEqual(['accepted', 'phase:resolving', 'phase:installing', 'complete']);
    expect(tracker.siteverifyCalls).toBe(verifiesBefore);
    expect(tracker.limiterCalls.slice(limitsBefore)).toEqual(['cli-ip']);
    expect(tracker.doCalls).toBe(1);
  });

  test('a tokenless JSON POST during a run still answers 202 in_progress', async () => {
    const sandbox = gatedSandbox();
    const env = makeEnv({ doFetch: sandbox.doFetch });
    const first = await call(post({ target: CLI, turnstile_token: 'x' }, STREAM), env);
    const initiator = lineReader(first.res);
    await initiator.until(isInstalling);
    const second = await call(post({ target: CLI }), env);
    expect(second.res.status).toBe(202);
    expect((await second.res.json()) as Line).toMatchObject({ in_progress: true, started_at: expect.any(String) });
    sandbox.release();
    await initiator.rest();
    await settle(first.ctx);
  });

  test('a tokened JSON POST during a run waits on the job and answers the terminal envelope', async () => {
    const tracker = newTracker();
    const sandbox = gatedSandbox();
    const env = makeEnv({ tracker, doFetch: sandbox.doFetch });
    const first = await call(post({ target: CLI, turnstile_token: 'x' }, STREAM), env);
    const initiator = lineReader(first.res);
    await initiator.until(isInstalling);
    const pending = call(post({ target: CLI, turnstile_token: 'x' }), env);
    sandbox.release();
    const second = await pending;
    await initiator.rest();
    await settle(first.ctx, second.ctx);
    expect(second.res.status).toBe(200);
    expect((await second.res.json()) as Line).toMatchObject({
      kind: 'cli',
      tier: 'live',
      scorecard_url: 'https://anc.dev/score/ouch',
    });
    expect(tracker.doCalls).toBe(1);
  });

  test('the operator hatch runs beside the live run and leaves its flag naming the job', async () => {
    const tracker = newTracker();
    const jobs = fakeJobNamespace();
    const job = jobs.get(jobs.idFromName(`cli:${CLI}`));
    const claim = await job.claim(AT, 90_000);
    if (!claim.claimed) throw new Error('expected a fresh claim');
    const flag = JSON.stringify({ started_at: AT, job: `cli:${CLI}` });
    const env = makeEnv({ tracker, jobs, kvSeed: { [`inflight:cli:${CLI}`]: flag } });
    const { res, ctx } = await call(post({ target: CLI, turnstile_token: 'x' }, { query: '?fromCache=false' }), env);
    expect(res.status).toBe(200);
    await res.json();
    await settle(ctx);
    // The run holding the job owns that key. A hatch run that overwrote it
    // would point every later reader at no job, and clearing it would retire
    // a flag whose run is still going.
    expect(JSON.parse(env._kv.get(`inflight:cli:${CLI}`) ?? 'null')).toMatchObject({ job: `cli:${CLI}` });
    expect(tracker.doCalls).toBe(1);
  });

  test('a claim lost to a run the KV read missed attaches instead of dispatching a second run', async () => {
    const tracker = newTracker();
    const jobs = fakeJobNamespace();
    const job = jobs.get(jobs.idFromName(`cli:${CLI}`));
    const claim = await job.claim(AT, 90_000);
    if (!claim.claimed) throw new Error('expected a fresh claim');
    await job.append(claim.run, { type: 'accepted', lane: 'cli', target: CLI, started_at: AT });
    const env = makeEnv({ tracker, jobs });
    const res = (await call(post({ target: CLI, turnstile_token: 'x' }, STREAM), env)).res;
    const attached = lineReader(res);
    await attached.until((l) => l.type === 'accepted');
    const complete = {
      type: 'complete',
      kind: 'cli',
      tier: 'live',
      target: 'ouch',
      scorecard_url: 'https://anc.dev/score/ouch',
      markdown_url: 'https://anc.dev/score/ouch/md',
      json_url: 'https://anc.dev/score/ouch/json',
      freshness: { cached: false, scored_at: AT, refresh_after: null },
      spec_version: '0.4.0',
      scorecard: {},
    } as unknown as AuditEvent;
    await job.append(claim.run, complete);
    expect(shape(await attached.rest())).toEqual(['accepted', 'complete']);
    expect(tracker.doCalls).toBe(0);
  });

  test("the job's log ends on the initiator's terminal line, and the flags name the job while the run is in flight", async () => {
    const jobs = fakeJobNamespace();
    const sandbox = gatedSandbox();
    const env = makeEnv({ jobs, doFetch: sandbox.doFetch });
    const first = await call(post({ target: CLI, turnstile_token: 'x' }, STREAM), env);
    const initiator = lineReader(first.res);
    await initiator.until(isInstalling);
    expect(JSON.parse(env._kv.get(`inflight:cli:${CLI}`) ?? '{}')).toMatchObject({ job: `cli:${CLI}` });
    expect(JSON.parse(env._kv.get('inflight:cli:ouch') ?? '{}')).toMatchObject({ job: `cli:${CLI}` });
    sandbox.release();
    await initiator.rest();
    await settle(first.ctx);
    const stored = jobs.jobs.get(`cli:${CLI}`);
    if (!stored) throw new Error('the run claimed no job');
    const replay = await ndjson(await stored.job.fetch(new Request('https://job.internal/attach')));
    expect(shape(replay)).toEqual(['accepted', 'phase:resolving', 'phase:installing', 'complete']);
  });

  test('a website run fans out the same way', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tracker = newTracker();
    const probe = probeFetchFor(tracker, 'ok');
    const gatedProbe = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await gate;
      return probe(input, init);
    }) as typeof fetch;
    const env = makeEnv({ tracker, deps: { probeFetch: gatedProbe } });
    const first = await call(post({ target: 'anc.dev', turnstile_token: 'x' }, STREAM), env);
    const initiator = lineReader(first.res);
    await initiator.until((l) => l.type === 'accepted');
    const second = await call(post({ target: 'anc.dev' }, STREAM), env);
    const attached = lineReader(second.res);
    await attached.until((l) => l.type === 'accepted');
    release();
    const a = await initiator.rest();
    const b = await attached.rest();
    await settle(first.ctx, second.ctx);
    expect(a.at(-1)?.type).toBe('complete');
    expect(shape(b)).toEqual(shape(a));
  });

  test('a website POST that names its listing choice runs its own audit instead of attaching', async () => {
    const tracker = newTracker();
    const jobs = fakeJobNamespace();
    const job = jobs.get(jobs.idFromName('web:anc.dev'));
    const claim = await job.claim(AT, 90_000);
    if (!claim.claimed) throw new Error('expected a fresh claim');
    const env = makeEnv({
      tracker,
      jobs,
      kvSeed: { 'inflight:web:anc.dev': JSON.stringify({ started_at: AT, job: 'web:anc.dev' }) },
    });
    const { res, ctx } = await call(post({ target: 'anc.dev', turnstile_token: 'x', public_listing: true }), env);
    await res.text();
    await settle(ctx);
    // Attaching would answer the caller with a run that never writes the
    // listing they asked for, so an explicit choice is its own request.
    expect(tracker.probeCalls.length).toBeGreaterThan(0);
  });

  test('a tokenless stream POST with no client IP, or one the per-IP burst limiter refuses, gets the 202 instead of a stream', async () => {
    const sandbox = gatedSandbox();
    const env = makeEnv({ doFetch: sandbox.doFetch });
    const first = await call(post({ target: CLI, turnstile_token: 'x' }, STREAM), env);
    const initiator = lineReader(first.res);
    await initiator.until(isInstalling);
    const noIp = await call(post({ target: CLI }, { ...STREAM, ip: null }), env);
    expect(noIp.res.status).toBe(202);
    const limited = makeEnv({
      ipLimiter: false,
      jobs: env.AUDIT_JOB,
      kvSeed: { [`inflight:cli:${CLI}`]: env._kv.get(`inflight:cli:${CLI}`) ?? '' },
    });
    expect((await call(post({ target: CLI }, STREAM), limited)).res.status).toBe(202);
    sandbox.release();
    await initiator.rest();
    await settle(first.ctx);
  });

  test('an attached stream that ends without a terminal line is closed with a typed error line', async () => {
    const truncated = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        claim: async () => ({ claimed: false, started_at: AT }),
        append: async () => true,
        fetch: async () =>
          new Response(`${JSON.stringify({ type: 'accepted', lane: 'cli', target: CLI, started_at: AT })}\n`, {
            status: 200,
          }),
      }),
    } as unknown as DurableObjectNamespace<AuditJob>;
    const env = makeEnv({
      jobs: truncated,
      kvSeed: { [`inflight:cli:${CLI}`]: JSON.stringify({ started_at: AT, job: `cli:${CLI}` }) },
    });
    const { res, ctx } = await call(post({ target: CLI }, STREAM), env);
    const lines = await ndjson(res);
    await settle(ctx);
    expect(shape(lines)).toEqual(['accepted', 'error']);
    expect((lines[1] as { error: { code: string } }).error.code).toBe('incomplete_response_contract');
  });
});
