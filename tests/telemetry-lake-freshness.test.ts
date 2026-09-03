// Lake-freshness tests: the daily stall check over the TELEMETRY_LAKE
// binding — threshold verdicts, the single status line per run, the
// KV-deduped alert path, staging log-only, the unscoped-prefix fail-closed
// guard, and the scheduled() cron dispatch through the Worker default
// export.

import { describe, expect, test } from 'bun:test';
import worker, { type Env } from '../src/worker/index';
import {
  LAKE_FRESHNESS_CRON,
  LAKE_INGEST_PREFIX,
  LAKE_STALE_THRESHOLD_MS,
  type LakeFreshnessEnv,
  runLakeFreshnessCheck,
} from '../src/worker/telemetry/lake-freshness';
import { captureLogs, type LogCapture } from './helpers/log-capture';
import { fakeKv, type SentMessage } from './helpers/notify-fakes';

const NOW = Date.parse('2026-09-02T06:00:00Z');
const HOUR_MS = 3_600_000;

type LakeObject = { key: string; uploaded: Date };
type ListCall = { prefix?: string; cursor?: string };

function lakeBucket(pages: LakeObject[][], listCalls: ListCall[] = []): R2Bucket {
  return {
    async list(opts: ListCall = {}) {
      listCalls.push(opts);
      const index = opts.cursor ? Number(opts.cursor) : 0;
      const objects = pages[index] ?? [];
      const truncated = index + 1 < pages.length;
      return truncated ? { objects, truncated, cursor: String(index + 1) } : { objects, truncated: false };
    },
  } as unknown as R2Bucket;
}

function alertEnv(
  sent: SentMessage[],
): Pick<LakeFreshnessEnv, 'EMAIL' | 'ALERT_EMAIL_FROM' | 'ALERT_EMAIL_TO' | 'SCORE_KV'> {
  return {
    EMAIL: {
      send: async (m: SentMessage) => {
        sent.push(m);
        return {};
      },
    },
    ALERT_EMAIL_FROM: 'alerts@example.com',
    ALERT_EMAIL_TO: 'ops@example.com',
    SCORE_KV: fakeKv(),
  };
}

function scopedLines(logs: LogCapture, scope: string): Array<Record<string, unknown>> {
  return logs.records.map((r) => r.record).filter((r) => r.scope === scope);
}

function statusLines(logs: LogCapture): Array<Record<string, unknown>> {
  return scopedLines(logs, 'telemetry.lake-freshness');
}

