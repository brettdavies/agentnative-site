// A client treats any failure of the version signal as no signal, so no consumer
// reports a broken one and the smoke is where it turns red: each way the endpoint
// can break has to fail it. Runs the real script against a local server.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTRACT_FINGERPRINT_ASSET_PATH } from '../src/shared/web-audit-contract';
import worker from '../src/worker/index';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';
import { REPO_ROOT } from './helpers/workflows';

const SCRIPT = join(REPO_ROOT, 'scripts/smoke-web-audit-version.sh');
const VALID = {
  spec_version: SPEC_VERSION,
  registry_fingerprint: 'c06f1efd281b',
  contract_fingerprint: '0a1b2c3d4e5f',
  web_schema_version: '0.5',
};
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const HANDLER_ENV = {
  ASSETS: {
    fetch: async (request: Request) =>
      new URL(request.url).pathname === CONTRACT_FINGERPRINT_ASSET_PATH
        ? new Response(`${VALID.contract_fingerprint}\n`)
        : new Response(JSON.stringify({ schema_version: 1, checks: [] })),
  },
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
  '/old-body-once': () => {
    oldBodiesLeft -= 1;
    return oldBodiesLeft >= 0 ? ANSWERS['/missing-key']() : ANSWERS['/valid']();
  },
  '/stale-once': () => {
    staleAnswersLeft -= 1;
    return staleAnswersLeft >= 0 ? new Response('not found', { status: 404 }) : ANSWERS['/valid']();
  },
  // An isolate on the previous deploy answers with a body that has no such field, or with another value.
  '/no-contract-fingerprint': () => {
    const { contract_fingerprint: _absent, ...previous } = VALID;
    return Response.json(previous, { headers: JSON_HEADERS });
  },
  '/propagating-no-field': () => {
    fingerprintHits += 1;
    propagatingAnswers -= 1;
    return propagatingAnswers >= 0 ? ANSWERS['/no-contract-fingerprint']() : ANSWERS['/valid']();
  },
  '/propagating-other-value': () => {
    fingerprintHits += 1;
    propagatingAnswers -= 1;
    return propagatingAnswers >= 0
      ? Response.json({ ...VALID, contract_fingerprint: 'ffffffffffff' }, { headers: JSON_HEADERS })
      : ANSWERS['/valid']();
  },
  '/unauthorized': () => new Response('denied', { status: 401 }),
  '/forbidden': () => new Response('denied', { status: 403 }),
  '/counted-missing': () => {
    fingerprintHits += 1;
    return new Response('not found', { status: 404 });
  },
  '/right-value-broken-field': () => Response.json({ ...VALID, web_schema_version: 0.5 }, { headers: JSON_HEADERS }),
  '/contract-not-hex': () =>
    Response.json({ ...VALID, contract_fingerprint: '<!doctype ht>' }, { headers: JSON_HEADERS }),
};

// A caller's real Access credentials must not reach the fixture server or change
// what these cases exercise.
const { CF_ACCESS_CLIENT_ID: _id, CF_ACCESS_CLIENT_SECRET: _secret, ...callerEnv } = process.env;

let server: ReturnType<typeof Bun.serve>;
let staleAnswersLeft = 0;
let oldBodiesLeft = 0;
let propagatingAnswers = 0;
let fingerprintHits = 0;
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

