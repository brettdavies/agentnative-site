// scripts/sync-spec.sh writes the vendored spec twice: once for the site build
// (src/data/spec/) and once for the skill bundle (skill/agent-native-cli/spec/).
// A hand edit to either copy, or a sync that updates only one, breaks the
// byte equality the bundle's published digest depends on.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const SITE_SPEC = join(REPO_ROOT, 'src/data/spec');
const BUNDLE_SPEC = join(REPO_ROOT, 'skill/agent-native-cli/spec');

function principleNames(dir: string): string[] {
  return readdirSync(join(dir, 'principles')).sort();
}

describe('vendored spec copies', () => {
  test('the two principles/ directories hold the same names', () => {
    expect(principleNames(BUNDLE_SPEC)).toEqual(principleNames(SITE_SPEC));
  });

  test('every principle file is byte-equal in the bundle copy', () => {
    const differing = principleNames(SITE_SPEC).filter(
      (name) =>
        !readFileSync(join(SITE_SPEC, 'principles', name)).equals(readFileSync(join(BUNDLE_SPEC, 'principles', name))),
    );
    expect(differing).toEqual([]);
  });

  test.each(['VERSION', 'CHANGELOG.md'])('%s is byte-equal in the bundle copy', (file) => {
    expect(readFileSync(join(BUNDLE_SPEC, file)).equals(readFileSync(join(SITE_SPEC, file)))).toBe(true);
  });

  test('the bundle carries the reading guide with every relative link made absolute', () => {
    const reading = readFileSync(join(BUNDLE_SPEC, 'reading-the-spec.md'), 'utf8');
    expect(reading.startsWith('## Reading the spec\n')).toBe(true);
    expect(reading).not.toMatch(/\]\((?!https?:|#)/);
  });
});
