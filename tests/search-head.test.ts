import { describe, expect, test } from 'bun:test';
import { extractDescription } from '../src/build/content.mjs';
import { DESCRIPTION_MAX, DESCRIPTION_MIN, descriptionFits, fitDescription } from '../src/shared/search-head';

const page = (...paragraphs: string[]) => `# Title\n\n${paragraphs.join('\n\n')}\n`;

describe('extractDescription reads a page as plain text', () => {
  test('strips bold, emphasis, code spans, and link syntax down to the words', () => {
    const source = page(
      '**Every** path MUST run `--dry-run` first, *not* after. See [the spec](https://anc.dev/p1) and _this_ one.',
    );
    expect(extractDescription(source)).toBe(
      'Every path MUST run --dry-run first, not after. See the spec and this one.',
    );
  });

  test('keeps underscores and asterisks that are not emphasis', () => {
    expect(extractDescription(page('The record is _agents.example.com and a*b*c stays.'))).toBe(
      'The record is _agents.example.com and a*b*c stays.',
    );
  });

  test('skips sub-headings to reach the first prose paragraph', () => {
    expect(extractDescription('# Title\n\n## Sub\n\nThe prose that follows the headings.\n')).toBe(
      'The prose that follows the headings.',
    );
  });

  test('returns the fallback when the page has no prose', () => {
    expect(extractDescription('# Title\n', 'fallback')).toBe('fallback');
  });
});

describe('extractDescription ends a long paragraph at a sentence boundary', () => {
  const first = 'CLI tools MUST detect invalid state early and exit with a structured error.';
  const second = 'An error that says "operation failed" gives the caller nothing to act on.';
  const third = `${'The remaining guidance keeps going and going '.repeat(4)}until it reaches its end.`;

  test('keeps a paragraph that already fits, whole', () => {
    expect(extractDescription(page(`${first} ${second}`))).toBe(`${first} ${second}`);
  });

  test('keeps whole sentences up to the limit and drops the rest', () => {
    const description = extractDescription(page(`${first} ${second} ${third}`));
    expect(description).toBe(`${first} ${second}`);
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });

  test('never ends in an ellipsis or inside a word', () => {
    const description = extractDescription(page(`${first} ${third}`));
    expect(description).toBe(first);
    expect(description).not.toMatch(/(\.\.\.|…)$/);
  });

  test('does not split after e.g. or i.e.', () => {
    const lead = 'Pick a runtime, e.g. Bun or Node, i.e. one that can run the script and print its output.';
    expect(extractDescription(page(`${lead} ${third}`))).toBe(lead);
  });

  test('refuses an opening sentence longer than the limit instead of cutting it', () => {
    const opening = `${'A single sentence that never stops, '.repeat(6)}and finally ends.`;
    expect(() => extractDescription(page(`${opening} Next.`))).toThrow(/opening sentence is \d+ characters/);
  });
});

describe('fitDescription', () => {
  const longText = 'x'.repeat(DESCRIPTION_MAX + 1);

  test('prefers the first candidate that fits the range', () => {
    expect(fitDescription('A description of a fitting length.', 'Another one of fitting length.')).toBe(
      'A description of a fitting length.',
    );
  });

  test('falls through a candidate that is too long', () => {
    expect(fitDescription(longText, 'The shorter wording that fits.')).toBe('The shorter wording that fits.');
  });

  test('falls through a candidate that is too short', () => {
    expect(fitDescription('Too short.', 'The longer wording that fits the range.')).toBe(
      'The longer wording that fits the range.',
    );
  });

  test('returns the last candidate when none fits', () => {
    expect(fitDescription(longText, 'short')).toBe('short');
  });

  test('names the Bing range', () => {
    expect([DESCRIPTION_MIN, DESCRIPTION_MAX]).toEqual([25, 160]);
    expect(descriptionFits('x'.repeat(24))).toBe(false);
    expect(descriptionFits('x'.repeat(25))).toBe(true);
    expect(descriptionFits('x'.repeat(160))).toBe(true);
    expect(descriptionFits('x'.repeat(161))).toBe(false);
  });
});