describe('runLakeFreshnessCheck', () => {
  test('a fresh lake emits exactly one status line and never alerts', async () => {
    const logSpy = captureLogs();
    try {
      const sent: SentMessage[] = [];
      const env: LakeFreshnessEnv = {
        TELEMETRY_LAKE: lakeBucket([[{ key: 'ingest/a', uploaded: new Date(NOW - HOUR_MS) }]]),
        TELEMETRY_ENVIRONMENT: 'production',
        ...alertEnv(sent),
      };
      await runLakeFreshnessCheck(env, NOW, 'ingest/');
      expect(sent).toEqual([]);
      const lines = statusLines(logSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        scope: 'telemetry.lake-freshness',
        environment: 'production',
        newest_age_ms: HOUR_MS,
        stale: false,
        notify: 'skipped',
      });
    } finally {
      logSpy.restore();
    }
  });

  test('a stalled production lake emails once, naming the environment and the stale age', async () => {
    const logSpy = captureLogs();
    try {
      const sent: SentMessage[] = [];
      const env: LakeFreshnessEnv = {
        TELEMETRY_LAKE: lakeBucket([[{ key: 'ingest/a', uploaded: new Date(NOW - 30 * HOUR_MS) }]]),
        TELEMETRY_ENVIRONMENT: 'production',
        ...alertEnv(sent),
      };
      await runLakeFreshnessCheck(env, NOW, 'ingest/');
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toContain('production');
      expect(sent[0].text).toContain('production');
      expect(sent[0].text).toContain('30');
      const lines = statusLines(logSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        scope: 'telemetry.lake-freshness',
        environment: 'production',
        newest_age_ms: 30 * HOUR_MS,
        stale: true,
        notify: 'sent',
      });
    } finally {
      logSpy.restore();
    }
  });

  test('an empty ingest prefix is a stall (a never-started sink alerts)', async () => {
    const logSpy = captureLogs();
    try {
      const sent: SentMessage[] = [];
      const env: LakeFreshnessEnv = {
        TELEMETRY_LAKE: lakeBucket([[]]),
        TELEMETRY_ENVIRONMENT: 'production',
        ...alertEnv(sent),
      };
      await runLakeFreshnessCheck(env, NOW, 'ingest/');
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toContain('production');
      expect(sent[0].text).toContain('no objects');
      const lines = statusLines(logSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        scope: 'telemetry.lake-freshness',
        environment: 'production',
        newest_age_ms: null,
        stale: true,
        notify: 'sent',
      });
    } finally {
      logSpy.restore();
    }
  });

  test('an unprovisioned email path lands on the status line and nothing throws', async () => {
    const logSpy = captureLogs();
    try {
      const env: LakeFreshnessEnv = {
        TELEMETRY_LAKE: lakeBucket([[{ key: 'ingest/a', uploaded: new Date(NOW - 30 * HOUR_MS) }]]),
        TELEMETRY_ENVIRONMENT: 'production',
      };
      await runLakeFreshnessCheck(env, NOW, 'ingest/');
      const lines = statusLines(logSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        scope: 'telemetry.lake-freshness',
        environment: 'production',
        newest_age_ms: 30 * HOUR_MS,
        stale: true,
        notify: 'unprovisioned',
      });
    } finally {
      logSpy.restore();
    }
  });

  test('a stale staging lake is log-only even with the email path provisioned', async () => {
    const logSpy = captureLogs();
    try {
      const sent: SentMessage[] = [];
      const env: LakeFreshnessEnv = {
        TELEMETRY_LAKE: lakeBucket([[{ key: 'ingest/a', uploaded: new Date(NOW - 30 * HOUR_MS) }]]),
        TELEMETRY_ENVIRONMENT: 'staging',
        ...alertEnv(sent),
      };
      await runLakeFreshnessCheck(env, NOW, 'ingest/');
      expect(sent).toEqual([]);
      const lines = statusLines(logSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        scope: 'telemetry.lake-freshness',
        environment: 'staging',
        newest_age_ms: 30 * HOUR_MS,
        stale: true,
        notify: 'log-only',
      });
    } finally {
      logSpy.restore();
    }
  });

  test('an unscoped ingest prefix renders no verdict and never alerts (fail closed)', async () => {
    // The deployed default is the unscoped state until the runbook's Sink
    // layout record pins the ingest-write prefix.
    expect(LAKE_INGEST_PREFIX).toBe('');
    const logSpy = captureLogs();
    try {
      const sent: SentMessage[] = [];
      const listCalls: ListCall[] = [];
      const env: LakeFreshnessEnv = {
        TELEMETRY_LAKE: lakeBucket([[]], listCalls),
        TELEMETRY_ENVIRONMENT: 'production',
        ...alertEnv(sent),
      };
      await runLakeFreshnessCheck(env, NOW);
      expect(sent).toEqual([]);
      expect(listCalls).toEqual([]);
      const lines = statusLines(logSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        scope: 'telemetry.lake-freshness',
        environment: 'production',
        error: 'ingest_prefix_unrecorded',
        newest_age_ms: null,
        stale: null,
        notify: 'skipped',
      });
    } finally {
      logSpy.restore();
    }
  });

  test('a missing TELEMETRY_LAKE binding logs and returns (best-effort, no alert)', async () => {
    const logSpy = captureLogs();
    try {
      const sent: SentMessage[] = [];
      const env: LakeFreshnessEnv = {
        TELEMETRY_ENVIRONMENT: 'production',
        ...alertEnv(sent),
      };
      await runLakeFreshnessCheck(env, NOW, 'ingest/');
      expect(sent).toEqual([]);
      const lines = statusLines(logSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        scope: 'telemetry.lake-freshness',
        environment: 'production',
        error: 'lake_binding_missing',
        newest_age_ms: null,
        stale: null,
        notify: 'skipped',
      });
    } finally {
      logSpy.restore();
    }
  });

  test('a production R2 list failure alerts once through the check-failed key', async () => {
    const logSpy = captureLogs();
    try {
      const sent: SentMessage[] = [];
      const env: LakeFreshnessEnv = {
        TELEMETRY_LAKE: {
          list: async () => {
            throw new Error('r2 unavailable');
          },
        } as unknown as R2Bucket,
        TELEMETRY_ENVIRONMENT: 'production',
        ...alertEnv(sent),
      };
      await runLakeFreshnessCheck(env, NOW, 'ingest/');
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toContain('production');
      expect(sent[0].text).toContain('r2 unavailable');
      const lines = statusLines(logSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        scope: 'telemetry.lake-freshness',
        environment: 'production',
        error: 'r2 unavailable',
        newest_age_ms: null,
        stale: null,
        notify: 'sent',
      });
    } finally {
      logSpy.restore();
    }
  });

  test('a staging R2 list failure is log-only', async () => {
    const logSpy = captureLogs();
    try {
      const sent: SentMessage[] = [];
      const env: LakeFreshnessEnv = {
        TELEMETRY_LAKE: {
          list: async () => {
            throw new Error('r2 unavailable');
          },
        } as unknown as R2Bucket,
        TELEMETRY_ENVIRONMENT: 'staging',
        ...alertEnv(sent),
      };
      await runLakeFreshnessCheck(env, NOW, 'ingest/');
      expect(sent).toEqual([]);
      const lines = statusLines(logSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        scope: 'telemetry.lake-freshness',
        environment: 'staging',
        error: 'r2 unavailable',
        newest_age_ms: null,
        stale: null,
        notify: 'log-only',
      });
    } finally {
      logSpy.restore();
    }
  });

  test('a truncated listing pages through and picks the true newest across pages', async () => {
    const logSpy = captureLogs();
    try {
      const sent: SentMessage[] = [];
      const listCalls: ListCall[] = [];
      const env: LakeFreshnessEnv = {
        TELEMETRY_LAKE: lakeBucket(
          [
            [{ key: 'ingest/old', uploaded: new Date(NOW - 40 * HOUR_MS) }],
            [{ key: 'ingest/new', uploaded: new Date(NOW - 2 * HOUR_MS) }],
          ],
          listCalls,
        ),
        TELEMETRY_ENVIRONMENT: 'production',
        ...alertEnv(sent),
      };
      await runLakeFreshnessCheck(env, NOW, 'ingest/');
      expect(sent).toEqual([]);
      expect(listCalls).toHaveLength(2);
      expect(listCalls[1].cursor).toBe('1');
      for (const call of listCalls) {
        expect(call.prefix).toBe('ingest/');
      }
      const lines = statusLines(logSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        scope: 'telemetry.lake-freshness',
        environment: 'production',
        newest_age_ms: 2 * HOUR_MS,
        stale: false,
        notify: 'skipped',
      });
    } finally {
      logSpy.restore();
    }
  });
});

