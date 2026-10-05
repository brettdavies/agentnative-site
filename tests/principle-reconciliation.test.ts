// content/principles/VERSION (SITE_SPEC_VERSION, shown in the footer) claims
// the principle pages cover that spec version. Once it equals the vendored
// snapshot's VERSION, every built page lists one requirement per spec
// requirement in each tier, so a bump that lands before the prose catches up
// fails here. While the vendored snapshot is ahead, the site is honestly
// behind and the comparison does not apply. The pages are read from dist/,
// which `bun test` does not build.

import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { SITE_SPEC_VERSION, SPEC_VERSION } from '../src/build/util.mjs';

const REPO_ROOT = join(import.meta.dir, '..');
const SPEC_PRINCIPLES = join(REPO_ROOT, 'src', 'data', 'spec', 'principles');
const DIST = join(REPO_ROOT, 'dist');

const TIERS = ['must', 'should', 'may'] as const;
type Tier = (typeof TIERS)[number];
type TierCounts = Record<Tier, number>;

const PRINCIPLE_FILES = readdirSync(SPEC_PRINCIPLES)
  .filter((name) => /^p\d+-.+\.md$/.test(name))
  .sort();

function emptyCounts(): TierCounts {
  return { must: 0, should: 0, may: 0 };
}

async function specRequirementCounts(file: string): Promise<TierCounts> {
  const source = await readFile(join(SPEC_PRINCIPLES, file), 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1];
  if (frontmatter === undefined) throw new Error(`${file}: no YAML frontmatter`);
  const { requirements } = yaml.load(frontmatter) as { requirements: Array<{ level: Tier }> };
  const counts = emptyCounts();
  for (const { level } of requirements) counts[level] += 1;
  return counts;
}

async function pageRequirementCounts(n: number): Promise<TierCounts> {
  const html = await readFile(join(DIST, `p${n}.html`), 'utf8');
  const counts = emptyCounts();
  const rewriter = new HTMLRewriter();
  for (const tier of TIERS) {
    rewriter.on(`aside.normative--${tier} > ul > li`, {
      element() {
        counts[tier] += 1;
      },
    });
  }
  await rewriter.transform(new Response(html)).text();
  return counts;
}

describe.skipIf(SITE_SPEC_VERSION !== SPEC_VERSION)(
  `principle pages cover every requirement of spec ${SPEC_VERSION} (the version the footer claims)`,
  () => {
    test('the vendored snapshot carries principle files', () => {
      expect(PRINCIPLE_FILES.length).toBeGreaterThan(0);
    });

    test.each(PRINCIPLE_FILES)('%s', async (file) => {
      const n = Number(/^p(\d+)-/.exec(file)?.[1]);
      const page = { page: `/p${n}`, requirements: await pageRequirementCounts(n) };
      expect(page).toEqual({ page: `/p${n}`, requirements: await specRequirementCounts(file) });
    });
  },
);
