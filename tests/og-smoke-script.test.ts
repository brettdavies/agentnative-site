// scripts/og/smoke.sh against a stubbed bunx on PATH: a help request or a
// base URL that is not one prints usage and stops before the fixture Worker
// deploys on anc.dev.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const SMOKE = join(REPO_ROOT, 'scripts/og/smoke.sh');

let stub: string;

function smoke(...args: string[]): { status: number; stdout: string; stderr: string; calls: string[] } {
  const proc = Bun.spawnSync(['bash', SMOKE, ...args], {
    env: { ...process.env, PATH: `${join(stub, 'bin')}:${process.env.PATH}` },
  });
  const calls = existsSync(join(stub, 'calls')) ? readFileSync(join(stub, 'calls'), 'utf8').trim().split('\n') : [];
  return { status: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), calls };
}

beforeEach(() => {
  stub = mkdtempSync(join(tmpdir(), 'og-smoke-'));
  Bun.spawnSync(['mkdir', '-p', join(stub, 'bin')]);
  writeFileSync(join(stub, 'bin', 'bunx'), `#!/usr/bin/env bash\necho "$*" >>"${stub}/calls"\nexit 1\n`);
  chmodSync(join(stub, 'bin', 'bunx'), 0o755);
});

afterEach(() => rmSync(stub, { recursive: true, force: true }));

describe('scripts/og/smoke.sh', () => {
  test.each([[['--help']], [['-h']], [['http://localhost:8787', '--help']]])(
    '%j prints usage on stdout, exits 0 and deploys nothing',
    (args) => {
      const run = smoke(...args);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('Usage: scripts/og/smoke.sh <base-url>');
      expect(run.calls).toEqual([]);
    },
  );

  test.each([
    [[]],
    [['not-a-url']],
    [['anc.dev']],
    [['--bogus']],
    [['https://']],
    [['http://localhost:8787', 'extra']],
  ])('arguments %j name the problem on stderr, exit 2 and deploy nothing', (args) => {
    const run = smoke(...args);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Usage: scripts/og/smoke.sh <base-url>');
    expect(run.calls).toEqual([]);
  });

  test('an http(s) base URL reaches the fixture deploy', () => {
    const run = smoke('http://localhost:8787');
    expect(run.calls[0]).toStartWith('wrangler deploy --config');
  });
});
