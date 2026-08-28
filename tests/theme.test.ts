import { describe, expect, test } from 'bun:test';
import { effectiveTheme, oppositeTheme } from '../src/client/theme';

describe('oppositeTheme', () => {
  test('swaps light ↔ dark', () => {
    expect(oppositeTheme('light')).toBe('dark');
    expect(oppositeTheme('dark')).toBe('light');
  });
});

describe('effectiveTheme', () => {
  test('honors a stored light or dark preference', () => {
    const store = new Map<string, string>([['theme', 'dark']]);
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    });
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false }),
    });
    try {
      expect(effectiveTheme()).toBe('dark');
      store.set('theme', 'light');
      expect(effectiveTheme()).toBe('light');
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
  });

  test('falls back to prefers-color-scheme when unset', () => {
    const originalLs = globalThis.localStorage;
    const originalMm = globalThis.matchMedia;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
    });
    try {
      Object.defineProperty(globalThis, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: true }),
      });
      expect(effectiveTheme()).toBe('dark');
      Object.defineProperty(globalThis, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: false }),
      });
      expect(effectiveTheme()).toBe('light');
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLs });
      Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: originalMm });
    }
  });
});
