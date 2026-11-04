// scripts/monitoring/check-kill-switch.sh reports whether the deployed kill switch is
// on. A stand-in `bun` on PATH answers as wrangler 4.153 does, measured against
// staging: without --remote wrangler reads a local store and exits 0 on every key;
// `kv key get --remote` answers an absent key and a missing namespace with one 404;
// `kv key list --remote` tells them apart.

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const FAKE_BUN = `#!/usr/bin/env bash
case " $* " in
  *" --remote "*) ;;
  *) echo 'Resource location: local' >&2; echo 'Value not found'; exit 0 ;;
esac
case " $* " in
  *" kv key list "*) cat "$FAKE_BUN_DIR/list.stdout"; cat "$FAKE_BUN_DIR/list.stderr" >&2; exit "$(cat "$FAKE_BUN_DIR/list.exit")" ;;
  *" kv key get "*) cat "$FAKE_BUN_DIR/get.stdout"; cat "$FAKE_BUN_DIR/get.stderr" >&2; exit "$(cat "$FAKE_BUN_DIR/get.exit")" ;;
esac
exit 64
`;

const NOT_FOUND = 'Failed to fetch /values/scoring_disabled - 404: Not Found\n';
const ABSENT = { list: '[]\n', get: { stderr: NOT_FOUND, exit: 1 } };
const present = (value: string) => ({
  list: '[{"name":"scoring_disabled"}]\n',
  get: { stdout: `${value}\n` },
});

interface Wrangler {
  list?: string;
  listStderr?: string;
  listExit?: number;
  get?: { stdout?: string; stderr?: string; exit?: number };
}

function check(
  { list = '', listStderr = '', listExit = 0, get = {} }: Wrangler,
  args = ['--env', 'staging'],
): { status: number; verdict: { status: string; evidence: Record<string, unknown> } } {
  const bin = mkdtempSync(join(tmpdir(), 'check-kill-switch-'));
  try {
    writeFileSync(join(bin, 'bun'), FAKE_BUN);
    chmodSync(join(bin, 'bun'), 0o755);
    writeFileSync(join(bin, 'list.stdout'), list);
    writeFileSync(join(bin, 'list.stderr'), listStderr);
    writeFileSync(join(bin, 'list.exit'), String(listExit));
    writeFileSync(join(bin, 'get.stdout'), get.stdout ?? '');
    writeFileSync(join(bin, 'get.stderr'), get.stderr ?? '');
    writeFileSync(join(bin, 'get.exit'), String(get.exit ?? 0));
    const proc = Bun.spawnSync(['bash', join(REPO_ROOT, 'scripts/monitoring/check-kill-switch.sh'), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_BUN_DIR: bin },
    });
    return { status: proc.exitCode, verdict: JSON.parse(proc.stdout.toString()) };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe('check-kill-switch reads deployed KV', () => {
  test('an absent key is ok', () => {
    const { status, verdict } = check(ABSENT);
    expect(verdict.status).toBe('ok');
    expect(status).toBe(0);
  });

  test('a key that only shares the prefix is absent', () => {
    const { status, verdict } = check({ list: '[{"name":"scoring_disabled_note"}]\n', get: ABSENT.get });
    expect(verdict.status).toBe('ok');
    expect(status).toBe(0);
  });

  test('true is a warning, and false is ok', () => {
    const on = check(present('true'));
    expect(on.verdict.status).toBe('warn');
    expect(on.status).toBe(1);
    expect(check(present('false')).verdict.status).toBe('ok');
  });

  test('an unexpected value is a warning, not ok', () => {
    const { status, verdict } = check(present('maybe'));
    expect(verdict.status).toBe('warn');
    expect(status).toBe(1);
  });

  test.each([
    ['a missing namespace', 'A request to the Cloudflare API failed: namespace not found\n', 1],
    ['a missing bun', 'bash: bun: command not found\n', 127],
    ['a network failure', 'network unreachable\n', 1],
  ])('%s is an error, never an absent key', (_name, listStderr, listExit) => {
    const { status, verdict } = check({ listStderr, listExit });
    expect(verdict.status).toBe('error');
    expect(status).toBe(4);
  });

  test('a failed read of a key the listing named is an error', () => {
    const { status, verdict } = check({
      list: '[{"name":"scoring_disabled"}]\n',
      get: { stderr: 'network unreachable\n', exit: 1 },
    });
    expect(verdict.status).toBe('error');
    expect(status).toBe(4);
  });

  test('a listing it cannot parse is an error, never an absent key', () => {
    const { status, verdict } = check({ list: 'not json\n', get: ABSENT.get });
    expect(verdict.status).toBe('error');
    expect(status).toBe(4);
  });

  test('--dry-run names the remote read', () => {
    const { verdict } = check({}, ['--env', 'staging', '--dry-run']);
    expect(String(verdict.evidence.would_run)).toContain('--remote');
  });
});
