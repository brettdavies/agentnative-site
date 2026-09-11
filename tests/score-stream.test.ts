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
