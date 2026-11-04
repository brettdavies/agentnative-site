// The smoke is the only place a broken version signal turns red, because the
// CLI skips silently on any failure, so each way the endpoint can break has to
// fail it. Runs the real script against a local server.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
};

let server: ReturnType<typeof Bun.serve>;
const seenHeaders: Record<string, string | null>[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      seenHeaders.push({ id: request.headers.get('cf-access-client-id') });
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
    env: { ...process.env, SMOKE_RETRIES: '0', ...env },
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
  ] as const) {
    test(`fails on ${name}`, async () => {
      const { exitCode, stderr } = await smoke(fixture(name));
      expect(exitCode).toBe(1);
      expect(stderr).toContain(expected);
    });
  }

  test('sends Access credentials when they are set', async () => {
    seenHeaders.length = 0;
    await smoke(fixture('valid'), { CF_ACCESS_CLIENT_ID: 'id-from-env', CF_ACCESS_CLIENT_SECRET: 'secret' });
    expect(seenHeaders.at(-1)?.id).toBe('id-from-env');
  });

  test('a missing base URL is a prerequisite failure, not a smoke failure', async () => {
    expect((await smoke(null)).exitCode).toBe(2);
  });
});