describe('scheduled() cron dispatch', () => {
  test('the deployed daily cron literal routes to the freshness check', async () => {
    // The dispatch constant must equal the string wrangler.jsonc deploys;
    // a drifted constant would leave the daily tick unrecognized.
    expect(LAKE_FRESHNESS_CRON).toBe('0 6 * * *');
    // Exactly 24 hours: a full day with no delivery is the stall line.
    expect(LAKE_STALE_THRESHOLD_MS).toBe(24 * HOUR_MS);

    const logSpy = captureLogs();
    try {
      const listCalls: ListCall[] = [];
      const env = {
        TELEMETRY_LAKE: lakeBucket([[{ key: 'ingest/a', uploaded: new Date(Date.now() - HOUR_MS) }]], listCalls),
        TELEMETRY_ENVIRONMENT: 'staging',
      } as unknown as Env;
      await worker.scheduled?.(
        { scheduledTime: Date.now(), cron: '0 6 * * *', noRetry: () => {} } as ScheduledController,
        env,
        {} as ExecutionContext,
      );
      // The deployed call site uses the module default prefix, which stays
      // unscoped until the sink layout is recorded — so the routed check
      // emits its fail-closed line without listing.
      expect(listCalls).toHaveLength(0);
      const lines = statusLines(logSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0].error).toBe('ingest_prefix_unrecorded');
    } finally {
      logSpy.restore();
    }
  });

  test('an unrecognized cron string logs one scoped line and does nothing', async () => {
    const logSpy = captureLogs();
    try {
      const createdIds: string[] = [];
      const listCalls: ListCall[] = [];
      const env = {
        TELEMETRY_LAKE: lakeBucket([[]], listCalls),
        WEB_RESCORE_WORKFLOW: {
          get: async () => ({ status: async () => ({ status: 'complete' }) }),
          create: async (options?: { id?: string }) => {
            createdIds.push(options?.id ?? 'auto');
            return { id: options?.id ?? 'auto' };
          },
        },
      } as unknown as Env;
      await worker.scheduled?.(
        { scheduledTime: Date.now(), cron: '15 3 * * *', noRetry: () => {} } as ScheduledController,
        env,
        {} as ExecutionContext,
      );
      expect(createdIds).toEqual([]);
      expect(listCalls).toEqual([]);
      expect(statusLines(logSpy)).toHaveLength(0);
      const dispatchLines = scopedLines(logSpy, 'scheduled');
      expect(dispatchLines).toHaveLength(1);
      expect(dispatchLines[0]).toEqual({ scope: 'scheduled', error: 'unrecognized_cron', cron: '15 3 * * *' });
    } finally {
      logSpy.restore();
    }
  });
});
