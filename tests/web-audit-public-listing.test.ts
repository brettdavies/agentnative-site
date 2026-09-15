// The listing-write decision is a pure function over the request's explicit
// choice and the stored record: which of serve / patch / audit a call takes,
// and whether that write changes the stored flag. It is the one gate both the
// transact endpoint and the MCP tool meter a flip against, so it is pinned
// here rather than through either caller.

import { describe, expect, test } from 'bun:test';
import type { CachedWebAudit } from '../src/worker/audit-web/cache';
import { decidePublicListingWrite } from '../src/worker/audit-web/public-listing';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

describe('decidePublicListingWrite', () => {
  const TARGET = 'https://example.com/';
  const FRESH = new Date().toISOString();
  const STALE = new Date(Date.now() - 10 * 60_000).toISOString();

  function entry(scoredAt: string, stored?: boolean): CachedWebAudit {
    const scorecard: Record<string, unknown> = {
      schema_version: '0.2',
      target_url: TARGET,
      score_pct: 50,
      results: [],
    };
    if (stored !== undefined) scorecard.public_listing = stored;
    return { spec_version: SPEC_VERSION, target_url: TARGET, scorecard, scored_at: scoredAt };
  }

  test('first-ever miss: omit and false audit to false; true audits to true', () => {
    expect(decidePublicListingWrite({ explicit: undefined, cached: null })).toEqual({
      path: 'audit',
      value: false,
      flagChanges: false,
    });
    expect(decidePublicListingWrite({ explicit: false, cached: null })).toEqual({
      path: 'audit',
      value: false,
      flagChanges: false,
    });
    expect(decidePublicListingWrite({ explicit: true, cached: null })).toEqual({
      path: 'audit',
      value: true,
      flagChanges: true,
    });
  });

  test('fresh hit: omit serves cached for stored true, false, and absent', () => {
    for (const stored of [true, false, undefined] as const) {
      const cached = entry(FRESH, stored);
      expect(decidePublicListingWrite({ explicit: undefined, cached })).toEqual({
        path: 'serve-cached',
        flagChanges: false,
      });
    }
  });

  test('fresh hit: an explicit value matching a concrete stored value serves cached', () => {
    expect(decidePublicListingWrite({ explicit: true, cached: entry(FRESH, true) })).toEqual({
      path: 'serve-cached',
      flagChanges: false,
    });
    expect(decidePublicListingWrite({ explicit: false, cached: entry(FRESH, false) })).toEqual({
      path: 'serve-cached',
      flagChanges: false,
    });
  });

  test('fresh hit: a differing explicit value patches (stored F/absent -> T)', () => {
    for (const stored of [false, undefined] as const) {
      const cached = entry(FRESH, stored);
      const d = decidePublicListingWrite({ explicit: true, cached });
      expect(d.path).toBe('patch');
      if (d.path === 'patch') {
        expect(d.value).toBe(true);
        expect(d.flagChanges).toBe(true);
        expect(d.cached).toBe(cached);
      }
    }
  });

  test('fresh hit: a differing explicit value patches (stored T/absent -> F)', () => {
    for (const stored of [true, undefined] as const) {
      const cached = entry(FRESH, stored);
      const d = decidePublicListingWrite({ explicit: false, cached });
      expect(d.path).toBe('patch');
      if (d.path === 'patch') {
        expect(d.value).toBe(false);
        expect(d.cached).toBe(cached);
      }
    }
  });

  test('stale hit: omit carries the prior stored value (never erases)', () => {
    expect(decidePublicListingWrite({ explicit: undefined, cached: entry(STALE, true) })).toEqual({
      path: 'audit',
      value: true,
      flagChanges: false,
    });
    expect(decidePublicListingWrite({ explicit: undefined, cached: entry(STALE, false) })).toEqual({
      path: 'audit',
      value: false,
      flagChanges: false,
    });
  });

  test('stale hit with no stored flag: omit assumes false', () => {
    expect(decidePublicListingWrite({ explicit: undefined, cached: entry(STALE, undefined) })).toEqual({
      path: 'audit',
      value: false,
      flagChanges: false,
    });
  });

  test('stale hit: an explicit value wins and marks a flip when it differs', () => {
    expect(decidePublicListingWrite({ explicit: false, cached: entry(STALE, true) })).toEqual({
      path: 'audit',
      value: false,
      flagChanges: true,
    });
    expect(decidePublicListingWrite({ explicit: true, cached: entry(STALE, false) })).toEqual({
      path: 'audit',
      value: true,
      flagChanges: true,
    });
    expect(decidePublicListingWrite({ explicit: true, cached: entry(STALE, true) })).toEqual({
      path: 'audit',
      value: true,
      flagChanges: false,
    });
  });
});
