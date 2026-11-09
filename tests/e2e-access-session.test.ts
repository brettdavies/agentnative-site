// tests/e2e/access-session.ts, the global setup that spends the Access service
// token once and hands each context a cookie. A local server stands in for
// Access, with a second host that must never hear from it. The credential guard
// around this module is in e2e-credential-guard.test.ts.

import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { STAGING_HOSTNAME } from '../scripts/web-audit/staging-host';
import globalSetup, {
  AccessSessionError,
  type AccessSessionReason,
  mayReceiveToken,
  mintAccessState,
} from './e2e/access-session';

const REPO_ROOT = join(import.meta.dir, '..');

// Each case builds Playwright request contexts, which a loaded machine can take
// seconds to start.
setDefaultTimeout(30_000);

const ID = 'fixture-client-id';
const SECRET = 'fixture-client-secret';
const JWT = 'fixture.jwt.value';
const EXPIRES = new Date(Date.now() + 3_600_000);
// No Secure attribute: the jar will not send a Secure cookie to these http fixtures.
const SET_COOKIE = `CF_Authorization=${JWT}; Expires=${EXPIRES.toUTCString()}; Path=/; HttpOnly; SameSite=none`;

type Seen = { secret: string | null };

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A local host that records every request it hears. */
function host(answer: (req: Request) => Response | Promise<Response>): { base: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      seen.push({ secret: req.headers.get('cf-access-client-secret') });
      return answer(req);
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, seen };
}

const login = (): Response =>
  new Response(null, { status: 302, headers: { location: 'https://team.example/cdn-cgi/access/login/x?kid=1' } });

const issued = (extra = '', status = 200): Response =>
  new Response('ok', { status, headers: { 'set-cookie': `${SET_COOKIE}${extra}` } });

/** A target behind Access: the token earns the cookie and the cookie earns the page. */
function gated(onToken: () => Response = () => issued()): { base: string; seen: Seen[] } {
  return host((req) => {
    if (req.headers.get('cookie')?.includes(`CF_Authorization=${JWT}`)) return new Response('ok');
    return req.headers.get('cf-access-client-secret') ? onToken() : login();
  });
}

const credentials = { clientId: ID, clientSecret: SECRET };

async function failureOf(attempt: Promise<unknown>): Promise<AccessSessionError> {
  const err = await attempt.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof AccessSessionError)) throw new Error(`expected an AccessSessionError, got ${String(err)}`);
  return err;
}

const reasonOf = async (attempt: Promise<unknown>): Promise<AccessSessionReason> => (await failureOf(attempt)).reason;

