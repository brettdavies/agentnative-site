import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type ContainerControl, ContainerRuns } from '../src/worker/score/container-runs';
import { doError } from '../src/worker/score/core';
import type { InstallSpec } from '../src/worker/score/discover-binary';
import { Sandbox, type ScoreSandboxEnv, streamScore } from '../src/worker/score/do';
import { statusForError, toAuditError } from '../src/worker/score/response-shape';
import type { ScoreResult } from '../src/worker/score/sandbox-exec';
import { captureLogs, type LogCapture } from './helpers/log-capture';

const RESULT: ScoreResult = { ok: false, error: 'timeout' };
const SPEC: InstallSpec = { pm: 'cargo-binstall', package: 'ripgrep', binary: 'rg' };

function fakeContainer(overrides: Partial<ContainerControl> = {}) {
  const events: string[] = [];
  let running = false;
  const container: ContainerControl = {
    isRunning: () => running,
    start: async () => {
      events.push('start');
      running = true;
    },
    destroy: async () => {
      events.push('destroy');
      running = false;
    },
    ...overrides,
  };
  return { container, events };
}

function deferred() {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});

const sandboxRecords = () =>
  logs.records.filter((r) => r.record.scope === 'score.sandbox').map((r) => r.record as Record<string, unknown>);

describe('ContainerRuns: one container for one run', () => {
  test('a run starts its container before scoring and destroys it only after the result is out', async () => {
    const { container, events } = fakeContainer();
    const claim = new ContainerRuns(container).claim();
    const written = deferred();
    const settled = claim.settle(written.promise);

    const result = await claim.run(async () => {
      events.push('score');
      return RESULT;
    });

    expect(result).toEqual(RESULT);
    await flush();
    expect(events).toEqual(['start', 'score']);
    written.resolve();
    await settled;
    expect(events).toEqual(['start', 'score', 'destroy']);
  });

  test('two concurrent runs never share a container', async () => {
    const { container, events } = fakeContainer();
    const runs = new ContainerRuns(container);
    const first = runs.claim();
    const second = runs.claim();
    const firstWritten = deferred();
    const firstSettled = first.settle(firstWritten.promise);
    const secondRun = second.run(async () => {
      events.push('score-2');
      return RESULT;
    });
    const secondSettled = second.settle(secondRun.then(() => {}));

    await first.run(async () => {
      events.push('score-1');
      return RESULT;
    });
    await flush();
    expect(events).toEqual(['start', 'score-1']);

    firstWritten.resolve();
    await Promise.all([firstSettled, secondSettled]);
    expect(events).toEqual(['start', 'score-1', 'destroy', 'start', 'score-2', 'destroy']);
  });

  test('a run claimed during a teardown waits for that teardown', async () => {
    const destroying = deferred();
    let up = false;
    const { container, events } = fakeContainer({
      isRunning: () => up,
      start: async () => {
        events.push('start');
        up = true;
      },
      destroy: async () => {
        events.push('destroy-begin');
        await destroying.promise;
        up = false;
        events.push('destroy-end');
      },
    });
    const runs = new ContainerRuns(container);
    const first = runs.claim();
    await first.run(async () => RESULT);
    const firstSettled = first.settle(Promise.resolve());
    await flush();

    const secondRun = runs.claim().run(async () => {
      events.push('score');
      return RESULT;
    });
    await flush();
    expect(events).toEqual(['start', 'destroy-begin']);

    destroying.resolve();
    await Promise.all([firstSettled, secondRun]);
    expect(events).toEqual(['start', 'destroy-begin', 'destroy-end', 'start', 'score']);
  });

  test('a run that finds a container up destroys it before starting its own', async () => {
    const { container, events } = fakeContainer();
    await container.start();
    events.length = 0;

    await new ContainerRuns(container).claim().run(async () => {
      events.push('score');
      return RESULT;
    });

    expect(events).toEqual(['destroy', 'start', 'score']);
  });

  test('a container still up after its teardown fails the run and scores nothing', async () => {
    const { container, events } = fakeContainer({ isRunning: () => true, destroy: async () => {} });
    const claim = new ContainerRuns(container).claim();

    await expect(
      claim.run(async () => {
        events.push('score');
        return RESULT;
      }),
    ).rejects.toThrow('container still running');

    expect(events).toEqual([]);
  });

  test('a container still up reaches the caller as sandbox_exception', async () => {
    const { container } = fakeContainer({ isRunning: () => true, destroy: async () => {} });
    const claim = new ContainerRuns(container).claim();
    const { body, done } = streamScore(SPEC, {
      env: {} as ScoreSandboxEnv,
      run: () => claim.run(async () => RESULT),
      purge: async () => {},
    });

    const text = await new Response(body).text();
    await done;

    expect(JSON.parse(text.trim())).toEqual({ error: 'sandbox_exception' });
  });
});

