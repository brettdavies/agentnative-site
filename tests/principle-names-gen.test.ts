// Drift guard for src/shared/principle-names.gen.mjs.
//
// `src/build/00a-principle-names-gen.mjs` writes each principle's name from the
// H1 of its page under content/principles/. The generated module is committed
// so the Worker bundle and the type check need no build step; this test
// re-reads the titles and fails when a title changes and the module does not.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeExpectedPrincipleNamesModule,
  readPrincipleNames,
  renderPrincipleNamesModule,
} from '../src/build/00a-principle-names-gen.mjs';

const scratch: string[] = [];

afterEach(async () => {
  while (scratch.length) await rm(scratch.pop() as string, { recursive: true, force: true });
});

async function principlesDir(titles: Record<number, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'anc-principles-'));
  scratch.push(dir);
  for (const [n, title] of Object.entries(titles)) {
    await writeFile(join(dir, `p${n}-slug.md`), `# P${n}: ${title}\n\n## Definition\n`);
  }
  return dir;
}

describe('principle-names-gen drift guard', () => {
  test('src/shared/principle-names.gen.mjs matches the principle page titles', async () => {
    const expected = await computeExpectedPrincipleNamesModule();
    expect(await readFile(expected.path, 'utf8')).toBe(expected.content);
  });

  test('a changed principle title changes the module the generator expects', async () => {
    const committed = (await computeExpectedPrincipleNamesModule()).content;
    const dir = await principlesDir({ 1: 'A Renamed Principle' });
    const changed = (await computeExpectedPrincipleNamesModule(dir)).content;
    expect(changed).not.toBe(committed);
    expect(changed).toContain("P1: 'A Renamed Principle'");
  });

  test('a principle page without a "P<n>: " H1 is refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anc-principles-'));
    scratch.push(dir);
    await writeFile(join(dir, 'p1-slug.md'), '# Untitled\n');
    await expect(readPrincipleNames(dir)).rejects.toThrow('p1-slug.md');
  });

  test('a name with a single quote is written with double quotes', () => {
    expect(renderPrincipleNamesModule({ P1: "Don't Prompt" })).toContain('P1: "Don\'t Prompt"');
  });
});
