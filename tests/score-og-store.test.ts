// Stored scorecard cards in R2: one object per finished-score key, pruned so
// a target keeps its newest card even when two stores finish out of order.

import { describe, expect, test } from 'bun:test';
import { SCORE_OG_TEMPLATE } from '../src/shared/score-og';
import { readStoredCard, storeCard } from '../src/worker/og/store';

type Stored = { bytes: Uint8Array; meta: Record<string, string> };

/** An R2 stand-in that keeps custom metadata and returns it from list() only when asked, as R2 does. */
function bucket() {
  const objects = new Map<string, Stored>();
  const r2 = {
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      return { customMetadata: object.meta, arrayBuffer: async () => object.bytes.slice().buffer };
    },
    async put(key: string, value: Uint8Array, opts: { customMetadata?: Record<string, string> } = {}) {
      objects.set(key, { bytes: new Uint8Array(value), meta: opts.customMetadata ?? {} });
    },
    async list({ prefix, include }: { prefix: string; include?: string[] }) {
      const withMeta = include?.includes('customMetadata') ?? false;
      return {
        objects: [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, object]) => (withMeta ? { key, customMetadata: object.meta } : { key })),
      };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  return { objects, r2: r2 as unknown as R2Bucket };
}

const TARGET = 'anc.dev';
const OLDER = '2026-10-20T10:00:00.000Z';
const NEWER = '2026-10-26T10:00:00.000Z';
const OLD_KEY = 's70-v0.6.0-d20261020-r1';
const NEW_KEY = 's80-v0.6.0-d20261026-r1';

function storedKeys(objects: Map<string, Stored>): string[] {
  return [...objects.keys()].map((key) => key.slice(key.lastIndexOf('/') + 1)).sort();
}

describe('storeCard', () => {
  test('an older card stored after a newer one leaves the newer card in place', async () => {
    const { objects, r2 } = bucket();
    await storeCard(r2, TARGET, NEW_KEY, new Uint8Array([2]), { scoredAt: NEWER, logo: 'homepage' });
    await storeCard(r2, TARGET, OLD_KEY, new Uint8Array([1]), { scoredAt: OLDER, logo: 'homepage' });
    expect(storedKeys(objects)).toContain(`${NEW_KEY}.png`);
  });

  test('a newer card stored after an older one removes the older card', async () => {
    const { objects, r2 } = bucket();
    await storeCard(r2, TARGET, OLD_KEY, new Uint8Array([1]), { scoredAt: OLDER, logo: 'homepage' });
    await storeCard(r2, TARGET, NEW_KEY, new Uint8Array([2]), { scoredAt: NEWER, logo: 'homepage' });
    expect(storedKeys(objects)).toEqual([`${NEW_KEY}.png`]);
  });

  test('a card stored without a scored-at stamp counts as older than a stamped one', async () => {
    const { objects, r2 } = bucket();
    await storeCard(r2, TARGET, OLD_KEY, new Uint8Array([1]), { scoredAt: null, logo: 'tile' });
    await storeCard(r2, TARGET, NEW_KEY, new Uint8Array([2]), { scoredAt: NEWER, logo: 'homepage' });
    expect(storedKeys(objects)).toEqual([`${NEW_KEY}.png`]);
  });

  test('a card stored without a scored-at stamp deletes nothing', async () => {
    const { objects, r2 } = bucket();
    await storeCard(r2, TARGET, NEW_KEY, new Uint8Array([2]), { scoredAt: NEWER, logo: 'homepage' });
    await storeCard(r2, TARGET, OLD_KEY, new Uint8Array([1]), { scoredAt: null, logo: 'tile' });
    expect(storedKeys(objects)).toEqual([`${OLD_KEY}.png`, `${NEW_KEY}.png`]);
  });

  test('a stored card reads back with the logo source it was drawn with, and records its template', async () => {
    const { objects, r2 } = bucket();
    await storeCard(r2, TARGET, NEW_KEY, new Uint8Array([7, 8]), { scoredAt: NEWER, logo: 'brand' });
    expect(await readStoredCard(r2, TARGET, NEW_KEY)).toEqual({ png: new Uint8Array([7, 8]), logo: 'brand' });
    expect([...objects.values()][0]?.meta.template).toBe(String(SCORE_OG_TEMPLATE));
  });
});
