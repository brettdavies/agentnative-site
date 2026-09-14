import { describe, expect, test } from 'bun:test';
import { getSurface, setSurface } from '../src/client/surface';

function mockStorage() {
  const store = new Map<string, string>();
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
  });
  return {
    store,
    restore() {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    },
  };
}

describe('getSurface', () => {
  test('defaults to cli when storage is empty', () => {
    const ls = mockStorage();
    try {
      expect(getSurface()).toBe('cli');
    } finally {
      ls.restore();
    }
  });

  test('returns web when stored', () => {
    const ls = mockStorage();
    try {
      ls.store.set('anc-surface', 'web');
      expect(getSurface()).toBe('web');
    } finally {
      ls.restore();
    }
  });

  test('invalid values fall back to cli', () => {
    const ls = mockStorage();
    try {
      ls.store.set('anc-surface', 'nonsense');
      expect(getSurface()).toBe('cli');
    } finally {
      ls.restore();
    }
  });
});

describe('setSurface', () => {
  test('round-trips the stored preference the panes read', () => {
    // The header no longer follows the surface: one anchor per entry, and the
    // segment on the page swaps its panes. The preference is what a returning
    // visitor's pane selection restores from.
    const ls = mockStorage();
    try {
      setSurface('web');
      expect(getSurface()).toBe('web');
      setSurface('cli');
      expect(getSurface()).toBe('cli');
    } finally {
      ls.restore();
    }
  });
});
