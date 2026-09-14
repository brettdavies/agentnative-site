// The pre-paint lane bridge. The pane radios live in the body, so a head
// script cannot check one; it sets the stored surface on <html> and the CSS
// answers that until surface.ts has the radios, then deletes it. These pin
// both halves: what the script writes, and that nothing is left behind to
// overrule a later selection.

import { describe, expect, test } from 'bun:test';

type Doc = { documentElement: { dataset: Record<string, string | undefined> } };

function fakeDocument(): Doc {
  return { documentElement: { dataset: {} } };
}

// The module reads globals at import time, so each case installs its own and
// re-imports with a cache-busting query.
async function runLaneInit(opts: { search: string; stored: string | null; throws?: boolean }): Promise<Doc> {
  const doc = fakeDocument();
  // Capture descriptors, not values. These globals are absent in this runtime,
  // so assigning a captured `undefined` back leaves them defined-as-undefined,
  // and every later suite in the same process that expects them missing breaks.
  const keys = ['document', 'location', 'localStorage'] as const;
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const install = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };

  install('document', doc);
  install('location', { search: opts.search });
  install('localStorage', {
    getItem(key: string) {
      if (opts.throws) throw new Error('storage blocked');
      return key === 'anc-surface' ? opts.stored : null;
    },
  });
  try {
    await import(
      `../src/client/lane-init.ts?case=${encodeURIComponent(`${opts.search}|${opts.stored}|${opts.throws}`)}`
    );
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
  return doc;
}

describe('lane-init: what the pre-paint script writes', () => {
  test('a stored website surface opens the website pane before the radios exist', async () => {
    const doc = await runLaneInit({ search: '', stored: 'web' });
    expect(doc.documentElement.dataset.surface).toBe('web');
  });

  test('a stored CLI surface writes nothing: CLI is the markup default', async () => {
    const doc = await runLaneInit({ search: '', stored: 'cli' });
    expect(doc.documentElement.dataset.surface).toBeUndefined();
  });

  test('no stored surface writes nothing', async () => {
    const doc = await runLaneInit({ search: '', stored: null });
    expect(doc.documentElement.dataset.surface).toBeUndefined();
  });

  test('an explicit lane in the URL wins over the stored surface', async () => {
    // The Worker has already checked the radio the link names, and an
    // explicit link beats a remembered preference.
    const doc = await runLaneInit({ search: '?lane=cli', stored: 'web' });
    expect(doc.documentElement.dataset.surface).toBeUndefined();

    const alsoWeb = await runLaneInit({ search: '?lane=web', stored: 'web' });
    expect(alsoWeb.documentElement.dataset.surface).toBeUndefined();
  });

  test('blocked storage leaves the CLI default standing rather than throwing', async () => {
    const doc = await runLaneInit({ search: '', stored: 'web', throws: true });
    expect(doc.documentElement.dataset.surface).toBeUndefined();
  });
});
