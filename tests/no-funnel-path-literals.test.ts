// Source-level guard: every audit-funnel path literal outside the shared
// route module is a place a rename can miss. The guard scans src/ for
// retired and current funnel paths and fails on any hit. Gate mode is the
// default; FUNNEL_PATH_GUARD_MODE=warn downgrades it to a report of every
// hit at once, which is what a sweep wants and a build never does.

import { describe, expect, test } from 'bun:test';
import {
  API_SCORE_PATH,
  AUDIT_PATH,
  FIX_PREFIX,
  SCORE_PREFIX,
  SCORECARDS_PATH,
  SCORING_PATH,
} from '../src/shared/audit-routes';
import {
  CURRENT_PATHS,
  enforce,
  listScannedFiles,
  resolveMode,
  scanSource,
  scanTree,
} from './helpers/funnel-path-guard';

const MODE = resolveMode(process.env.FUNNEL_PATH_GUARD_MODE);

describe('funnel path literal guard', () => {
  test('the src tree carries no funnel path literal outside the route module', async () => {
    const hits = await scanTree();
    // Named in the failure rather than just counted: the whole point of the
    // gate is that the next reader sees which file to fix.
    expect(hits.map((h) => `${h.file}:${h.line} ${h.literal}`)).toEqual([]);
    enforce(hits, MODE);
  });

  test('a fixture containing /web/scoring is reported', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a quoted fixture of a source line the scanner reads
    const hits = scanSource("const page = '/web/scoring';\nconst next = `${origin}/scorecards`;", 'fixture.ts');
    expect(hits.map((h) => h.literal)).toEqual(['/web/scoring', '/scorecards']);
    expect(hits[0]).toMatchObject({ file: 'fixture.ts', line: 1 });
  });

  test('warning mode reports the fixture and exits green; gate mode fails on it', () => {
    const hits = scanSource("const page = '/web/scoring';", 'fixture.ts');
    const warnings: string[] = [];
    expect(() => enforce(hits, 'warn', (msg) => warnings.push(msg))).not.toThrow();
    expect(warnings.join('\n')).toContain('fixture.ts:1');
    expect(() => enforce(hits, 'gate', () => {})).toThrow(/fixture\.ts:1/);
  });

  test('comment lines are not literals', () => {
    const source = ['// the old /web/scoring page', ' * see /audit', '/* /scorecards */', '# /fix/x'].join('\n');
    expect(scanSource(source, 'fixture.ts')).toEqual([]);
  });

  test('longer paths win over their prefixes and adjacent names do not match', () => {
    const source = [
      "a('/score/live/x');",
      "b('/api/audit-web');",
      "c('./audit-web/cache');",
      "d('/scorecard-schema');",
      "e('/checks');",
      "f('/web-audit/skill/x');",
      "g('audits/web/abc');",
      "h('https://github.com/o/r/tree/main/scorecards');",
      "import { x } from './web-audit';",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a quoted fixture of a source line the scanner reads
      'i(`${origin}/web/anc.dev`);',
    ].join('\n');
    expect(scanSource(source, 'fixture.ts').map((h) => h.literal)).toEqual([
      '/score/live',
      '/api/audit-web',
      '/web-audit',
      '/web/',
    ]);
  });

  test('the route module itself is excluded from the tree scan', async () => {
    const hits = await scanTree();
    expect(hits.some((h) => h.file.endsWith('src/shared/audit-routes.ts'))).toBe(false);
  });
});

describe('funnel path literal guard: review fixtures', () => {
  test('regex route literals and own-host URLs are literals too', () => {
    const source = [
      'a(pathname.match(/^\\/score\\/live\\/([^/]+)$/));',
      "b('https://anc.dev/scoring');",
      "c('see anc.dev/web-audit for details');",
      "d('http://localhost:8787/audit');",
      "e('https://example.com/check');",
      "f('https://anc-dev.brett.workers.dev/scorecards');",
    ].join('\n');
    expect(scanSource(source, 'fixture.ts').map((h) => h.literal)).toEqual([
      '/score/live',
      '/scoring',
      '/web-audit',
      '/audit',
      '/scorecards',
    ]);
  });

  test('the current-path half of the pattern is the route module vocabulary', () => {
    expect(CURRENT_PATHS).toEqual([
      SCORING_PATH,
      SCORECARDS_PATH,
      AUDIT_PATH,
      API_SCORE_PATH,
      SCORE_PREFIX,
      FIX_PREFIX,
    ]);
    for (const p of CURRENT_PATHS) {
      expect(scanSource(`a('${p}x');`, 'fixture.ts')).toHaveLength(p.endsWith('/') ? 1 : 0);
      expect(scanSource(`a('${p}');`, 'fixture.ts')).toHaveLength(1);
    }
  });

  test('the scanned file set covers nested source and excludes the route module', async () => {
    const files = await listScannedFiles();
    expect(files).toContain('src/worker/index.ts');
    expect(files).toContain('src/build/shell.mjs');
    expect(files).not.toContain('src/shared/audit-routes.ts');
  });

  test('an unrecognized mode value throws instead of defaulting to a mode', () => {
    expect(() => resolveMode('true')).toThrow(/FUNNEL_PATH_GUARD_MODE/);
    expect(() => resolveMode('1')).toThrow(/FUNNEL_PATH_GUARD_MODE/);
    expect(resolveMode(undefined)).toBe('gate');
    expect(resolveMode('')).toBe('gate');
    expect(resolveMode('gate')).toBe('gate');
    expect(resolveMode('warn')).toBe('warn');
  });
});
