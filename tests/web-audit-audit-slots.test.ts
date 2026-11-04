// One audit's slots: who a free slot goes to, and how a fan-out shares them.

import { describe, expect, test } from 'bun:test';
import { createAuditSlots } from '../src/worker/audit-web/audit-slots';

function deferred(): { done: Promise<void>; finish: () => void } {
  let finish = (): void => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { done, finish };
}

describe('the cap', () => {
  test.each([0, -1, Number.NaN, 1.5])('of %p is refused', (cap) => {
    expect(() => createAuditSlots(cap)).toThrow(RangeError);
  });
});

describe('a free slot', () => {
  test('goes to the lowest rank, and to the earliest within a rank', async () => {
    const slots = createAuditSlots(1);
    const hold = deferred();
    const started: string[] = [];
    const queued = [
      slots.run(() => hold.done, 0),
      ...(
        [
          ['row-5', 5],
          ['step-a', -2],
          ['row-3', 3],
          ['step-b', -2],
          ['source', -1],
        ] as const
      ).map(([name, rank]) =>
        slots.run(async () => {
          started.push(name);
        }, rank),
      ),
    ];
    hold.finish();
    await Promise.all(queued);
    expect(started).toEqual(['step-a', 'step-b', 'source', 'row-3', 'row-5']);
  });

  test('comes back when a task throws', async () => {
    const slots = createAuditSlots(1);
    await expect(slots.run(() => Promise.reject(new Error('task failed')), 0)).rejects.toThrow('task failed');
    expect(await slots.run(async () => 'ran', 0)).toBe('ran');
  });
});

describe('a fan-out', () => {
  const probing =
    (log: { inFlight: number; peak: number }, ms = 3) =>
    async (item: number) => {
      log.inFlight += 1;
      log.peak = Math.max(log.peak, log.inFlight);
      await Bun.sleep(ms);
      log.inFlight -= 1;
      return item * 2;
    };

  test.each([
    [1, 1],
    [2, 1],
    [3, 2],
    [6, 5],
  ])('at a cap of %d runs %d probes at once, which leaves a slot free above a cap of 1', async (cap, expected) => {
    const slots = createAuditSlots(cap);
    const log = { inFlight: 0, peak: 0 };
    const results = await slots.run(() => slots.fanOut([1, 2, 3, 4, 5, 6, 7, 8], probing(log)), 0);
    expect(log.peak).toBe(expected);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
  });

  test('never takes the last slot, so another check runs while its probes hang', async () => {
    const slots = createAuditSlots(3);
    const hung = deferred();
    const fan = slots.run(() => slots.fanOut([1, 2, 3, 4], () => hung.done), 0);
    await Bun.sleep(1);
    expect(await slots.run(async () => 'another check ran', 5)).toBe('another check ran');
    hung.finish();
    await fan;
  });

  test('joins behind ranked work, whatever its own check ranks', async () => {
    const slots = createAuditSlots(3);
    const hold = deferred();
    const order: string[] = [];
    const held = [slots.run(() => hold.done, 0), slots.run(() => hold.done, 0)];
    const fan = slots.run(
      () =>
        slots.fanOut(['a', 'b', 'c'], async (item) => {
          order.push(item);
          await Bun.sleep(5);
        }),
      0,
    );
    await Bun.sleep(1);
    const ranked = slots.run(async () => {
      order.push('ranked row');
    }, 50);
    hold.finish();
    await Promise.all([...held, fan, ranked]);
    expect(order.indexOf('ranked row')).toBeLessThan(order.indexOf('b'));
  });

  test('a helper gives its slot up between items, so ranked work that arrives meanwhile goes first', async () => {
    const slots = createAuditSlots(3);
    const order: string[] = [];
    const fan = slots.run(
      () =>
        slots.fanOut(['a', 'b', 'c', 'd'], async (item) => {
          order.push(item);
          await Bun.sleep(5);
        }),
      0,
    );
    await Bun.sleep(1);
    const blocker = slots.run(async () => {
      order.push('first ranked row');
      await Bun.sleep(10);
    }, 1);
    const ranked = slots.run(async () => {
      order.push('second ranked row');
    }, 2);
    await Promise.all([fan, blocker, ranked]);
    expect(order.indexOf('second ranked row')).toBeLessThan(order.indexOf('d'));
  });

  test('a helper that gets its slot after the items ran out gives it straight back', async () => {
    const slots = createAuditSlots(3);
    const hold = deferred();
    const held = [slots.run(() => hold.done, 0), slots.run(() => hold.done, 0)];
    await slots.run(() => slots.fanOut([1, 2], async (item) => item), 0);
    hold.finish();
    await Promise.all(held);
    await Bun.sleep(1);
    const log = { inFlight: 0, peak: 0 };
    await Promise.all([1, 2, 3].map((item) => slots.run(() => probing(log, 5)(item), 0)));
    expect(log.peak).toBe(3);
  });

  test('a probe that throws on a helper rejects it and every slot comes back', async () => {
    const slots = createAuditSlots(4);
    const rejected = slots.run(
      () =>
        slots.fanOut([1, 2, 3, 4], async (item) => {
          await Bun.sleep(item === 2 ? 1 : 3);
          if (item === 2) throw new Error('helper probe failed');
          return item;
        }),
      0,
    );
    await expect(rejected).rejects.toThrow('helper probe failed');
    await Bun.sleep(20);
    const log = { inFlight: 0, peak: 0 };
    await Promise.all([1, 2, 3, 4].map((item) => slots.run(() => probing(log, 5)(item), 0)));
    expect(log.peak).toBe(4);
  });

  test('a probe that throws rejects it and every slot comes back', async () => {
    const slots = createAuditSlots(3);
    await expect(
      slots.run(
        () =>
          slots.fanOut([1, 2, 3], async (item) => {
            await Bun.sleep(1);
            if (item === 1) throw new Error('probe failed');
            return item;
          }),
        0,
      ),
    ).rejects.toThrow('probe failed');
    await Bun.sleep(5);
    const log = { inFlight: 0, peak: 0 };
    await Promise.all([1, 2, 3].map((item) => slots.run(() => probing(log, 5)(item), 0)));
    expect(log.peak).toBe(3);
  });
});
