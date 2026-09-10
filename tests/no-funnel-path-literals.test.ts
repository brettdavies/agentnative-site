// Source-level guard: every audit-funnel path literal outside the shared
// route module is a place a rename can miss. The guard scans src/ for
// retired and current funnel paths. In warning mode it reports each hit as a
// loud warning and exits green; in gate mode it fails on any hit. The
// default is warning mode; FUNNEL_PATH_GUARD_MODE=gate selects gate mode.

import { describe, expect, test } from 'bun:test';
import { enforce, scanSource, scanTree } from './helpers/funnel-path-guard';

const MODE = process.env.FUNNEL_PATH_GUARD_MODE === 'gate' ? 'gate' : 'warn';

describe('funnel path literal guard', () => {
  test('the src tree carries no funnel path literal outside the route module', async () => {
    const hits = await scanTree();
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
