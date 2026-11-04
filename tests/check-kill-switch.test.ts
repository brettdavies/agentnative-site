// scripts/monitoring/check-kill-switch.sh reads SCORE_KV through wrangler and
// reports a JSON verdict. A stand-in `bun` on PATH answers with the shapes wrangler
// 4.153 produces: a key that is absent is exit 0 with `Value not found` on stdout,
// and "not found" on stderr with a non-zero exit means the read itself failed.

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

interface Wrangler {
  stdout?: string;
  stderr?: string;
  exit?: number;
}

function check({ stdout = '', stderr = '', exit = 0 }: Wrangler): { status: number; verdict: { status: string } } {
  const bin = mkdtempSync(join(tmpdir(), 'check-kill-switch-'));
  try {
    writeFileSync(join(bin, 'stdout.txt'), stdout);
    writeFileSync(join(bin, 'stderr.txt'), stderr);
    writeFileSync(
      join(bin, 'bun'),
      `#!/usr/bin/env bash\ncat "${bin}/stdout.txt"\ncat "${bin}/stderr.txt" >&2\nexit ${exit}\n`,
    );
    chmodSync(join(bin, 'bun'), 0o755);
    const proc = Bun.spawnSync(
      ['bash', join(REPO_ROOT, 'scripts/monitoring/check-kill-switch.sh'), '--env', 'staging'],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    return { status: proc.exitCode, verdict: JSON.parse(proc.stdout.toString()) };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe('check-kill-switch', () => {
  test('reads an absent key as ok', () => {
    const { status, verdict } = check({ stdout: 'Value not found\n' });
    expect(verdict.status).toBe('ok');
    expect(status).toBe(0);
  });

  test('reads false as ok and true as a warning', () => {
    expect(check({ stdout: 'false\n' }).verdict.status).toBe('ok');
    const { status, verdict } = check({ stdout: 'true\n' });
    expect(verdict.status).toBe('warn');
    expect(status).toBe(1);
  });

  test.each([
    ['a missing bun', 'bash: bun: command not found\n', 127],
    ['a namespace that answers 404', 'Failed to fetch .../values/scoring_disabled - 404: Not Found\n', 1],
    ['a network failure', 'network unreachable\n', 1],
  ])('reads %s as an error, never as an absent key', (_name, stderr, exit) => {
    const { status, verdict } = check({ stderr, exit });
    expect(verdict.status).toBe('error');
    expect(status).toBe(4);
  });
});
