// A client treats any failure of the version signal as no signal, so no consumer
// reports a broken one and the smoke is where it turns red: each way the endpoint
// can break has to fail it. Runs the real script against a local server.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';
import { REPO_ROOT } from './helpers/workflows';

const SCRIPT = join(REPO_ROOT, 'scripts/smoke-web-audit-version.sh');
const VALID = { spec_version: SPEC_VERSION, registry_fingerprint: 'c06f1efd281b', web_schema_version: '0.5' };
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

const ANSWERS: Record<string, () => Response> = {
  '/valid': () => Response.json(VALID, { headers: JSON_HEADERS }),
  '/missing': () => new Response('not found', { status: 404 }),
  '/text': () => new Response(JSON.stringify(VALID), { headers: { 'content-type': 'text/plain' } }),
  '/html': () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
  '/not-json': () => new Response('{', { headers: JSON_HEADERS }),
  '/extra-key': () => Response.json({ ...VALID, site_version: '1' }, { headers: JSON_HEADERS }),
  '/missing-key': () => {
    const { web_schema_version: _dropped, ...rest } = VALID;
    return Response.json(rest, { headers: JSON_HEADERS });
  },
  '/full-digest': () =>
    Response.json({ ...VALID, registry_fingerprint: 'c06f1efd281b'.repeat(5) }, { headers: JSON_HEADERS }),
  '/number': () => Response.json({ ...VALID, web_schema_version: 0.5 }, { headers: JSON_HEADERS }),
  '/spec-suffix': () => Response.json({ ...VALID, spec_version: '0.7.0garbage' }, { headers: JSON_HEADERS }),
  '/spec-newline': () => Response.json({ ...VALID, spec_version: '0.7.0\n' }, { headers: JSON_HEADERS }),
  '/schema-three-parts': () => Response.json({ ...VALID, web_schema_version: '0.5.1' }, { headers: JSON_HEADERS }),
  '/prerelease': () => Response.json({ ...VALID, spec_version: '0.8.0-rc.1' }, { headers: JSON_HEADERS }),
  '/stale-once': () => {
    staleAnswersLeft -= 1;
    return staleAnswersLeft >= 0 ? new Response('not found', { status: 404 }) : ANSWERS['/valid']();
  },
};

let server: ReturnType<typeof Bun.serve>;
let staleAnswersLeft = 0;
let lastHeaders: Record<string, string> = {};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      lastHeaders = Object.fromEntries(request.headers);
      const answer = ANSWERS[pathname.replace('/api/web-audit/version', '')];
      return answer ? answer() : new Response('no fixture', { status: 500 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

async function smoke(base: string | null, env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bash', SCRIPT, ...(base === null ? [] : [base])], {
    env: { ...process.env, SMOKE_RETRIES: '0', SMOKE_RETRY_DELAY: '1', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const fixture = (name: string) => `http://localhost:${server.port}/${name}`;

describe('scripts/smoke-web-audit-version.sh', () => {
  test('passes on the contract', async () => {
    const { exitCode, stdout } = await smoke(fixture('valid'));
    expect(exitCode).toBe(0);
    expect(stdout).toContain('PASS');
    expect(stdout).toContain('c06f1efd281b');
  });

  test('a trailing slash on the base URL reaches the same route', async () => {
    expect((await smoke(`${fixture('valid')}/`)).exitCode).toBe(0);
  });

  for (const [name, expected] of [
    ['missing', 'did not answer 200'],
    ['text', 'expected application/json'],
    ['html', 'expected application/json'],
    ['not-json', 'broke the contract'],
    ['extra-key', 'broke the contract'],
    ['missing-key', 'broke the contract'],
    ['full-digest', 'broke the contract'],
    ['number', 'broke the contract'],
    ['spec-suffix', 'broke the contract'],
    ['spec-newline', 'broke the contract'],
    ['schema-three-parts', 'broke the contract'],
  ] as const) {
    test(`fails on ${name}`, async () => {
      const { exitCode, stderr } = await smoke(fixture(name));
      expect(exitCode).toBe(1);
      expect(stderr).toContain(expected);
    });
  }

  test('a prerelease spec version passes', async () => {
    expect((await smoke(fixture('prerelease'))).exitCode).toBe(0);
  });

  // The window a deploy's retries exist for: a stale isolate answers 404, then
  // the new version answers.
  test('a retry that succeeds passes', async () => {
    staleAnswersLeft = 1;
    const { exitCode, stdout, stderr } = await smoke(fixture('stale-once'), { SMOKE_RETRIES: '1' });
    expect(`${exitCode} ${stderr}`).toStartWith('0 ');
    expect(stdout).toContain('PASS');
  }, 30_000);

  test('retries are spent before it fails', async () => {
    staleAnswersLeft = 2;
    const { exitCode, stderr } = await smoke(fixture('stale-once'), { SMOKE_RETRIES: '1' });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('did not answer 200');
  }, 30_000);

  test('sends both Access headers once each, and never puts the secret on the command line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'smoke-curl-'));
    try {
      const argv = join(dir, 'argv');
      const wrapper = join(dir, 'curl');
      await writeFile(
        wrapper,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >>"${argv}"\nexec "${Bun.which('curl')}" "$@"\n`,
      );
      await chmod(wrapper, 0o755);
      const { exitCode } = await smoke(fixture('valid'), {
        CF_ACCESS_CLIENT_ID: 'id-from-env',
        CF_ACCESS_CLIENT_SECRET: 'secret-from-env',
        PATH: `${dir}:${process.env.PATH}`,
      });
      expect(exitCode).toBe(0);
      expect(lastHeaders['cf-access-client-id']).toBe('id-from-env');
      expect(lastHeaders['cf-access-client-secret']).toBe('secret-from-env');
      expect(await readFile(argv, 'utf8')).not.toContain('secret-from-env');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('a missing base URL is a prerequisite failure, not a smoke failure', async () => {
    expect((await smoke(null)).exitCode).toBe(2);
  });
});
