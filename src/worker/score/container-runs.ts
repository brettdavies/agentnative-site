// One audit per container. A run waits for every earlier run on its Durable
// Object, starts a container of its own, and destroys it once the result line
// is out, so nothing one run leaves behind reaches another.

import { withinMs } from '../../shared/within-ms';
import { emitLog } from '../telemetry/log';
import type { ContainerLike, ScoreResult } from './sandbox-exec';

// destroy() can hang on a container that is already wedged.
const DESTROY_TIMEOUT_MS = 15_000;

const INSTANCE_CAP_MESSAGE = 'maximum number of running container instances exceeded';
const NO_INSTANCE_MESSAGE = 'there is no container instance';

type StartRefusal = 'at_instance_cap' | 'no_container_instance';

export type ContainerControl = {
  isRunning(): boolean;
  start(): Promise<void>;
  destroy(): Promise<void>;
};

export type RunClaim = {
  /** Runs `score` in a new container once every earlier claim has settled. */
  run(score: () => Promise<ScoreResult>): Promise<ScoreResult>;
  /** `sandbox`, refusing every call once this claim's teardown has begun. */
  scoped(sandbox: ContainerLike): ContainerLike;
  /** Destroys that container after `done`, then lets the next claim start. */
  settle(done: Promise<void>): Promise<void>;
};

// The SDK wraps the platform's message in a cause chain, and the error can
// cross a realm, so this reads messages rather than testing `instanceof`. The
// SDK's no-instance message also covers a VM still provisioning, so only the
// platform's own text, anywhere in the chain, names the cap.
function startRefusal(error: unknown): StartRefusal | null {
  let refusal: StartRefusal | null = null;
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    const message = String((current as { message?: unknown }).message ?? current).toLowerCase();
    if (message.includes(INSTANCE_CAP_MESSAGE)) return 'at_instance_cap';
    if (message.includes(NO_INSTANCE_MESSAGE)) refusal = 'no_container_instance';
    current = (current as { cause?: unknown }).cause;
  }
  return refusal;
}

export class ContainerRuns {
  private last: Promise<void> = Promise.resolve();

  constructor(
    private readonly container: ContainerControl,
    private readonly destroyTimeoutMs: number = DESTROY_TIMEOUT_MS,
  ) {}

  claim(): RunClaim {
    const previous = this.last;
    let release = (): void => {};
    this.last = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The run's time limit abandons its promise without stopping it, and the
    // SDK starts a container for any call that finds none running.
    let over = false;
    const assertOpen = (): void => {
      if (over) throw new Error('run is over');
    };
    return {
      run: (score) => previous.then(() => this.startFresh(score)),
      scoped: (sandbox) => ({
        setOutboundHandler: async <P>(name: string, params?: P) => {
          assertOpen();
          await sandbox.setOutboundHandler(name, params);
        },
        exec: async (command, options) => {
          assertOpen();
          return sandbox.exec(command, options);
        },
      }),
      settle: (done) =>
        done
          .catch(() => {})
          .then(() => {
            over = true;
            return this.tearDown();
          })
          .finally(release),
    };
  }

  private async startFresh(score: () => Promise<ScoreResult>): Promise<ScoreResult> {
    if (this.container.isRunning()) {
      await this.tearDown();
      if (this.container.isRunning()) throw new Error('container still running after destroy');
    }
    try {
      await this.container.start();
    } catch (error) {
      const refusal = startRefusal(error);
      if (!refusal) throw error;
      emitLog({ scope: 'score.sandbox' }, { [refusal]: true });
      return { ok: false, error: 'sandbox_busy' };
    }
    return score();
  }

  private async tearDown(): Promise<void> {
    try {
      await withinMs(this.container.destroy(), this.destroyTimeoutMs);
    } catch (error) {
      emitLog({ scope: 'score.sandbox' }, { teardown_error: error instanceof Error ? error.message : String(error) });
    }
  }
}
