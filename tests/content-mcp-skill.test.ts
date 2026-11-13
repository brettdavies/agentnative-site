// The client guide's example answers are what an agent copies its expectations
// from, so each example carries the spec version the server sends.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

const GUIDE = join(import.meta.dir, '..', 'content', 'mcp-skill.md');

describe('content/mcp-skill.md examples', () => {
  test('every spec_version in an example answer is the version the server sends', async () => {
    const guide = await readFile(GUIDE, 'utf8');
    const literals = [...guide.matchAll(/"spec_version":\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(literals.length).toBeGreaterThan(0);
    expect(literals.filter((value) => value !== SPEC_VERSION)).toEqual([]);
  });
});