describe('mintAccessState', () => {
  test('a target with no Access wall never sees the service token', async () => {
    const target = host(() => new Response('ok'));
    expect(await mintAccessState({ base: target.base, ...credentials })).toEqual({ cookies: [], origins: [] });
    expect(target.seen.map((s) => s.secret)).toEqual([null]);
  });

  test('a gated target yields only the Access cookie, scoped to its own host', async () => {
    const target = gated(() => {
      const headers = new Headers();
      headers.append('set-cookie', SET_COOKIE);
      headers.append('set-cookie', 'CF_AppSession=other; Path=/');
      return new Response('ok', { headers });
    });
    const state = await mintAccessState({ base: target.base, ...credentials });
    expect(state).toEqual({
      origins: [],
      cookies: [
        {
          name: 'CF_Authorization',
          value: JWT,
          domain: '127.0.0.1',
          path: '/',
          expires: Math.floor(EXPIRES.getTime() / 1000),
          httpOnly: true,
          secure: false,
          sameSite: 'None',
        },
      ],
    });
    expect(JSON.stringify(state)).not.toContain(SECRET);
    expect(target.seen.filter((s) => s.secret !== null)).toHaveLength(1);
  });

  test('a broader Domain attribute does not widen where the cookie goes', async () => {
    const target = gated(() => issued('; Domain=127.0.0.1'));
    const state = await mintAccessState({ base: target.base, ...credentials });
    expect(state.cookies.map((cookie) => cookie.domain)).toEqual(['127.0.0.1']);
  });

  test('a credentialed request does not follow a redirect to another host', async () => {
    const elsewhere = host(() => new Response('ok'));
    const target = gated(() => new Response(null, { status: 302, headers: { location: `${elsewhere.base}/landed` } }));
    await reasonOf(mintAccessState({ base: target.base, ...credentials }));
    expect(elsewhere.seen).toEqual([]);
  });

  test.each([
    ['the login redirect', login],
    ['a 401', () => new Response(null, { status: 401 })],
    ['a 403', () => new Response(null, { status: 403 })],
  ])('a token answered with %s is reported as rejected', async (_name, answer) => {
    const target = gated(answer);
    expect(await reasonOf(mintAccessState({ base: target.base, ...credentials }))).toBe('access-token-rejected');
  });

  // Access admitted the token, so the fix is on the Worker: naming the token
  // here would send the operator to rotate a good credential.
  test('a Worker error behind a token Access admitted does not blame the token', async () => {
    const target = gated(() => issued('', 500));
    const state = await mintAccessState({ base: target.base, ...credentials });
    expect(state.cookies.map((cookie) => cookie.value)).toEqual([JWT]);
  });

  test('a gated target with no credentials stops the run and sends nothing', async () => {
    const target = gated();
    expect(await reasonOf(mintAccessState({ base: target.base }))).toBe('access-credentials-missing');
    expect(target.seen.map((s) => s.secret)).toEqual([null]);
  });

  test('strict service token authentication withholding the cookie stops the run', async () => {
    const target = gated(() => new Response('ok'));
    expect(await reasonOf(mintAccessState({ base: target.base, ...credentials }))).toBe('access-cookie-not-issued');
  });

  test('a cookie Access will not honor stops the run', async () => {
    const target = host((req) => (req.headers.get('cf-access-client-secret') ? issued() : login()));
    expect(await reasonOf(mintAccessState({ base: target.base, ...credentials }))).toBe('access-cookie-refused');
  });

  // A bare status can come from any host a mistyped target names, so it earns
  // no credential, and it must not read as "no wall" either: that would run
  // every test with no session and report the result as missing features.
  test.each([401, 403, 500, 503, 301, 302])(
    'a first answer of %i stops the run and spends no token',
    async (status) => {
      const target = host(
        () => new Response(null, { status, headers: { location: 'https://elsewhere.example/landed' } }),
      );
      expect(await reasonOf(mintAccessState({ base: target.base, ...credentials }))).toBe('access-target-unavailable');
      expect(target.seen.map((s) => s.secret)).toEqual([null]);
    },
  );

  test('a redirect that only mentions the login path in its query is not the wall', async () => {
    const target = host(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example/landed?next=/cdn-cgi/access/login/x' },
        }),
    );
    expect(await reasonOf(mintAccessState({ base: target.base, ...credentials }))).toBe('access-target-unavailable');
    expect(target.seen.map((s) => s.secret)).toEqual([null]);
  });

  test('only the staging Worker over https and this machine may receive the token', () => {
    expect(mayReceiveToken(new URL(`https://${STAGING_HOSTNAME}/`))).toBe(true);
    expect(mayReceiveToken(new URL('http://127.0.0.1:8787/'))).toBe(true);
    expect(mayReceiveToken(new URL('http://localhost:8787/'))).toBe(true);
    expect(mayReceiveToken(new URL(`http://${STAGING_HOSTNAME}/`))).toBe(false);
    expect(mayReceiveToken(new URL('https://agentnative-site-staging.another-account.workers.dev/'))).toBe(false);
    expect(mayReceiveToken(new URL('https://anc.dev/'))).toBe(false);
  });

  test('a target that does not answer stops the run with a named reason', async () => {
    const attempt = mintAccessState({ base: 'http://127.0.0.1:1', ...credentials });
    expect(await reasonOf(attempt)).toBe('access-target-unavailable');
  });

  test('no failure message carries a credential, even when the credentialed request itself fails', async () => {
    const withheld = await failureOf(mintAccessState({ base: gated(() => new Response('ok')).base, ...credentials }));
    expect(String(withheld)).not.toContain(SECRET);

    // Playwright's error for a failed request prints that request's headers.
    let hangUp = (): void => {};
    const target = host((req) => {
      if (!req.headers.get('cf-access-client-secret')) return login();
      hangUp();
      return new Promise<Response>(() => {});
    });
    hangUp = () => {
      for (const server of servers) server.stop(true);
    };
    const dropped = await failureOf(mintAccessState({ base: target.base, ...credentials }));
    expect(dropped.reason).toBe('access-target-unavailable');
    expect(String(dropped)).not.toContain(SECRET);
    expect(String(dropped)).not.toContain(ID);
  });
});

