// scripts/release/preflight.sh's surface and mechanics gates read a release
// out of git: the newest `v*` tag, the dev commit that synced it back, and the
// deploy stamp CHANGELOG.md's top section names. Each case runs the repo's own
// preflight.sh, with the scripts it calls, in a fixture repository whose
// origin/main and origin/dev are plain remote-tracking refs: dev grows from
// main's first commit, as a release's squash leaves main beside dev rather
// than under it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const COPIED = [
  'scripts/release/preflight.sh',
  'scripts/release/_lib.sh',
  'scripts/release/release.env',
  'scripts/release/guarded-paths.sh',
  'scripts/release/site-version.sh',
  '.github/workflows/guard-main-docs.yml',
];

let root = '';

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GIT_')) env[key] = value;
  }
  return { ...env, NO_COLOR: '1' };
}

function run(cwd: string, cmd: string[]): { status: number; output: string } {
  const proc = Bun.spawnSync(cmd, { cwd, env: cleanEnv() });
  return { status: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

function git(cwd: string, ...args: string[]): string {
  const { status, output } = run(cwd, ['git', ...args]);
  if (status !== 0) throw new Error(`git ${args.join(' ')}: ${output}`);
  return output.trim();
}

function commit(cwd: string, subject: string, files: Record<string, string> = {}): string {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), body);
  }
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '--quiet', '--allow-empty', '-m', subject);
  return git(cwd, 'rev-parse', 'HEAD');
}

function changelog(version: string): Record<string, string> {
  return { 'CHANGELOG.md': `# Changelog\n\n## [${version}] - 2026-11-03\n\n### Fixed\n\n- Fix a page.\n` };
}

/**
 * A repository with main's first commit, one dev commit after it, and
 * origin/main and origin/dev pointing at them. Returns the dev commit.
 */
function fixture(name: string): { repo: string; main: string; dev: string } {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  for (const path of COPIED) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    copyFileSync(join(REPO_ROOT, path), join(repo, path));
  }
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'fixture');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'tag.gpgsign', 'false');
  const main = commit(repo, 'init');
  git(repo, 'update-ref', 'refs/remotes/origin/main', main);
  git(repo, 'checkout', '--quiet', '-b', 'dev');
  const dev = commit(repo, 'feat: add a page (#1)', { 'a.txt': 'a\n' });
  git(repo, 'update-ref', 'refs/remotes/origin/dev', dev);
  return { repo, main, dev };
}

function stampOf(repo: string, sha: string): string {
  const { status, output } = run(repo, ['bash', 'scripts/release/site-version.sh', '--commit', sha]);
  if (status !== 0) throw new Error(`site-version.sh --commit ${sha}: ${output}`);
  return output.trim();
}

/** Cuts release/v<stamp of dev> from origin/main with dev's tree and a changelog section. */
function cutRelease(repo: string, dev: string, heading?: string): string {
  const version = stampOf(repo, dev);
  git(repo, 'checkout', '--quiet', '-B', `release/v${version}`, 'origin/main');
  git(repo, 'checkout', dev, '--', '.');
  commit(repo, `release: v${version}`, changelog(heading ?? version));
  return version;
}

function preflight(repo: string, gate: string, path?: string): string {
  const cmd = ['bash', 'scripts/release/preflight.sh', gate];
  if (!path) return run(repo, cmd).output;
  const proc = Bun.spawnSync(cmd, { cwd: repo, env: { ...cleanEnv(), PATH: `${path}:${process.env.PATH}` } });
  return proc.stdout.toString() + proc.stderr.toString();
}

/** Writes an executable script at PATH under DIR. */
function script(dir: string, path: string, body: string): void {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), `#!/usr/bin/env bash\n${body}`);
  chmodSync(join(dir, path), 0o755);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'preflight-release-gates-'));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('preflight surface', () => {
  test('skips while the repo has no v* tag', () => {
    const { repo } = fixture('surface-untagged');
    git(repo, 'tag', 'competition-baseline');
    expect(preflight(repo, 'surface')).toContain('no tags in repo yet (first release)');
  });

  test("counts dev's commits from the commit that synced the last tag back", () => {
    const { repo } = fixture('surface-synced');
    git(repo, 'checkout', '--quiet', 'main');
    commit(repo, 'release: ship the page (#2)', changelog('0.0.1700000000-gabcdef0'));
    git(repo, 'tag', 'v0.0.1700000000-gabcdef0');
    git(repo, 'checkout', '--quiet', 'dev');
    commit(repo, 'chore(release): sync dev after v0.0.1700000000-gabcdef0 (#3)');
    const next = commit(repo, 'fix: mend the page (#4)', { 'b.txt': 'b\n' });
    git(repo, 'update-ref', 'refs/remotes/origin/dev', next);
    const output = preflight(repo, 'surface');
    expect(output).toContain('LAST_TAG = v0.0.1700000000-gabcdef0  (1 commits');
    expect(output).toContain('counted from its backport');
  });

  test('reads an older backport subject as the sync commit', () => {
    const { repo } = fixture('surface-backport');
    git(repo, 'checkout', '--quiet', 'main');
    commit(repo, 'release: ship the page (#2)');
    git(repo, 'tag', 'v0.0.1700000000-gabcdef0');
    git(repo, 'checkout', '--quiet', 'dev');
    const synced = commit(repo, 'chore(release): backport v0.0.1700000000-gabcdef0 artifacts to dev (#3)');
    git(repo, 'update-ref', 'refs/remotes/origin/dev', synced);
    expect(preflight(repo, 'surface')).toContain('counted from its backport');
  });

  test('skips when the last tag never synced back to dev', () => {
    const { repo } = fixture('surface-unsynced');
    git(repo, 'checkout', '--quiet', 'main');
    commit(repo, 'release: ship the page (#2)');
    git(repo, 'tag', 'v0.0.1700000000-gabcdef0');
    expect(preflight(repo, 'surface')).toContain('no commit there syncs it back');
  });

  test('does not take a sync of a longer tag for the last tag', () => {
    const { repo } = fixture('surface-longer');
    git(repo, 'checkout', '--quiet', 'main');
    commit(repo, 'release: ship the page (#2)');
    git(repo, 'tag', 'v0.0.170000000-gabcdef0');
    git(repo, 'checkout', '--quiet', 'dev');
    const synced = commit(repo, 'chore(release): sync dev after v0.0.170000000-gabcdef01 (#3)');
    git(repo, 'update-ref', 'refs/remotes/origin/dev', synced);
    expect(preflight(repo, 'surface')).toContain('no commit there syncs it back');
  });
});

