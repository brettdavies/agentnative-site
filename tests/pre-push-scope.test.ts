// scripts/hooks/pre-push runs nothing for a push that brings no commit: one
// that only deletes, one with no ref to update, and a tag or new branch at a
// commit a remote-tracking branch already reaches. Each case runs the hook in a
// fixture repository holding the hook and its library, with a `bun` on PATH
// that fails at once, so a push that does bring a commit stops at the first
// stage instead of running the suite.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const ZERO = '0'.repeat(40);

let root = '';
let repo = '';
let bin = '';
let known = '';
let fresh = '';

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GIT_')) env[key] = value;
  }
  return env;
}

function git(...args: string[]): string {
  const proc = Bun.spawnSync(['git', ...args], { cwd: repo, env: cleanEnv() });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pre-push-scope-'));
  repo = join(root, 'repo');
  bin = join(root, 'bin');
  mkdirSync(join(repo, 'scripts/hooks'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(join(REPO_ROOT, 'scripts/hooks/pre-push'), join(repo, 'scripts/hooks/pre-push'));
  copyFileSync(join(REPO_ROOT, 'scripts/hooks/_lib.sh'), join(repo, 'scripts/hooks/_lib.sh'));
  writeFileSync(join(bin, 'bun'), '#!/usr/bin/env bash\necho "stub bun: $*"\nexit 3\n');
  chmodSync(join(bin, 'bun'), 0o755);

  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'fixture');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'known');
  known = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', known);
  writeFileSync(join(repo, 'new.txt'), 'new\n');
  git('add', 'new.txt');
  git('commit', '--quiet', '-m', 'fresh');
  fresh = git('rev-parse', 'HEAD');
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function prePush(stdin: string, args: string[] = ['origin', 'https://example.invalid/repo.git']) {
  const proc = Bun.spawnSync(['bash', 'scripts/hooks/pre-push', ...args], {
    cwd: repo,
    stdin: new TextEncoder().encode(stdin),
    env: { ...cleanEnv(), PATH: `${bin}:${process.env.PATH}`, HOOK_STDIN_WAIT_SECONDS: '1' },
  });
  return { status: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

describe('pre-push push scope', () => {
  test('a tag at a commit the remote already has runs nothing', () => {
    const { status, output } = prePush(`refs/tags/v0.0.1-gabc1234 ${known} refs/tags/v0.0.1-gabc1234 ${ZERO}\n`);
    expect(output).toContain('Nothing to check: every pushed commit is already on origin.');
    expect(status).toBe(0);
  });

  test('a push that only deletes runs nothing', () => {
    const { status, output } = prePush(`(delete) ${ZERO} refs/heads/old ${known}\n`);
    expect(output).toContain('Nothing to check: the push only deletes.');
    expect(status).toBe(0);
  });

  test('a push with no ref to update runs nothing', () => {
    const { status, output } = prePush('');
    expect(output).toContain('pre-push: nothing to push');
    expect(status).toBe(0);
  });

  test('a branch with a new commit runs the stages', () => {
    const { status, output } = prePush(`refs/heads/feat ${fresh} refs/heads/feat ${ZERO}\n`);
    expect(output).toContain('stub bun: run lint');
    expect(output).not.toContain('Nothing to check');
    expect(status).not.toBe(0);
  });

  test('a known tag beside a branch with a new commit runs the stages', () => {
    const { status, output } = prePush(
      `refs/tags/v0.0.1-gabc1234 ${known} refs/tags/v0.0.1-gabc1234 ${ZERO}\nrefs/heads/feat ${fresh} refs/heads/feat ${ZERO}\n`,
    );
    expect(output).toContain('stub bun: run lint');
    expect(status).not.toBe(0);
  });
});
