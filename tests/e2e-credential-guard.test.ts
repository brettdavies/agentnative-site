// What stands between the Access service token and everywhere it must not go,
// outside the session module itself: no spec or config may build the headers or
// read the session, the audit script may only send the token to staging, and a
// run holding the token writes nothing CI uploads that could carry it.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { isStagingUrl, STAGING_HOSTNAME } from '../scripts/web-audit/staging-host';

// Several cases start a subprocess, which a loaded machine can take seconds to do.
setDefaultTimeout(30_000);

const REPO_ROOT = join(import.meta.dir, '..');
const SESSION_MODULE = 'tests/e2e/access-session.ts';
const LIVE_SCOPE_SPEC = 'tests/e2e/web-audit.e2e.ts';
const CONFIG = 'playwright.config.ts';

const ID = 'fixture-client-id';
const SECRET = 'fixture-client-secret';
const JWT = 'fixture.jwt.value';

type Source = { path: string; text: string };

// Every spec, the config, and the helpers the specs import, which merge into the
// same requests.
async function e2eSources(): Promise<Source[]> {
  const dir = join(REPO_ROOT, 'tests', 'e2e');
  const names = (await readdir(dir, { recursive: true })).filter((name) => name.endsWith('.ts'));
  const paths = new Set([...names.map((name) => join(dir, name)), join(REPO_ROOT, CONFIG)]);
  for (const path of [...paths]) {
    for (const match of (await readFile(path, 'utf8')).matchAll(/from '(\.\.\/helpers\/[^']+)'/g)) {
      paths.add(join(dirname(path), `${match[1]}.ts`));
    }
  }
  return Promise.all(
    [...paths].map(async (path) => ({ path: relative(REPO_ROOT, path), text: await readFile(path, 'utf8') })),
  );
}

const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

function hits(sources: Source[], pattern: RegExp, except: string[] = []): string[] {
  return sources
    .filter((source) => !except.includes(source.path))
    .flatMap((source) =>
      source.text
        .split('\n')
        .flatMap((line, index) => (!isComment(line) && pattern.test(line) ? [`${source.path}:${index + 1}`] : [])),
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
  test('only the session module names the service-token headers, the Access token header, or the cookie', async () => {
    const pattern = /cf-access-client-|cf-access-token|cf-access-jwt|CF_Authorization/i;
    expect(hits(await e2eSources(), pattern, [SESSION_MODULE])).toEqual([]);
  });

  test('no spec or config sets a cookie header, in any shape', async () => {
    const pattern = /\bcookie['"`]?\s*[:,}\]]/i;
    expect(hits(await e2eSources(), pattern, [SESSION_MODULE])).toEqual([]);
    for (const shape of ['headers: { cookie }', 'headers: { cookie: value }', "headers.set('cookie', value)"]) {
      expect(pattern.test(shape)).toBe(true);
    }
  });

  test('only the live scope test reads the session', async () => {
    const pattern = /ACCESS_COOKIE_NAME|\.cookies\(|\.storageState\(/;
    expect(hits(await e2eSources(), pattern, [SESSION_MODULE, LIVE_SCOPE_SPEC])).toEqual([]);
    expect(hits(await e2eSources(), /ANC_E2E_ACCESS_STATE/, [SESSION_MODULE, CONFIG])).toEqual([]);
  });

  test('only the session module and the config read the service token', async () => {
    const sources = await e2eSources();
    expect(hits(sources, /ANC_STAGING_ACCESS_CLIENT_SECRET/, [SESSION_MODULE])).toEqual([]);
    expect(hits(sources, /ANC_STAGING_ACCESS_CLIENT_ID/, [SESSION_MODULE, CONFIG])).toEqual([]);
  });

  test('the session module sends every request through the one that refuses redirects', async () => {
    const source = await readFile(join(REPO_ROOT, SESSION_MODULE), 'utf8');
    expect(source.match(/\bcontext\.(get|post|put|patch|delete|head|fetch)\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).toContain('maxRedirects: 0');
  });
});

describe('credentials outside Playwright', () => {
  test('the local audit script treats only the staging Worker itself as staging', () => {
    expect(isStagingUrl(`https://${STAGING_HOSTNAME}/`)).toBe(true);
    expect(isStagingUrl(`https://${STAGING_HOSTNAME}/some/path`)).toBe(true);
    expect(isStagingUrl(`http://${STAGING_HOSTNAME}/`)).toBe(false);
    expect(isStagingUrl(`https://${STAGING_HOSTNAME}:8080/`)).toBe(false);
    expect(isStagingUrl('https://agentnative-site-staging.another-account.workers.dev/')).toBe(false);
    expect(isStagingUrl('https://agentnative-site-staging.example.com/')).toBe(false);
    expect(isStagingUrl(`https://${STAGING_HOSTNAME}.example.com/`)).toBe(false);
    expect(isStagingUrl(`https://example.com/${STAGING_HOSTNAME}`)).toBe(false);
    expect(isStagingUrl('https://anc.dev/')).toBe(false);
  });

  test('run.sh reads the token only when the same predicate says the target is staging', async () => {
    const script = join(REPO_ROOT, 'scripts', 'web-audit', 'staging-host.ts');
    const exitOf = (url: string): number | null => Bun.spawnSync(['bun', script, url]).exitCode;
    expect(exitOf(`https://${STAGING_HOSTNAME}/`)).toBe(0);
    expect(exitOf('https://agentnative-site-staging.another-account.workers.dev/')).toBe(1);

    const source = await readFile(join(REPO_ROOT, 'scripts', 'web-audit', 'run.sh'), 'utf8');
    expect(source).toContain('if bun "$REPO_ROOT/scripts/web-audit/staging-host.ts" "$TARGET"');
    expect(source).not.toContain('*agentnative-site-staging*');
    // A second copy of the host that drifted would read as a public target.
    expect(source).toContain(`https://${STAGING_HOSTNAME}/`);
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

  test('a local-target run with the token exported keeps its traces and reports and mints nothing', () => {
    const config = configUnder({
      CI: 'true',
      ANC_STAGING_ACCESS_CLIENT_ID: ID,
      ANC_STAGING_ACCESS_CLIENT_SECRET: SECRET,
    });
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