describe('ContainerRuns: teardown never costs a run its result', () => {
  test('a teardown that throws keeps the result and logs once, and the next run refuses the container still up', async () => {
    const { container } = fakeContainer({
      destroy: async () => {
        throw new Error('destroy failed');
      },
    });
    const runs = new ContainerRuns(container);
    const claim = runs.claim();

    expect(await claim.run(async () => RESULT)).toEqual(RESULT);
    await claim.settle(Promise.resolve());

    expect(sandboxRecords().filter((r) => r.teardown_error === 'destroy failed')).toHaveLength(1);
    await expect(runs.claim().run(async () => RESULT)).rejects.toThrow('container still running');
  });

  test('a teardown that stalls is bounded, logs once, and frees the next run', async () => {
    let up = true;
    const { container, events } = fakeContainer({
      isRunning: () => up,
      start: async () => {
        events.push('start');
      },
      destroy: () => new Promise<void>(() => {}),
    });
    const runs = new ContainerRuns(container, 5);
    await runs.claim().settle(Promise.resolve());

    expect(sandboxRecords().filter((r) => typeof r.teardown_error === 'string')).toHaveLength(1);
    up = false;
    await runs.claim().run(async () => RESULT);
    expect(events).toEqual(['start']);
  });

  test('a failed run is still torn down', async () => {
    const { container, events } = fakeContainer();
    const claim = new ContainerRuns(container).claim();
    await claim.run(async () => RESULT);

    await claim.settle(Promise.reject(new Error('stream failed')));

    expect(events).toEqual(['start', 'destroy']);
  });
});

describe('ContainerRuns: the instance cap', () => {
  const capMessages = [
    'there is no container instance that can be provided to this durable object',
    'There is no container instance available at this time',
    'Maximum number of running container instances exceeded',
  ];

  for (const message of capMessages) {
    test(`"${message}" answers sandbox_busy, scores nothing, and logs the field`, async () => {
      const { container, events } = fakeContainer({
        start: async () => {
          throw new Error(message);
        },
      });

      const result = await new ContainerRuns(container).claim().run(async () => {
        events.push('score');
        return RESULT;
      });

      expect(result).toEqual({ ok: false, error: 'sandbox_busy' });
      expect(events).toEqual([]);
      expect(sandboxRecords().filter((r) => r.at_instance_cap === true)).toHaveLength(1);
    });
  }

  test('the cap is recognized through a wrapped cause', async () => {
    const { container } = fakeContainer({
      start: async () => {
        throw new Error('start failed', { cause: new Error('rpc failed', { cause: new Error(capMessages[0]) }) });
      },
    });

    expect(await new ContainerRuns(container).claim().run(async () => RESULT)).toEqual({
      ok: false,
      error: 'sandbox_busy',
    });
  });

  test('any other start failure stays an exception and carries no cap field', async () => {
    const { container, events } = fakeContainer({
      start: async () => {
        throw new Error('image pull failed');
      },
    });

    await expect(
      new ContainerRuns(container).claim().run(async () => {
        events.push('score');
        return RESULT;
      }),
    ).rejects.toThrow('image pull failed');

    expect(events).toEqual([]);
    expect(sandboxRecords().filter((r) => 'at_instance_cap' in r)).toEqual([]);
  });

  test('sandbox_busy keeps its code through doError and maps to 503 with the retry text', () => {
    const error = doError('sandbox_busy');
    expect(error.code).toBe('sandbox_busy');
    expect(statusForError(error)).toBe(503);
    expect(toAuditError(error).error).toMatchObject({
      code: 'sandbox_busy',
      message: 'The scoring sandbox is busy. Try again in a minute.',
    });
  });
});

describe('Sandbox: every audit goes through a claim', () => {
  type Harness = { runs: unknown; env: unknown; ctx: { waitUntil(promise: Promise<unknown>): void } };

  function post(): Request {
    return new Request('https://do.internal/score', {
      method: 'POST',
      body: JSON.stringify({ spec: SPEC, hash: 'beef' }),
    });
  }

  test('fetch runs the audit through its claim and settles the claim on the end of the stream', async () => {
    const events: string[] = [];
    const waited: Promise<unknown>[] = [];
    const harness: Harness = {
      runs: {
        claim: () => ({
          run: async () => {
            events.push('run');
            return { ok: false, error: 'sandbox_busy' };
          },
          settle: (done: Promise<void>) => done.then(() => void events.push('settle')),
        }),
      },
      env: {},
      ctx: { waitUntil: (promise) => void waited.push(promise) },
    };

    const res = await Sandbox.prototype.fetch.call(harness as unknown as Sandbox, post());
    const text = await res.text();
    await Promise.all(waited);

    expect(JSON.parse(text.trim())).toEqual({ error: 'sandbox_busy' });
    expect(events).toEqual(['run', 'settle']);
  });

  test('the Durable Object exposes no audit entry point outside fetch', () => {
    expect('score' in Sandbox.prototype).toBe(false);
  });
});
