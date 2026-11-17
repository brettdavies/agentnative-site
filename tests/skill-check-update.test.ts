// bin/check-update ships inside the skill package and compares the installed
// VERSION with the version pointer anc.dev publishes. Each case runs the script
// the way a host runs it: through bash, with no exec bit, against a local
// server standing in for the pointer.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const PACKAGE = join(REPO_ROOT, 'skill/agent-native-cli');
const SCRIPT = join(PACKAGE, 'bin/check-update');
const POINTER_URL = 'https://anc.dev/.well-known/agent-skills/agent-native-cli/VERSION';

function installedVersion(): string {
  return readFileSync(join(PACKAGE, 'VERSION'), 'utf8').trim();
}

async function run(remoteUrl: string, home: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(['bash', SCRIPT], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      NO_PROXY: '127.0.0.1,localhost',
      AGENTNATIVE_SKILL_REMOTE_URL: remoteUrl,
      AGENTNATIVE_SKILL_STATE_DIR: join(home, 'state'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

let home: string;
let server: ReturnType<typeof Bun.serve> | undefined;

function serve(body: string): string {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(body) });
  return `http://127.0.0.1:${server.port}/VERSION`;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'check-update-'));
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe('bin/check-update', () => {
  test('the default remote is the anc.dev version pointer', () => {
    const match = /REMOTE_URL="\$\{AGENTNATIVE_SKILL_REMOTE_URL:-([^}]+)\}"/.exec(readFileSync(SCRIPT, 'utf8'));
    expect(match?.[1]).toBe(POINTER_URL);
  });

  test('a different remote version prints UPGRADE_AVAILABLE and exits 0', async () => {
    const result = await run(serve('0.9.9\n'), home);
    expect(result).toEqual({ stdout: `UPGRADE_AVAILABLE ${installedVersion()} 0.9.9\n`, exitCode: 0 });
  });

  test('the same remote version prints nothing and exits 0', async () => {
    const result = await run(serve(`${installedVersion()}\n`), home);
    expect(result).toEqual({ stdout: '', exitCode: 0 });
  });

  test('an unreachable remote prints nothing and exits 0', async () => {
    const url = serve('0.9.9\n');
    server?.stop(true);
    server = undefined;
    const result = await run(url, home);
    expect(result).toEqual({ stdout: '', exitCode: 0 });
  });

  test('VERSION is one SemVer line and a newline', () => {
    expect(readFileSync(join(PACKAGE, 'VERSION'), 'utf8')).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});
