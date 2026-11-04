// A client treats any failure of the version signal as no signal, so no consumer
// reports a broken one and the smoke is where it turns red: each way the endpoint
// can break has to fail it. Runs the real script against a local server.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../src/worker/index';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';
import { REPO_ROOT } from './helpers/workflows';

const SCRIPT = join(REPO_ROOT, 'scripts/smoke-web-audit-version.sh');
const VALID = { spec_version: SPEC_VERSION, registry_fingerprint: 'c06f1efd281b', web_schema_version: '0.5' };
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const HANDLER_ENV = {
  ASSETS: { fetch: async () => new Response(JSON.stringify({ schema_version: 1, checks: [] })) },
} as unknown as Parameters<typeof worker.fetch>[1];

const ANSWERS: Record<string, () => Response | Promise<Response>> = {
  '/valid': () => Response.json(VALID, { headers: JSON_HEADERS }),
  '/handler': () =>
    worker.fetch(new Request('https://anc.dev/api/web-audit/version'), HANDLER_ENV, {} as ExecutionContext),
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
  '/created': () => Response.json(VALID, { status: 201, headers: JSON_HEADERS }),
  '/redirect': () =>
    new Response(JSON.stringify(VALID), {
      status: 302,
      headers: { ...JSON_HEADERS, location: 'https://example.com/' },
    }),
  '/jsonp': () => new Response(JSON.stringify(VALID), { headers: { 'content-type': 'application/jsonp' } }),
  '/two-documents': () => new Response(`${JSON.stringify(VALID)}\n${JSON.stringify(VALID)}`, { headers: JSON_HEADERS }),
  '/prerelease': () => Response.json({ ...VALID, spec_version: '0.8.0-rc.1' }, { headers: JSON_HEADERS }),
  '/stale-once': () => {
    staleAnswersLeft -= 1;
    return staleAnswersLeft >= 0 ? new Response('not found', { status: 404 }) : ANSWERS['/valid']();
  },
};

// A caller's real Access credentials must not reach the fixture server or change
// what these cases exercise.
const { CF_ACCESS_CLIENT_ID: _id, CF_ACCESS_CLIENT_SECRET: _secret, ...callerEnv } = process.env;

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
    env: { ...callerEnv, SMOKE_RETRIES: '0', SMOKE_RETRY_DELAY: '1', ...env },
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
    ['created', 'answered HTTP 201'],
    ['redirect', 'answered HTTP 302'],
    ['jsonp', 'expected application/json'],
    ['two-documents', 'broke the contract'],
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

  test('a failing run leaves the secret out of its output and no credential file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'smoke-tmp-'));
    try {
      const { exitCode, stdout, stderr } = await smoke(fixture('missing'), {
        CF_ACCESS_CLIENT_ID: 'id-from-env',
        CF_ACCESS_CLIENT_SECRET: 'secret-from-env',
        TMPDIR: dir,
      });
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).not.toContain('secret-from-env');
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("a verbose .curlrc cannot print the secret, because curl ignores the caller's config", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'smoke-curlrc-'));
    try {
      await writeFile(join(dir, '.curlrc'), 'verbose\n');
      const { exitCode, stdout, stderr } = await smoke(fixture('valid'), {
        CF_ACCESS_CLIENT_ID: 'id-from-env',
        CF_ACCESS_CLIENT_SECRET: 'secret-from-env',
        CURL_HOME: dir,
      });
      expect(exitCode).toBe(0);
      expect(`${stdout}${stderr}`).not.toContain('secret-from-env');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  for (const [label, base] of [
    ['a plain-http public host', 'http://anc.dev'],
    ['an unknown https host', 'https://example.com'],
    ['a host that only starts like a known one', 'https://anc.dev.example.com'],
    ['a host that only ends like a known one', 'https://not-anc.dev'],
    ['a look-alike staging suffix', 'https://evil.workers.dev.example.com'],
    ['a stranger on workers.dev', 'https://attacker.workers.dev'],
    ['the staging name under another account', 'https://agentnative-site-staging.attacker.workers.dev'],
    ['plain-http staging', 'http://agentnative-site-staging.brettdavies.workers.dev'],
    ['a known host on another port', 'https://anc.dev:8443'],
  ] as const) {
    test(`refuses to send Access credentials to ${label}, before any request`, async () => {
      const { exitCode, stderr } = await smoke(base, {
        CF_ACCESS_CLIENT_ID: 'id-from-env',
        CF_ACCESS_CLIENT_SECRET: 'secret-from-env',
      });
      expect(exitCode).toBe(2);
      expect(stderr).toContain('refusing to send Access credentials');
    });
  }

  for (const [label, base] of [
    ['no scheme', 'anc.dev'],
    ['no host', 'https://'],
    ['a space in the host', 'http://exa mple'],
    ['a leading dot', 'https://.workers.dev'],
    ['a known host used as userinfo', 'https://anc.dev:pw@evil.example'],
    ['a suffix smuggled past a backslash', 'https://evil.example\\.workers.dev'],
  ] as const) {
    const credentialSets: Record<string, string>[] = [
      {},
      { CF_ACCESS_CLIENT_ID: 'id', CF_ACCESS_CLIENT_SECRET: 'secret' },
    ];
    for (const credentials of credentialSets) {
      const withOrWithout = 'CF_ACCESS_CLIENT_ID' in credentials ? 'with' : 'without';
      test(`${label} is a prerequisite failure ${withOrWithout} credentials, not a broken surface`, async () => {
        const { exitCode, stderr } = await smoke(base, credentials);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('full http(s) origin');
      });
    }
  }

  for (const name of ['SMOKE_RETRIES', 'SMOKE_RETRY_DELAY']) {
    test(`a non-numeric ${name} is a prerequisite failure, not a broken surface`, async () => {
      const { exitCode, stderr } = await smoke(fixture('valid'), { [name]: 'soon' });
      expect(exitCode).toBe(2);
      expect(stderr).toContain(name);
    });
  }

  // A stub curl, so this needs no DNS: an unresolvable name can take the full
  // timeout to fail on some resolvers.
  test('an unknown host with no credentials is checked as a request, not refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'smoke-stub-'));
    try {
      const called = join(dir, 'called');
      const stub = join(dir, 'curl');
      await writeFile(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >"${called}"\nexit 7\n`);
      await chmod(stub, 0o755);
      const { exitCode, stderr } = await smoke('https://unknown.example', { PATH: `${dir}:${process.env.PATH}` });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('did not answer 200');
      expect(await readFile(called, 'utf8')).toContain('https://unknown.example/api/web-audit/version');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  for (const [label, env] of [
    ['only the id', { CF_ACCESS_CLIENT_ID: 'id-from-env' }],
    ['only the secret', { CF_ACCESS_CLIENT_SECRET: 'secret-from-env' }],
  ] as const) {
    test(`${label} is a prerequisite failure, because a dropped header looks like a broken surface`, async () => {
      const { exitCode, stderr } = await smoke(fixture('valid'), env);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('both');
    });
  }

  test('a missing base URL is a prerequisite failure, not a smoke failure', async () => {
    expect((await smoke(null)).exitCode).toBe(2);
  });

  test("the real handler's answer passes, so a change to its fields cannot first show as a red deploy", async () => {
    const { exitCode, stdout } = await smoke(fixture('handler'));
    expect(exitCode).toBe(0);
    expect(stdout).toContain(SPEC_VERSION);
  });
});