describe('preflight mechanics: CHANGELOG.md top section', () => {
  test('passes the stamp of the dev commit the release ships', () => {
    const { repo, dev } = fixture('mechanics-pass');
    const version = cutRelease(repo, dev);
    expect(preflight(repo, 'mechanics')).toContain(
      `CHANGELOG.md top section = [${version}] (site-version.sh: is the stamp of ${dev}`,
    );
  });

  test('fails a section that is already tagged', () => {
    const { repo, dev } = fixture('mechanics-tagged');
    const version = cutRelease(repo, dev);
    git(repo, 'tag', `v${version}`);
    expect(preflight(repo, 'mechanics')).toContain(`v${version} is already tagged, so this is a released section`);
  });

  test('fails a stamp that names no commit on origin/dev', () => {
    const { repo, dev } = fixture('mechanics-unknown');
    cutRelease(repo, dev, '0.0.1700000000-g0000000');
    const output = preflight(repo, 'mechanics');
    expect(output).toContain('✗ CHANGELOG.md top section = [0.0.1700000000-g0000000]');
    expect(output).toContain('no commit on origin/dev starts with it');
  });

  test('fails a release branch with no CHANGELOG.md', () => {
    const { repo, dev } = fixture('mechanics-missing');
    const version = stampOf(repo, dev);
    git(repo, 'checkout', '--quiet', '-B', `release/v${version}`, 'origin/main');
    git(repo, 'checkout', dev, '--', '.');
    commit(repo, `release: v${version}`);
    const output = preflight(repo, 'mechanics');
    expect(output).toContain('✗ CHANGELOG.md\n');
    expect(output).toContain('missing on a release branch');
  });

  test('skips off a release branch, where the top section is the last release', () => {
    const { repo } = fixture('mechanics-dev');
    commit(repo, 'chore(release): sync dev after v0.0.1700000000-gabcdef0 (#3)', changelog('0.0.1700000000-gabcdef0'));
    git(repo, 'tag', 'v0.0.1700000000-gabcdef0');
    const output = preflight(repo, 'mechanics');
    expect(output).toContain('⊝ CHANGELOG.md top section');
    expect(output).not.toContain('already tagged');
  });

  test("compares the release tree with the stamp's commit, not dev's tip", () => {
    const { repo, dev } = fixture('mechanics-dev-moved');
    cutRelease(repo, dev);
    git(repo, 'checkout', '--quiet', '-b', 'dev-later', dev);
    const later = commit(repo, 'feat: add another page (#5)', { 'c.txt': 'c\n' });
    git(repo, 'update-ref', 'refs/remotes/origin/dev', later);
    git(repo, 'checkout', '--quiet', '-');
    const output = preflight(repo, 'mechanics');
    expect(output).toContain(`diff-B: no missed picks vs ${dev.slice(0, 12)}, the commit the stamp names`);
    expect(output).not.toContain('c.txt');
  });
});

describe('preflight changelog-sections', () => {
  // The gate wraps generate-changelog.py --audit-sections, which reads PR
  // bodies from GitHub; a stand-in generator answers for it here.
  function sections(name: string, exit: number, lines: string): string {
    const { repo } = fixture(name);
    script(repo, 'scripts/generate-changelog.py', `printf '%s\\n' ${lines}\nexit ${exit}\n`);
    const bin = join(root, `${name}-bin`);
    script(bin, 'gh', 'exit 0\n');
    return preflight(repo, 'changelog-sections', bin);
  }

  test('passes with the audit summary when every PR answers its section', () => {
    expect(sections('sections-pass', 0, "'3 PR(s) merged into dev: 3 with entries'")).toContain(
      '✓ PR changelog sections: 3 PR(s) merged into dev: 3 with entries',
    );
  });

  test('fails with the audit listing when a PR has no section', () => {
    const output = sections('sections-fail', 1, "'2 PR(s): 1 without the section' '#7 feat: x: no section'");
    expect(output).toContain('✗ PR changelog sections');
    expect(output).toContain('#7 feat: x: no section');
  });
});
