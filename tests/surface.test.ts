import { describe, expect, test } from 'bun:test';
import { auditHref, getSurface, leaderboardsHref, setSurface } from '../src/client/surface';

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

describe('leaderboardsHref', () => {
  test('maps cli to /scorecards and web to /web', () => {
    const ls = mockStorage();
    try {
      expect(leaderboardsHref()).toBe('/scorecards');
      setSurface('web');
      expect(leaderboardsHref()).toBe('/web');
    } finally {
      ls.restore();
    }
  });
});

describe('auditHref', () => {
  test('maps cli to /audit and web to /web-audit', () => {
    const ls = mockStorage();
    try {
      expect(auditHref()).toBe('/audit');
      setSurface('web');
      expect(auditHref()).toBe('/web-audit');
    } finally {
      ls.restore();
    }
  });
});
