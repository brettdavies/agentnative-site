// The CLI lane's stream contract end to end: the Durable Object body the
// sandbox run writes, the orchestrator's line reader over it, and the
// endpoint relay that forwards phases, heartbeats, and the terminal line.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { InstallSpec } from '../src/worker/score/discover-binary';
import { type ScoreSandboxEnv, streamScore } from '../src/worker/score/do';
import type { SandboxPhase, ScoreResult } from '../src/worker/score/sandbox-exec';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';
import { captureLogs, type LogCapture } from './helpers/log-capture';

const BINARY_SPEC: InstallSpec = { pm: 'npm', package: 'cowsay', binary: 'cowsay' };
const BRANCH_SPEC: InstallSpec = { pm: 'git-clone', owner: 'o', repo: 'r', branch: 'feature', binary: 'r' };
const SHA = 'c'.repeat(40);
const PHASES: SandboxPhase[] = ['installing', 'installed', 'verifying', 'lockdown', 'auditing'];

type Written = { key: string; value: string };

function sandboxEnv(opts: { bucket?: boolean; throwOnPut?: boolean } = {}): {
  env: ScoreSandboxEnv;
  writes: Written[];
} {
  const writes: Written[] = [];
  const env: ScoreSandboxEnv = {
    ASSETS: { fetch: async () => new Response('unused') } as unknown as Fetcher,
    ...(opts.bucket === false
      ? {}
      : {
          SCORE_CACHE: {
            async put(key: string, value: string) {
              if (opts.throwOnPut) throw new Error('r2 down');
              writes.push({ key, value });
            },
            async get() {
              return null;
            },
            async delete() {},
          } as unknown as R2Bucket,
        }),
  };
  return { env, writes };
}

const OK: ScoreResult = {
  ok: true,
  value: {
    scorecard: { tool: { name: 'cowsay', version: '1.6.0' }, score: { value: 88 } },
    anc_version: ANC_VERSION,
    install_ms: 10,
    anc_audit_ms: 20,
  },
};

