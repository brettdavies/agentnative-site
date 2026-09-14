import { describe, expect, test } from 'bun:test';
import { listingChoice } from '../src/client/audit-entry';

// The entry form's public-listing decision. The opt-in lives in the website
// pane, so only a visitor who chose that lane themselves can be said to have
// answered it; every other path sends no answer, and the server keeps
// whatever listing the site already has.

describe('listingChoice', () => {
  test('a visitor flipped to the website lane by the target shape sends no decision', () => {
    // They typed a domain on the CLI lane: the checkbox was never on screen,
    // so its unchecked state would otherwise post as an explicit false and
    // take a listed site off the public board.
    expect(listingChoice('cli', 'web', false)).toBeNull();
    expect(listingChoice('cli', 'web', true)).toBeNull();
  });

  test('a visitor on the website lane sends the box either way', () => {
    expect(listingChoice('web', 'web', true)).toBe(true);
    expect(listingChoice('web', 'web', false)).toBe(false);
  });

  test('a CLI run carries no listing at all', () => {
    expect(listingChoice('cli', 'cli', null)).toBeNull();
    expect(listingChoice('web', 'cli', true)).toBeNull();
  });

  test('a form without the checkbox sends no decision', () => {
    expect(listingChoice('web', 'web', null)).toBeNull();
  });
});
