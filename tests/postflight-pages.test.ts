// scripts/release/postflight.sh's gates read the deployed site. A stand-in `curl` on
// PATH answers from fixed bodies and negotiates like the Worker, so what runs is the
// gate's own shell, under its own pipefail. What curl does between attempts belongs to
// curl itself, so those cases live in postflight-pages-curl.test.ts.

import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const FAKE_CURL = `#!/usr/bin/env bash
url="" html="" out=/dev/stdout format=""
case " $* " in *" fixture-secret "*) echo 'secret in argv' >>"$FAKE_CURL_DIR/credentials.log" ;; esac
env | grep -q '^CF_ACCESS_' && echo 'secret in environment' >>"$FAKE_CURL_DIR/credentials.log"
while [ $# -gt 0 ]; do
  case "$1" in
    http://* | https://* | HTTPS://*) url="$1" ;;
    'Accept: text/html') html=1 ;;
    -o) out="$2"; shift ;;
    -w) format="$2"; shift ;;
    -K)
      if [ -p "$2" ]; then echo 'config through a pipe' >>"$FAKE_CURL_DIR/credentials.log"
      else echo 'config in a file' >>"$FAKE_CURL_DIR/credentials.log"; fi
      grep -q fixture-secret "$2" && echo 'config carries the secret' >>"$FAKE_CURL_DIR/credentials.log"
      shift ;;
  esac
  shift
done
printf '%s\\n' "$url" >>"$FAKE_CURL_DIR/urls.log"
if [ -n "\${FAKE_CURL_REDIRECT:-}" ]; then
  : >"$out"
  printf '302 %s' "$FAKE_CURL_REDIRECT"
  exit 0
fi
case "$url" in
  */api/score) cat "$FAKE_CURL_DIR/score.json" >"$out"; printf '200 '; exit 0 ;;
  */sitemap.xml) cat "$FAKE_CURL_DIR/sitemap.xml" >"$out"; printf '200 '; exit "\${FAKE_CURL_EXIT:-0}" ;;
  */skill.json) printf '{"version":"%s"}' "\${FAKE_SKILL_VERSION:-0.0.0}" >"$out"; printf '200 '; exit "\${FAKE_CURL_EXIT:-0}" ;;
esac
case "$format" in
  '%{http_code}') printf '%s' "\${FAKE_WALK_CODE:-200}"; exit "\${FAKE_WALK_EXIT:-0}" ;;
esac
if [ -z "$html" ]; then
  printf -- '---\\ntitle: the markdown twin\\n---\\n' >"$out"
elif [ "\${url%/scorecards}" != "$url" ]; then
  cat "$FAKE_CURL_DIR/scorecards.html" >"$out"
else
  cat "$FAKE_CURL_DIR/home.html" >"$out"
fi
printf '%s ' "\${FAKE_CURL_CODE:-200}"
exit "\${FAKE_CURL_EXIT:-0}"
`;

// The helpers a gate runs around its fetches, which have no business holding the secret.
const recordsItsEnvironment = (tool: string): string => `#!/usr/bin/env bash
env | grep -q '^CF_ACCESS_' && echo 'secret in environment' >>"$FAKE_CURL_DIR/credentials.log"
PATH="$REAL_PATH" exec ${tool} "$@"
`;

const SCORE = JSON.stringify({
  tier: 'registry',
  scorecard_url: 'https://fixture.invalid/score/ripgrep',
  spec_version: '0.0.0',
});

// The sitemap names the canonical host on every deployment.
const SITEMAP = [
  '<urlset>',
  '<url><loc>https://anc.dev</loc></url>',
  '<url><loc>https://anc.dev/</loc></url>',
  '<url><loc>https://anc.dev/privacy</loc></url>',
  '</urlset>',
].join('\n');
const SOURCE_SKILL_VERSION: string = JSON.parse(
  readFileSync(join(REPO_ROOT, 'src/data/skill/skill.json'), 'utf8'),
).version;
const LOGIN_REDIRECT = 'https://team.cloudflareaccess.com/cdn-cgi/access/login/fixture';