async function linesOf(readable: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const text = await new Response(readable).text();
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('streamScore: the Durable Object body', () => {
  let logs: LogCapture;
  beforeEach(() => {
    logs = captureLogs();
  });
  afterEach(() => {
    logs.restore();
  });

  test('every phase is a line before the result line, and the R2 write lands before the result line is written', async () => {
    const { env, writes } = sandboxEnv();
    const order: string[] = [];
    const readable = streamScore(BINARY_SPEC, {
      env,
      run: async (_spec, onPhase) => {
        for (const phase of PHASES) onPhase(phase);
        return OK;
      },
      purge: async (tags) => {
        order.push(`purge:${tags.join(',')}`);
      },
      now: () => '2026-09-11T00:00:00.000Z',
    });
    const lines = await linesOf(readable);
    expect(lines.slice(0, 5)).toEqual(
      PHASES.map((phase) => ({ type: 'phase', phase, at: '2026-09-11T00:00:00.000Z' })),
    );
    expect(lines[5]).toMatchObject({ anc_version: ANC_VERSION, install_ms: 10, anc_audit_ms: 20 });
    expect(lines).toHaveLength(6);
    expect(writes.map((w) => w.key)).toEqual([`scores/cowsay/${SPEC_VERSION}.json`]);
    expect(order).toEqual(['purge:cli:cowsay']);
  });

  test('a failed run ends with an error line carrying the code and details', async () => {
    const { env, writes } = sandboxEnv();
    const readable = streamScore(BINARY_SPEC, {
      env,
      run: async () => ({ ok: false, error: 'chain_resolved_install_failed', details: 'npm exploded' }),
      purge: async () => {},
    });
    expect(await linesOf(readable)).toEqual([{ error: 'chain_resolved_install_failed', details: 'npm exploded' }]);
    expect(writes).toEqual([]);
  });

  test('a run that throws ends with a sandbox_exception error line', async () => {
    const { env } = sandboxEnv();
    const readable = streamScore(BINARY_SPEC, {
      env,
      run: async () => {
        throw new Error('container gone');
      },
      purge: async () => {},
    });
    expect(await linesOf(readable)).toEqual([{ error: 'sandbox_exception', details: 'container gone' }]);
  });

  test('a purge RPC failure is logged and the result line still follows', async () => {
    const { env, writes } = sandboxEnv();
    const readable = streamScore(BINARY_SPEC, {
      env,
      run: async () => OK,
      purge: async () => {
        throw new Error('rpc down');
      },
    });
    const lines = await linesOf(readable);
    expect(lines[lines.length - 1]).toMatchObject({ anc_version: ANC_VERSION });
    expect(writes).toHaveLength(1);
    const purgeLog = logs.records.find((r) => r.record.scope === 'hit-min-purge');
    expect(purgeLog?.record).toMatchObject({ error: 'rpc down', tags: ['cli:cowsay'] });
  });

  test('a branch run writes under the branch key with its source sha, then purges cli:o/r@feature', async () => {
    const { env, writes } = sandboxEnv();
    const purged: string[][] = [];
    const readable = streamScore(BRANCH_SPEC, {
      env,
      run: async () => ({ ok: true, value: { ...OK.value, scorecard: { tool: { name: 'r' } }, source_sha: SHA } }),
      purge: async (tags) => {
        purged.push(tags);
      },
    });
    const lines = await linesOf(readable);
    expect(lines[lines.length - 1]).toMatchObject({ source_sha: SHA });
    expect(writes.map((w) => w.key)).toEqual([`scores/o/r@feature/${SPEC_VERSION}.json`]);
    expect(JSON.parse(writes[0].value)).toMatchObject({ source_sha: SHA, tool_version: '' });
    expect(purged).toEqual([['cli:o/r@feature']]);
  });

  test('no purge fires when the write was refused or when R2 failed', async () => {
    const purged: string[][] = [];
    const refused = sandboxEnv();
    await linesOf(
      streamScore(BRANCH_SPEC, {
        env: refused.env,
        run: async () => ({ ok: true, value: { ...OK.value, scorecard: { tool: { name: 'r' } } } }),
        purge: async (tags) => {
          purged.push(tags);
        },
      }),
    );
    expect(refused.writes).toEqual([]);
    expect(logs.records.find((r) => r.record.scope === 'cache.write')?.record).toMatchObject({
      skipped: 'no_source_sha',
      target: 'o/r@feature',
    });
    const failed = sandboxEnv({ throwOnPut: true });
    await linesOf(
      streamScore(BINARY_SPEC, {
        env: failed.env,
        run: async () => OK,
        purge: async (tags) => {
          purged.push(tags);
        },
      }),
    );
    expect(purged).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The endpoint relay over a streaming Durable Object.
// ---------------------------------------------------------------------------

import { handleAuditApi } from '../src/worker/audit/api';
import type { Sandbox } from '../src/worker/score/do';
import { makeEnv } from './audit-api.test';

type StreamPlan = {
  /** Lines the stub writes, each after `gapMs`. */
  lines: unknown[];
  gapMs?: number;
  /** Never write the result line; stay open until the request signal aborts. */
  stall?: boolean;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const DO_RESULT = {
  scorecard: { tool: { name: 'ouch', binary: 'ouch', version: '0.5.0' }, badge: { score_pct: 71, eligible: true } },
  anc_version: ANC_VERSION,
  install_ms: 100,
  anc_audit_ms: 200,
};

const DO_PHASES = PHASES.map((phase) => ({ type: 'phase', phase, at: '2026-09-11T00:00:00.000Z' }));

// A Durable Object stub that streams lines with a gap between them and
// honors the request's abort signal the way a workerd subrequest does.
function streamingDo(plan: StreamPlan): Sandbox['fetch'] {
  return async (req: Request) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const abort = () => {
          try {
            controller.error(req.signal.reason ?? new DOMException('aborted', 'AbortError'));
          } catch {}
        };
        if (req.signal.aborted) return abort();
        req.signal.addEventListener('abort', abort, { once: true });
        for (const line of plan.lines) {
          await sleep(plan.gapMs ?? 0);
          if (req.signal.aborted) return;
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        }
        if (plan.stall) return;
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  };
}

function ndjsonPost(target: string, init: RequestInit = {}): Request {
  return new Request('https://anc.dev/api/score', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.9',
      accept: 'application/x-ndjson',
    },
    body: JSON.stringify({ target, turnstile_token: 'x' }),
    ...init,
  });
}

function jsonPost(target: string): Request {
  return new Request('https://anc.dev/api/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify({ target, turnstile_token: 'x' }),
  });
}

function ctxWithPromises() {
  const promises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => promises.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, promises };
}

async function readAll(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type Row = Record<string, unknown>;

describe('the relay over a streaming Durable Object', () => {
  let logs: LogCapture;
  beforeEach(() => {
    logs = captureLogs();
  });
  afterEach(() => {
    logs.restore();
  });
  const rows = (scope: string): Row[] =>
    logs.records.filter((r) => r.record.scope === scope).map((r) => r.record as Row);

  test('the client sees accepted, resolving, the five sandbox phases in order, then complete', async () => {
    const env = makeEnv({ doFetch: streamingDo({ lines: [...DO_PHASES, DO_RESULT] }) });
    const { ctx, promises } = ctxWithPromises();
    const res = await handleAuditApi(ndjsonPost('cargo binstall ouch'), env, ctx, env._deps);
    const lines = await readAll(res);
    await Promise.all(promises);
    expect(lines.map((l) => l.type)).toEqual([
      'accepted',
      'phase',
      'phase',
      'phase',
      'phase',
      'phase',
      'phase',
      'complete',
    ]);
    expect(lines.slice(1, 7).map((l) => l.phase)).toEqual(['resolving', ...PHASES]);
    expect(lines[2]).toMatchObject({ at: '2026-09-11T00:00:00.000Z' });
    expect(lines[7]).toMatchObject({ tier: 'live', target: 'ouch' });
  });

  test('silence produces a heartbeat, a quick run produces none, and every line parses on its own', async () => {
    const slow = makeEnv({
      doFetch: streamingDo({ lines: [DO_PHASES[0], DO_RESULT], gapMs: 60 }),
      deps: { heartbeatMs: 20 },
    });
    const a = ctxWithPromises();
    const slowLines = await readAll(await handleAuditApi(ndjsonPost('cargo binstall ouch'), slow, a.ctx, slow._deps));
    await Promise.all(a.promises);
    expect(slowLines.filter((l) => l.type === 'heartbeat').length).toBeGreaterThan(0);
    expect(slowLines[slowLines.length - 1].type).toBe('complete');

    const quick = makeEnv({ doFetch: streamingDo({ lines: [DO_RESULT] }), deps: { heartbeatMs: 20 } });
    const b = ctxWithPromises();
    const quickLines = await readAll(
      await handleAuditApi(ndjsonPost('cargo binstall ouch'), quick, b.ctx, quick._deps),
    );
    await Promise.all(b.promises);
    expect(quickLines.filter((l) => l.type === 'heartbeat')).toEqual([]);
  });

  test('a relay that exceeds its deadline ends the client stream with a timeout error and clears the flags', async () => {
    const env = makeEnv({
      doFetch: streamingDo({ lines: [DO_PHASES[0]], stall: true }),
      deps: { relayDeadlineMs: 40 },
    });
    const { ctx, promises } = ctxWithPromises();
    const lines = await readAll(await handleAuditApi(ndjsonPost('cargo binstall ouch'), env, ctx, env._deps));
    await Promise.all(promises);
    expect(lines[lines.length - 1]).toMatchObject({ type: 'error', error: { code: 'timeout' } });
    expect(rows('audit.request')[0]).toMatchObject({ lane: 'cli', outcome: 'error_timeout' });
    expect([...env._kv.keys()].filter((k) => k.startsWith('inflight:'))).toEqual([]);
  });

  test('a stream that ends after a phase line ends the client stream with incomplete_response_contract', async () => {
    const env = makeEnv({ doFetch: streamingDo({ lines: [DO_PHASES[0]] }) });
    const { ctx, promises } = ctxWithPromises();
    const lines = await readAll(await handleAuditApi(ndjsonPost('cargo binstall ouch'), env, ctx, env._deps));
    await Promise.all(promises);
    expect(lines[lines.length - 1]).toMatchObject({ type: 'error', error: { code: 'incomplete_response_contract' } });
  });

  test('a client that goes away mid-run is recorded as client_gone at once, and the consumer still finishes with the real tier', async () => {
    const env = makeEnv({ doFetch: streamingDo({ lines: [DO_PHASES[0], DO_RESULT], gapMs: 40 }) });
    const { ctx, promises } = ctxWithPromises();
    const controller = new AbortController();
    const res = await handleAuditApi(
      ndjsonPost('cargo binstall ouch', { signal: controller.signal }),
      env,
      ctx,
      env._deps,
    );
    const reader = res.body?.getReader();
    await reader?.read();
    controller.abort();
    await sleep(5);
    const requestRows = rows('audit.request');
    expect(requestRows).toHaveLength(1);
    expect(requestRows[0]).toMatchObject({ lane: 'cli', outcome: 'client_gone', stream: true });
    expect(typeof requestRows[0].ms_bucket).toBe('string');
    await Promise.all(promises);
    expect(rows('audit.request')).toHaveLength(1);
    expect(rows('score.tier')[0]).toMatchObject({ tier: 'live', binary: 'ouch' });
    expect(logs.records.some((r) => JSON.stringify(r.record).includes('incomplete_response_contract'))).toBe(false);
    expect([...env._kv.keys()].filter((k) => k.startsWith('inflight:'))).toEqual([]);
  });

  test('the terminal score.tier line and the analytics row come from the consumer, after the terminal line', async () => {
    const points: Array<{ blobs?: (string | null)[]; doubles?: (number | null)[]; indexes?: string[] }> = [];
    const env = makeEnv({ doFetch: streamingDo({ lines: [...DO_PHASES, DO_RESULT], gapMs: 5 }) });
    env.SCORE_TELEMETRY = { writeDataPoint: (event) => void points.push(event) };
    const { ctx, promises } = ctxWithPromises();
    const res = await handleAuditApi(ndjsonPost('cargo binstall ouch'), env, ctx, env._deps);
    expect(rows('score.tier')).toEqual([]);
    await readAll(res);
    await Promise.all(promises);
    expect(rows('score.tier')).toHaveLength(1);
    expect(rows('score.tier')[0]).toMatchObject({ tier: 'live', binary: 'ouch', input_kind: 'install-command' });
    expect(points).toHaveLength(1);
    expect(points[0].blobs).toEqual(['install-command', 'cargo-binstall', null, 'live', null]);
    expect(points[0].doubles?.slice(1)).toEqual([100, 200, 200]);
    expect(points[0].indexes).toEqual(['ouch']);
  });

  test('a registry hit on the JSON path emits its score.tier line and analytics row from the request itself', async () => {
    const points: Array<{ blobs?: (string | null)[] }> = [];
    const env = makeEnv();
    env.SCORE_TELEMETRY = { writeDataPoint: (event) => void points.push(event) };
    const { ctx } = ctxWithPromises();
    const res = await handleAuditApi(jsonPost('ripgrep'), env, ctx, env._deps);
    expect(res.status).toBe(200);
    expect(rows('score.tier')).toHaveLength(1);
    expect(rows('score.tier')[0]).toMatchObject({ tier: 'curated', binary: 'rg', input_kind: 'slug' });
    expect(points[0].blobs).toEqual(['registry', null, null, 'registry-hit', 'registry']);
  });
});
