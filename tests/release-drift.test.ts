// scripts/release/drift.sh gates every release cut on what main carries that
// dev never received. Each case builds a throwaway repository whose `main` is
// the release base and whose `dev` is the integration branch, both starting
// from one `release:` anchor commit.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function drift(...args: string[]): { status: number; output: string } {
  const proc = Bun.spawnSync(['bash', DRIFT, '--base', 'dev', '--head', 'main', '--no-fetch', ...args], {
    cwd: repo,
    env,
  });
  return { status: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'release-drift-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
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
