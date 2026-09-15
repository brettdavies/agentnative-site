// In-flight state for one audit input: the KV flags that let a reader find
// a running audit, and the client side of the job that serves that audit to
// every late reader.
//
//   inflight:<lane>:<input>    written at accepted
//   inflight:<lane>:<result>   the result-keyed twin, written once the result
//                              target is known (the host, the binary, or
//                              owner/repo@branch)
//
// Both hold { started_at, job }, where `job` names the AuditJob serving the
// run; both expire with the relay deadline and are deleted at the terminal
// line. The flags save a Durable Object round trip on every tokenless POST
// and let the result route and the MCP tools find a run by its result; the
// job's claim, not the flag, is the single-flight gate.

import { type AuditEvent, isTerminalEvent, type TerminalEvent } from '../../shared/audit-events';
import type { Lane } from '../../shared/audit-routes';
import { ndjsonValues } from '../../shared/ndjson';
import { emitLog } from '../telemetry/log';
import { ATTACH_PATH, type AuditJob, JOB_GRACE_MS } from './job';

/**
 * The relay's deadline over the Durable Object read, the TTL of the
 * in-flight flags, and the job's running deadline. It sits above the
 * sandbox's own 60 s install-plus-audit budget (`TOTAL_TIMEOUT_MS` in
 * sandbox-exec.ts) so the sandbox answers first and the slack covers the
 * container's cold start, the R2 write, and the purge.
 */
export const RELAY_DEADLINE_SECONDS = 90;

export type InFlight = { started_at: string; job: string | null };

export type InFlightEnv = { SCORE_KV?: KVNamespace; AUDIT_JOB?: DurableObjectNamespace<AuditJob> };

function inflightKey(lane: Lane, key: string): string {
  return `inflight:${lane}:${key}`;
}

/** The job serving one lane and normalized input. */
export function jobName(lane: Lane, input: string): string {
  return `${lane}:${input}`;
}

