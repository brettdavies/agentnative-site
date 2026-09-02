// Lake-freshness tests: the daily stall check over the TELEMETRY_LAKE
// binding — threshold verdicts, the single status line per run, the
// KV-deduped alert path, staging log-only, and the scheduled() cron
// dispatch through the Worker default export.

import { describe, expect, spyOn, test } from 'bun:test';
import worker, { type Env } from '../src/worker/index';
import {
  LAKE_FRESHNESS_CRON,
  LAKE_INGEST_PREFIX,
  LAKE_STALE_THRESHOLD_MS,
  type LakeFreshnessEnv,
  runLakeFreshnessCheck,
} from '../src/worker/telemetry/lake-freshness';
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

function scopedLines(logSpy: { mock: { calls: unknown[][] } }, scope: string): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
    .filter((l) => l.scope === scope);
}

function statusLines(logSpy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return scopedLines(logSpy, 'telemetry.lake-freshness');
}

describe('runLakeFreshnessCheck', () => {
  test('a fresh lake emits exactly one status line and never alerts', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const sent: SentMessage[] = [];
      const env: LakeFreshnessEnv = {
        TELEMETRY_LAKE: lakeBucket([[{ key: 'ingest/a', uploaded: new Date(NOW - HOUR_MS) }]]),
        TELEMETRY_ENVIRONMENT: 'production',
        ...alertEnv(sent),
      };
      await runLakeFreshnessCheck(env, NOW);
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
      logSpy.mockRestore();
    }
  });

  test('a stalled production lake emails once, naming the environment and the stale age', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const sent: SentMessage[] = [];
      const env: LakeFreshnessEnv = {
        TELEMETRY_LAKE: lakeBucket([[{ key: 'ingest/a', uploaded: new Date(NOW - 30 * HOUR_MS) }]]),
        TELEMETRY_ENVIRONMENT: 'production',
        ...alertEnv(sent),
      };
      await runLakeFreshnessCheck(env, NOW);
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
      logSpy.mockRestore();
    }
  });

  test('an empty ingest prefix is a stall (a never-started sink alerts)', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const sent: SentMessage[] = [];
      const env: LakeFreshnessEnv = {
        TELEMETRY_LAKE: lakeBucket([[]]),
        TELEMETRY_ENVIRONMENT: 'production',
        ...alertEnv(sent),
      };
      await runLakeFreshnessCheck(env, NOW);
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
      logSpy.mockRestore();
    }
  });

  test('an unprovisioned email path lands on the status line and nothing throws', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const env: LakeFreshnessEnv = {
        TELEMETRY_LAKE: lakeBucket([[{ key: 'ingest/a', uploaded: new Date(NOW - 30 * HOUR_MS) }]]),
        TELEMETRY_ENVIRONMENT: 'production',
      };
      await runLakeFreshnessCheck(env, NOW);
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
      logSpy.mockRestore();
    }
  });

  test('a stale staging lake is log-only even with the email path provisioned', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const sent: SentMessage[] = [];
      const env: LakeFreshnessEnv = {
        TELEMETRY_LAKE: lakeBucket([[{ key: 'ingest/a', uploaded: new Date(NOW - 30 * HOUR_MS) }]]),
        TELEMETRY_ENVIRONMENT: 'staging',
        ...alertEnv(sent),
      };
      await runLakeFreshnessCheck(env, NOW);
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
      logSpy.mockRestore();
    }
  });

  test('a missing TELEMETRY_LAKE binding logs and returns (best-effort, no alert)', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const sent: SentMessage[] = [];
      const env: LakeFreshnessEnv = {
        TELEMETRY_ENVIRONMENT: 'production',
        ...alertEnv(sent),
      };
      await runLakeFreshnessCheck(env, NOW);
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
      logSpy.mockRestore();
    }
  });

  test('an R2 list failure folds into the status line and never alerts', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
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
      await runLakeFreshnessCheck(env, NOW);
      expect(sent).toEqual([]);
      const lines = statusLines(logSpy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        scope: 'telemetry.lake-freshness',
        environment: 'production',
        error: 'r2 unavailable',
        newest_age_ms: null,
        stale: null,
        notify: 'skipped',
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test('a truncated listing pages through and picks the true newest across pages', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
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
      await runLakeFreshnessCheck(env, NOW);
      expect(sent).toEqual([]);
      expect(listCalls).toHaveLength(2);
      expect(listCalls[1].cursor).toBe('1');
      for (const call of listCalls) {
        expect(call.prefix).toBe(LAKE_INGEST_PREFIX);
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
      logSpy.mockRestore();
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

    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
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
      expect(listCalls).toHaveLength(1);
      expect(statusLines(logSpy)).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  test('an unrecognized cron string logs one scoped line and does nothing', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
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
      logSpy.mockRestore();
    }
  });
});
