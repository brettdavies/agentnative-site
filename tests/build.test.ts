import { describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMarkdown } from '../src/build/render.mjs';
import { parseFilename, sortedGlob } from '../src/build/util.mjs';

describe('sortedGlob', () => {
  test('sorts principles by numeric prefix, not lexicographic', async () => {
    const dir = join(tmpdir(), `sortedGlob-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      for (const name of ['p10-tenth.md', 'p2-second.md', 'p1-first.md', 'p9-ninth.md', 'notes.md', 'p3-third.md']) {
        await writeFile(join(dir, name), '# stub\n');
      }
      const result = await sortedGlob(dir);
      const names = result.map((p) => p.slice(p.lastIndexOf('/') + 1));
      expect(names).toEqual(['p1-first.md', 'p2-second.md', 'p3-third.md', 'p9-ninth.md', 'p10-tenth.md']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('parseFilename', () => {
  test('extracts n and slug from bare filename', () => {
    expect(parseFilename('p3-progressive-help-discovery.md')).toEqual({
      n: 3,
      slug: 'progressive-help-discovery',
    });
  });

  test('extracts n and slug from absolute path', () => {
    expect(parseFilename('/some/abs/path/p7-bounded-high-signal-responses.md')).toEqual({
      n: 7,
      slug: 'bounded-high-signal-responses',
    });
  });

  test('throws on non-principle filename', () => {
    expect(() => parseFilename('notes.md')).toThrow();
  });

  test('throws on uppercase prefix', () => {
    expect(() => parseFilename('P1-foo.md')).toThrow();
  });
});

// RFC-keyword regex + plugin cases from docs/DESIGN.md §4.7 (A6/C2).
describe('rfc-keywords plugin', () => {
  async function render(md: string): Promise<string> {
    return renderMarkdown(md);
  }

  test('MUST becomes a single rfc-must strong', async () => {
    const html = await render('The agent MUST run.');
    expect(html).toContain('<strong class="rfc-must">MUST</strong>');
  });

  test('MUST NOT becomes a single rfc-must strong, not two', async () => {
    const html = await render('The agent MUST NOT prompt.');
    expect(html).toContain('<strong class="rfc-must">MUST NOT</strong>');
    expect(html).not.toContain('<strong class="rfc-must">MUST</strong> NOT');
    // Exactly one rfc-must span in this single-keyword sentence.
    const count = (html.match(/class="rfc-must"/g) ?? []).length;
    expect(count).toBe(1);
  });

  test('SHOULD NOT becomes a single rfc-should strong', async () => {
    const html = await render('The tool SHOULD NOT block on prompts.');
    expect(html).toContain('<strong class="rfc-should">SHOULD NOT</strong>');
  });

  test('MAY becomes rfc-may', async () => {
    const html = await render('Callers MAY pass --verbose.');
    expect(html).toContain('<strong class="rfc-may">MAY</strong>');
  });

  test('MUSTARD does not match (word boundary strict)', async () => {
    const html = await render('I like MUSTARD on my burger.');
    expect(html).not.toContain('class="rfc-must"');
    expect(html).toContain('MUSTARD');
  });

  test('lowercase must does not match', async () => {
    const html = await render('The agent must run.');
    expect(html).not.toContain('class="rfc-must"');
  });

  test('MUST inside inlineCode does not match', async () => {
    const html = await render('Use the `MUST` convention.');
    expect(html).not.toContain('class="rfc-must"');
    expect(html).toContain('MUST');
  });

  test('MUST inside fenced code block does not match', async () => {
    const html = await render('```\nMUST run\n```\n');
    expect(html).not.toContain('class="rfc-must"');
  });

  test('MUST inside link label does not match', async () => {
    const html = await render('[MUST see this](https://example.com)');
    expect(html).not.toContain('class="rfc-must"');
  });

  test('trailing comma after MUST still matches', async () => {
    const html = await render('The agent MUST, at minimum, support JSON.');
    expect(html).toContain('<strong class="rfc-must">MUST</strong>');
  });

  test('**MUST:** nested-strong annotates parent, no double strong', async () => {
    // **MUST:** — mdast `strong` with a single text child whose value is
    // `MUST:` (keyword + colon). The plugin should annotate the existing
    // strong rather than nesting a second one.
    const html = await render('**MUST:** this holds always.');
    // Should have a single <strong class="rfc-must"> element containing MUST:,
    // never nested.
    expect(html).not.toContain('<strong class="rfc-must"><strong>');
    expect(html).not.toContain('<strong><strong class="rfc-must">');
    // The annotation should appear (either via the nested-strong branch or
    // the split-children branch — accept both).
    expect(html).toContain('class="rfc-must"');
  });

  test('MUST inside a heading matches', async () => {
    const html = await render('## MUST behave correctly\n\nBody.');
    expect(html).toContain('class="rfc-must"');
  });
});
