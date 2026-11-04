// scripts/monitoring/check-kill-switch.sh reads SCORE_KV through wrangler and
// reports a JSON verdict. A stand-in `bun` on PATH answers as wrangler does, so
// what runs is the script's own shell, under its own pipefail.

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

// 110 KB, in lines, past the 64 KB pipe buffer and under the 128 KB ceiling on one
// argument, because the script hands this text to jq as an --arg.
const PADDING = `${'x'.repeat(79)}\n`.repeat(1375);

function check(stderr: string): { status: number; verdict: { status: string; disabled?: unknown } } {
  const bin = mkdtempSync(join(tmpdir(), 'check-kill-switch-'));
  try {
    writeFileSync(join(bin, 'stderr.txt'), stderr);
    writeFileSync(join(bin, 'bun'), `#!/usr/bin/env bash\ncat "${bin}/stderr.txt" >&2\nexit 1\n`);
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
  test('reads a missing key as ok, however much stderr follows the not-found line', () => {
    const { status, verdict } = check(`Value not found\n${PADDING}`);
    expect(verdict.status).toBe('ok');
    expect(status).toBe(0);
  });

  test('reads any other wrangler failure as an error', () => {
    const { status, verdict } = check(`network unreachable\n${PADDING}`);
    expect(verdict.status).toBe('error');
    expect(status).toBe(4);
  });
});
