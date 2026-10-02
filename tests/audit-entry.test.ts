import { describe, expect, test } from 'bun:test';
import { followChoice, listingChoice } from '../src/client/audit-entry';

// The entry form's public-listing decision. The opt-in lives in the website
// pane, so only a visitor who chose that lane themselves can be said to have
// answered it; every other path sends no answer, and the server keeps
// whatever listing the site already has.

describe('listingChoice', () => {
  test('a visitor flipped to the website lane by the target shape sends no decision', () => {
    // They typed a domain on the CLI lane: the checkbox was never on screen,
    // so its unchecked state would otherwise post as an explicit false and
    // take a listed site off the public board.
    expect(listingChoice('cli', 'web', false, true)).toBeNull();
    expect(listingChoice('cli', 'web', true, true)).toBeNull();
  });

  test('a visitor on the website lane sends the box either way', () => {
    expect(listingChoice('web', 'web', true, true)).toBe(true);
    expect(listingChoice('web', 'web', false, true)).toBe(false);
  });

  test('a CLI run carries no listing at all', () => {
    expect(listingChoice('cli', 'cli', null, true)).toBeNull();
    expect(listingChoice('web', 'cli', true, true)).toBeNull();
  });

  test('a form without the checkbox sends no decision', () => {
    expect(listingChoice('web', 'web', null, true)).toBeNull();
  });
});

describe('followChoice', () => {
  test('only a visitor on the website lane who unticked the box opts out', () => {
    expect(followChoice('web', 'web', false)).toBe(false);
    expect(followChoice('web', 'web', true)).toBe(true);
  });

  test('a visitor who never saw the box follows: a flipped lane, a CLI run, or a form without it', () => {
    expect(followChoice('cli', 'web', false)).toBe(true);
    expect(followChoice('web', 'cli', false)).toBe(true);
    expect(followChoice('cli', 'cli', null)).toBe(true);
    expect(followChoice('web', 'web', null)).toBe(true);
  });
});

describe('listingChoice when following is off', () => {
  test('an opted-out run carries no listing, whatever the box says', () => {
    // The listing box is disabled while following is off; its state, even a
    // ticked box on a listed site, must not reach the server as a change.
    expect(listingChoice('web', 'web', true, false)).toBeNull();
    expect(listingChoice('web', 'web', false, false)).toBeNull();
  });
});
