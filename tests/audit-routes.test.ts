// The shared route module is the one owner of funnel paths, target
// classification, normalization, and reserved names. Every row of the
// classification table is a fixture here, so a regression in the
// classifier shows up as a named row rather than as a wrong lane on a
// live page.

import { describe, expect, test } from 'bun:test';
import {
  API_SCORE_PATH,
  apiScorePath,
  auditPath,
  classifyTarget,
  damerauLevenshtein,
  fixPath,
  isAlwaysMissPath,
  isHitMinPath,
  isScorePath,
  leaderboardPath,
  normalizeTarget,
  RESERVED_NAMES,
  scoreJsonPath,
  scoreMarkdownPath,
  scorePath,
  scoringPath,
  splitRepresentation,
  suggestTargets,
  TARGET_MAX_LENGTH,
  targetOfSpec,
} from '../src/shared/audit-routes';
import { keyFor } from '../src/worker/score/cache';
import type { InstallSpec } from '../src/worker/score/discover-binary';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

function ok(raw: string) {
  const c = classifyTarget(raw);
  if (!c.ok) throw new Error(`expected ${JSON.stringify(raw)} to classify, got ${c.reason}`);
  return c;
}

function rejected(raw: string) {
  const c = classifyTarget(raw);
  if (c.ok) throw new Error(`expected ${JSON.stringify(raw)} to be rejected, got ${c.lane} ${c.target}`);
  return c;
}

