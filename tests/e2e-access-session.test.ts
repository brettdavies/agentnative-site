// The live Playwright suites reach staging through Cloudflare Access. These
// tests pin the ways that credential can leave a run: a spec or config that
// puts the service-token headers on a context or a request, the one module
// allowed to send them following a redirect or spending them on a host with no
// Access wall, and Playwright's own output reaching what CI uploads.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { isStagingUrl } from '../scripts/web-audit/staging-host';
import globalSetup, { AccessSessionError, type AccessSessionReason, mintAccessState } from './e2e/access-session';

const REPO_ROOT = join(import.meta.dir, '..');
const SESSION_MODULE = 'tests/e2e/access-session.ts';
const CONFIG = 'playwright.config.ts';

const ID = 'fixture-client-id';
const SECRET = 'fixture-client-secret';
const JWT = 'fixture.jwt.value';
const SET_COOKIE = `CF_Authorization=${JWT}; Expires=Sat, 05 Dec 2026 01:35:52 GMT; Path=/; Secure; HttpOnly; SameSite=none`;

type Seen = { path: string; secret: string | null; cookie: string | null };

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A local host that records every request it hears. */
function host(answer: (req: Request) => Response): { base: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      seen.push({
        path: new URL(req.url).pathname,
        secret: req.headers.get('cf-access-client-secret'),
        cookie: req.headers.get('cookie'),
      });
      return answer(req);
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, seen };
}

const login = (): Response =>
  new Response(null, { status: 302, headers: { location: 'https://team.example/cdn-cgi/access/login/x?kid=1' } });

const issued = (extra = ''): Response => new Response('ok', { headers: { 'set-cookie': `${SET_COOKIE}${extra}` } });

/** A target behind Access: the token earns the cookie and the cookie earns the page. */
function gated(onToken: () => Response = () => issued()): { base: string; seen: Seen[] } {
  return host((req) => {
    if (req.headers.get('cookie') === `CF_Authorization=${JWT}`) return new Response('ok');
    return req.headers.get('cf-access-client-secret') ? onToken() : login();
  });
}

async function reasonOf(attempt: Promise<unknown>): Promise<AccessSessionReason> {
  const err = await attempt.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof AccessSessionError)) throw new Error(`expected an AccessSessionError, got ${String(err)}`);
  return err.reason;
}

