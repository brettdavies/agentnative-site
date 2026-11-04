// scripts/release/postflight.sh's pages gate reads each page from the deployed
// edge and looks for a marker in the body. Most cases use a stand-in `curl` on
// PATH that answers from fixed bodies and negotiates like the Worker, so what runs
// is the gate's own shell, under its own pipefail. Retry behavior belongs to curl
// itself, so those cases drive real curl against a local socket.

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const POSTFLIGHT = join(REPO_ROOT, 'scripts/release/postflight.sh');

const FAKE_CURL = `#!/usr/bin/env bash
url="" html="" out=/dev/stdout
while [ $# -gt 0 ]; do
  case "$1" in
    https://*) url="$1" ;;
    'Accept: text/html') html=1 ;;
    -o) out="$2"; shift ;;
  esac
  shift
done
case "$url" in
  */api/score) cat "$FAKE_CURL_DIR/score.json"; exit 0 ;;
esac
if [ -z "$html" ]; then
  printf -- '---\\ntitle: the markdown twin\\n---\\n' >"$out"
elif [ "\${url%/scorecards}" != "$url" ]; then
  cat "$FAKE_CURL_DIR/scorecards.html" >"$out"
else
  cat "$FAKE_CURL_DIR/home.html" >"$out"
fi
printf '%s %s' "\${FAKE_CURL_CODE:-200}" "\${FAKE_CURL_FINAL:-$url}"
exit "\${FAKE_CURL_EXIT:-0}"
`;

const SCORE = JSON.stringify({
  tier: 'registry',
  scorecard_url: 'https://fixture.invalid/score/ripgrep',
  spec_version: '0.0.0',
});

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

const PAGE = largePage('<div class="lrow">');
const LOGIN = '<title>Sign in</title>';

