// scripts/ops/flip-kill-switch.sh is the incident tool for turning live scoring off.
// A stand-in `bun` on PATH records what it was asked, so no test here reaches Cloudflare.
// It answers exit 0 either way, as wrangler does: without --remote wrangler writes a
// local store and reports success, so the exit status cannot show the flip reached KV.

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

function flip(...args: string[]): {
  status: number;
  calls: string;
  verdict: { status: string; evidence: Record<string, unknown> };
} {
  const bin = mkdtempSync(join(tmpdir(), 'flip-kill-switch-'));
  try {
    writeFileSync(join(bin, 'bun'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"${bin}/calls.log"\nexit 0\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    writeFileSync(join(bin, 'calls.log'), '');
    const proc = Bun.spawnSync(['bash', join(REPO_ROOT, 'scripts/ops/flip-kill-switch.sh'), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return {
      status: proc.exitCode,
      calls: readFileSync(join(bin, 'calls.log'), 'utf8'),
      verdict: JSON.parse(proc.stdout.toString()),
    };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe('flip-kill-switch writes deployed KV', () => {
  test.each([
    ['staging on', ['--env', 'staging', '--on'], 'kv key put', '--env staging'],
    ['staging off', ['--env', 'staging', '--off'], 'kv key delete', '--env staging'],
    ['production on', ['--env', 'production', '--on', '--yes'], 'kv key put', ''],
    ['production off', ['--env', 'production', '--off', '--yes'], 'kv key delete', ''],
  ])('%s passes --remote', (_name, args, verb, envFlag) => {
    const { status, calls, verdict } = flip(...args);
    expect(calls).toContain(verb);
    expect(calls).toContain('--remote');
    expect(calls).toContain('scoring_disabled');
    if (envFlag) expect(calls).toContain(envFlag);
    else expect(calls).not.toContain('--env');
    expect(verdict.status).toBe('ok');
    expect(status).toBe(0);
  });

  test('--dry-run names the remote write and calls nothing', () => {
    const { calls, verdict } = flip('--env', 'staging', '--on', '--dry-run');
    expect(calls).toBe('');
    expect(String(verdict.evidence.would_run)).toContain('--remote');
  });
});
