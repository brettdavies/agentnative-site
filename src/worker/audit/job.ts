// AuditJob: one running audit, fanned out to every reader of its input.
// The transact endpoint claims the job at `accepted` under
// `idFromName('<lane>:<input>')`, appends every event its relay consumes,
// and the terminal event closes the run. A second tab, a refreshed progress
// page, or an MCP transact tool attaches instead of starting a second run:
// the stored log replays from a sequence, then the live tail follows.
//
//   claim(started_at, deadline) -- a run inside its deadline --> refused,
//        | run id                                               { claimed: false }
//        v
//   running --append(run, event)--> events (seq, line) --> live subscribers
//        |                                                   ^
//        |                        attach(from): replay seq >= from, then
//        |                        tail while the run is still running
//        | terminal event
//        v
//   done ------ alarm at terminal + grace ---------------------> deleted
//   running --- alarm at deadline + grace -> timeout line -----> deleted
//
// Claim is the single-flight gate: the object serves one request at a time,
// so two claims cannot both win, where the KV flag in front of it is only a
// propagation-lagged hint. The run id keeps an initiator that outlived its
// deadline from writing into the run that took the job over.
//
// Subscribers live in memory. An open stream keeps the object active; an
// eviction drops them, and their readers see the stream end without a
// terminal line, the same as a lost connection. An attach to a job that was
// never claimed, or was already deleted, is a 404.

import { DurableObject } from 'cloudflare:workers';
import { type AuditEvent, auditErrorFor, CTA_RETRY, isTerminalEvent } from '../../shared/audit-events';

/** The attach route on the object's own fetch. */
export const ATTACH_PATH = '/attach';

/** How long a job outlives its deadline or its terminal event, so a late attach still replays it. */
export const JOB_GRACE_MS = 60_000;

/** Events past this count reach live readers but are not kept; the terminal event always is. */
export const JOB_LOG_LIMIT = 1_000;

export type JobClaim = { claimed: true; run: string } | { claimed: false; started_at: string };

type JobStatus = 'running' | 'done';

type JobRow = { run: string; status: JobStatus; started_at: string; deadline: number };

type Subscriber = (line: string | null) => void;

export class AuditJob extends DurableObject {
  private readonly subscribers = new Set<Subscriber>();
  private schemaReady = false;

  /** Start a run unless one is already running inside its deadline. */
  async claim(startedAt: string, deadlineMs: number): Promise<JobClaim> {
    const now = Date.now();
    const current = this.current();
    if (current?.status === 'running' && now < current.deadline) {
      return { claimed: false, started_at: current.started_at };
    }
    if (current?.status === 'running') this.endSubscribers(timeoutLine());
    const run = crypto.randomUUID();
    const deadline = now + deadlineMs;
    const sql = this.sql();
    sql.exec('DELETE FROM events');
    sql.exec(
      'INSERT OR REPLACE INTO job (id, run, status, started_at, deadline) VALUES (1, ?, ?, ?, ?)',
      run,
      'running',
      startedAt,
      deadline,
    );
    await this.ctx.storage.setAlarm(deadline + JOB_GRACE_MS);
    return { claimed: true, run };
  }

  /** Keep one event of the run and push it to every live reader; false when `run` is not the running one. */
  async append(run: string, event: AuditEvent): Promise<boolean> {
    const current = this.current();
    if (!current || current.status !== 'running' || current.run !== run) return false;
    // Each reader's relay writes its own heartbeats.
    if (event.type === 'heartbeat') return true;
    const line = JSON.stringify(event);
    const terminal = isTerminalEvent(event);
    const sql = this.sql();
    // The log is emptied at claim and seq counts up from 1 with no gaps, so
    // the highest seq is the kept count: one index lookup, not a scan.
    const kept = sql.exec<{ n: number }>('SELECT COALESCE(MAX(seq), 0) AS n FROM events').one().n;
    if (terminal || kept < JOB_LOG_LIMIT) sql.exec('INSERT INTO events (line) VALUES (?)', line);
    for (const push of this.subscribers) push(line);
    if (terminal) {
      sql.exec("UPDATE job SET status = 'done' WHERE id = 1");
      this.endSubscribers(null);
      await this.ctx.storage.setAlarm(Date.now() + JOB_GRACE_MS);
    }
    return true;
  }

  /** `GET /attach?from=<seq>`: the log from `seq` on, then the live tail while the run is running. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const current = request.method === 'GET' && url.pathname === ATTACH_PATH ? this.current() : null;
    if (!current) return new Response(null, { status: 404 });
    const from = Math.max(0, Number.parseInt(url.searchParams.get('from') ?? '0', 10) || 0);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    // Writes are queued and never awaited: a TransformStream write settles
    // only once the reader consumes it, and the replay and the subscribe
    // must land in one turn so no append slips between them.
    const subscriber: Subscriber = (line) => {
      if (line === null) {
        this.subscribers.delete(subscriber);
        writer.close().catch(() => {});
        return;
      }
      writer.write(encoder.encode(`${line}\n`)).catch(() => this.subscribers.delete(subscriber));
    };
    const replay = this.sql().exec<{ line: string }>('SELECT line FROM events WHERE seq >= ? ORDER BY seq', from);
    for (const row of replay) subscriber(row.line);
    if (current.status === 'running') this.subscribers.add(subscriber);
    else subscriber(null);
    return new Response(readable, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
  }

  override async alarm(): Promise<void> {
    this.endSubscribers(this.current()?.status === 'running' ? timeoutLine() : null);
    await this.ctx.storage.deleteAll();
    this.schemaReady = false;
  }

  private current(): JobRow | null {
    return (
      this.sql().exec<JobRow>('SELECT run, status, started_at, deadline FROM job WHERE id = 1').toArray()[0] ?? null
    );
  }

  private sql(): SqlStorage {
    const sql = this.ctx.storage.sql;
    if (!this.schemaReady) {
      sql.exec(
        'CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY CHECK (id = 1), run TEXT NOT NULL, ' +
          'status TEXT NOT NULL, started_at TEXT NOT NULL, deadline INTEGER NOT NULL)',
      );
      sql.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, line TEXT NOT NULL)');
      this.schemaReady = true;
    }
    return sql;
  }

  private endSubscribers(last: string | null): void {
    for (const push of [...this.subscribers]) {
      if (last !== null) push(last);
      push(null);
    }
  }
}

function timeoutLine(): string {
  const event: AuditEvent = {
    type: 'error',
    ...auditErrorFor('timeout', { cta: CTA_RETRY, details: 'The audit did not finish before its deadline.' }),
  };
  return JSON.stringify(event);
}
