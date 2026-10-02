// Web-audit instrumentation + operator notification tests: the event
// wrapper must be a faithful pass-through with summary-always /
// detail-on-debug logging, and the notifier must be a safe no-op until
// provisioned, deduplicated once it is.

import { describe, expect, test } from 'bun:test';
import { instrumentAuditEvents } from '../src/worker/audit-web/audit-log';
import { sha256Hex } from '../src/worker/audit-web/cache';
import { type AuditEvent, runWebAudit } from '../src/worker/audit-web/engine';
import type { DomainBudget } from '../src/worker/audit-web/follow-requests';
import type { WebScorecard } from '../src/worker/audit-web/scorecard';
import { notifyFailure } from '../src/worker/notify';
import {
  aiCatalog,
  cardEntry,
  followRegistry,
  html,
  requestsTo,
  router,
  type Seen,
  sep2127Card,
  TARGET,
} from './helpers/follow-fixtures';
import { captureLogs } from './helpers/log-capture';
import { fakeKv, type SentMessage } from './helpers/notify-fakes';
import { stubFetch } from './helpers/stub-fetch';

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
  follow: { requests: 0, domainRequests: {}, elapsedMs: 0 },
};

describe('instrumentAuditEvents', () => {
  test('passes every event through unchanged and logs one run summary', async () => {
    const logs = captureLogs();
    try {
      const input: AuditEvent[] = [{ type: 'discovery', endpoint: null, evidence: [] }, RESULT_EVENT, COMPLETE_EVENT];
      const output = await collect(
        instrumentAuditEvents(
          eventsOf(input),
          {},
          { target: 'https://example.com/', surface: 'stream', followDeclarations: true },
        ),
      );
      expect(output).toEqual(input);
      const lines = logs.records.map((r) => r.record);
      const summaries = lines.filter((l) => l.scope === 'web-audit.run');
      expect(summaries.length).toBe(1);
      expect(summaries[0].terminal).toBe('complete');
      expect(summaries[0].surface).toBe('stream');
      expect(summaries[0].checks).toEqual({ pass: 1 });
      expect(summaries[0].follow_declarations).toBe(true);
      expect(lines.some((l) => l.scope === 'web-audit.check')).toBe(false);
      expect(lines.some((l) => l.scope === 'web-audit.discovery')).toBe(false);
    } finally {
      logs.restore();
    }
  });

  test('the run summary records the follow state the audit ran with', async () => {
    const logs = captureLogs();
    try {
      await collect(
        instrumentAuditEvents(
          eventsOf([COMPLETE_EVENT]),
          {},
          { target: 'x', surface: 'mcp', followDeclarations: false },
        ),
      );
      const summary = logs.records.map((r) => r.record).find((l) => l.scope === 'web-audit.run');
      expect(summary?.follow_declarations).toBe(false);
    } finally {
      logs.restore();
    }
  });

  test('WEB_AUDIT_DEBUG adds per-check and discovery lines', async () => {
    const logs = captureLogs();
    try {
      const input: AuditEvent[] = [{ type: 'discovery', endpoint: null, evidence: [] }, RESULT_EVENT, COMPLETE_EVENT];
      await collect(
        instrumentAuditEvents(
          eventsOf(input),
          { WEB_AUDIT_DEBUG: 'true' },
          { target: 'x', surface: 'mcp', followDeclarations: true },
        ),
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
          { target: 'x', surface: 'stream', followDeclarations: true },
        ),
      );
      const lines = logs.records.map((r) => r.record);
      expect(lines.find((l) => l.scope === 'web-audit.run')?.terminal).toBe('unreachable');
    } finally {
      logs.restore();
    }
  });

  test("the run summary records the follow slice's outcome counts, requests, and elapsed time", async () => {
    // One endpoint its host does not confirm, then one on a domain whose
    // hourly budget is spent. Only requests to the declared host move the
    // clock, so the slice's elapsed time is 100 ms per request it sent.
    const refused = 'https://mcp.example.net/mcp';
    const capped = 'https://mcp.capped.org/mcp';
    let clock = 1_000_000;
    const seen: Seen[] = [];
    const site = router(
      {
        [`GET ${TARGET}`]: () => html(),
        'GET https://example.com/.well-known/ai-catalog.json': () =>
          aiCatalog(cardEntry({ data: sep2127Card(refused) }), cardEntry({ data: sep2127Card(capped) })),
      },
      seen,
    );
    const fetchImpl = stubFetch((url, init) => {
      if (new URL(url).hostname !== 'example.com') clock += 100;
      return site(url, init);
    });
    const budget: DomainBudget = {
      keyOf: (hostname) => hostname.split('.').slice(-2).join('.'),
      reserve: async (domain) => domain !== 'capped.org',
    };
    const logs = captureLogs();
    try {
      await collect(
        instrumentAuditEvents(
          runWebAudit({
            url: TARGET,
            registry: followRegistry(),
            fetchOptions: { fetchImpl },
            domainBudget: budget,
            now: () => clock,
          }),
          {},
          { target: TARGET, surface: 'stream', followDeclarations: true },
        ),
      );
      const sent = requestsTo(seen, 'mcp.example.net').length;
      expect(sent).toBeGreaterThan(0);
      expect(requestsTo(seen, 'mcp.capped.org')).toEqual([]);
      const summary = logs.records.map((r) => r.record).find((l) => l.scope === 'web-audit.run');
      expect(summary).toMatchObject({
        terminal: 'complete',
        follow_outcomes: { 'reciprocity-refused': 1, 'budget-exceeded': 1 },
        follow_budget_causes: { 'domain-budget': 1 },
        follow_requests: sent,
        follow_elapsed_ms: sent * 100,
        follow_domain_requests: { [await sha256Hex('example.net')]: sent },
      });
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
      await expect(
        collect(instrumentAuditEvents(explodes(), {}, { target: 'x', surface: 'mcp', followDeclarations: true })),
      ).rejects.toThrow('boom');
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
