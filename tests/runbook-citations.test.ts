// Guard: runbook citations resolve by name, never by line number.
//
// docs/runbooks cite the code and tests behind each fact as `path#anchor`.
// A line number drifts silently with every edit above it; an anchor that
// stops resolving fails here instead. In a test file the anchor is a
// describe/test/it title; anywhere else it is an identifier or a verbatim
// string from the file.

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const RUNBOOK_DIR = join(REPO_ROOT, 'docs/runbooks');
const CITED_ROOT = '(?:tests|src|scripts)/';
const ANCHOR_RE = new RegExp(`\`(${CITED_ROOT}[^\`#\\s]+)#([^\`]+)\``, 'g');
const LINE_CITATION_RE = new RegExp(`\`(?:${CITED_ROOT}[^\`\\s]*)?:\\d+(?:-\\d+)?\``, 'g');
const TEST_FILE_RE = /\.(?:test|e2e)\.ts$/;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolves(source: string, file: string, anchor: string): boolean {
  const escaped = escapeRegExp(anchor);
  if (TEST_FILE_RE.test(file)) return new RegExp(`\\b(?:describe|test|it)\\(\\s*(['"\`])${escaped}\\1`).test(source);
  if (IDENTIFIER_RE.test(anchor)) return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(source);
  return source.includes(anchor);
}

const runbooks = readdirSync(RUNBOOK_DIR)
  .filter((name) => name.endsWith('.md'))
  .map((name) => ({ rel: `docs/runbooks/${name}`, text: readFileSync(join(RUNBOOK_DIR, name), 'utf8') }));

describe('runbook citations resolve by name', () => {
  test('the wire-protocol runbook carries anchored citations to check', () => {
    const wire = runbooks.find((r) => r.rel.endsWith('/mcp-wire-protocol.md'));
    expect([...(wire?.text.matchAll(ANCHOR_RE) ?? [])].length).toBeGreaterThan(0);
  });

  for (const { rel, text } of runbooks) {
    test(`${rel} cites no line numbers`, () => {
      expect(
        [...text.matchAll(LINE_CITATION_RE)].map((m) => m[0]),
        `${rel} must cite a symbol, a verbatim string, or a test title as path#anchor; line numbers drift`,
      ).toEqual([]);
    });

    for (const [, path, rawAnchor] of text.matchAll(ANCHOR_RE)) {
      const anchor = rawAnchor.replace(/\s+/g, ' ');
      test(`${rel}: ${path}#${anchor}`, () => {
        const file = join(REPO_ROOT, path);
        expect(existsSync(file), `${path} does not exist`).toBe(true);
        expect(resolves(readFileSync(file, 'utf8'), path, anchor), `"${anchor}" no longer resolves in ${path}`).toBe(
          true,
        );
      });
    }
  }
});