const PROD = ['--env', 'prod', '--prod-url', 'https://fixture.invalid'];
const STAGING = ['--env', 'staging', '--staging-url', 'https://fixture.invalid'];

// 264 KB, past twice the 64 KB pipe buffer, so a writer feeding `grep -q` is still
// blocked when grep matches in its first read and exits. Just past one buffer the
// writer can finish first: a 90 KB body, /scorecards' size on anc.dev, fails 39 of 40.
const PADDING = `${'x'.repeat(79)}\n`.repeat(3300);

/** A page past the pipe buffer, in lines, with `marker` where the first read reaches it. */
function largePage(marker: string): string {
  return `<!doctype html>\n${marker}\n${PADDING}`;
}

const HOME = largePage('<h1 class="hero__title">');
const SCORECARDS = largePage('<div class="lrow">');
const LOGIN = '<title>Sign in</title>';

interface Run {
  script?: string;
  gate?: string;
  sitemap?: string;
  args?: string[];
  env?: Record<string, string>;
  token?: boolean;
}

function postflight(
  home: string,
  scorecards: string,
  { script = 'postflight.sh', gate = 'pages', sitemap = SITEMAP, args = PROD, env = {}, token = false }: Run = {},
): { status: number; output: string; urls: string[]; credentials: string } {
  const bin = mkdtempSync(join(tmpdir(), 'postflight-pages-'));
  try {
    writeFileSync(join(bin, 'curl'), FAKE_CURL);
    chmodSync(join(bin, 'curl'), 0o755);
    for (const tool of ['mktemp', 'rm']) {
      writeFileSync(join(bin, tool), recordsItsEnvironment(tool));
      chmodSync(join(bin, tool), 0o755);
    }
    writeFileSync(join(bin, 'read_field.sh'), '#!/usr/bin/env bash\necho fixture-secret\n');
    chmodSync(join(bin, 'read_field.sh'), 0o755);
    writeFileSync(join(bin, 'home.html'), home);
    writeFileSync(join(bin, 'scorecards.html'), scorecards);
    writeFileSync(join(bin, 'score.json'), SCORE);
    writeFileSync(join(bin, 'sitemap.xml'), sitemap);
    writeFileSync(join(bin, 'urls.log'), '');
    writeFileSync(join(bin, 'credentials.log'), '');
    const proc = Bun.spawnSync(['bash', join(REPO_ROOT, 'scripts/release', script), ...args, gate], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REAL_PATH: process.env.PATH,
        FAKE_CURL_DIR: bin,
        OP_SKILL: token ? bin : '/nonexistent',
        CF_ACCESS_CLIENT_ID: '',
        CF_ACCESS_CLIENT_SECRET: '',
        ...env,
      },
    });
    return {
      status: proc.exitCode,
      output: proc.stdout.toString() + proc.stderr.toString(),
      urls: readFileSync(join(bin, 'urls.log'), 'utf8').split('\n').filter(Boolean),
      credentials: readFileSync(join(bin, 'credentials.log'), 'utf8'),
    };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe('postflight pages gate', () => {
  test('passes a page past the pipe buffer whose marker is on an early line', () => {
    const { status, output } = postflight(HOME, SCORECARDS);
    expect(output).toContain('home page renders (has hero__title)');
    expect(output).toContain('/scorecards renders (has lrow)');
    expect(status).toBe(0);
  });

  test('fails a page past the pipe buffer that lacks its marker', () => {
    const { status, output } = postflight(largePage('<p>none</p>'), largePage('<p>none</p>'));
    expect(output).toContain('did not return HTML with hero__title (HTTP 200)');
    expect(output).toContain('did not return HTML with lrow (HTTP 200)');
    expect(status).toBe(1);
  });

  test('names the failed fetch and its HTTP status when the marker arrived before the failure', () => {
    const { status, output } = postflight(HOME, SCORECARDS, { env: { FAKE_CURL_EXIT: '28', FAKE_CURL_CODE: '000' } });
    expect(output).toContain('curl exited 28 (HTTP 000)');
    expect(output).not.toContain('renders (has');
    expect(status).toBe(1);
  });

  test('runs against production with no Access token, because production is public', () => {
    const { status, output } = postflight(HOME, SCORECARDS);
    expect(output).not.toContain('no CF Access service token');
    expect(output).toContain('/scorecards renders (has lrow)');
    expect(status).toBe(0);
  });

  test('runs the rows on staging with a token loaded', () => {
    const { status, output } = postflight(HOME, SCORECARDS, { args: STAGING, token: true });
    expect(output).toContain('home page renders (has hero__title)');
    expect(output).toContain('/scorecards renders (has lrow)');
    expect(status).toBe(0);
  });

  test('names where a rejected token was sent instead of passing on the login page', () => {
    const { status, output } = postflight(LOGIN, LOGIN, {
      args: STAGING,
      token: true,
      env: { FAKE_CURL_REDIRECT: LOGIN_REDIRECT },
    });
    expect(output).toContain(`did not return HTML with hero__title (HTTP 302 to ${LOGIN_REDIRECT})`);
    expect(output).not.toContain('renders (has');
    expect(status).toBe(1);
  });
});

