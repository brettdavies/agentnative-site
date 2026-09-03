// Web-audit instrumentation + operator notification tests: the event
// wrapper must be a faithful pass-through with summary-always /
// detail-on-debug logging, and the notifier must be a safe no-op until
// provisioned, deduplicated once it is.

import { describe, expect, test } from 'bun:test';
import { instrumentAuditEvents } from '../src/worker/audit-web/audit-log';
import type { AuditEvent } from '../src/worker/audit-web/engine';
import type { WebScorecard } from '../src/worker/audit-web/scorecard';
import { notifyFailure } from '../src/worker/notify';
import { captureLogs } from './helpers/log-capture';
import { fakeKv, type SentMessage } from './helpers/notify-fakes';

async function* eventsOf(events: AuditEvent[]): AsyncGenerator<AuditEvent> {
  for (const e of events) yield e;
}

async function collect(gen: AsyncGenerator<AuditEvent>): Promise<AuditEvent[]> {
  const out: AuditEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const RESULT_EVENT: AuditEvent = {
  type: 'result',
  result: {
    id: 'llms-txt',
    title: 't',
    principle: 'P2',
    keyword: 'should',
    tier: 'recommended',
    category: 'content-for-agents',
    weight: 4,
    status: 'pass',
    evidence: 'https://example.com/llms.txt -> 200',
    raw_evidence: [],
  },
};

const COMPLETE_EVENT: AuditEvent = {
  type: 'complete',
  scorecard: { score_pct: 50 } as WebScorecard,
  complete: true,
};

describe('instrumentAuditEvents', () => {
  test('passes every event through unchanged and logs one run summary', async () => {
    const logs = captureLogs();
    try {
      const input: AuditEvent[] = [{ type: 'discovery', endpoint: null, evidence: [] }, RESULT_EVENT, COMPLETE_EVENT];
      const output = await collect(
        instrumentAuditEvents(eventsOf(input), {}, { target: 'https://example.com/', surface: 'stream' }),
      );
      expect(output).toEqual(input);
      const lines = logs.records.map((r) => r.record);
      const summaries = lines.filter((l) => l.scope === 'web-audit.run');
      expect(summaries.length).toBe(1);
      expect(summaries[0].terminal).toBe('complete');
      expect(summaries[0].surface).toBe('stream');
      expect(summaries[0].checks).toEqual({ pass: 1 });
      expect(lines.some((l) => l.scope === 'web-audit.check')).toBe(false);
    } finally {
      logs.restore();
    }
  });

  test('WEB_AUDIT_DEBUG adds per-check and discovery lines', async () => {
    const logs = captureLogs();
    try {
      const input: AuditEvent[] = [{ type: 'discovery', endpoint: null, evidence: [] }, RESULT_EVENT, COMPLETE_EVENT];
      await collect(
        instrumentAuditEvents(eventsOf(input), { WEB_AUDIT_DEBUG: 'true' }, { target: 'x', surface: 'mcp' }),
      );
      const lines = logs.records.map((r) => r.record);
      expect(lines.some((l) => l.scope === 'web-audit.discovery')).toBe(true);
      expect(lines.filter((l) => l.scope === 'web-audit.check').length).toBe(1);
    } finally {
      logs.restore();
    }
  });

  test('an unreachable terminal is reported in the summary', async () => {
    const logs = captureLogs();
    try {
      await collect(
        instrumentAuditEvents(
          eventsOf([{ type: 'unreachable', reason: 'silence' }]),
          {},
          { target: 'x', surface: 'stream' },
        ),
      );
      const lines = logs.records.map((r) => r.record);
      expect(lines.find((l) => l.scope === 'web-audit.run')?.terminal).toBe('unreachable');
    } finally {
      logs.restore();
    }
  });

  test('the summary still logs when the engine throws mid-stream', async () => {
    const logs = captureLogs();
    try {
      async function* explodes(): AsyncGenerator<AuditEvent> {
        yield RESULT_EVENT;
        throw new Error('boom');
      }
      await expect(collect(instrumentAuditEvents(explodes(), {}, { target: 'x', surface: 'mcp' }))).rejects.toThrow(
        'boom',
      );
      const lines = logs.records.map((r) => r.record);
      const summary = lines.find((l) => l.scope === 'web-audit.run');
      expect(summary?.terminal).toBe('none');
      expect(summary?.checks).toEqual({ pass: 1 });
    } finally {
      logs.restore();
    }
  });
});

describe('notifyFailure', () => {
  const alert = { key: 'test-alert', subject: 's', text: 't' };

  test('is a no-op until the binding and addresses are provisioned', async () => {
    expect(await notifyFailure({}, alert)).toBe('unprovisioned');
    expect(await notifyFailure({ ALERT_EMAIL_FROM: 'a@example.com', ALERT_EMAIL_TO: 'b@example.com' }, alert)).toBe(
      'unprovisioned',
    );
  });

  test('sends once, then dedupes within the TTL window', async () => {
    const sent: SentMessage[] = [];
    const env = {
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
    expect(await notifyFailure(env, alert)).toBe('sent');
    expect(await notifyFailure(env, alert)).toBe('deduped');
    expect(sent.length).toBe(1);
    expect(sent[0].from).toBe('alerts@example.com');
    expect(sent[0].to).toBe('ops@example.com');
  });

  test('a failed send is reported, never thrown', async () => {
    const logs = captureLogs();
    try {
      const env = {
        EMAIL: {
          send: async () => {
            throw new Error('domain not onboarded');
          },
        },
        ALERT_EMAIL_FROM: 'alerts@example.com',
        ALERT_EMAIL_TO: 'ops@example.com',
      };
      expect(await notifyFailure(env, alert)).toBe('send_failed');
      const failed = logs.records.find((r) => r.record.scope === 'notify.send_failed');
      expect(failed?.level).toBe('error');
    } finally {
      logs.restore();
    }
  });
});