function gatePages(
  home: string,
  scorecards: string,
  { args = PROD, env = {}, token = false }: { args?: string[]; env?: Record<string, string>; token?: boolean } = {},
): { status: number; output: string } {
  const bin = mkdtempSync(join(tmpdir(), 'postflight-pages-'));
  try {
    writeFileSync(join(bin, 'curl'), FAKE_CURL);
    chmodSync(join(bin, 'curl'), 0o755);
    writeFileSync(join(bin, 'read_field.sh'), '#!/usr/bin/env bash\necho fixture-value\n');
    chmodSync(join(bin, 'read_field.sh'), 0o755);
    writeFileSync(join(bin, 'home.html'), home);
    writeFileSync(join(bin, 'scorecards.html'), scorecards);
    writeFileSync(join(bin, 'score.json'), SCORE);
    const proc = Bun.spawnSync(['bash', POSTFLIGHT, ...args, 'pages'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_CURL_DIR: bin,
        OP_SKILL: token ? bin : '/nonexistent',
        ...env,
      },
    });
    return { status: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe('postflight pages gate', () => {
  test('passes a page past the pipe buffer whose marker is on an early line', () => {
    const { status, output } = gatePages(PAGE, PAGE);
    expect(output).toContain('home page renders (has lrow)');
    expect(output).toContain('/scorecards renders (has lrow)');
    expect(status).toBe(0);
  });

  test('fails a page past the pipe buffer that lacks its marker', () => {
    const { status, output } = gatePages(largePage('<p>no rows</p>'), largePage('<p>no rows</p>'));
    expect(output.match(/did not return HTML with lrow/g)).toHaveLength(2);
    expect(status).toBe(1);
  });

  test('names the failed fetch and its HTTP status when the marker arrived before the failure', () => {
    const { status, output } = gatePages(PAGE, PAGE, { env: { FAKE_CURL_EXIT: '28', FAKE_CURL_CODE: '000' } });
    expect(output).toContain('curl exited 28 (HTTP 000)');
    expect(output).not.toContain('renders (has');
    expect(status).toBe(1);
  });

  test('runs against production with no Access token, because production is public', () => {
    const { status, output } = gatePages(PAGE, PAGE);
    expect(output).not.toContain('no CF Access service token');
    expect(output).toContain('/scorecards renders (has lrow)');
    expect(status).toBe(0);
  });

  test('names a missing Access token instead of reading the staging login page', () => {
    const { status, output } = gatePages(LOGIN, LOGIN, { args: STAGING });
    expect(output).toContain('no CF Access service token');
    expect(output).not.toContain('renders (has');
    expect(status).toBe(1);
  });

  test('runs the rows on staging with a token loaded', () => {
    const { status, output } = gatePages(PAGE, PAGE, { args: STAGING, token: true });
    expect(output).toContain('home page renders (has lrow)');
    expect(output).toContain('/scorecards renders (has lrow)');
    expect(status).toBe(0);
  });

  test('names where a rejected token landed instead of passing on the login page', () => {
    const final = 'https://team.cloudflareaccess.com/cdn-cgi/access/login/fixture';
    const { status, output } = gatePages(LOGIN, LOGIN, {
      args: STAGING,
      token: true,
      env: { FAKE_CURL_FINAL: final },
    });
    expect(output).toContain(`did not return HTML with lrow (ended at ${final})`);
    expect(output).not.toContain('renders (has');
    expect(status).toBe(1);
  });
});

type Answer = 'page' | 'no-marker' | 'dropped' | '503' | '503-retry-after';

function answer(kind: Answer): string {
  const respond = (status: string, body: string, headers = '') =>
    `HTTP/1.1 ${status}\r\ncontent-type: text/html\r\ncontent-length: ${body.length}\r\nconnection: close\r\n${headers}\r\n${body}`;
  switch (kind) {
    case 'page':
      return respond('200 OK', '<div class="lrow">\n');
    case 'no-marker':
      return respond('200 OK', '<p>no rows</p>\n');
    case 'dropped':
      return 'HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 500000\r\n\r\n<div class="lrow">\n';
    case '503':
      return respond('503 Service Unavailable', '');
    case '503-retry-after':
      return respond('503 Service Unavailable', '', 'retry-after: 45\r\n');
  }
}

/** The real gate and real curl against a socket that answers `/` in turn from `attempts`. */
async function gateOverRealCurl(attempts: Answer[]): Promise<{ elapsedMs: number; output: string }> {
  let served = 0;
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, request) {
        const path = request.toString().split(' ')[1];
        if (path === '/') socket.write(answer(attempts[Math.min(served++, attempts.length - 1)]));
        else if (path === '/api/score') socket.write(`HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n${SCORE}`);
        else socket.write(answer('page'));
        socket.end();
      },
    },
  });
  const started = Date.now();
  try {
    const proc = Bun.spawn(
      ['bash', POSTFLIGHT, '--env', 'prod', '--prod-url', `http://127.0.0.1:${server.port}`, 'pages'],
      {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { elapsedMs: Date.now() - started, output: out + err };
  } finally {
    server.stop(true);
  }
}

describe('postflight pages gate over real curl', () => {
  test('recovers when a first attempt fails', async () => {
    const { output } = await gateOverRealCurl(['503', 'page']);
    expect(output).toContain('home page renders (has lrow)');
  }, 30_000);

  test('names the HTTP status when every attempt fails', async () => {
    const { output } = await gateOverRealCurl(['503']);
    expect(output).toContain('curl exited 22 (HTTP 503)');
    expect(output).not.toContain('home page renders');
  }, 30_000);

  test('does not read the marker from a dropped attempt when the next attempt lacks it', async () => {
    const { output } = await gateOverRealCurl(['dropped', 'no-marker']);
    expect(output).toContain('did not return HTML with lrow');
    expect(output).not.toContain('home page renders');
  }, 30_000);

  test('does not sleep through a long Retry-After', async () => {
    const { elapsedMs, output } = await gateOverRealCurl(['503-retry-after']);
    expect(elapsedMs).toBeLessThan(25_000);
    expect(output).not.toContain('home page renders');
  }, 30_000);
});
