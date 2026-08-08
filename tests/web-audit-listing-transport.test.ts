// Client transport contract for the web form's public_listing choice.
//
// The server treats an omitted public_listing as "preserve the stored
// choice" while an explicit false erases an opt-in, so the client must
// send the boolean only when a real form submit stashed one and omit the
// field entirely on a direct /web/scoring/<host> visit. These tests pin
// that omit-vs-false line and the sessionStorage stash round-trip.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { buildAuditWebBody, stashPublicListing, takePublicListing } from '../src/client/web-audit-listing';

const HOST = 'example.com';
const STASH_KEY = `web-audit-listing:${HOST}`;

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const realSessionStorage: Storage | undefined = (globalThis as { sessionStorage?: Storage }).sessionStorage;

beforeEach(() => {
  (globalThis as { sessionStorage?: Storage }).sessionStorage = makeStorage();
});

afterAll(() => {
  (globalThis as { sessionStorage?: Storage }).sessionStorage = realSessionStorage;
});

describe('buildAuditWebBody', () => {
  test('an explicit true rides the body', () => {
    const body = buildAuditWebBody('https://example.com/', 'tok', true);
    expect(body.public_listing).toBe(true);
    expect(JSON.stringify(body)).toContain('"public_listing":true');
  });

  test('an explicit false rides the body (a real unchecked submit opts out)', () => {
    const body = buildAuditWebBody('https://example.com/', 'tok', false);
    expect(body.public_listing).toBe(false);
    expect(JSON.stringify(body)).toContain('"public_listing":false');
  });

  test('no stashed choice omits the field entirely, never sending false', () => {
    const body = buildAuditWebBody('https://example.com/', 'tok', null);
    expect('public_listing' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('public_listing');
  });

  test('url and turnstile_token are always present', () => {
    const body = buildAuditWebBody('https://example.com/', 'tok', null);
    expect(body.url).toBe('https://example.com/');
    expect(body.turnstile_token).toBe('tok');
  });
});

describe('stash/take round-trip', () => {
  test('a stashed true comes back true', () => {
    stashPublicListing(HOST, true);
    expect(takePublicListing(HOST)).toBe(true);
  });

  test('a stashed false comes back false, distinct from no stash', () => {
    stashPublicListing(HOST, false);
    expect(takePublicListing(HOST)).toBe(false);
  });

  test('no stash yields null', () => {
    expect(takePublicListing(HOST)).toBe(null);
  });

  test('take is single-use', () => {
    stashPublicListing(HOST, true);
    takePublicListing(HOST);
    expect(takePublicListing(HOST)).toBe(null);
  });

  test('the stash is keyed by host', () => {
    stashPublicListing(HOST, true);
    expect(takePublicListing('other.example')).toBe(null);
    expect(takePublicListing(HOST)).toBe(true);
  });

  test('a stale entry is discarded', () => {
    sessionStorage.setItem(STASH_KEY, JSON.stringify({ value: true, ts: Date.now() - 300_000 }));
    expect(takePublicListing(HOST)).toBe(null);
  });

  test('a corrupt entry is discarded', () => {
    sessionStorage.setItem(STASH_KEY, 'not json');
    expect(takePublicListing(HOST)).toBe(null);
  });

  test('a wrongly-typed entry is discarded', () => {
    sessionStorage.setItem(STASH_KEY, JSON.stringify({ value: 'true', ts: Date.now() }));
    expect(takePublicListing(HOST)).toBe(null);
  });
});