describe('global setup', () => {
  const VARS = [
    'ANC_STAGING_BASE_URL',
    'ANC_E2E_ACCESS_STATE',
    'ANC_STAGING_ACCESS_CLIENT_ID',
    'ANC_STAGING_ACCESS_CLIENT_SECRET',
    'GITHUB_ACTIONS',
  ] as const;

  async function run(env: {
    actions: boolean;
    outputDir?: string;
  }): Promise<{ logged: string[]; statePath: string; done: () => Promise<void> }> {
    const before = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
    const statePath = join(await mkdtemp(join(tmpdir(), 'anc-access-session-')), 'state.json');
    const config = {
      projects: [{ outputDir: env.outputDir ?? join(statePath, 'no-output') }],
    } as unknown as FullConfig;
    process.env.ANC_STAGING_BASE_URL = gated().base;
    process.env.ANC_E2E_ACCESS_STATE = statePath;
    process.env.ANC_STAGING_ACCESS_CLIENT_ID = ID;
    process.env.ANC_STAGING_ACCESS_CLIENT_SECRET = SECRET;
    if (env.actions) process.env.GITHUB_ACTIONS = 'true';
    else delete process.env.GITHUB_ACTIONS;
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const done = await globalSetup(config);
      return { logged: log.mock.calls.map((call) => String(call[0])), statePath, done };
    } finally {
      log.mockRestore();
      for (const name of VARS) {
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
      }
    }
  }

  test('writes a state only its owner can read, holding no service token, and removes it on teardown', async () => {
    const { statePath, done } = await run({ actions: false });
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    const written = await readFile(statePath, 'utf8');
    expect(written).toContain(JWT);
    expect(written).not.toContain(SECRET);
    await done();
    expect(await Bun.file(statePath).exists()).toBe(false);
  });

  test('registers the cookie as a mask before any test can print it on CI', async () => {
    const { logged, done } = await run({ actions: true });
    expect(logged).toEqual([`::add-mask::${JWT}`]);
    await done();
  });

  test("teardown redacts the cookie from a failed test's error context", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'anc-access-session-output-'));
    const contextPath = join(outputDir, 'a-failed-test', 'error-context.md');
    await mkdir(dirname(contextPath), { recursive: true });
    await writeFile(contextPath, `- cookie: CF_Authorization=${JWT}\n- accept: */*\n`);
    const { done } = await run({ actions: false, outputDir });
    await done();
    expect(await readFile(contextPath, 'utf8')).toBe('- cookie: CF_Authorization=<redacted>\n- accept: */*\n');
  });

  test('prints no cookie off CI', async () => {
    const { logged, done } = await run({ actions: false });
    expect(logged).toEqual([]);
    await done();
  });
});

describe('the real Playwright runner holding a fixture token', () => {
  // GitHub only honours a workflow command that starts a line of the step's
  // stdout, and a mask that never registers prints the cookie in a public log, so
  // this runs the runner rather than spying on console.log.
  test('registers the mask before any test, seeds the cookie, and leaves no state behind', async () => {
    const heard: Array<string | null> = [];
    const target = host((req) => {
      const path = new URL(req.url).pathname;
      if (path === '/score/never-audited.dev') {
        heard.push(req.headers.get('cookie'));
        return new Response('none', { status: 404, headers: { 'cache-control': 'no-store' } });
      }
      if (req.headers.get('cookie')?.includes(`CF_Authorization=${JWT}`)) return new Response('ok');
      return req.headers.get('cf-access-client-secret') ? issued() : login();
    });
    const work = await mkdtemp(join(tmpdir(), 'anc-access-runner-'));
    const statePath = join(work, 'state.json');
    const run = Bun.spawn(
      [
        'bun',
        'x',
        'playwright',
        'test',
        '--project=edge-hit',
        '-g',
        'a never-audited host 404',
        `--output=${join(work, 'output')}`,
      ],
      {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          CI: 'true',
          GITHUB_ACTIONS: 'true',
          ANC_STAGING_BASE_URL: target.base,
          ANC_STAGING_ACCESS_CLIENT_ID: ID,
          ANC_STAGING_ACCESS_CLIENT_SECRET: SECRET,
          ANC_E2E_ACCESS_STATE: statePath,
        },
      },
    );
    const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
    expect(await run.exited, `${stdout}\n${stderr}`).toBe(0);

    const lines = stdout.split('\n');
    const mask = lines.indexOf(`::add-mask::${JWT}`);
    expect(mask).toBeGreaterThanOrEqual(0);
    expect(mask).toBeLessThan(lines.findIndex((line) => line.includes('never-audited')));
    expect(`${stdout}${stderr}`).not.toContain(SECRET);

    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((cookie) => cookie?.includes(`CF_Authorization=${JWT}`))).toBe(true);
    expect(target.seen.filter((s) => s.secret !== null)).toHaveLength(1);
    expect(await Bun.file(statePath).exists()).toBe(false);
  }, 60_000);
});
