// One audit's concurrency cap. A check holds a slot while it probes; a check
// gated without a request never takes one. Slots go out first come, first
// served, so what became ready first runs first.

export interface AuditSlots {
  /** `task` once a slot is free, holding that slot until it settles. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createAuditSlots(cap: number): AuditSlots {
  let free = cap;
  const waiting: Array<() => void> = [];
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (free > 0) {
        free -= 1;
        resolve();
      } else {
        waiting.push(resolve);
      }
    });
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else free += 1;
  };
  return {
    run: async (task) => {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}
