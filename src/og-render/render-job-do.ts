// RenderJob: one card's render, claimed once however many triggers ask for
// it, under `idFromName('<target>:<key>')`. Different cards claim different
// objects, so they render in parallel.
//
//   request(inputs) -- none, failed, or past deadline --> queued (new run id,
//        |                                                alarm at now + delay)
//        | a live job or a done one: its status, nothing claimed
//        v
//   alarm(attempt) --> rendering --> png (card stored) --> done --> og-rendered
//        |   template differs: claim released (deleted), skew logged
//        |   clip already fresh: done, no binding call
//        |   error: queued, rethrow; Cloudflare retries with backoff
//        |   error on the last retry: failed
//        v
//   done -- alarm at + 60 s --> deleted
//   failed -- alarm at + 24 h --> deleted
//
// Every state write checks the run id, so a run that was taken over cannot
// write into the run that took it. A render killed on every attempt (CPU or
// memory) leaves the job rendering with no alarm; past its deadline, status()
// reports it failed and the next request takes it over. wait() holds a caller
// until the job reaches a state; waiters live in memory, so an eviction
// drops them and their callers fall back on their own deadline.

import { DurableObject } from 'cloudflare:workers';
import type { RenderInputs, RenderJobState, RenderJobStatus, RenderJobWaitUntil } from '../shared/og-render';
import { logRender, type RenderDeps, type RenderEnv, RunTakenOver, runRender } from './render-job';

/** A queued or rendering job older than this is treated as dead. */
export const JOB_DEADLINE_MS = 10 * 60 * 1000;
export const DONE_GRACE_MS = 60 * 1000;
/** A failure stays readable this long, so a status check can still name its run. */
export const FAILED_GRACE_MS = 24 * 60 * 60 * 1000;
/** Cloudflare retries a throwing alarm up to six times (https://developers.cloudflare.com/durable-objects/api/base/#alarm). */
export const MAX_ALARM_RETRIES = 6;

const JOB_KEY = 'job';

type JobRecord = {
  run: string;
  state: RenderJobState;
  attempt: number;
  deadline: number;
  inputs: RenderInputs;
};

type Waiter = { until: RenderJobWaitUntil; settle: (status: RenderJobStatus) => void };

const LIVE: ReadonlySet<RenderJobState> = new Set(['queued', 'rendering', 'png']);

export class RenderJob extends DurableObject<RenderEnv> {
  private readonly waiters = new Set<Waiter>();

  /** Claim the card's render unless a live or finished job already holds it. */
  async request(inputs: RenderInputs, startInMs = 0): Promise<RenderJobStatus> {
    const now = Date.now();
    const current = await this.read();
    if (current && (current.state === 'done' || (LIVE.has(current.state) && now < current.deadline))) {
      return statusOf(current);
    }
    const job: JobRecord = {
      run: crypto.randomUUID(),
      state: 'queued',
      attempt: 0,
      deadline: now + JOB_DEADLINE_MS,
      inputs,
    };
    await this.ctx.storage.put(JOB_KEY, job);
    await this.ctx.storage.setAlarm(now + startInMs);
    return statusOf(job);
  }

  /** The job's state; a live job past its deadline reads as failed. */
  async status(): Promise<RenderJobStatus> {
    const job = await this.read();
    if (!job) return { state: 'none' };
    if (LIVE.has(job.state) && Date.now() >= job.deadline)
      return { state: 'failed', run: job.run, attempt: job.attempt };
    return statusOf(job);
  }

  /** Resolve once the job reaches `until` (`png`, or a terminal state) or `deadline` passes. */
  async wait(deadline: number, until: RenderJobWaitUntil): Promise<RenderJobStatus> {
    const current = await this.status();
    if (reached(current, until) || Date.now() >= deadline) return current;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        this.status().then(resolve, () => resolve(current));
      }, deadline - Date.now());
      const waiter: Waiter = {
        until,
        settle: (status) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(status);
        },
      };
      this.waiters.add(waiter);
    });
  }

  override async alarm(info?: AlarmInvocationInfo): Promise<void> {
    const job = await this.read();
    if (!job) return;
    if (job.state === 'done' || job.state === 'failed') {
      await this.release();
      return;
    }
    const started = Date.now();
    const retry = info?.retryCount ?? 0;
    const attempt = retry + 1;
    const { run, inputs } = job;
    const log = { run, attempt, key: inputs.key, lane: inputs.card.lane, started };
    if (!(await this.mark(run, 'rendering', attempt))) return;
    try {
      const result = await runRender(this.env, inputs, () => this.mark(run, 'png', attempt), this.renderDeps());
      if (result.outcome === 'skew') {
        await this.release();
        logRender({ ...log, outcome: 'skew' });
        return;
      }
      if (!(await this.mark(run, 'done', attempt))) throw new RunTakenOver();
      await this.ctx.storage.setAlarm(Date.now() + DONE_GRACE_MS);
      if (result.outcome === 'fresh') {
        logRender({ ...log, outcome: 'fresh' });
        return;
      }
      await this.env.OG_RENDERED.send({ target: inputs.target, lane: inputs.card.lane, key: inputs.key });
      logRender({ ...log, outcome: 'rendered', logo: result.logo });
    } catch (err) {
      if (err instanceof RunTakenOver) {
        logRender({ ...log, outcome: 'superseded' });
        return;
      }
      if (retry >= MAX_ALARM_RETRIES) {
        if (await this.mark(run, 'failed', attempt)) {
          await this.ctx.storage.setAlarm(Date.now() + FAILED_GRACE_MS);
        }
        logRender({ ...log, outcome: 'failed', err });
        return;
      }
      await this.mark(run, 'queued', attempt);
      logRender({ ...log, outcome: 'retry', err });
      throw err;
    }
  }

  /** Drawing dependencies for the render; production draws with the defaults. */
  protected renderDeps(): RenderDeps {
    return {};
  }

  private async read(): Promise<JobRecord | null> {
    return (await this.ctx.storage.get<JobRecord>(JOB_KEY)) ?? null;
  }

  /** Write the run's state; false when `run` is no longer the job's run. */
  private async mark(run: string, state: RenderJobState, attempt: number): Promise<boolean> {
    const job = await this.read();
    if (job?.run !== run) return false;
    const next: JobRecord = { ...job, state, attempt };
    await this.ctx.storage.put(JOB_KEY, next);
    this.notify(statusOf(next));
    return true;
  }

  private async release(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.notify({ state: 'none' });
  }

  private notify(status: RenderJobStatus): void {
    for (const waiter of [...this.waiters]) {
      if (reached(status, waiter.until)) waiter.settle(status);
    }
  }
}

function statusOf(job: JobRecord): RenderJobStatus {
  return { state: job.state, run: job.run, attempt: job.attempt };
}

/** Whether a waiter for `until` can stop: the state it asked for, or one past which it never comes. */
function reached(status: RenderJobStatus, until: RenderJobWaitUntil): boolean {
  if (status.state === 'none' || status.state === 'done' || status.state === 'failed') return true;
  return until === 'png' && status.state === 'png';
}
