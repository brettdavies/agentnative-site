// scripts/og/setup.sh against a stubbed wrangler and 1Password reader on
// PATH: the create, verify, pending and check-only paths, in prose and
// --json, and the queue names both Worker configs declare.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const SETUP = join(REPO_ROOT, 'scripts/og/setup.sh');
const KEY = 'ctx-test-key-value';

const WRANGLER_STUB = `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"$STUB/calls"
name=""
for ((i = 1; i <= $#; i++)); do [[ "\${!i}" == --name ]] && { j=$((i + 1)); name="\${!j}"; }; done
case "$1 $2" in
  "queues list") printf '┌──────┐\\n│ name │\\n'; while read -r q; do printf '│ %s │\\n' "$q"; done <"$STUB/queues" ;;
  "queues create") echo "$3" >>"$STUB/queues" ;;
  "secret list") [[ -f "$STUB/secrets-$name" ]] || { echo "This Worker does not exist" >&2; exit 1; }; cat "$STUB/secrets-$name" ;;
  "secret put") cat >"$STUB/put-$name-$3" ;;
  "secret delete") echo "deleted" ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`;

let stub: string;

function secrets(worker: string, names: string[]): void {
  writeFileSync(join(stub, `secrets-${worker}`), JSON.stringify(names.map((name) => ({ name, type: 'secret_text' }))));
}

function setup(...args: string[]): { status: number; out: string; calls: string[] } {
  const proc = Bun.spawnSync(['bash', SETUP, ...args], {
    env: { ...process.env, STUB: stub, PATH: `${join(stub, 'bin')}:${process.env.PATH}` },
  });
  const calls = existsSync(join(stub, 'calls')) ? readFileSync(join(stub, 'calls'), 'utf8').trim().split('\n') : [];
  return { status: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString(), calls };
}

function json(out: string): Record<string, unknown> {
  return JSON.parse(out.trim().split('\n').at(-1) ?? '{}');
}

beforeEach(() => {
  stub = mkdtempSync(join(tmpdir(), 'og-setup-'));
  Bun.spawnSync(['mkdir', '-p', join(stub, 'bin')]);
  writeFileSync(join(stub, 'bin', 'wrangler'), WRANGLER_STUB);
  writeFileSync(join(stub, 'bin', 'read_field.sh'), `#!/usr/bin/env bash\nprintf '%s' '${KEY}'\n`);
  chmodSync(join(stub, 'bin', 'wrangler'), 0o755);
  chmodSync(join(stub, 'bin', 'read_field.sh'), 0o755);
  writeFileSync(join(stub, 'queues'), 'some-other-queue\nog-rendered\n');
});

afterEach(() => rmSync(stub, { recursive: true, force: true }));

describe('scripts/og/setup.sh', () => {
  test('creates the queue, pipes the key to the render Worker, deletes the site copy, and reports the switch', () => {
    secrets('anc-og-render-staging', []);
    secrets('agentnative-site-staging', ['CONTEXT_DEV_API_KEY', 'MCP_ENABLED']);
    const run = setup('staging', '--json');
    expect(run.status).toBe(14);
    expect(json(run.out)).toMatchObject({
      reason: 'switch-off',
      exit_code: 14,
      value: {
        queue: 'og-rendered-staging',
        changed: [
          'created queue og-rendered-staging',
          'set CONTEXT_DEV_API_KEY on anc-og-render-staging',
          'deleted CONTEXT_DEV_API_KEY from agentnative-site-staging',
        ],
      },
      next_step: {
        action: 'set-secret',
        command: 'printf true | bunx wrangler secret put OG_VIDEO_ENABLED --name agentnative-site-staging',
      },
    });
    expect(readFileSync(join(stub, 'put-anc-og-render-staging-CONTEXT_DEV_API_KEY'), 'utf8')).toBe(KEY);
    expect(run.calls).toContain('secret delete CONTEXT_DEV_API_KEY --name agentnative-site-staging');
    expect(run.out).not.toContain(KEY);
  });

  test('a finished environment verifies clean and changes nothing, in prose and JSON', () => {
    writeFileSync(join(stub, 'queues'), 'og-rendered-staging\n');
    secrets('anc-og-render-staging', ['CONTEXT_DEV_API_KEY']);
    secrets('agentnative-site-staging', ['OG_VIDEO_ENABLED']);
    const prose = setup('staging');
    expect(prose.status).toBe(0);
    expect(prose.out).toContain('ok: ');
    expect(prose.out).toContain('next: scripts/og/setup.sh staging --check');
    expect(json(setup('staging', '--json').out)).toMatchObject({ reason: 'ok', exit_code: 0, value: { changed: [] } });
    expect(prose.calls.some((call) => /create|put|delete/.test(call))).toBe(false);
  });

  test('before the render Worker exists, its secret steps are pending and the run exits non-zero', () => {
    secrets('agentnative-site-staging', []);
    const run = setup('staging', '--json');
    expect(run.status).toBe(11);
    expect(json(run.out)).toMatchObject({
      reason: 'render-worker-missing',
      next_step: {
        action: 'deploy',
        command: expect.stringMatching(/^gh workflow run deploy\.yml -f ref=\S+ -f environment=staging$/),
      },
      value: { changed: ['created queue og-rendered-staging'] },
    });
    const prose = setup('staging');
    expect(prose.status).toBe(11);
    expect(prose.out).toContain('rerun scripts/og/setup.sh staging');
  });

  test('--check reports each missing piece and changes nothing', () => {
    secrets('anc-og-render', []);
    secrets('agentnative-site', ['CONTEXT_DEV_API_KEY']);
    writeFileSync(join(stub, 'queues'), 'og-rendered-staging\n');
    const missingQueue = setup('production', '--check', '--json');
    expect([missingQueue.status, json(missingQueue.out).reason]).toEqual([10, 'queue-missing']);

    writeFileSync(join(stub, 'queues'), 'og-rendered\n');
    const missingKey = setup('production', '--check', '--json');
    expect([missingKey.status, json(missingKey.out).reason]).toEqual([12, 'secret-missing']);

    secrets('anc-og-render', ['CONTEXT_DEV_API_KEY']);
    const siteKey = setup('production', '--check');
    expect(siteKey.status).toBe(13);
    expect(siteKey.out).toContain('site-secret-present: agentnative-site still holds CONTEXT_DEV_API_KEY');
    expect(siteKey.calls.some((call) => /create|put|delete/.test(call))).toBe(false);
  });

  test('a wrangler that cannot list queues is its own reason, not a missing queue', () => {
    writeFileSync(join(stub, 'bin', 'wrangler'), '#!/usr/bin/env bash\nexit 1\n');
    const run = setup('staging', '--check', '--json');
    expect([run.status, json(run.out).reason]).toEqual([30, 'wrangler-failed']);
  });

  test('--help prints the usage header and an unknown argument exits 2', () => {
    const help = setup('--help');
    expect(help.status).toBe(0);
    expect(help.out).toContain('Usage: scripts/og/setup.sh <staging|production> [--check] [--json]');
    expect(setup('prod').status).toBe(2);
  });
});