describe('classifyTarget: the classification table', () => {
  test('a bare slug is CLI even though a single-label domain regex would accept it', () => {
    expect(ok('ripgrep')).toMatchObject({ lane: 'cli', kind: 'cli', target: 'ripgrep' });
  });

  test('install commands are CLI, kept as entered and trimmed', () => {
    expect(ok('cargo binstall ouch')).toMatchObject({ lane: 'cli', target: 'cargo binstall ouch' });
    expect(ok('  pip install some.pkg ')).toMatchObject({ lane: 'cli', target: 'pip install some.pkg' });
  });

  test('owner/repo and GitHub repo URLs are CLI, kept as entered and trimmed', () => {
    expect(ok('cli/cli')).toMatchObject({ lane: 'cli', kind: 'cli', target: 'cli/cli' });
    expect(ok(' https://github.com/cli/cli ')).toMatchObject({
      lane: 'cli',
      kind: 'cli',
      target: 'https://github.com/cli/cli',
    });
    expect(ok('github.com/cli/cli')).toMatchObject({ lane: 'cli', kind: 'cli', target: 'github.com/cli/cli' });
  });

  test('a /tree/<branch> URL and the owner/repo@branch form are branch-scoped CLI', () => {
    expect(ok('https://github.com/o/r/tree/feature/x')).toMatchObject({
      lane: 'cli',
      kind: 'cli-branch',
      target: 'o/r@feature/x',
      owner: 'o',
      repo: 'r',
      branch: 'feature/x',
    });
    expect(ok('o/r@feature/x')).toMatchObject({ kind: 'cli-branch', target: 'o/r@feature/x' });
    expect(ok('github.com/cli/cli/tree/main')).toMatchObject({ kind: 'cli-branch', target: 'cli/cli@main' });
  });

  test('a branch whose last segment is a reserved representation segment is rejected', () => {
    expect(rejected('o/r@release/json').reason).toBe('reserved_branch_segment');
    expect(rejected('o/r@md').reason).toBe('reserved_branch_segment');
    expect(rejected('https://github.com/o/r/tree/feature/html').reason).toBe('reserved_branch_segment');
  });

  test('a branch named release.json is accepted (a dot is not a segment boundary)', () => {
    expect(ok('o/r@release.json')).toMatchObject({ kind: 'cli-branch', target: 'o/r@release.json' });
  });

  test('a non-GitHub URL is a website normalized to its host', () => {
    expect(ok('https://example.com/docs')).toMatchObject({ lane: 'web', kind: 'web', target: 'example.com' });
    expect(ok('http://example.com/?q=1#x')).toMatchObject({ lane: 'web', target: 'example.com' });
  });

  test('hosts lowercase, punycode, keep the port, and drop path and query', () => {
    expect(ok('Example.COM:8443')).toMatchObject({ lane: 'web', target: 'example.com:8443' });
    expect(ok('bücher.de')).toMatchObject({ lane: 'web', target: 'xn--bcher-kva.de' });
    expect(ok('anc.dev/audit?x=1')).toMatchObject({ lane: 'web', target: 'anc.dev' });
    expect(ok('https://example.com:443/')).toMatchObject({ lane: 'web', target: 'example.com' });
  });

  test('a bare host with a dot is a website', () => {
    expect(ok('socket.io')).toMatchObject({ lane: 'web', target: 'socket.io' });
    expect(ok('foo.internal')).toMatchObject({ lane: 'web', target: 'foo.internal' });
  });

  test('IP literals and localhost are websites by shape; the server SSRF gate rejects them later', () => {
    expect(ok('10.0.0.1')).toMatchObject({ lane: 'web', target: '10.0.0.1' });
    expect(ok('localhost')).toMatchObject({ lane: 'web', target: 'localhost' });
    expect(ok('localhost:3000')).toMatchObject({ lane: 'web', target: 'localhost:3000' });
    expect(ok('[::1]')).toMatchObject({ lane: 'web', target: '[::1]' });
    expect(ok('::1')).toMatchObject({ lane: 'web', target: '[::1]' });
    expect(ok('0x7f000001')).toMatchObject({ lane: 'web', target: '127.0.0.1' });
    expect(ok('0177.0.0.1')).toMatchObject({ lane: 'web', target: '127.0.0.1' });
  });

  test('a TLD-shaped host is an ordinary website target', () => {
    expect(ok('defuddle.md')).toMatchObject({ lane: 'web', target: 'defuddle.md' });
    expect(ok('example.map')).toMatchObject({ lane: 'web', target: 'example.map' });
  });

  test('a URL whose host would re-classify as CLI is rejected so normalization stays idempotent', () => {
    expect(rejected('https://ripgrep').reason).toBe('invalid_target');
    expect(rejected('https://user:pw@example.com').reason).toBe('invalid_target');
    expect(rejected('javascript://example.com').reason).toBe('invalid_target');
  });

  test('a malformed GitHub URL is rejected rather than laned as a website', () => {
    expect(rejected('https://github.com/o/r/releases/download/x').reason).toBe('invalid_target');
    expect(rejected('https://github.com/o/r/tree/').reason).toBe('invalid_target');
    expect(rejected('o/r@../etc').reason).toBe('invalid_target');
  });

  test('a target longer than the bound is rejected before normalization; the bound itself is accepted', () => {
    const atBound = `https://github.com/o/r/tree/${'a'.repeat(TARGET_MAX_LENGTH - 'https://github.com/o/r/tree/'.length)}`;
    expect(atBound).toHaveLength(TARGET_MAX_LENGTH);
    expect(ok(atBound).kind).toBe('cli-branch');
    const over = `${atBound}a`;
    expect(over).toHaveLength(TARGET_MAX_LENGTH + 1);
    expect(rejected(over).reason).toBe('target_too_long');
    expect(rejected(`brew install ${'x'.repeat(TARGET_MAX_LENGTH)}`).reason).toBe('target_too_long');
  });

  test('empty and reserved inputs are rejected', () => {
    expect(rejected('').reason).toBe('target_empty');
    expect(rejected('   ').reason).toBe('target_empty');
    for (const name of RESERVED_NAMES) expect(rejected(name).reason).toBe('target_reserved');
  });

  test('classification is idempotent over its own normalized target', () => {
    for (const raw of [
      'ripgrep',
      'cargo binstall ouch',
      'https://github.com/o/r/tree/feature/x',
      'o/r@feature/x',
      'https://example.com/docs',
      'Example.COM:8443',
      'bücher.de',
      '0x7f000001',
      'defuddle.md',
    ]) {
      const first = ok(raw);
      const second = ok(first.target);
      expect(second).toEqual(first);
    }
  });

  test('normalizeTarget returns the normalized target or null', () => {
    expect(normalizeTarget('https://Example.com/x')).toBe('example.com');
    expect(normalizeTarget('o/r@md')).toBeNull();
  });
});

