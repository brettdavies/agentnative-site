// scripts/monitoring/check-kill-switch.sh reports whether the deployed kill switch is
// on. A stand-in `bun` on PATH answers as wrangler 4.153 does, measured against
// staging: without --remote wrangler reads a local store and exits 0 on every key;
// `kv key get --remote` answers an absent key and a missing namespace with one 404;
// `kv key list --remote` exits 0 for an absent key and non-zero for a missing namespace.
// KV listings are eventually consistent, so a listing can disagree with `get` just
// after a flip, and these cases hold that the value comes from `get`.

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const FAKE_BUN = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_BUN_DIR/calls.log"
case " $* " in
  *" --remote "*) ;;
  *) echo 'Resource location: local' >&2; echo 'Value not found'; exit 0 ;;
esac
case " $* " in
  *" kv key get "*) cat "$FAKE_BUN_DIR/get.stdout"; cat "$FAKE_BUN_DIR/get.stderr" >&2; exit "$(cat "$FAKE_BUN_DIR/get.exit")" ;;
  *" kv key list "*) cat "$FAKE_BUN_DIR/list.stdout"; cat "$FAKE_BUN_DIR/list.stderr" >&2; exit "$(cat "$FAKE_BUN_DIR/list.exit")" ;;
esac
exit 64
`;

const NOT_FOUND = { stderr: 'Failed to fetch /values/scoring_disabled - 404: Not Found\n', exit: 1 };
const LISTED = '[{"name":"scoring_disabled"}]\n';
const value = (stored: string) => ({ stdout: `${stored}\n` });

interface Wrangler {
  get?: { stdout?: string; stderr?: string; exit?: number };
  list?: { stdout?: string; stderr?: string; exit?: number };
}

function check(
  { get = {}, list = {} }: Wrangler,
  args = ['--env', 'staging'],
): { status: number; calls: string; verdict: { status: string; evidence: Record<string, unknown> } } {
  const bin = mkdtempSync(join(tmpdir(), 'check-kill-switch-'));
  try {
    writeFileSync(join(bin, 'bun'), FAKE_BUN);
    chmodSync(join(bin, 'bun'), 0o755);
    writeFileSync(join(bin, 'calls.log'), '');
    writeFileSync(join(bin, 'get.stdout'), get.stdout ?? '');
    writeFileSync(join(bin, 'get.stderr'), get.stderr ?? '');
    writeFileSync(join(bin, 'get.exit'), String(get.exit ?? 0));
    writeFileSync(join(bin, 'list.stdout'), list.stdout ?? '[]\n');
    writeFileSync(join(bin, 'list.stderr'), list.stderr ?? '');
    writeFileSync(join(bin, 'list.exit'), String(list.exit ?? 0));
    const proc = Bun.spawnSync(['bash', join(REPO_ROOT, 'scripts/monitoring/check-kill-switch.sh'), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_BUN_DIR: bin },
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

describe('check-kill-switch reads deployed KV', () => {
  test('an absent key is ok', () => {
    const { status, verdict } = check({ get: NOT_FOUND });
    expect(verdict.status).toBe('ok');
    expect(status).toBe(0);
  });

  test('a key just flipped off is ok, though a stale listing still names it', () => {
    const { status, verdict } = check({ get: NOT_FOUND, list: { stdout: LISTED } });
    expect(verdict.status).toBe('ok');
    expect(status).toBe(0);
  });

  test('a key just flipped on is a warning, though a stale listing misses it', () => {
    const { status, verdict } = check({ get: value('true'), list: { stdout: '[]\n' } });
    expect(verdict.status).toBe('warn');
    expect(status).toBe(1);
  });

  test('false is ok', () => {
    const { status, verdict } = check({ get: value('false') });
    expect(verdict.status).toBe('ok');
    expect(status).toBe(0);
  });

  test('an unexpected value is a warning, not ok', () => {
    const { status, verdict } = check({ get: value('maybe') });
    expect(verdict.status).toBe('warn');
    expect(status).toBe(1);
  });

  test('a missing namespace is an error, though its get is the same 404 as an absent key', () => {
    const { status, verdict } = check({
      get: NOT_FOUND,
      list: { stderr: 'A request to the Cloudflare API failed\n', exit: 1 },
    });
    expect(verdict.status).toBe('error');
    expect(status).toBe(4);
  });

  test.each([
    ['a missing bun', 'bash: bun: command not found\n', 127],
    ['a network failure', 'network unreachable\n', 1],
    ['an auth failure', 'Authentication error [code: 10000]\n', 1],
  ])('%s is an error, and the listing is not asked', (_name, stderr, exit) => {
    const { status, calls, verdict } = check({ get: { stderr, exit } });
    expect(verdict.status).toBe('error');
    expect(status).toBe(4);
    expect(calls).not.toContain('kv key list');
  });

  test('reads the environment it was asked about', () => {
    const staging = check({ get: value('false') }, ['--env', 'staging']);
    expect(staging.calls).toContain('--env staging');
    const production = check({ get: value('false') }, ['--env', 'production']);
    expect(production.calls).toContain('kv key get --remote');
    expect(production.calls).not.toContain('--env');
  });

  test('--dry-run names both remote reads and runs neither', () => {
    const { calls, verdict } = check({}, ['--env', 'staging', '--dry-run']);
    expect(calls).toBe('');
    const wouldRun = verdict.evidence.would_run as string[];
    expect(wouldRun.some((command) => command.includes('kv key get --remote'))).toBe(true);
    expect(wouldRun.some((command) => command.includes('kv key list --remote'))).toBe(true);
  });
});
