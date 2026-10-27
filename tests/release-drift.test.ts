// scripts/release/drift.sh gates every release cut on what main carries that
// dev never received. Each case builds a throwaway repository whose `main` is
// the release base and whose `dev` is the integration branch, both starting
// from one `release:` anchor commit.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const DRIFT = join(REPO_ROOT, 'scripts/release/drift.sh');

// The pre-push hook runs this suite, and a hook exports variables that pin
// every git it starts to the hook's own repository.
const GIT_REPO_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
]);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_REPO_ENV.has(key)));

let repo: string;

function git(...args: string[]): void {
  const proc = Bun.spawnSync(['git', ...args], { cwd: repo, env });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString()}`);
}

function write(path: string, body: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
}

function commit(message: string): void {
  git('add', '-A');
  git('commit', '-qm', message);
}

function runDrift(
  script: string,
  extraEnv: Record<string, string>,
  args: string[],
): { status: number; output: string } {
  const proc = Bun.spawnSync(['bash', script, '--base', 'dev', '--head', 'main', '--no-fetch', ...args], {
    cwd: repo,
    env: { ...env, ...extraEnv },
  });
  return { status: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

function drift(...args: string[]): { status: number; output: string } {
  return runDrift(DRIFT, {}, args);
}

/**
 * bun.lock holding one entry per `key=version`. A key's path nests the entry
 * under the package that pulled it in, as Bun writes it, trailing commas included.
 */
function writeBunLock(...specs: string[]): void {
  const entries = specs.map((spec) => {
    const key = spec.slice(0, spec.indexOf('='));
    const value = spec.slice(spec.indexOf('=') + 1);
    const segments = key.split('/');
    const scope = segments.at(-2);
    const name = scope?.startsWith('@') ? `${scope}/${segments.at(-1)}` : (segments.at(-1) as string);
    const resolved = value.includes('@') ? value : `${name}@${value}`;
    return `"${key}": ["${resolved}", "", {}, "sha512-x"],`;
  });
  write('bun.lock', `{"lockfileVersion":1,"workspaces":{"":{"name":"t"},},"packages":{${entries.join('')}},}\n`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'release-drift-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  write('.github/dependabot.yml', 'target-branch: dev\n');
  write('src/app.txt', 'line one\nline two\n');
  commit('release: the anchor');
  git('branch', 'dev');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('drift.sh gate 2: .github/ parity', () => {
  test('passes when .github/ is identical on both branches', () => {
    const { status, output } = drift();
    expect(output).toContain('.github/ identical on dev and main');
    expect(status).toBe(0);
  });

  test('passes workflow changes only dev holds, which the release delivers', () => {
    git('checkout', '-q', 'dev');
    write('.github/dependabot.yml', 'target-branch: dev\nnew: option\n');
    write('.github/workflows/lint.yml', 'name: lint\n');
    commit('ci: lint workflows on dev');
    git('checkout', '-q', 'main');

    const { status, output } = drift();
    expect(output).toContain('.github/: dev contains every change main carries (2 paths the release delivers)');
    expect(status).toBe(0);
  });

  test('passes a .github/ file dev deleted while main kept the anchor copy', () => {
    git('checkout', '-q', 'dev');
    git('rm', '-q', '.github/dependabot.yml');
    commit('ci: drop dependabot on dev');
    git('checkout', '-q', 'main');

    const { status, output } = drift();
    expect(output).toContain('.github/: dev contains every change main carries');
    expect(status).toBe(0);
  });

  test('fails a .github/ change main carries that dev never received', () => {
    write('.github/dependabot.yml', 'target-branch: dev\nmain-only: true\n');
    commit('ci: hotfix config on main');

    const { status, output } = drift();
    expect(output).toContain('.github/ on main holds changes dev never received');
    expect(output).toContain('differs .github/dependabot.yml');
    expect(status).toBe(1);
  });

  test('fails a .github/ file only main has', () => {
    write('.github/workflows/hotfix.yml', 'name: hotfix\n');
    commit('ci: hotfix workflow on main');

    const { status, output } = drift();
    expect(output).toContain('missing .github/workflows/hotfix.yml');
    expect(status).toBe(1);
  });

  test('fails a .github/ file dev deleted after main changed it', () => {
    git('checkout', '-q', 'dev');
    git('rm', '-q', '.github/dependabot.yml');
    commit('ci: drop dependabot on dev');
    git('checkout', '-q', 'main');
    write('.github/dependabot.yml', 'target-branch: dev\nmain-only: true\n');
    commit('ci: hotfix config on main');

    const { status, output } = drift();
    expect(output).toContain('missing .github/dependabot.yml');
    expect(status).toBe(1);
  });
});

describe('drift.sh --help', () => {
  test('prints the whole header, through the dependency list', () => {
    const { status, output } = drift('--help');
    expect(output).toContain('Exit codes:');
    expect(output).toContain('Dependencies: git');
    expect(status).toBe(2);
  });
});

describe('drift.sh gate 3: bun.lock', () => {
  // Each case moves the anchor past main's lockfile commit with a release tag,
  // so gate 1 has nothing to report and gate 3 is the only gate that can speak.
  function lockOnBoth(...specs: string[]): void {
    writeBunLock(...specs);
    commit('add bun.lock');
    git('checkout', '-q', 'dev');
    git('merge', '-q', '--ff-only', 'main');
    git('checkout', '-q', 'main');
  }

  function lockOnMain(message: string, ...specs: string[]): void {
    writeBunLock(...specs);
    commit(message);
    git('tag', '-a', 'v9.0.0', '-m', 'v9.0.0');
  }

  test('fails a package main resolves newer than dev', () => {
    lockOnBoth('left-pad=1.0.0', '@scope/pkg=2.0.0');
    lockOnMain('security bump left-pad on main', 'left-pad=1.0.1', '@scope/pkg=2.0.0');

    const { status, output } = drift();
    expect(output).toContain('bun.lock: 1 packages newer on main');
    expect(output).not.toContain('@scope/pkg');
    expect(status).toBe(1);
  });

  test('passes a file: or workspace: spec, which is not a newer version', () => {
    lockOnBoth('left-pad=1.0.0', '@scope/contracts=0.2.0');
    lockOnMain(
      'link the vendored contracts on main',
      'left-pad=1.0.0',
      '@scope/contracts=file:./vendor/contracts',
      '@scope/sdk/@scope/contracts=workspace:packages/contracts',
    );

    const { status, output } = drift();
    expect(output).toContain('bun.lock: nothing newer on main');
    expect(status).toBe(0);
  });

  test('passes a copy main nests under a package dev does not carry', () => {
    lockOnBoth('get-stream=5.2.0', 'extract-zip=2.0.1');
    lockOnMain(
      'a dependency on main pulls execa',
      'get-stream=5.2.0',
      'extract-zip=2.0.1',
      'execa=5.1.1',
      'execa/get-stream=6.0.1',
    );

    const { status, output } = drift();
    expect(output).toContain('bun.lock: nothing newer on main');
    expect(status).toBe(0);
  });

  test('fails a newer copy main nests under a package dev also carries', () => {
    lockOnBoth('undici=7.28.0', 'unifont=1.0.0', 'unifont/undici=8.10.1');
    lockOnMain("security bump unifont's undici on main", 'undici=7.28.0', 'unifont=1.0.0', 'unifont/undici=8.11.2');

    const { status, output } = drift();
    expect(output).toContain('bun.lock: 1 packages newer on main');
    expect(output).toContain('main=8.11.2');
    expect(status).toBe(1);
  });
});

describe('drift.sh gate 1: line-by-line containment', () => {
  test('flags a main change dev lacks when diff is BSD diff, which rejects the GNU line formats', () => {
    write('src/three.txt', 'line one\nline two\nline three\n');
    commit('add three');
    git('checkout', '-q', 'dev');
    git('merge', '-q', '--ff-only', 'main');
    write('src/three.txt', 'line one\nline two on dev\nline three\n');
    commit('dev edits line two');
    git('checkout', '-q', 'main');
    git('tag', '-a', 'v9.0.0', '-m', 'v9.0.0');
    write('src/three.txt', 'line one on main\nline two\nline three\n');
    commit('hotfix line one on main');

    const shim = join(repo, '.bsd-diff');
    const realDiff = Bun.which('diff') as string;
    write(
      '.bsd-diff/diff',
      `#!/bin/sh\nfor arg in "$@"; do case "$arg" in --*-line-format*) echo "diff: unrecognized option '$arg'" >&2; exit 2 ;; esac; done\nexec ${realDiff} "$@"\n`,
    );
    chmodSync(join(shim, 'diff'), 0o755);

    const { status, output } = runDrift(DRIFT, { PATH: `${shim}:${env.PATH}` }, []);
    expect(output).toContain('differs   src/three.txt');
    expect(status).toBe(1);
  });
});

describe('drift.sh gate 0: version carriers', () => {
  test('checks a carrier release.env adds to VERSION_CARRIERS', () => {
    write('packages/a/package.json', '{\n  "name": "a",\n  "version": "1.0.0"\n}\n');
    commit('add workspace member a');
    git('checkout', '-q', 'dev');
    git('merge', '-q', '--ff-only', 'main');
    git('checkout', '-q', 'main');
    write('packages/a/package.json', '{\n  "name": "a",\n  "version": "1.1.0"\n}\n');
    commit('release: a 1.1.0');

    const scripts = join(repo, '.release-scripts');
    mkdirSync(scripts);
    for (const file of ['drift.sh', '_lib.sh']) {
      copyFileSync(join(REPO_ROOT, 'scripts/release', file), join(scripts, file));
    }
    writeFileSync(join(scripts, 'release.env'), 'VERSION_CARRIERS="package.json packages/a/package.json"\n');

    const { status, output } = runDrift(join(scripts, 'drift.sh'), {}, []);
    expect(output).toContain('packages/a/package.json');
    expect(status).toBe(1);
  });
});