describe('splitRepresentation', () => {
  test('splits a trailing md or json segment and reads everything else as HTML', () => {
    expect(splitRepresentation('/score/anc.dev/json')).toEqual({ target: 'anc.dev', representation: 'json' });
    expect(splitRepresentation('/score/ripgrep/md')).toEqual({ target: 'ripgrep', representation: 'md' });
    expect(splitRepresentation('/score/defuddle.md')).toEqual({ target: 'defuddle.md', representation: 'html' });
    expect(splitRepresentation('/score/o/r@feature/x')).toEqual({ target: 'o/r@feature/x', representation: 'html' });
    expect(splitRepresentation('/score/o/r@feature/x/json')).toEqual({
      target: 'o/r@feature/x',
      representation: 'json',
    });
  });

  test('a lone reserved segment is a target, not a representation', () => {
    expect(splitRepresentation('/score/md')).toEqual({ target: 'md', representation: 'html' });
  });

  test('returns null off the namespace and on empty segments', () => {
    expect(splitRepresentation('/scorecards')).toBeNull();
    expect(splitRepresentation('/score/')).toBeNull();
    expect(splitRepresentation('/score')).toBeNull();
    expect(splitRepresentation('/score/anc.dev/')).toBeNull();
    expect(splitRepresentation('/score//x')).toBeNull();
  });

  test('decodes percent-encoded segments', () => {
    expect(splitRepresentation('/score/o/r%40feature')).toEqual({ target: 'o/r@feature', representation: 'html' });
  });
});

describe('path builders', () => {
  test('result paths round-trip through the splitter', () => {
    for (const target of ['ripgrep', 'anc.dev', 'example.com:8443', 'o/r@feature/x', 'xn--bcher-kva.de']) {
      expect(splitRepresentation(scorePath(target))).toEqual({ target, representation: 'html' });
      expect(splitRepresentation(scoreMarkdownPath(target))).toEqual({ target, representation: 'md' });
      expect(splitRepresentation(scoreJsonPath(target))).toEqual({ target, representation: 'json' });
    }
    expect(scorePath('o/r@feature/x')).toBe('/score/o/r@feature/x');
    expect(scoreJsonPath('anc.dev')).toBe('/score/anc.dev/json');
  });

  test('reserved names and reserved trailing segments cannot be produced as a result path', () => {
    for (const name of RESERVED_NAMES) expect(() => scorePath(name)).toThrow(RangeError);
    expect(() => scorePath('o/r@release/json')).toThrow(RangeError);
    expect(() => scorePath('')).toThrow(RangeError);
  });

  test('the progress page path carries the target and an optional refresh flag', () => {
    expect(scoringPath()).toBe('/scoring');
    expect(scoringPath('anc.dev')).toBe('/scoring?target=anc.dev');
    expect(scoringPath('o/r@feature/x')).toBe('/scoring?target=o/r@feature/x');
    expect(scoringPath('cargo binstall ouch')).toBe('/scoring?target=cargo%20binstall%20ouch');
    expect(scoringPath('ouch', { refresh: true })).toBe('/scoring?target=ouch&refresh=1');
    const url = new URL(scoringPath('o/r@feature/x'), 'https://anc.dev');
    expect(url.searchParams.get('target')).toBe('o/r@feature/x');
  });

  test('the audit page path is the prefill-only GET shape', () => {
    expect(auditPath()).toBe('/audit');
    expect(auditPath({ lane: 'web', target: 'anc.dev' })).toBe('/audit?lane=web&target=anc.dev');
    expect(auditPath({ lane: 'cli' })).toBe('/audit?lane=cli');
  });

  test('the leaderboard path carries lane and view deep links', () => {
    expect(leaderboardPath()).toBe('/scorecards');
    expect(leaderboardPath({ lane: 'web' })).toBe('/scorecards?lane=web');
    expect(leaderboardPath({ lane: 'web', view: 'all' })).toBe('/scorecards?lane=web&view=all');
  });

  test('fix-skill pages live under /fix/', () => {
    expect(fixPath('llms-txt')).toBe('/fix/llms-txt');
    expect(() => fixPath('')).toThrow(RangeError);
  });

  test('the transact endpoint path keeps the operator hatch', () => {
    expect(API_SCORE_PATH).toBe('/api/score');
    expect(apiScorePath()).toBe('/api/score');
    expect(apiScorePath({ fromCache: false })).toBe('/api/score?fromCache=false');
  });
});

