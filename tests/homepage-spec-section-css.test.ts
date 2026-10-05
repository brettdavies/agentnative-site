// The homepage's principles section is styled by child-combinator rules that
// spell out the markup path to each element. A rule whose path no longer
// matches the built homepage stops applying without any error, and the
// element falls back to the generic heading and paragraph styles. Every
// .spec-section selector in the shipped stylesheet must match at least one
// element of the built homepage.
//
// Run `bun run build` before these tests (bun test does not auto-build).

import { beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireDistBuild } from './helpers/dist';

const DIST_DIR = join(import.meta.dir, '..', 'dist');

/** Every selector in a rule whose selector list names .spec-section, from minified CSS. */
function specSectionSelectors(css: string): string[] {
  const selectors = new Set<string>();
  for (const [, list] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const selector of list.split(',')) {
      const trimmed = selector.trim();
      if (trimmed.includes('.spec-section')) selectors.add(trimmed);
    }
  }
  return [...selectors];
}

async function matchCount(html: string, selector: string): Promise<number> {
  let count = 0;
  await new HTMLRewriter()
    .on(selector, {
      element() {
        count += 1;
      },
    })
    .transform(new Response(html))
    .text();
  return count;
}

describe('homepage principles section styles reach its markup', () => {
  let selectors: string[] = [];
  let html = '';

  beforeAll(async () => {
    requireDistBuild(DIST_DIR);
    selectors = specSectionSelectors(await readFile(join(DIST_DIR, 'css', 'site.css'), 'utf8'));
    html = await readFile(join(DIST_DIR, 'index.html'), 'utf8');
  });

  test('the stylesheet styles the section heading and its subline', () => {
    expect(selectors.some((s) => s.endsWith('h2'))).toBe(true);
    expect(selectors.some((s) => s.endsWith('.sub'))).toBe(true);
  });

  test('every .spec-section selector matches an element of the built homepage', async () => {
    const dead: string[] = [];
    for (const selector of selectors) {
      if ((await matchCount(html, selector)) === 0) dead.push(selector);
    }
    expect(dead, 'these selectors match nothing on the built homepage, so their declarations never apply').toEqual([]);
  });
});
