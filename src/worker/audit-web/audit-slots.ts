// One audit's concurrency cap. A check holds a slot while it probes; a check
// gated without a request never takes one. Slots go out first come, first
// served, so what became ready first runs first.

/** `probe` over `items`, results in item order however the probes finish. */
export type FanOut = <T, R>(items: readonly T[], probe: (item: T) => Promise<R>) => Promise<R[]>;

export interface AuditSlots {
  /** `task` once a slot is free, holding that slot until it settles. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /**
   * For a check already holding a slot: probes on that slot, joined by any
   * other that frees while items remain. It never waits on a slot it does not
   * yet have, so a check always finishes on its own slot at a cap of 1.
   */
  fanOut: FanOut;
}

/** A fan-out for a caller with no slots to share. */
export const oneAtATime: FanOut = async (items, probe) => {
  const results = [];
  for (const item of items) results.push(await probe(item));
  return results;
};

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
  const fanOut: FanOut = async <T, R>(items: readonly T[], probe: (item: T) => Promise<R>) => {
    const results = new Array<R>(items.length);
    let next = 0;
    const drain = async (): Promise<void> => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await probe(items[index]);
      }
    };
    const joined = new Set<Promise<void>>();
    const join = async (): Promise<void> => {
      await acquire();
      if (next >= items.length) {
        release();
        return;
      }
      const helper = drain().finally(release);
      // Awaited below once the caller's own drain ends; a failure before then is not unhandled.
      helper.catch(() => {});
      joined.add(helper);
    };
    for (let i = 1; i < items.length; i += 1) void join();
    await drain();
    await Promise.all(joined);
    return results;
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
    fanOut,
  };
}