// A KV read that fails is a miss: the flag is a dedup hint, never a gate.
export async function readInFlight(env: { SCORE_KV?: KVNamespace }, lane: Lane, key: string): Promise<InFlight | null> {
  if (!env.SCORE_KV) return null;
  try {
    const raw = await env.SCORE_KV.get(inflightKey(lane, key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<InFlight>;
    if (typeof parsed.started_at !== 'string') return null;
    return { started_at: parsed.started_at, job: typeof parsed.job === 'string' ? parsed.job : null };
  } catch {
    return null;
  }
}

export class InFlightFlags {
  private keys = new Set<string>();
  constructor(
    private readonly env: InFlightEnv,
    private readonly lane: Lane,
    readonly startedAt: string,
    private readonly job: string | null,
    // A run proceeding beside the run that holds the job owns none of its
    // keys: writing them would point every later reader at no job, and
    // clearing them would retire a flag whose run is still going.
    private readonly owns = true,
  ) {}

  async mark(...keys: string[]): Promise<void> {
    const kv = this.env.SCORE_KV;
    if (!kv || !this.owns) return;
    const value = JSON.stringify({ started_at: this.startedAt, job: this.job });
    await Promise.all(
      keys.map((key) => {
        const full = inflightKey(this.lane, key);
        this.keys.add(full);
        return kv.put(full, value, { expirationTtl: RELAY_DEADLINE_SECONDS }).catch(() => {});
      }),
    );
  }

  async clear(): Promise<void> {
    const kv = this.env.SCORE_KV;
    if (!kv || !this.owns) return;
    await Promise.all([...this.keys].map((key) => kv.delete(key).catch(() => {})));
    this.keys.clear();
  }
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

function stubFor(env: InFlightEnv, name: string): DurableObjectStub<AuditJob> | null {
  const namespace = env.AUDIT_JOB;
  return namespace ? namespace.get(namespace.idFromName(name)) : null;
}

function logJobError(job: string, stage: string, err: unknown): void {
  emitLog({ scope: 'audit.job' }, { job, stage, error: err instanceof Error ? err.message : String(err) });
}

/**
 * A run's writer onto its job. Appends go through one sequential chain so
 * the job's log keeps the relay's order; a failed append is logged and the
 * run it describes continues.
 */
export class JobWriter {
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly stub: DurableObjectStub<AuditJob>,
    readonly name: string,
    private readonly run: string,
  ) {}

  append(event: AuditEvent): void {
    this.chain = this.chain
      .then(async () => {
        await this.stub.append(this.run, event);
      })
      .catch((err) => logJobError(this.name, 'append', err));
  }

  /** Settles once every queued append has landed or failed. */
  settled(): Promise<void> {
    return this.chain;
  }
}

export type JobClaimOutcome =
  | { kind: 'claimed'; writer: JobWriter }
  | { kind: 'running'; name: string; started_at: string }
  /** No binding, or the claim failed: the run proceeds without fan-out. */
  | { kind: 'unavailable' };

export async function claimJob(
  env: InFlightEnv,
  lane: Lane,
  input: string,
  startedAt: string,
): Promise<JobClaimOutcome> {
  const name = jobName(lane, input);
  const stub = stubFor(env, name);
  if (!stub) return { kind: 'unavailable' };
  try {
    const claim = await stub.claim(startedAt, RELAY_DEADLINE_SECONDS * 1000);
    return claim.claimed
      ? { kind: 'claimed', writer: new JobWriter(stub, name, claim.run) }
      : { kind: 'running', name, started_at: claim.started_at };
  } catch (err) {
    logJobError(name, 'claim', err);
    return { kind: 'unavailable' };
  }
}

/**
 * The named job's events from the start of its log, then its live tail;
 * null when no job answers. The iteration throws the signal's reason when
 * `signal` aborts.
 */
export async function attachJob(
  env: InFlightEnv,
  name: string,
  signal?: AbortSignal,
): Promise<AsyncGenerator<AuditEvent> | null> {
  const stub = stubFor(env, name);
  if (!stub) return null;
  let res: Response;
  try {
    res = await stub.fetch(`https://audit-job${ATTACH_PATH}?from=0`);
  } catch (err) {
    logJobError(name, 'attach', err);
    return null;
  }
  if (res.status !== 200 || !res.body) return null;
  // The lines are the job's own log of the relay's events.
  return ndjsonValues(res.body, signal) as AsyncGenerator<AuditEvent>;
}

/**
 * The named job's terminal event, or null when none arrives by the relay
 * deadline plus the job's grace, or when `signal` aborts first because the
 * caller went away.
 */
export async function awaitJobTerminal(
  env: InFlightEnv,
  name: string,
  signal?: AbortSignal,
): Promise<TerminalEvent | null> {
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(new Error('attach_deadline')),
    RELAY_DEADLINE_SECONDS * 1000 + JOB_GRACE_MS,
  );
  const onCallerGone = () => abort.abort(signal?.reason);
  if (signal?.aborted) onCallerGone();
  else signal?.addEventListener('abort', onCallerGone, { once: true });
  try {
    const events = await attachJob(env, name, abort.signal);
    if (!events) return null;
    for await (const event of events) {
      if (isTerminalEvent(event)) return event;
    }
    return null;
  } catch (err) {
    if (!signal?.aborted) logJobError(name, 'await', err);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerGone);
  }
}

/**
 * The terminal event of the run in flight for one lane and key; null when
 * none is in flight, it does not finish in time, or the caller goes away.
 */
export async function awaitInFlightTerminal(
  env: InFlightEnv,
  lane: Lane,
  key: string,
  signal?: AbortSignal,
): Promise<TerminalEvent | null> {
  const flag = await readInFlight(env, lane, key);
  return flag?.job ? awaitJobTerminal(env, flag.job, signal) : null;
}
