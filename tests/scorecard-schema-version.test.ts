// Drift guard for content/scorecard-schema.md's stated current
// schema_version. The doc is prose, so nothing structural stops a "Current:
// 0.6." reference from outliving a schema bump — this test pins the doc's
// two current-version surfaces (the top-level example JSON and the
// field-table "Current: X." sentence) to the maximum of the build's
// SUPPORTED_SCHEMA_VERSIONS. When the supported set gains a new maximum,
// this fails until the doc is updated alongside it.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareVersions, SUPPORTED_SCHEMA_VERSIONS } from '../src/build/scorecards.mjs';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const DOC_PATH = join(REPO_ROOT, 'content', 'scorecard-schema.md');

function maxSupportedVersion(): string {
  return [...SUPPORTED_SCHEMA_VERSIONS].sort(compareVersions).at(-1) as string;
}

describe('scorecard-schema doc current-version drift guard', () => {
  test('the field-table "Current: X." sentence matches max(SUPPORTED_SCHEMA_VERSIONS)', async () => {
    const doc = await readFile(DOC_PATH, 'utf8');
    const m = doc.match(/Current: (\d+\.\d+)\./);
    expect(m).not.toBeNull();
    expect((m as RegExpMatchArray)[1]).toBe(maxSupportedVersion());
  });

  test('the top-level example JSON schema_version matches max(SUPPORTED_SCHEMA_VERSIONS)', async () => {
    const doc = await readFile(DOC_PATH, 'utf8');
    const m = doc.match(/"schema_version": "(\d+\.\d+)"/);
    expect(m).not.toBeNull();
    expect((m as RegExpMatchArray)[1]).toBe(maxSupportedVersion());
  });

  test('the documented current version is a member of SUPPORTED_SCHEMA_VERSIONS', async () => {
    const doc = await readFile(DOC_PATH, 'utf8');
    const m = doc.match(/Current: (\d+\.\d+)\./);
    expect(SUPPORTED_SCHEMA_VERSIONS.has((m as RegExpMatchArray)[1])).toBe(true);
  });

  test('the historical "Added in 0.6." field annotations are preserved', async () => {
    const doc = await readFile(DOC_PATH, 'utf8');
    const annotations = doc.match(/Added in 0\.6\./g) ?? [];
    expect(annotations.length).toBeGreaterThanOrEqual(3);
  });
});
