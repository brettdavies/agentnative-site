import { describe, expect, test } from 'bun:test';
import { mdCodeSpan, mdFlatten, mdInlineText, mdLinkDestination, mdTableCell } from '../src/shared/md-inline';

describe('mdFlatten', () => {
  const separators = ['\n', '\r', '\r\n', '\t', '\v', '\f', '\u0085', '\u2028', '\u2029', '\u0000', '\u001b'];

  for (const separator of separators) {
    test(`${JSON.stringify(separator)} leaves one line`, () => {
      expect(mdFlatten(`a${separator}b`)).toBe('a b');
    });
  }

  test('a run of them collapses to one space', () => {
    expect(mdFlatten('a\r\n\n\u2028b')).toBe('a b');
  });

  test('a value from a stored record need not be a string', () => {
    expect(mdFlatten(90)).toBe('90');
  });
});

describe('mdInlineText', () => {
  test('a link or image cannot form', () => {
    expect(mdInlineText('[click](https://x.example)')).toBe('[click\\](https://x.example)');
    expect(mdInlineText('![i](https://x.example)')).toBe('![i\\](https://x.example)');
  });

  test('a backslash of its own cannot cancel the escape', () => {
    expect(mdInlineText('[click\\](https://x.example)')).toBe('[click\\\\\\](https://x.example)');
  });

  test('an autolink or a tag cannot form', () => {
    expect(mdInlineText('<https://x.example>')).toBe('\\<https://x.example>');
    expect(mdInlineText('<b>')).toBe('\\<b>');
  });

  test('ordinary usage text stays as written', () => {
    expect(mdInlineText('usage: tool [OPTIONS] (see man tool) lex:..\\nvec `code`')).toBe(
      'usage: tool [OPTIONS] (see man tool) lex:..\\nvec `code`',
    );
  });
});

describe('mdInlineText around code spans', () => {
  test('a code span stays as written, because a backslash in one shows literally', () => {
    expect(mdInlineText('entries repeat `qmd query <query>` and `a](b)`')).toBe(
      'entries repeat `qmd query <query>` and `a](b)`',
    );
    expect(mdInlineText('``a`<b`` and <c>')).toBe('``a`<b`` and \\<c>');
  });

  test('a backtick with a backslash before it cannot pass a link off as code', () => {
    expect(mdInlineText('\\`[x](y)`')).toBe('\\`[x\\](y)`');
  });

  test('a backtick that never closes opens no span', () => {
    expect(mdInlineText('`[x](y)')).toBe('`[x\\](y)');
    expect(mdInlineText('``[x](y)`')).toBe('``[x\\](y)`');
  });

  test('a span that closes before the delimiter does not shield it', () => {
    expect(mdInlineText('[`x`](y)')).toBe('[`x`\\](y)');
  });
});

describe('mdTableCell', () => {
  test('a pipe inside a code span is still escaped, and the span is not otherwise touched', () => {
    expect(mdTableCell('`a|b <c>`')).toBe('`a\\|b <c>`');
  });

  test('a pipe cannot end the cell, and a backslash of its own cannot cancel that', () => {
    expect(mdTableCell('a|b')).toBe('a\\|b');
    expect(mdTableCell('a\\|b')).toBe('a\\\\\\|b');
  });

  test('a backslash nowhere near a delimiter stays as written', () => {
    expect(mdTableCell('`lex:..\\nvec:...`')).toBe('`lex:..\\nvec:...`');
  });

  test('it holds the inline rule too', () => {
    expect(mdTableCell('[a](b)\n<c>')).toBe('[a\\](b) \\<c>');
  });
});

describe('mdCodeSpan', () => {
  test('a backtick cannot close the span, and a line break cannot leave it', () => {
    expect(mdCodeSpan('a`b\nc')).toBe('`` a`b c ``');
    expect(mdCodeSpan('plain')).toBe('`plain`');
  });
});

describe('mdLinkDestination', () => {
  test('both parentheses are encoded, and nothing else moves', () => {
    expect(mdLinkDestination('https://x.example/a(b)?c=d')).toBe('https://x.example/a%28b%29?c=d');
  });
});
