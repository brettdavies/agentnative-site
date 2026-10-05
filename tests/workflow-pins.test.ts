// Every `uses:` in a workflow resolves to an immutable commit: a tag or
// branch can be moved to different code after review, a 40-hex commit SHA
// cannot. The trailing `# vX.Y.Z` comment names the release the SHA was taken
// from, so a reviewer can tell what an update moves between.
//
// Two shapes carry no SHA by design. A local `./` action resolves from the
// same commit as the workflow that calls it, so there is no ref to move.
// The owner's first-party reusable workflows under
// brettdavies/.github/.github/workflows/ pin to `@main`, because the repo that
// publishes them and the repos that call them share one owner.

import { describe, expect, test } from 'bun:test';
import * as yaml from 'js-yaml';
import { listWorkflows, workflowText } from './helpers/workflows';

const USES_LINE = /^\s*(?:-\s+)?uses:\s*(['"]?)([^'"\s#]+)\1\s*(#.*)?$/;
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^#\s*v\d+\.\d+\.\d+\b/;
const FIRST_PARTY_REUSABLE = /^brettdavies\/\.github\/\.github\/workflows\/[^@\s]+@main$/;

interface UsesLine {
  line: number;
  ref: string;
  comment: string;
}

function scanUsesLines(text: string): UsesLine[] {
  return text.split('\n').flatMap((raw, index): UsesLine[] => {
    if (/^\s*#/.test(raw)) return [];
    const match = USES_LINE.exec(raw);
    return match ? [{ line: index + 1, ref: match[2] ?? '', comment: (match[3] ?? '').trim() }] : [];
  });
}

// The parsed document is the authority on how many `uses` keys exist; the
// line scan is what can see comments. Comparing the two catches a `uses:`
// written in a shape the line pattern does not recognize.
function parsedUsesValues(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(parsedUsesValues);
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === 'uses' && typeof value === 'string' ? [value] : parsedUsesValues(value),
  );
}

function violation(use: UsesLine): string | null {
  if (use.ref.startsWith('./')) return null;
  if (FIRST_PARTY_REUSABLE.test(use.ref)) return null;
  if (!PINNED.test(use.ref)) return `${use.ref} is not pinned to a 40-character commit SHA`;
  if (!VERSION_COMMENT.test(use.comment)) return `${use.ref} lacks a trailing "# vX.Y.Z" version comment`;
  return null;
}

const workflows = listWorkflows();

describe('workflow actions are pinned to commit SHAs', () => {
  test('the spec-drift workflow is scanned and pins at least one action', () => {
    expect(workflows).toContain('spec-drift.yml');
    expect(scanUsesLines(workflowText('spec-drift.yml')).length).toBeGreaterThan(0);
  });

  test('the line scan sees every uses key the YAML parser sees', () => {
    for (const file of workflows) {
      const text = workflowText(file);
      const scanned = scanUsesLines(text)
        .map((use) => use.ref)
        .sort();
      expect(scanned, `${file}: a uses value is written in a shape the pin scan cannot read`).toEqual(
        parsedUsesValues(yaml.load(text)).sort(),
      );
    }
  });

  test('every uses is a commit SHA with a version comment, or an allowed exception', () => {
    const violations = workflows.flatMap((file) =>
      scanUsesLines(workflowText(file)).flatMap((use) => {
        const problem = violation(use);
        return problem ? [`.github/workflows/${file}:${use.line}: ${problem}`] : [];
      }),
    );
    expect(violations).toEqual([]);
  });
});
