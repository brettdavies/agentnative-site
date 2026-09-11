// Durable Object state for the audit job, over bun:sqlite: the job's SQL
// runs against a real SQLite engine and the alarm is a value a test fires
// by hand. The namespace hands out one real AuditJob per name, and its stub
// copies each appended event the way an RPC call does, so a test drives the
// endpoint and the MCP tools against the object's actual single-flight and
// fan-out behavior.

import { Database } from 'bun:sqlite';
import type { AuditEvent } from '../../src/shared/audit-events';
import { AuditJob } from '../../src/worker/audit/job';

type SqlValue = string | number | null;

export type FakeJobState = {
  alarm: number | null;
  deleted: number;
  /** The tables in the object's database, by name. */
  tables(): string[];
  storage: {
    sql: { exec(query: string, ...bindings: SqlValue[]): unknown };
    setAlarm(at: number): Promise<void>;
    deleteAll(): Promise<void>;
  };
};

export function fakeJobState(): FakeJobState {
  let db = new Database(':memory:');
  const state: FakeJobState = {
    alarm: null,
    deleted: 0,
    tables: () =>
      (
        db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
      ).map((table) => table.name),
    storage: {
      sql: {
        exec(query: string, ...bindings: SqlValue[]) {
          const rows = db.query(query).all(...bindings) as Array<Record<string, SqlValue>>;
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
      // Mirrors the platform from compatibility date 2026-02-24 on (this
      // Worker's is 2026-04-01): deleteAll clears the alarm with the database.
      async deleteAll() {
        db.close();
        db = new Database(':memory:');
        state.alarm = null;
        state.deleted += 1;
      },
    },
  };
  return state;
}

export function makeJob(state: FakeJobState = fakeJobState()): { job: AuditJob; state: FakeJobState } {
  return { job: new AuditJob(state as unknown as DurableObjectState, {} as never), state };
}

export type FakeJobNamespace = DurableObjectNamespace<AuditJob> & {
  jobs: Map<string, { job: AuditJob; state: FakeJobState }>;
};

export function fakeJobNamespace(): FakeJobNamespace {
  const jobs = new Map<string, { job: AuditJob; state: FakeJobState }>();
  const entry = (name: string) => {
    let found = jobs.get(name);
    if (!found) {
      found = makeJob();
      jobs.set(name, found);
    }
    return found;
  };
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => {
      const { job } = entry(id.name);
      return {
        claim: (startedAt: string, deadlineMs: number) => job.claim(startedAt, deadlineMs),
        append: (run: string, event: AuditEvent) => job.append(run, structuredClone(event)),
        fetch: (input: RequestInfo | URL, init?: RequestInit) => job.fetch(new Request(input, init)),
      };
    },
    jobs,
  };
  return namespace as unknown as FakeJobNamespace;
}