// curl's own stderr names the status too, so these read the script's verdict alone.
const failLine = (stderr: string) => stderr.split('\n').find((line) => line.startsWith('FAIL:')) ?? '';

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
    ['no-contract-fingerprint', 'broke the contract'],
    ['contract-not-hex', 'broke the contract'],
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

  test('an additional field passes, so adding one does not need this script to change first', async () => {
    expect((await smoke(fixture('extra-key'))).exitCode).toBe(0);
  });

  // The window a deploy's retries exist for: a stale isolate answers 404, then
  // the new version answers.
  test('a retry that succeeds passes', async () => {
    staleAnswersLeft = 1;
    const { exitCode, stdout, stderr } = await smoke(fixture('stale-once'), { SMOKE_RETRIES: '1' });
    expect(`${exitCode} ${stderr}`).toStartWith('0 ');
    expect(stdout).toContain('PASS');
  }, 30_000);

  // An isolate still on the previous version answers 200 with its own body once a
  // later release has changed the fields.
  test('a retry that replaces a stale 200 body passes', async () => {
    oldBodiesLeft = 1;
    const { exitCode, stdout, stderr } = await smoke(fixture('old-body-once'), { SMOKE_RETRIES: '1' });
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

  // No shell runs a trap after a SIGKILL, so the only way to leave nothing behind is never to write it.
  test('no file holds the secret during a run or after a SIGKILL, and no child inherits it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'smoke-kill-'));
    try {
      const tmp = join(dir, 'tmp');
      await mkdir(tmp);
      const started = join(dir, 'started');
      const stub = join(dir, 'curl');
      await writeFile(
        stub,
        `#!/usr/bin/env bash\nenv >"${dir}/env"\nls -A "${tmp}" >"${dir}/during"\n: >"${started}"\nexec sleep 5\n`,
      );
      await chmod(stub, 0o755);
      const proc = Bun.spawn(['bash', SCRIPT, fixture('valid')], {
        env: {
          ...callerEnv,
          CF_ACCESS_CLIENT_ID: 'id-from-env',
          CF_ACCESS_CLIENT_SECRET: 'secret-from-env',
          TMPDIR: tmp,
          PATH: `${dir}:${process.env.PATH}`,
        },
        stdout: 'ignore',
        stderr: 'ignore',
      });
      for (let attempt = 0; attempt < 400 && !existsSync(started); attempt += 1) await Bun.sleep(50);
      expect(existsSync(started)).toBe(true);
      proc.kill('SIGKILL');
      await proc.exited;
      expect(await readFile(join(dir, 'during'), 'utf8')).toBe('');
      expect(await readdir(tmp)).toEqual([]);
      const childEnv = await readFile(join(dir, 'env'), 'utf8');
      expect(childEnv).not.toContain('CF_ACCESS');
      expect(childEnv).not.toContain('secret-from-env');
    } finally {
      await rm(dir, { recursive: true });
    }
  }, 30_000);

  // An operator's debug run prints each line it traces, so tracing has to be off before the script reads the variables.
  test.each([
    ['bash -x', ['bash', '-x', SCRIPT], {}],
    ['SHELLOPTS=xtrace', ['bash', SCRIPT], { SHELLOPTS: 'xtrace' }],
  ] as const)(
    'tracing with %s cannot print the secret',
    async (_how, command, extra) => {
      const proc = Bun.spawn([...command, fixture('valid')], {
        env: {
          ...callerEnv,
          ...extra,
          CF_ACCESS_CLIENT_ID: 'id-from-env',
          CF_ACCESS_CLIENT_SECRET: 'secret-from-env',
          SMOKE_RETRIES: '0',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(lastHeaders['cf-access-client-secret']).toBe('secret-from-env');
      expect(`${stdout}${stderr}`).not.toContain('secret-from-env');
    },
    30_000,
  );

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
    ['a query string', 'https://anc.dev?x=1'],
    ['a fragment', 'https://anc.dev#a'],
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

  for (const [label, secret] of [
    ['a quote', 'sec"ret'],
    ['a backslash', 'sec\\ret'],
    ['a line break', 'sec\nurl = https://evil.example'],
  ] as const) {
    test(`a credential holding ${label} is a prerequisite failure, and its value is not printed`, async () => {
      const { exitCode, stdout, stderr } = await smoke(fixture('valid'), {
        CF_ACCESS_CLIENT_ID: 'id-from-env',
        CF_ACCESS_CLIENT_SECRET: secret,
      });
      expect(exitCode).toBe(2);
      expect(stderr).toContain('CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET');
      expect(`${stdout}${stderr}`).not.toContain('sec');
    });
  }

  // A stub curl, because this is about the rail, not the network. Read from the
  // file the script reads, so a rename there fails here rather than on a deploy.
  for (const name of ['STAGING_URL_DEFAULT', 'PROD_URL_DEFAULT']) {
    test(`Access credentials reach ${name}, and curl never routes localhost through a proxy`, async () => {
      const env = readFileSync(join(REPO_ROOT, 'scripts/release/release.env'), 'utf8');
      const origin = env.match(new RegExp(`^${name}="([^"]+)"$`, 'm'))?.[1];
      expect(origin).toStartWith('https://');
      const dir = await mkdtemp(join(tmpdir(), 'smoke-origin-'));
      try {
        const called = join(dir, 'called');
        const stub = join(dir, 'curl');
        await writeFile(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >"${called}"\nexit 7\n`);
        await chmod(stub, 0o755);
        const { exitCode } = await smoke(`${origin}`, {
          CF_ACCESS_CLIENT_ID: 'id-from-env',
          CF_ACCESS_CLIENT_SECRET: 'secret-from-env',
          PATH: `${dir}:${process.env.PATH}`,
        });
        expect(exitCode).toBe(1);
        const args = await readFile(called, 'utf8');
        expect(args).toContain(`${origin}/api/web-audit/version`);
        expect(args).toContain('--noproxy');
        expect(args).not.toContain('secret-from-env');
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  }

  for (const name of ['SMOKE_RETRIES', 'SMOKE_RETRY_DELAY']) {
    test(`a non-numeric ${name} is a prerequisite failure, not a broken surface`, async () => {
      const { exitCode, stderr } = await smoke(fixture('valid'), { [name]: 'soon' });
      expect(exitCode).toBe(2);
      expect(stderr).toContain(name);
    });

    // Bash reads a leading zero as octal, and 08 is an arithmetic error that drops
    // out of the retry loop onto the PASS line.
    test(`a leading-zero ${name} is a prerequisite failure, so it cannot print a false PASS`, async () => {
      const { exitCode, stdout, stderr } = await smoke(fixture('not-json'), { [name]: '08' });
      expect(exitCode).toBe(2);
      expect(stderr).toContain(name);
      expect(stdout).not.toContain('PASS');
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

  // curl -f also fails on a broken transfer, and its trailer still carries the status it saw.
  test('a 200 whose transfer failed says so, rather than that it did not answer 200', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'smoke-stub-'));
    try {
      const stub = join(dir, 'curl');
      await writeFile(stub, `#!/usr/bin/env bash\nprintf '\\n200 application/json'\nexit 18\n`);
      await chmod(stub, 0o755);
      const { exitCode, stderr } = await smoke(fixture('valid'), { PATH: `${dir}:${process.env.PATH}` });
      expect(exitCode).toBe(1);
      expect(failLine(stderr)).toContain('answered HTTP 200 but the transfer failed');
      expect(failLine(stderr)).not.toContain('did not answer 200');
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

  describe('with SMOKE_EXPECT_CONTRACT_FINGERPRINT', () => {
    const expecting = (extra: Record<string, string> = {}) => ({
      SMOKE_EXPECT_CONTRACT_FINGERPRINT: VALID.contract_fingerprint,
      SMOKE_RETRIES: '3',
      SMOKE_RETRY_DELAY: '0',
      ...extra,
    });

    test('passes on the value it expects', async () => {
      const { exitCode, stdout } = await smoke(fixture('valid'), expecting());
      expect(exitCode).toBe(0);
      expect(stdout).toContain('PASS');
      expect(stdout).toContain('contract_fingerprint compared');
    });

    test.each([
      ['with no such field', 'propagating-no-field'],
      ['with another value', 'propagating-other-value'],
    ])('an isolate answering %s reads as not yet propagated, then passes', async (_how, name) => {
      propagatingAnswers = 2;
      fingerprintHits = 0;
      const { exitCode, stdout } = await smoke(fixture(name), expecting());
      expect(exitCode).toBe(0);
      expect(stdout).toContain('PASS');
      expect(fingerprintHits).toBe(3);
    });

    test('a value that never arrives fails once the retries are spent, naming the served and expected values', async () => {
      propagatingAnswers = 1_000;
      fingerprintHits = 0;
      const { exitCode, stderr } = await smoke(fixture('propagating-other-value'), expecting());
      expect(exitCode).toBe(1);
      expect(stderr).toContain('serves contract_fingerprint ffffffffffff');
      expect(stderr).toContain(`expected contract_fingerprint ${VALID.contract_fingerprint}`);
      expect(fingerprintHits).toBe(4);
    });

    test.each([
      ['no-contract-fingerprint', 'broke the contract'],
      ['right-value-broken-field', 'broke the contract'],
      ['two-documents', 'broke the contract'],
      ['not-json', 'broke the contract'],
      ['text', 'expected application/json'],
      ['missing', 'did not answer 200'],
      ['redirect', 'Access credentials'],
    ])('%s fails with its own reason and the expected value', async (name, reason) => {
      const { exitCode, stderr } = await smoke(fixture(name), expecting());
      expect(exitCode).toBe(1);
      expect(stderr).toContain(reason);
      expect(stderr).toContain(`expected contract_fingerprint ${VALID.contract_fingerprint}`);
    });

    // The wait ends on the last answer, so a stale Access token has to read as itself rather than as a missing field.
    test.each([
      ['redirect', 'answered HTTP 302'],
      ['unauthorized', 'did not answer 200: HTTP 401'],
      ['forbidden', 'did not answer 200: HTTP 403'],
    ])('a final %s names its status and the Access hint', async (name, answered) => {
      const { exitCode, stderr } = await smoke(fixture(name), expecting());
      expect(exitCode).toBe(1);
      expect(failLine(stderr)).toContain(answered);
      expect(failLine(stderr)).toContain('Access credentials');
    });

    test('a final 404 names its status, with no Access hint', async () => {
      const { exitCode, stderr } = await smoke(fixture('missing'), expecting());
      expect(exitCode).toBe(1);
      expect(failLine(stderr)).toContain('did not answer 200: HTTP 404');
      expect(failLine(stderr)).not.toContain('Access credentials');
    });

    test('no HTTP answer at all says so', async () => {
      const { exitCode, stderr } = await smoke('http://localhost:1', expecting());
      expect(exitCode).toBe(1);
      expect(failLine(stderr)).toContain('did not answer 200: no HTTP answer');
    });

    // Without the longer wait a deploy that moves the value goes red while old isolates drain.
    test.each([
      ['with', { SMOKE_EXPECT_CONTRACT_FINGERPRINT: VALID.contract_fingerprint }, 13],
      ['without', {}, 6],
    ])(
      '%s an expected value, the default retries give the attempts its wait needs',
      async (_with, extra, attempts) => {
        fingerprintHits = 0;
        const { exitCode } = await smoke(fixture('counted-missing'), {
          SMOKE_RETRIES: '',
          SMOKE_RETRY_DELAY: '0',
          ...extra,
        });
        expect(exitCode).toBe(1);
        expect(fingerprintHits).toBe(attempts);
      },
      30_000,
    );

    // The production job records nothing for a ref without the file, and its smoke then checks the shape alone.
    test('an empty value compares nothing', async () => {
      propagatingAnswers = 1;
      const { exitCode, stdout } = await smoke(
        fixture('propagating-other-value'),
        expecting({ SMOKE_EXPECT_CONTRACT_FINGERPRINT: '' }),
      );
      expect(exitCode).toBe(0);
      expect(stdout).not.toContain('contract_fingerprint compared');
    });

    test.each(['not-a-print', '0A1B2C3D4E5F', '0a1b2c3d4e5'])('%s is a prerequisite failure', async (value) => {
      const { exitCode, stderr } = await smoke(
        fixture('valid'),
        expecting({ SMOKE_EXPECT_CONTRACT_FINGERPRINT: value }),
      );
      expect(exitCode).toBe(2);
      expect(stderr).toContain('SMOKE_EXPECT_CONTRACT_FINGERPRINT');
    });
  });

  test('a missing base URL is a prerequisite failure, not a smoke failure', async () => {
    expect((await smoke(null)).exitCode).toBe(2);
  });

  test("the real handler's answer passes, so a change to its fields cannot first show as a red deploy", async () => {
    const { exitCode, stdout } = await smoke(fixture('handler'));
    expect(exitCode).toBe(0);
    expect(stdout).toContain(SPEC_VERSION);
  });
});