describe('a run killed before its EXIT trap', () => {
  test('leaves the Access secret nowhere on disk', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'postflight-killed-'));
    const scratch = mkdtempSync(join(tmpdir(), 'postflight-killed-tmp-'));
    try {
      writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\ntouch "${bin}/started"\nexec sleep 5\n`);
      chmodSync(join(bin, 'curl'), 0o755);
      writeFileSync(join(bin, 'read_field.sh'), '#!/usr/bin/env bash\necho fixture-secret\n');
      chmodSync(join(bin, 'read_field.sh'), 0o755);
      const proc = Bun.spawn(['bash', join(REPO_ROOT, 'scripts/release/postflight.sh'), ...STAGING, 'pages'], {
        cwd: REPO_ROOT,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OP_SKILL: bin, TMPDIR: scratch },
        stdout: 'ignore',
        stderr: 'ignore',
      });
      while (!existsSync(join(bin, 'started'))) await Bun.sleep(20);
      proc.kill('SIGKILL');
      await proc.exited;
      const leftBehind = readdirSync(scratch).filter((name) =>
        readFileSync(join(scratch, name), 'utf8').includes('fixture-secret'),
      );
      expect(leftBehind).toEqual([]);
    } finally {
      rmSync(bin, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('postflight gates that read staging through CF Access', () => {
  test.each(['pages', 'retired', 'sitemap', 'purge', 'mcp'])('%s fails and names a missing token', (gate) => {
    const { status, output } = postflight(LOGIN, LOGIN, { gate, args: STAGING });
    expect(output).toContain('no CF Access service token, exported or from 1Password');
    expect(output).not.toContain('renders (has');
    expect(status).toBe(1);
  });

  test('sitemap walks the target it was given, so staging credentials stay on staging', () => {
    const { status, output, urls } = postflight(HOME, SCORECARDS, { gate: 'sitemap', args: STAGING, token: true });
    expect(urls).toEqual([
      'https://fixture.invalid/sitemap.xml',
      'https://fixture.invalid/',
      'https://fixture.invalid/',
      'https://fixture.invalid/privacy',
    ]);
    expect(output).toContain('all 3 sitemap entries return 200');
    expect(status).toBe(0);
  });

  test('sitemap fails an entry naming a host other than the canonical one, and does not fetch it', () => {
    const elsewhere = 'https://other.invalid/privacy';
    const { status, output, urls } = postflight(HOME, SCORECARDS, {
      gate: 'sitemap',
      sitemap: `<urlset><url><loc>https://anc.dev/</loc></url><url><loc>${elsewhere}</loc></url></urlset>`,
    });
    expect(output).toContain(`sitemap entry ${elsewhere}`);
    expect(output).toContain('names a host other than');
    expect(urls).not.toContain(elsewhere);
    expect(status).toBe(1);
  });

  test('sitemap reports a failed entry with the status curl gave', () => {
    const { status, output } = postflight(HOME, SCORECARDS, {
      gate: 'sitemap',
      env: { FAKE_WALK_CODE: '000', FAKE_WALK_EXIT: '7' },
    });
    expect(output).toContain('code=000');
    expect(output).not.toContain('code=000000');
    expect(status).toBe(1);
  });

  test.each(['pages', 'purge', 'sitemap'])('%s runs on staging with credentials exported instead of staged', (gate) => {
    const { output, urls, credentials } = postflight(HOME, SCORECARDS, {
      gate,
      args: STAGING,
      env: { CF_ACCESS_CLIENT_ID: 'fixture-id', CF_ACCESS_CLIENT_SECRET: 'fixture-secret' },
    });
    expect(output).not.toContain('no CF Access service token');
    expect(urls.length).toBeGreaterThan(0);
    expect(credentials).toContain('config carries the secret');
  });

  test('sitemap fails an entry whose transfer failed after it answered 200', () => {
    const { status, output } = postflight(HOME, SCORECARDS, {
      gate: 'sitemap',
      env: { FAKE_WALK_CODE: '200', FAKE_WALK_EXIT: '18' },
    });
    expect(output).toContain('curl exited 18, code=200');
    expect(status).toBe(1);
  });

  test('mcp runs on staging with credentials exported instead of staged', () => {
    const { output, credentials } = postflight(HOME, SCORECARDS, {
      gate: 'mcp',
      args: STAGING,
      env: { CF_ACCESS_CLIENT_ID: 'fixture-id', CF_ACCESS_CLIENT_SECRET: 'fixture-secret' },
    });
    expect(output).toContain('Live MCP surface');
    expect(credentials).toContain('config carries the secret');
  });

  test.each(['pages', 'mcp'])(
    "%s holds the credentials off disk, out of argv and out of curl's environment",
    (gate) => {
      const { credentials } = postflight(HOME, SCORECARDS, { gate, args: STAGING, token: true });
      expect(credentials).toContain('config through a pipe');
      expect(credentials).toContain('config carries the secret');
      expect(credentials).not.toContain('config in a file');
      expect(credentials).not.toContain('secret in argv');
      expect(credentials).not.toContain('secret in environment');
    },
  );

  test.each(['mcp', 'dist'])(
    "preflight %s holds the credentials off disk, out of argv and out of curl's environment",
    (gate) => {
      const { urls, credentials } = postflight(HOME, SCORECARDS, {
        script: 'preflight.sh',
        gate,
        args: STAGING,
        token: true,
      });
      expect(urls.length).toBeGreaterThan(0);
      expect(credentials).toContain('config through a pipe');
      expect(credentials).toContain('config carries the secret');
      expect(credentials).not.toContain('config in a file');
      expect(credentials).not.toContain('secret in argv');
      expect(credentials).not.toContain('secret in environment');
    },
  );

  test.each([['pages'], ['mcp']])('%s against a local preview asks 1Password for no token to send it', (gate) => {
    const { urls, credentials } = postflight(HOME, SCORECARDS, {
      gate,
      args: ['--env', 'staging', '--staging-url', 'http://127.0.0.1:8787'],
      token: true,
    });
    expect(urls.length).toBeGreaterThan(0);
    expect(credentials).not.toContain('config carries the secret');
  });

  test('a local preview still receives credentials the operator exported', () => {
    const { credentials } = postflight(HOME, SCORECARDS, {
      args: ['--env', 'staging', '--staging-url', 'http://127.0.0.1:8787'],
      env: { CF_ACCESS_CLIENT_ID: 'fixture-id', CF_ACCESS_CLIENT_SECRET: 'fixture-secret' },
    });
    expect(credentials).toContain('config carries the secret');
  });

  test('a host that only starts like a local preview still needs a token', () => {
    const { status, output } = postflight(HOME, SCORECARDS, {
      args: ['--env', 'staging', '--staging-url', 'http://localhost.fixture.invalid'],
    });
    expect(output).toContain('no CF Access service token');
    expect(status).toBe(1);
  });

  test.each([['https://anc.dev'], ['https://www.anc.dev/'], ['HTTPS://ANC.dev'], ['https://anc.dev:443']])(
    'mcp-smoke.sh pointed at %s drops exported staging credentials',
    (url) => {
      const { urls, credentials } = postflight(HOME, SCORECARDS, {
        script: 'mcp-smoke.sh',
        gate: '--core-only',
        args: [url],
        env: { CF_ACCESS_CLIENT_ID: 'fixture-id', CF_ACCESS_CLIENT_SECRET: 'fixture-secret' },
      });
      expect(urls.length).toBeGreaterThan(0);
      expect(credentials).not.toContain('config carries the secret');
    },
  );

  test('mcp-smoke.sh pointed anywhere else keeps them', () => {
    const { credentials } = postflight(HOME, SCORECARDS, {
      script: 'mcp-smoke.sh',
      gate: '--core-only',
      args: ['https://fixture.invalid'],
      env: { CF_ACCESS_CLIENT_ID: 'fixture-id', CF_ACCESS_CLIENT_SECRET: 'fixture-secret' },
    });
    expect(credentials).toContain('config carries the secret');
  });

  test.each(['pages', 'mcp'])('%s against production sends exported staging credentials nowhere', (gate) => {
    const { output, credentials } = postflight(HOME, SCORECARDS, {
      gate,
      env: { CF_ACCESS_CLIENT_ID: 'fixture-id', CF_ACCESS_CLIENT_SECRET: 'fixture-secret' },
    });
    expect(output).not.toContain('no CF Access service token');
    expect(credentials).not.toContain('config carries the secret');
    expect(credentials).not.toContain('secret in environment');
  });

  test('sitemap names where a rejected token was sent', () => {
    const { status, output } = postflight(LOGIN, LOGIN, {
      gate: 'sitemap',
      args: STAGING,
      token: true,
      env: { FAKE_CURL_REDIRECT: LOGIN_REDIRECT },
    });
    expect(output).toContain(`(curl exited 0, HTTP 302 to ${LOGIN_REDIRECT})`);
    expect(status).toBe(1);
  });

  test.each(['sitemap', 'purge'])('%s fails when its fetch failed after the bytes arrived', (gate) => {
    const { status, output } = postflight(HOME, SCORECARDS, {
      gate,
      args: STAGING,
      token: true,
      env: { FAKE_CURL_EXIT: '18', FAKE_SKILL_VERSION: SOURCE_SKILL_VERSION },
    });
    expect(output).toContain('curl exited 18');
    expect(status).toBe(1);
  });

  test('purge fails on a rejected token rather than exiting 0 having verified nothing', () => {
    const { status, output } = postflight(LOGIN, LOGIN, {
      gate: 'purge',
      args: STAGING,
      token: true,
      env: { FAKE_CURL_REDIRECT: LOGIN_REDIRECT },
    });
    expect(output).toContain(`HTTP 302 to ${LOGIN_REDIRECT}`);
    expect(output).not.toContain('⊝');
    expect(status).toBe(1);
  });

  test('purge runs to a verdict with a token loaded', () => {
    const matches = postflight(HOME, SCORECARDS, {
      gate: 'purge',
      args: STAGING,
      token: true,
      env: { FAKE_SKILL_VERSION: SOURCE_SKILL_VERSION },
    });
    expect(matches.output).toContain('matches src/data/skill/skill.json');
    expect(matches.status).toBe(0);
    const drifted = postflight(HOME, SCORECARDS, {
      gate: 'purge',
      args: STAGING,
      token: true,
      env: { FAKE_SKILL_VERSION: '0.0.0-drifted' },
    });
    expect(drifted.output).toContain('version drift');
    expect(drifted.status).toBe(1);
  });

  test.each(['retired', 'sitemap', 'purge'])('%s needs no token on production, and fetches', (gate) => {
    const { output, urls } = postflight(HOME, SCORECARDS, { gate });
    expect(output).not.toContain('no CF Access service token');
    expect(urls.length).toBeGreaterThan(0);
  });
});