describe('mintAccessState', () => {
  test('a target with no Access wall never sees the service token', async () => {
    const target = host(() => new Response('ok'));
    const state = await mintAccessState({ base: target.base, clientId: ID, clientSecret: SECRET });
    expect(state).toEqual({ cookies: [], origins: [] });
    expect(target.seen.map((s) => s.secret)).toEqual([null]);
  });

  test('a gated target yields only the cookie, scoped to its own host', async () => {
    const target = gated();
    const state = await mintAccessState({ base: target.base, clientId: ID, clientSecret: SECRET });
    expect(state).toEqual({
      origins: [],
      cookies: [
        {
          name: 'CF_Authorization',
          value: JWT,
          domain: '127.0.0.1',
          path: '/',
          expires: Math.floor(Date.parse('Sat, 05 Dec 2026 01:35:52 GMT') / 1000),
          httpOnly: true,
          secure: true,
          sameSite: 'None',
        },
      ],
    });
    expect(JSON.stringify(state)).not.toContain(SECRET);
    expect(target.seen.filter((s) => s.secret !== null)).toHaveLength(1);
  });

  test('a broader Domain attribute does not widen where the cookie goes', async () => {
    const target = gated(() => issued('; Domain=example.dev'));
    const state = await mintAccessState({ base: target.base, clientId: ID, clientSecret: SECRET });
    expect(state.cookies[0]?.domain).toBe('127.0.0.1');
  });

  test('a credentialed request does not follow a redirect to another host', async () => {
    const elsewhere = host(() => new Response('ok'));
    const target = gated(() => new Response(null, { status: 302, headers: { location: `${elsewhere.base}/landed` } }));
    const attempt = mintAccessState({ base: target.base, clientId: ID, clientSecret: SECRET });
    expect(await reasonOf(attempt)).toBe('access-token-rejected');
    expect(elsewhere.seen).toEqual([]);
  });

  test('a gated target with no credentials stops the run and sends nothing', async () => {
    const target = gated();
    expect(await reasonOf(mintAccessState({ base: target.base }))).toBe('access-credentials-missing');
    expect(target.seen.map((s) => s.secret)).toEqual([null]);
  });

  test('strict service token authentication withholding the cookie stops the run', async () => {
    const target = gated(() => new Response('ok'));
    const attempt = mintAccessState({ base: target.base, clientId: ID, clientSecret: SECRET });
    expect(await reasonOf(attempt)).toBe('access-cookie-not-issued');
  });

  test('a cookie Access will not honor stops the run', async () => {
    const target = host((req) => (req.headers.get('cf-access-client-secret') ? issued() : login()));
    const attempt = mintAccessState({ base: target.base, clientId: ID, clientSecret: SECRET });
    expect(await reasonOf(attempt)).toBe('access-cookie-refused');
  });

  test('no failure message carries a credential', async () => {
    const target = gated(() => new Response('ok'));
    const err = await mintAccessState({ base: target.base, clientId: ID, clientSecret: SECRET }).catch(
      (e: unknown) => e,
    );
    expect(String(err)).not.toContain(SECRET);
    expect(String(err)).not.toContain(ID);
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
  }): Promise<{ logged: string[]; statePath: string; done: () => Promise<void> }> {
    const before = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
    const statePath = join(await mkdtemp(join(tmpdir(), 'anc-access-session-')), 'state.json');
    process.env.ANC_STAGING_BASE_URL = gated().base;
    process.env.ANC_E2E_ACCESS_STATE = statePath;
    process.env.ANC_STAGING_ACCESS_CLIENT_ID = ID;
    process.env.ANC_STAGING_ACCESS_CLIENT_SECRET = SECRET;
    if (env.actions) process.env.GITHUB_ACTIONS = 'true';
    else delete process.env.GITHUB_ACTIONS;
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const done = await globalSetup();
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

  test('prints no cookie off CI', async () => {
    const { logged, done } = await run({ actions: false });
    expect(logged).toEqual([]);
    await done();
  });
});

type Source = { path: string; text: string };

async function e2eSources(): Promise<Source[]> {
  const dir = join(REPO_ROOT, 'tests', 'e2e');
  const names = (await readdir(dir, { recursive: true })).filter((name) => name.endsWith('.ts'));
  const paths = [...names.map((name) => join(dir, name)), join(REPO_ROOT, CONFIG)];
  return Promise.all(
    paths.map(async (path) => ({ path: relative(REPO_ROOT, path), text: await readFile(path, 'utf8') })),
  );
}

function hits(sources: Source[], pattern: RegExp, except: string[] = []): string[] {
  return sources
    .filter((source) => !except.includes(source.path))
    .flatMap((source) =>
      source.text.split('\n').flatMap((line, index) => (pattern.test(line) ? [`${source.path}:${index + 1}`] : [])),
    );
}

describe('live e2e credential guard', () => {
  // Whatever this option holds is sent to every host a page or a followed
  // redirect reaches, so it is banned outright rather than judged by its value.
  test('no spec or config sets extra HTTP headers on a context', async () => {
    expect(hits(await e2eSources(), /extraHTTPHeaders/i)).toEqual([]);
  });

  // A spec that could build these headers, or copy the cookie into one, could
  // pass them to a request that follows a redirect.
  test('only the session module names the service-token headers or the cookie', async () => {
    expect(hits(await e2eSources(), /cf-access-client-|CF_Authorization/i, [SESSION_MODULE])).toEqual([]);
  });

  test('only the session module and the config read the service token', async () => {
    const sources = await e2eSources();
    expect(hits(sources, /ANC_STAGING_ACCESS_CLIENT_SECRET/, [SESSION_MODULE])).toEqual([]);
    expect(hits(sources, /ANC_STAGING_ACCESS_CLIENT_ID/, [SESSION_MODULE, CONFIG])).toEqual([]);
  });

  test('the session module sends every request through the one that refuses redirects', async () => {
    const source = await readFile(join(REPO_ROOT, SESSION_MODULE), 'utf8');
    expect(source.match(/\bfetch\(/g)).toHaveLength(1);
    expect(source).toContain("fetch(url, { redirect: 'manual',");
  });
});

describe('credentials outside Playwright', () => {
  test('the local audit script sends the token to the staging Worker and no lookalike', () => {
    expect(isStagingUrl('https://agentnative-site-staging.example-team.workers.dev/')).toBe(true);
    expect(isStagingUrl('https://agentnative-site-staging.example.com/')).toBe(false);
    expect(isStagingUrl('https://not-agentnative-site-staging.example-team.workers.dev/')).toBe(false);
    expect(isStagingUrl('https://example.com/agentnative-site-staging')).toBe(false);
    expect(isStagingUrl('https://anc.dev/')).toBe(false);
  });

  test("preflight redacts the cookie from every failed gate's tail", async () => {
    const source = await readFile(join(REPO_ROOT, 'scripts', 'release', 'preflight.sh'), 'utf8');
    const definition = /redact_access_cookie\(\) \{\n[^}]*\n\}/.exec(source)?.[0];
    expect(definition).toBeDefined();
    const line = `cookie: CF_Authorization=${JWT}; other=1`;
    const run = Bun.spawnSync(['bash', '-c', `${definition}\nprintf '%s\\n' '${line}' | redact_access_cookie`]);
    expect(run.stdout.toString().trim()).toBe('cookie: CF_Authorization=<redacted>; other=1');
    const tails = source.split('\n').filter((text) => /tail -25/.test(text));
    expect(tails.length).toBeGreaterThan(0);
    expect(tails.filter((text) => !text.includes('redact_access_cookie'))).toEqual([]);
  });
});

describe('a run holding the token writes no credential to what CI uploads', () => {
  type ConfigView = { trace: unknown; reporter: unknown; storageState: unknown; globalSetup: unknown };

  // A subprocess, because the config reads its environment once at import.
  function configUnder(env: Record<string, string>): ConfigView {
    const script = `import c from './${CONFIG}';
console.log(JSON.stringify({ trace: c.use.trace, reporter: c.reporter, storageState: c.use.storageState, globalSetup: c.globalSetup }));`;
    const run = Bun.spawnSync(['bun', '-e', script], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    expect(run.exitCode).toBe(0);
    return JSON.parse(run.stdout.toString().trim().split('\n').at(-1) ?? '{}') as ConfigView;
  }

  const HOLDING_TOKEN = {
    ANC_STAGING_BASE_URL: 'https://example.dev',
    ANC_STAGING_ACCESS_CLIENT_ID: ID,
    ANC_STAGING_ACCESS_CLIENT_SECRET: SECRET,
  };

  // Playwright records a request's headers, cookie included, in its traces,
  // its JSON and HTML reports, and error-context.md, and this repository's
  // Actions artifacts are public.
  test('traces are off and the file reporters are gone', () => {
    const config = configUnder({ ...HOLDING_TOKEN, CI: 'true' });
    expect(config.trace).toBe('off');
    expect(JSON.stringify(config.reporter)).not.toMatch(/"(html|json)"/);
  });

  test('a local-target run keeps its traces and reports and mints nothing', () => {
    const config = configUnder({ CI: 'true' });
    expect(config.trace).toBe('retain-on-failure');
    expect(JSON.stringify(config.reporter)).toContain('"html"');
    expect(config.globalSetup).toBeUndefined();
    expect(config.storageState).toBeUndefined();
  });

  test('a remote run seeds its contexts from a state file outside the repository', () => {
    const config = configUnder(HOLDING_TOKEN);
    expect(typeof config.globalSetup).toBe('string');
    expect(relative(REPO_ROOT, String(config.storageState)).startsWith('..')).toBe(true);
  });

  test('the job holding the token uploads screenshots only', async () => {
    const workflow = await readFile(join(REPO_ROOT, '.github', 'workflows', 'deep-check.yml'), 'utf8');
    const job = workflow.slice(workflow.indexOf('\n  staging-mcp:'), workflow.indexOf('\n  lhci:'));
    expect(job).toContain('ANC_STAGING_ACCESS_CLIENT_SECRET');
    const upload = job.slice(job.indexOf('actions/upload-artifact'));
    expect(upload).toContain('path: .context/test-results/**/*.png');
    expect(upload).not.toContain('playwright-report/');
  });
});
