// The skill bundle under skill/agent-native-cli/ ships as one archive, so every
// tracked file in it has to survive the archive's path and mode rules. These
// checks read the git index, which is the list the package builder reads.

import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { REPO_ROOT } from './helpers/workflows';

const PACKAGE_DIR = 'skill/agent-native-cli';
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;
const MAX_PATH_BYTES = 100;
const MAX_FILES = 512;
const MAX_BYTES = 16 * 1024 * 1024;

interface IndexEntry {
  mode: string;
  path: string;
}

function packageIndex(): IndexEntry[] {
  const proc = Bun.spawnSync(['git', 'ls-files', '-z', '-s', PACKAGE_DIR], { cwd: REPO_ROOT });
  if (proc.exitCode !== 0) throw new Error(`git ls-files: ${proc.stderr.toString()}`);
  return proc.stdout
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t');
      return { mode: meta.split(' ')[0], path: path.slice(PACKAGE_DIR.length + 1) };
    });
}

function onDisk(path: string): string {
  return join(REPO_ROOT, PACKAGE_DIR, path);
}

const entries = packageIndex();

describe('skill package tree', () => {
  test('the tree is tracked and non-empty', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  test('every path is a regular file with no symlink and no dotfile', () => {
    const violations: string[] = [];
    for (const { mode, path } of entries) {
      if (mode !== '100644' && mode !== '100755') violations.push(`${path}: index mode ${mode}`);
      if (path.split('/').some((segment) => segment.startsWith('.'))) violations.push(`${path}: dotfile`);
      if (!existsSync(onDisk(path)) || !lstatSync(onDisk(path)).isFile()) {
        violations.push(`${path}: not a regular file on disk`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('every path is ASCII and at most 100 bytes, so it fits a ustar name field', () => {
    const violations: string[] = [];
    for (const { path } of entries) {
      if (!ASCII_PRINTABLE.test(path)) violations.push(`${path}: not printable ASCII`);
      if (Buffer.byteLength(path) > MAX_PATH_BYTES) violations.push(`${path}: over ${MAX_PATH_BYTES} bytes`);
    }
    expect(violations).toEqual([]);
  });

  test('every path segment matches the archive segment pattern', () => {
    const violations: string[] = [];
    for (const { path } of entries) {
      for (const segment of path.split('/')) {
        if (!SEGMENT.test(segment) || segment === '.' || segment === '..') {
          violations.push(`${path}: segment "${segment}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('the executable set is bin/check-update alone', () => {
    const executable = entries.filter((entry) => entry.mode === '100755').map((entry) => entry.path);
    expect(executable).toEqual(['bin/check-update']);
  });

  test('the tree stays within the SEP-2640 file and size limits', () => {
    expect(entries.length).toBeLessThanOrEqual(MAX_FILES);
    const total = entries.reduce((sum, { path }) => sum + readFileSync(onDisk(path)).length, 0);
    expect(total).toBeLessThanOrEqual(MAX_BYTES);
  });

  test('SKILL.md sits at the root and its frontmatter name equals the directory name', () => {
    const body = readFileSync(onDisk('SKILL.md'), 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n/.exec(body);
    expect(match).not.toBeNull();
    const { name } = load(match?.[1] ?? '') as { name?: string };
    expect(name).toBe('agent-native-cli');
    expect(PACKAGE_DIR.split('/').at(-1)).toBe(name);
  });
});
