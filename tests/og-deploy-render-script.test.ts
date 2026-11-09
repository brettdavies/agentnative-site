// scripts/og/deploy-render.sh against a stubbed bunx on PATH: the flags each
// environment deploys with, the redeploy after a first deploy's 10007
// read-back, and the failures it does not retry.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, workflowText } from './helpers/workflows';

const DEPLOY = join(REPO_ROOT, 'scripts/og/deploy-render.sh');
const CONFIG = join(REPO_ROOT, 'src/og-render/wrangler.jsonc');

// Each call answers with the next line of $STUB/answers: ok, 10007, or other.
const BUNX_STUB = `#!/usr/bin/env bash
echo "$*" >>"$STUB/calls"
answer=$(head -n1 "$STUB/answers"); sed -i 1d "$STUB/answers"
case "$answer" in
  ok) echo "Deployed anc-og-render" ;;
  10007) echo "Uploaded anc-og-render"; echo "This Worker does not exist on your account. [code: 10007]" >&2; exit 1 ;;
  *) echo "Authentication error [code: 10000]" >&2; exit 1 ;;
esac
`;

let stub: string;

function deploy(answers: string[], ...args: string[]): { status: number; out: string; calls: string[] } {
  writeFileSync(join(stub, 'answers'), `${answers.join('\n')}\n`);
  const proc = Bun.spawnSync(['bash', DEPLOY, ...args], {
    env: {
      ...process.env,
      STUB: stub,
      PATH: `${join(stub, 'bin')}:${process.env.PATH}`,
      OG_DEPLOY_RETRY_WAITS: '0 0 0',
    },
  });
  const calls = existsSync(join(stub, 'calls')) ? readFileSync(join(stub, 'calls'), 'utf8').trim().split('\n') : [];
  return { status: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString(), calls };
}

beforeEach(() => {
  stub = mkdtempSync(join(tmpdir(), 'og-deploy-'));
  Bun.spawnSync(['mkdir', '-p', join(stub, 'bin')]);
  writeFileSync(join(stub, 'bin', 'bunx'), BUNX_STUB);
  chmodSync(join(stub, 'bin', 'bunx'), 0o755);
});

afterEach(() => rmSync(stub, { recursive: true, force: true }));

describe('scripts/og/deploy-render.sh', () => {
  test('deploys once per environment, staging under its env and production under the top-level config', () => {
    const staging = deploy(['ok'], 'staging');
    expect(staging.status).toBe(0);
    expect(staging.calls).toEqual([`wrangler deploy --config ${CONFIG} --env staging`]);

    rmSync(join(stub, 'calls'));
    const production = deploy(['ok'], 'production');
    expect(production.status).toBe(0);
    expect(production.calls).toEqual([`wrangler deploy --config ${CONFIG} --env=`]);
  });

  test("a first deploy's 10007 read-back is deployed again, and the later success passes", () => {
    const run = deploy(['10007', '10007', 'ok'], 'staging');
    expect(run.status).toBe(0);
    expect(run.calls).toHaveLength(3);
    expect(run.out).toContain('Deployed anc-og-render');
  });

  test('a 10007 that outlasts every wait fails after the last attempt', () => {
    const run = deploy(['10007', '10007', '10007', '10007', 'ok'], 'staging');
    expect(run.status).toBe(1);
    expect(run.calls).toHaveLength(4);
  });

  test('any other failure fails at once', () => {
    const run = deploy(['other', 'ok'], 'production');
    expect(run.status).toBe(1);
    expect(run.calls).toHaveLength(1);
  });

  test('an unknown environment deploys nothing', () => {
    const run = deploy(['ok'], 'prod');
    expect(run.status).toBe(2);
    expect(run.calls).toEqual([]);
  });

  test('both deploy jobs deploy the render Worker through the script', () => {
    const yml = workflowText('deploy.yml');
    expect(yml).toContain('run: scripts/og/deploy-render.sh staging');
    expect(yml).toContain('run: scripts/og/deploy-render.sh production');
    expect(yml).not.toContain('src/og-render/wrangler.jsonc --env');
  });
});
