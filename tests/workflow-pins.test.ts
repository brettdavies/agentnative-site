// Every `uses:` in a workflow or a composite action resolves to an immutable
// commit: a tag or branch can be moved to different code after review, a
// 40-hex commit SHA cannot. A composite action runs inside the job that calls
// it, with that job's token, so its `uses:` carry the same exposure as the
// workflow's own. The trailing `# vX.Y.Z` comment names the release the SHA
// was taken from, so a reviewer can tell what an update moves between.
//
// Two shapes carry no SHA by design. A local `./` action resolves from the
// same commit as the workflow that calls it, so there is no ref to move.
// The owner's first-party reusable workflows under
// brettdavies/.github/.github/workflows/ pin to `@main`, because the repo that
// publishes them and the repos that call them share one owner.

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { listWorkflows, REPO_ROOT } from './helpers/workflows';

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

function listCompositeActions(): string[] {
  const dir = join(REPO_ROOT, '.github/actions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => ['action.yml', 'action.yaml'].map((name) => `.github/actions/${entry.name}/${name}`))
    .filter((path) => existsSync(join(REPO_ROOT, path)))
    .sort();
}

const SCANNED: string[] = [...listWorkflows().map((file) => `.github/workflows/${file}`), ...listCompositeActions()];

const text = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');

describe('workflow actions are pinned to commit SHAs', () => {
  test('the spec-drift workflow is scanned and pins at least one action', () => {
    expect(SCANNED).toContain('.github/workflows/spec-drift.yml');
    expect(scanUsesLines(text('.github/workflows/spec-drift.yml')).length).toBeGreaterThan(0);
  });

  test('composite actions are scanned', () => {
    expect(SCANNED).toContain('.github/actions/wrangler-crash-probe/action.yml');
  });

  test('the line scan sees every uses key the YAML parser sees', () => {
    for (const path of SCANNED) {
      const source = text(path);
      const scanned = scanUsesLines(source)
        .map((use) => use.ref)
        .sort();
      expect(scanned, `${path}: a uses value is written in a shape the pin scan cannot read`).toEqual(
        parsedUsesValues(yaml.load(source)).sort(),
      );
    }
  });

  test('every uses is a commit SHA with a version comment, or an allowed exception', () => {
    const violations = SCANNED.flatMap((path) =>
      scanUsesLines(text(path)).flatMap((use) => {
        const problem = violation(use);
        return problem ? [`${path}:${use.line}: ${problem}`] : [];
      }),
    );
    expect(violations).toEqual([]);
  });
});

describe('the pin rule rejects every movable ref', () => {
  const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

  function verdict(line: string): string | null {
    const uses = scanUsesLines(line);
    const [use] = uses;
    if (!use || uses.length !== 1) throw new Error(`fixture is not exactly one uses line: ${line}`);
    return violation(use);
  }

  const NOT_PINNED = 'is not pinned to a 40-character commit SHA';
  const NO_VERSION = 'lacks a trailing "# vX.Y.Z" version comment';

  test.each([
    ['a tag', '- uses: actions/checkout@v4 # v4.2.2', NOT_PINNED],
    ['a branch', '- uses: actions/checkout@main', NOT_PINNED],
    ['a short SHA', '- uses: actions/checkout@3d3c42e # v7.0.1', NOT_PINNED],
    ['a full SHA with no comment', `- uses: actions/checkout@${SHA}`, NO_VERSION],
    ['a full SHA whose comment names no version', `- uses: actions/checkout@${SHA} # pinned`, NO_VERSION],
    ["another owner's reusable workflow on @main", 'uses: acme/.github/.github/workflows/ci.yml@main', NOT_PINNED],
    ["the owner's reusable workflow on a tag", 'uses: brettdavies/.github/.github/workflows/ci.yml@v1', NOT_PINNED],
  ])('%s is rejected', (_label, line, problem) => {
    expect(verdict(line)).toContain(problem);
  });

  test.each([
    ['a full SHA with a version comment', `- uses: actions/checkout@${SHA} # v7.0.1`],
    ['a quoted full SHA with a version comment', `- uses: 'actions/checkout@${SHA}' # v7.0.1`],
    ['a local action', '- uses: ./.github/actions/wrangler-crash-probe'],
    ["the owner's reusable workflow on @main", 'uses: brettdavies/.github/.github/workflows/ci.yml@main'],
  ])('%s passes', (_label, line) => {
    expect(verdict(line)).toBeNull();
  });
});
