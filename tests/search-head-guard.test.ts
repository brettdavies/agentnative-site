// Search-engine head guard over the built output. Bing's Site Scan and the
// search-presence audit read each page's description as written: outside
// 25-160 characters, cut off with an ellipsis, or carrying Markdown syntax
// it fails. Run `bun run build` first; this reads dist/.

import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DESCRIPTION_MAX, DESCRIPTION_MIN, SENTENCE_END } from '../src/shared/search-head';
import { requireDistBuild } from './helpers/dist';

const DIST = join(import.meta.dir, '..', 'dist');

// The Worker fills this template's placeholders per request; its own head
// states `{{TITLE}}` and `{{DESCRIPTION}}` verbatim.
const SHELL_TEMPLATE = '_internal/score-live-shell.html';

const DESCRIPTION_TAGS = [
  { label: 'description', pattern: /<meta name="?description"? content="([^"]*)"/ },
  { label: 'og:description', pattern: /<meta property="?og:description"? content="([^"]*)"/ },
  { label: 'twitter:description', pattern: /<meta name="?twitter:description"? content="([^"]*)"/ },
] as const;

const MARKDOWN_SYNTAX = [
  { label: 'bold', pattern: /\*\*/ },
  { label: 'code span', pattern: /`/ },
  { label: 'link', pattern: /\[[^\]]+\]\([^)]*\)/ },
  { label: 'emphasis', pattern: /(^|[\s(])\*[^*\s][^*]*\*(?=[\s).,;:!?]|$)/ },
  { label: 'underscore emphasis', pattern: /(^|[\s(])_[^_\s][^_]*_(?=[\s).,;:!?]|$)/ },
  { label: 'heading', pattern: /^#/ },
] as const;

function decodeEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

type Page = { path: string; html: string };

let pages: Page[] = [];

beforeAll(async () => {
  requireDistBuild(DIST);
  const entries = await readdir(DIST, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => relative(DIST, join(entry.parentPath, entry.name)))
    .filter((path) => path !== SHELL_TEMPLATE)
    .sort();
  pages = await Promise.all(files.map(async (path) => ({ path, html: await readFile(join(DIST, path), 'utf8') })));
});

function descriptionsOf(page: Page): { label: string; text: string | null }[] {
  return DESCRIPTION_TAGS.map(({ label, pattern }) => {
    const match = page.html.match(pattern);
    return { label, text: match ? decodeEntities(match[1]) : null };
  });
}

function violations(check: (label: string, text: string) => string | null): string[] {
  return pages.flatMap((page) => {
    const found = new Map<string, string[]>();
    for (const { label, text } of descriptionsOf(page)) {
      const problem = text === null ? 'is missing' : check(label, text);
      if (problem === null) continue;
      const line = `${problem}: ${text ?? ''}`;
      found.set(line, [...(found.get(line) ?? []), label]);
    }
    return [...found].map(([line, labels]) => `${page.path} (${labels.join(', ')}) ${line}`);
  });
}

describe('built pages state a description search engines can show whole', () => {
  test('the build emitted pages to check', () => {
    expect(pages.length).toBeGreaterThan(100);
  });

  test(`every description is ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} characters`, () => {
    expect(
      violations((_label, text) =>
        text.length < DESCRIPTION_MIN || text.length > DESCRIPTION_MAX ? `is ${text.length} characters` : null,
      ),
    ).toEqual([]);
  });

  test('no description ends in an ellipsis', () => {
    expect(
      violations((_label, text) => (text.endsWith('...') || text.endsWith('…') ? 'ends in an ellipsis' : null)),
    ).toEqual([]);
  });

  test('every description ends at a sentence boundary', () => {
    expect(violations((_label, text) => (SENTENCE_END.test(text) ? null : 'does not end a sentence'))).toEqual([]);
  });

  test('every description is plain text, with no Markdown syntax', () => {
    expect(
      violations((_label, text) => {
        const found = MARKDOWN_SYNTAX.find(({ pattern }) => pattern.test(text));
        return found ? `carries Markdown (${found.label})` : null;
      }),
    ).toEqual([]);
  });
});
