// The skill bundle under skill/agent-native-cli/ ships as one archive, so every
// tracked file in it has to survive the archive's path and mode rules. These
// checks read the git index, which is the list the package builder reads.

import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { REPO_ROOT } from './helpers/workflows';

const DESCRIPTION_MAX = 1024;
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const AGENT_SKILLS_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);
const GIT_INSTALL_MARKERS = [
  'git clone',
  'git pull',
  'git -C',
  'raw.githubusercontent.com',
  'github.com/brettdavies/agentnative-skill',
];

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

  test('SKILL.md frontmatter name is a valid skill name', () => {
    const { name } = frontmatter();
    expect(typeof name === 'string' && name.length <= 64 && SKILL_NAME.test(name)).toBe(true);
  });
});

function frontmatter(): { name?: string; description?: string } & Record<string, unknown> {
  const body = readFileSync(onDisk('SKILL.md'), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(body);
  return load(match?.[1] ?? '') as Record<string, unknown>;
}

function bundleText(path: string): string {
  return readFileSync(onDisk(path), 'utf8');
}

function bundleMarkdown(): string[] {
  return entries.map((entry) => entry.path).filter((path) => path.endsWith('.md'));
}

function installDestinations(): Record<string, string> {
  const source = JSON.parse(readFileSync(join(REPO_ROOT, 'src/data/skill/skill.json'), 'utf8')) as {
    install: Record<string, string>;
  };
  return Object.fromEntries(
    Object.entries(source.install).map(([host, command]) => [host, command.split(' ').at(-1) ?? '']),
  );
}

describe('skill description', () => {
  test('the parsed description is 1 to 1,024 characters', () => {
    const description = frontmatter().description ?? '';
    expect(description.length).toBeGreaterThanOrEqual(1);
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });

  test('the frontmatter holds only keys the Agent Skills spec defines', () => {
    const extra = Object.keys(frontmatter()).filter((key) => !AGENT_SKILLS_FRONTMATTER_KEYS.has(key));
    expect(extra).toEqual([]);
  });

  test('the description keeps the literal scorecard schema version the version model tracks', () => {
    expect(frontmatter().description).toContain('scorecard schema 0.9');
  });
});

describe('skill install and update prose', () => {
  test('no bundle file outside the vendored spec names a git install', () => {
    const hits: string[] = [];
    for (const { path } of entries) {
      if (path.startsWith('spec/')) continue;
      const text = bundleText(path);
      for (const marker of GIT_INSTALL_MARKERS) {
        if (text.includes(marker)) hits.push(`${path}: ${marker}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test('update-check.md runs anc --version before the first anc skill update', () => {
    const text = bundleText('references/update-check.md');
    const check = text.indexOf('anc --version');
    const update = text.indexOf('anc skill update');
    expect(check).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(check);
  });

  test('update-check.md lists every host slug beside its destination', () => {
    const text = bundleText('references/update-check.md');
    const missing = Object.entries(installDestinations())
      .filter(
        ([host, destination]) =>
          !text.split('\n').some((line) => line.includes(`\`${host}\``) && line.includes(destination)),
      )
      .map(([host]) => host);
    expect(missing).toEqual([]);
  });

  test('SKILL.md tells a skill:// reader to skip the update check', () => {
    expect(bundleText('SKILL.md')).toContain('skill://');
  });

  test('no bundle markdown resolves the update check through $0, and SKILL.md names the skill directory', () => {
    const hits = bundleMarkdown().filter((path) => bundleText(path).includes('dirname "$0"'));
    expect(hits).toEqual([]);
    const firstAction = bundleText('SKILL.md').split('## First action: update check')[1]?.split('\n## ')[0] ?? '';
    expect(firstAction).toMatch(/bash <skill-dir>\/bin\/check-update/);
    expect(firstAction).toContain('the directory this `SKILL.md` was read from');
  });
});
