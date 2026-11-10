// A scorecard page's address is what its link to the audited site sends as the
// referrer. dropScoreQuery clears every query parameter on a result path and
// leaves the path and fragment; any other page keeps its own query, because
// /scoring and the entry pages read theirs.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { dropScoreQuery } from '../src/client/score-address';

type Replace = [unknown, string, string | URL | null | undefined];

function load(pathname: string, search: string, hash = '', state: unknown = null): Replace[] {
  const replaced: Replace[] = [];
  const holder = globalThis as { location?: unknown; history?: unknown };
  const saved = { location: holder.location, history: holder.history };
  holder.location = { pathname, search, hash };
  holder.history = { state, replaceState: (...args: Replace) => replaced.push(args) };
  try {
    dropScoreQuery();
  } finally {
    Object.assign(holder, saved);
  }
  return replaced;
}

describe('a result path', () => {
  test('inbound tracking parameters are cleared and the fragment is kept', () => {
    const replaced = load('/score/ripgrep', '?utm_source=x&fbclid=y', '#some-anchor');
    expect(replaced).toHaveLength(1);
    expect(replaced[0][2]).toBe('/score/ripgrep#some-anchor');
  });

  test('a ?v= forwarding query is cleared the same way', () => {
    const replaced = load('/score/anc.dev', '?v=2026-09-10T12%3A00%3A00.000Z');
    expect(replaced).toHaveLength(1);
    expect(replaced[0][2]).toBe('/score/anc.dev');
  });

  test('the history state passes through unchanged', () => {
    const state = { kept: true };
    expect(load('/score/ripgrep', '?gclid=z', '', state)[0][0]).toBe(state);
  });

  test('an address without a query is not rewritten', () => {
    expect(load('/score/ripgrep', '', '#some-anchor')).toEqual([]);
  });
});

describe('any other page', () => {
  test.each([
    ['/scoring', '?target=anc.dev'],
    ['/scorecards', '?lane=web'],
    ['/audit', '?lane=web'],
    ['/', '?utm_source=x'],
    ['/scoreboard', '?x=1'],
  ])('%s%s keeps its query', (pathname, search) => {
    expect(load(pathname, search)).toEqual([]);
  });
});

describe('the surface.js bundle', () => {
  test('clears the query when a result page loads it', async () => {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, '../src/client/surface.ts')],
      target: 'browser',
      format: 'iife',
    });
    expect(built.success).toBe(true);
    const source = await built.outputs[0].text();

    const replaced: Replace[] = [];
    const document = {
      readyState: 'interactive',
      documentElement: { dataset: {} },
      getElementById: () => null,
      querySelector: () => null,
      addEventListener: () => {},
    };
    const location = { pathname: '/score/ripgrep', search: '?utm_source=x&fbclid=y', hash: '#some-anchor' };
    const history = { state: null, replaceState: (...args: Replace) => replaced.push(args) };
    const localStorage = { getItem: () => null, setItem: () => {} };
    new Function('document', 'location', 'history', 'localStorage', source)(document, location, history, localStorage);

    expect(replaced.map((args) => args[2])).toEqual(['/score/ripgrep#some-anchor']);
  });
});
