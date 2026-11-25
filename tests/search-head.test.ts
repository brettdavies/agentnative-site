import { describe, expect, test } from 'bun:test';
import { extractDescription } from '../src/build/content.mjs';
import { emitShell, emitShellTemplate } from '../src/build/shell.mjs';
import { scoringTitle } from '../src/shared/scoring-copy';
import {
  BRAND,
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  descriptionFits,
  endSentence,
  fitDescription,
  HOME_HEAD_TITLE,
  headTitle,
  TITLE_MAX,
  TITLE_MIN,
} from '../src/shared/search-head';

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

  test('keeps the text of a code span as written, asterisks and underscores included', () => {
    expect(extractDescription(page('Run `anc --glob *.md` or `**/*.md` and `*.rs` on a `snake_case_name`.'))).toBe(
      'Run anc --glob *.md or **/*.md and *.rs on a snake_case_name.',
    );
  });

  test('ends a link at its own closing parenthesis, even when the URL holds one', () => {
    expect(extractDescription(page('See [the note](https://a.example/b_(c)) for the rule.'))).toBe(
      'See the note for the rule.',
    );
  });

  test('reads the text of a link whose label is a code span', () => {
    expect(extractDescription(page('Read [`--dry-run`](/p5) before a write.'))).toBe('Read --dry-run before a write.');
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

  test('splits after a word that only ends in vs, such as devs', () => {
    const lead = 'The standard is written for CLI devs.';
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

describe('endSentence', () => {
  test.each([
    ['Command-line tool for transferring data with URLs', 'Command-line tool for transferring data with URLs.'],
    ['Already a sentence.', 'Already a sentence.'],
    ['Asks a question?', 'Asks a question?'],
    ['Ends in a bracket (CSV, JSON, etc.)', 'Ends in a bracket (CSV, JSON, etc.)'],
    ['A quoted "word."', 'A quoted "word."'],
  ])('%s', (text, expected) => {
    expect(endSentence(text)).toBe(expected);
  });
});

describe('headTitle', () => {
  test('puts the brand after the page title', () => {
    expect(headTitle('Install anc')).toBe('Install anc · agentnative');
  });

  test('brings a one-character title up to the 15-character minimum', () => {
    expect(headTitle('x').length).toBeGreaterThanOrEqual(TITLE_MIN);
  });

  test('prefers the first wording that keeps the whole title within 70 characters', () => {
    const long = `Fix: ${'a long check title '.repeat(4)}`;
    expect(headTitle(long, 'Fix: DNS-AID', 'Fix')).toBe('Fix: DNS-AID · agentnative');
  });

  test('keeps a title that lands exactly on the limit', () => {
    const own = 'x'.repeat(TITLE_MAX - ' · agentnative'.length);
    expect(headTitle(own)).toBe(`${own} · agentnative`);
    expect(headTitle(own)).toHaveLength(TITLE_MAX);
  });

  test('cuts the last wording, never the brand, when none fits', () => {
    const title = headTitle('a'.repeat(128));
    expect(title).toHaveLength(TITLE_MAX);
    expect(title.endsWith('…' + ' · agentnative')).toBe(true);
    expect(title).toContain(BRAND);
  });

  test('names the brand and the standard on the home page', () => {
    expect(HOME_HEAD_TITLE).toBe('agentnative: the agent-native CLI standard');
  });

  test('the scoring page title is its own part; the client adds the brand', () => {
    expect(scoringTitle('running', 'ripgrep')).toBe('Auditing ripgrep…');
    expect(headTitle(scoringTitle('running', 'ripgrep'))).toBe('Auditing ripgrep… · agentnative');
  });
});

describe('the shell states the brand in <title> and the bare title in the social tags', () => {
  const page = {
    description: 'A description of a fitting length.',
    canonicalPath: '/x',
    bodyHtml: '',
    themeInitJs: '',
  };

  test('a built page takes the brand suffix in <title> and leaves og:title and twitter:title bare', () => {
    const html = emitShell({ ...page, title: 'Install anc', breadcrumb: 'Install anc' });
    expect(html).toContain('<title>Install anc · agentnative</title>');
    expect(html).toContain('<meta property="og:title" content="Install anc" />');
    expect(html).toContain('<meta name="twitter:title" content="Install anc" />');
  });

  test('a page passes its own <title> when its own part runs long', () => {
    const html = emitShell({
      ...page,
      title: 'The agent-native standard',
      headTitle: HOME_HEAD_TITLE,
      breadcrumb: 'x',
    });
    expect(html).toContain(`<title>${HOME_HEAD_TITLE}</title>`);
    expect(html).toContain('<meta property="og:title" content="The agent-native standard" />');
  });

  test('the Worker template defers both titles to request time', () => {
    const template = emitShellTemplate();
    expect(template).toContain('<title>{{HEAD_TITLE}}</title>');
    expect(template).toContain('<meta property="og:title" content="{{TITLE}}" />');
  });
});
