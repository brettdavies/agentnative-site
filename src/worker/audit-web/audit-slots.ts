// One audit's concurrency cap. A check holds a slot while it probes; a check
// gated without a request never takes one. A free slot goes to the waiter that
// ranks first, earliest first within a rank, so what other work waits on goes
// ahead of what waits on it. Rank orders only what is waiting: a low-ranked row
// that became ready first keeps the slot it took.

/** `probe` over `items`, results in item order however the probes finish. */
export type FanOut = <T, R>(items: readonly T[], probe: (item: T) => Promise<R>) => Promise<R[]>;

export interface AuditSlots {
  /** `task` once a slot is free, holding that slot until it settles. A lower rank goes first. */
  run<T>(task: () => Promise<T>, rank: number): Promise<T>;
  /**
   * For a check already holding a slot: probes on that slot, joined by others
   * as they free once no ranked work is waiting. It never waits on a slot it
   * does not yet have, so a check finishes on its own slot at any cap, and it
   * always leaves one slot free, so hung probes cannot stall every other check.
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
  // At a cap of 0 nothing would ever run, and the audit would wait on it forever.
  if (cap < 1) throw new RangeError(`concurrency must be at least 1, got ${cap}`);
  let free = cap;
  const waiting: Array<{ rank: number; resume: () => void }> = [];
  const acquire = (rank: number): Promise<void> =>
    new Promise((resume) => {
      if (free > 0) {
        free -= 1;
        resume();
        return;
      }
      const after = waiting.findIndex((waiter) => waiter.rank > rank);
      waiting.splice(after === -1 ? waiting.length : after, 0, { rank, resume });
    });
  const release = (): void => {
    const next = waiting.shift();
    if (next) next.resume();
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
      await acquire(Number.POSITIVE_INFINITY);
      if (next >= items.length) {
        release();
        return;
      }
      const helper = drain().finally(release);
      // Awaited below once the caller's own drain ends; a failure before then is not unhandled.
      helper.catch(() => {});
      joined.add(helper);
    };
    // The caller's slot plus these, which leaves one for every other check.
    const helpers = Math.min(items.length - 1, Math.max(0, cap - 2));
    for (let i = 0; i < helpers; i += 1) void join();
    await drain();
    await Promise.all(joined);
    return results;
  };
  return {
    run: async (task, rank) => {
      await acquire(rank);
      try {
        return await task();
      } finally {
        release();
      }
    },
    fanOut,
  };
}
