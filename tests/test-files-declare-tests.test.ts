// bun test runs a test file that declares no tests as "0 pass, 0 fail"
// and exits 0, so a file emptied by a bad write or a lost merge keeps the
// suite green while gating nothing. The Playwright specs under e2e/ end in
// .e2e.ts, which bun's discovery never picks up, so the glob below
// matches only files bun itself runs.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TESTS_DIR = import.meta.dir;
const BUN_TEST_FILE = new Bun.Glob('**/*{.,_}{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}');

/** A test() or it() call, modifiers included (test.each, it.skip); `.test(` on a RegExp does not count. */
const DECLARES_TEST = /(?<![\w.$])(?:test|it)(?:\.\w+)*\s*\(/;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const files = [...BUN_TEST_FILE.scanSync({ cwd: TESTS_DIR })].sort();

describe('every bun test file declares at least one test', () => {
  test('the scan reaches the suite, this file included', () => {
    expect(files).toContain('test-files-declare-tests.test.ts');
  });

  test('no test file is empty of tests', () => {
    const empty = files.filter(
      (file) => !DECLARES_TEST.test(withoutComments(readFileSync(join(TESTS_DIR, file), 'utf8'))),
    );
    expect(
      empty,
      'these files declare no test() or it() call, so bun test runs them as 0 pass, 0 fail and exits 0; restore their tests or delete the file',
    ).toEqual([]);
  });
});
