// Guard: content/*.md must not carry interactive form widgets.
//
// The subpage build emits each content/*.md as both an HTML page and a
// verbatim markdown twin (and folds the twin into llms-full.txt). Raw
// <form>/<input>/<button> markup in the source therefore leaks dead
// controls into the agent-facing twin. Browser widgets belong in a build
// template with a placeholder slot (src/build/07-subpages.mjs), which
// renders HTML in the page and prose in the twin.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTENT_DIR = new URL('../content', import.meta.url).pathname;
const WIDGET_RE = /<form\b|<input\b|<button\b/i;

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));
}

describe('content markdown carries no interactive form widgets', () => {
  const files = markdownFiles(CONTENT_DIR);

  test('there is at least one content markdown file to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = file.slice(CONTENT_DIR.length + 1);
    test(`content/${rel} has no <form>/<input>/<button> (use a widget slot in 07-subpages.mjs)`, () => {
      expect(WIDGET_RE.test(readFileSync(file, 'utf8'))).toBe(false);
    });
  }
});
