// One audit per container. A run waits for every earlier run on its Durable
// Object, starts a container of its own, and destroys it once the result line
// is out, so nothing one run leaves behind reaches another.

import { withinMs } from '../../shared/within-ms';
import { emitLog } from '../telemetry/log';
import type { ScoreResult } from './sandbox-exec';

// destroy() can hang on a container that is already wedged.
const DESTROY_TIMEOUT_MS = 15_000;

const INSTANCE_CAP_MESSAGES = [
  'there is no container instance',
  'maximum number of running container instances exceeded',
];

export type ContainerControl = {
  isRunning(): boolean;
  start(): Promise<void>;
  destroy(): Promise<void>;
};

export type RunClaim = {
  /** Runs `score` in a new container once every earlier claim has settled. */
  run(score: () => Promise<ScoreResult>): Promise<ScoreResult>;
  /** Destroys that container after `done`, then lets the next claim start. */
  settle(done: Promise<void>): Promise<void>;
};

// The SDK wraps the platform's message in a cause chain, and the error can
// cross a realm, so this reads messages rather than testing `instanceof`.
function atInstanceCap(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    const message = String((current as { message?: unknown }).message ?? current).toLowerCase();
    if (INSTANCE_CAP_MESSAGES.some((signature) => message.includes(signature))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
    return {
      run: (score) => previous.then(() => this.startFresh(score)),
      settle: (done) =>
        done
          .catch(() => {})
          .then(() => this.tearDown())
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
      if (!atInstanceCap(error)) throw error;
      emitLog({ scope: 'score.sandbox' }, { at_instance_cap: true });
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