describe('pathname predicates', () => {
  test('the progress page is always MISS; the boards and the homepage are HIT-min', () => {
    expect(isAlwaysMissPath('/scoring')).toBe(true);
    expect(isAlwaysMissPath('/scoring.md')).toBe(true);
    expect(isAlwaysMissPath('/score/ripgrep')).toBe(false);
    expect(isHitMinPath('/')).toBe(true);
    expect(isHitMinPath('/index.md')).toBe(true);
    expect(isHitMinPath('/scorecards')).toBe(true);
    expect(isHitMinPath('/scorecards.md')).toBe(true);
    expect(isHitMinPath('/audit')).toBe(false);
    expect(isScorePath('/score/anc.dev')).toBe(true);
    expect(isScorePath('/scorecards')).toBe(false);
  });
});

describe('suggestTargets', () => {
  test('a transposition suggests the curated slug first', () => {
    expect(suggestTargets('ripgrpe', ['ouch', 'ripgrep', 'anc'])).toEqual(['ripgrep']);
  });

  test('a dropped character suggests the seeded host', () => {
    expect(suggestTargets('anc.dv', ['anc.dev', 'example.com'])).toEqual(['anc.dev']);
  });

  test('a four-character target allows one edit, so two edits return nothing', () => {
    expect(suggestTargets('abcd', ['abxy'])).toEqual([]);
    expect(suggestTargets('abcd', ['abce'])).toEqual(['abce']);
  });

  test('a host never suggests a slug and an exact match is excluded', () => {
    expect(suggestTargets('anc.de', ['ancdev', 'anc.dev'])).toEqual(['anc.dev']);
    expect(suggestTargets('ripgrep', ['ripgrep', 'ripgrep2'])).toEqual(['ripgrep2']);
  });

  test('top three by distance then length', () => {
    expect(suggestTargets('abcde', ['abcdefg', 'abcdee', 'xbcde', 'abcd'])).toEqual(['abcd', 'xbcde', 'abcdee']);
  });

  test('the distance function is never called for a candidate whose length differs by more than the bound', () => {
    const seen: string[] = [];
    const spy = (a: string, b: string): number => {
      seen.push(b);
      return damerauLevenshtein(a, b);
    };
    suggestTargets('ripgrpe', ['ripgrep', 'ripgrep-all-the-things', 'rg', 'ripgrepx'], { distance: spy });
    expect(seen).toEqual(['ripgrep', 'ripgrepx']);
  });

  test('the scan stops once three distance-one matches exist', () => {
    const seen: string[] = [];
    const spy = (a: string, b: string): number => {
      seen.push(b);
      return damerauLevenshtein(a, b);
    };
    const out = suggestTargets('abcde', ['abcdf', 'abcdg', 'abcdh', 'abcdi'], { distance: spy });
    expect(out).toEqual(['abcdf', 'abcdg', 'abcdh']);
    expect(seen).toEqual(['abcdf', 'abcdg', 'abcdh']);
  });

  test('damerauLevenshtein counts an adjacent transposition as one edit', () => {
    expect(damerauLevenshtein('ripgrpe', 'ripgrep')).toBe(1);
    expect(damerauLevenshtein('abc', 'abc')).toBe(0);
    expect(damerauLevenshtein('', 'abc')).toBe(3);
    expect(damerauLevenshtein('kitten', 'sitting')).toBe(3);
  });
});

describe('targetOfSpec', () => {
  const pmSpec: InstallSpec = { pm: 'cargo-binstall', package: 'ouch', binary: 'ouch' };
  const directSpec: InstallSpec = { pm: 'direct', url: 'https://x/y.tar.gz', binary: 'yy' };
  const cloneSpec: InstallSpec = { pm: 'git-clone', owner: 'o', repo: 'r', branch: 'feature/x', binary: 'r' };

  test('a package-manager or direct spec targets its binary; a git-clone spec targets owner/repo@branch', () => {
    expect(targetOfSpec(pmSpec)).toBe('ouch');
    expect(targetOfSpec(directSpec)).toBe('yy');
    expect(targetOfSpec(cloneSpec)).toBe('o/r@feature/x');
  });

  test('the route target and the R2 key derive from one string for both families', () => {
    for (const spec of [pmSpec, cloneSpec]) {
      const target = targetOfSpec(spec);
      expect(splitRepresentation(scorePath(target))?.target).toBe(target);
      expect(keyFor(target, SPEC_VERSION)).toBe(`scores/${target}/${SPEC_VERSION}.json`);
    }
  });
});
