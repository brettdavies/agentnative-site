// The postflight pages gate over real curl and a local socket, for what a stand-in
// cannot show: what curl does between attempts and on a redirect. Also holds that no
// fetch carrying the CF Access credentials follows a redirect, because curl keeps
// custom headers across hosts, so following one hands the secret to wherever it points.

import { describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, trackedPaths } from './helpers/workflows';

const POSTFLIGHT = join(REPO_ROOT, 'scripts/release/postflight.sh');
const SECRET = 'fixture-access-secret';
const SCORE = JSON.stringify({
  tier: 'registry',
  scorecard_url: 'http://127.0.0.1/score/ripgrep',
  spec_version: '0.0.0',
});

type Answer =
  | 'page'
  | 'score'
  | 'score-truncated'
  | 'no-marker'
  | 'dropped'
  | '403'
  | 'moved-with-marker'
  | '503'
  | '503-retry-after'
  | 'redirect';

interface Plan {
  home?: Answer[];
  score?: Answer[];
  token?: boolean;
  staging?: boolean;
}

function respond(status: string, body: string, headers = ''): string {
  return `HTTP/1.1 ${status}\r\ncontent-type: text/html\r\ncontent-length: ${body.length}\r\nconnection: close\r\n${headers}\r\n${body}`;
}

/** The real gate and real curl against a socket that answers `/` and `/api/score` in turn from `plan`. */
async function gate({ home = ['page'], score = ['score'], token = false, staging = token }: Plan) {
  const elsewhere: string[] = [];
  const otherHost = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, request) {
        elsewhere.push(request.toString());
        socket.write(respond('200 OK', '<h1 class="hero__title">\n'));
        socket.end();
      },
    },
  });
  const answer = (kind: Answer): string => {
    switch (kind) {
      case 'page':
        return respond('200 OK', '<h1 class="hero__title">\n<div class="lrow">\n');
      case 'score':
        return respond('200 OK', SCORE);
      case 'score-truncated':
        return `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${SCORE.length + 5000}\r\n\r\n${SCORE}`;
      case '403':
        return respond('403 Forbidden', '');
      case 'moved-with-marker':
        return respond('301 Moved Permanently', '<h1 class="hero__title">\n', 'location: /elsewhere\r\n');
      case 'no-marker':
        return respond('200 OK', '<p>none</p>\n');
      case 'dropped':
        return 'HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 500000\r\n\r\n<h1 class="hero__title">\n';
      case '503':
        return respond('503 Service Unavailable', '');
      case '503-retry-after':
        return respond('503 Service Unavailable', '', 'retry-after: 45\r\n');
      case 'redirect':
        return respond('302 Found', '', `location: http://127.0.0.1:${otherHost.port}/\r\n`);
    }
  };
  const served = { home: 0, score: 0 };
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, request) {
        const start = /^[A-Z]+ (\S+)/.exec(request.toString());
        if (!start) return;
        if (start[1] === '/') socket.write(answer(home[Math.min(served.home++, home.length - 1)]));
        else if (start[1] === '/api/score') socket.write(answer(score[Math.min(served.score++, score.length - 1)]));
        else socket.write(answer('page'));
        socket.end();
      },
    },
  });
  const op = mkdtempSync(join(tmpdir(), 'postflight-pages-curl-'));
  const started = Date.now();
  try {
    writeFileSync(join(op, 'read_field.sh'), `#!/usr/bin/env bash\necho ${SECRET}\n`);
    chmodSync(join(op, 'read_field.sh'), 0o755);
    const url = `http://127.0.0.1:${server.port}`;
    const target = staging ? ['--env', 'staging', '--staging-url', url] : ['--env', 'prod', '--prod-url', url];
    const proc = Bun.spawn(['bash', POSTFLIGHT, ...target, 'pages'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OP_SKILL: token ? op : '/nonexistent',
        CF_ACCESS_CLIENT_ID: '',
        CF_ACCESS_CLIENT_SECRET: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { elapsedMs: Date.now() - started, output: out + err, elsewhere, otherPort: otherHost.port, served };
  } finally {
    server.stop(true);
    otherHost.stop(true);
    rmSync(op, { recursive: true, force: true });
  }
}

describe('postflight pages gate over real curl', () => {
  test('recovers when a first attempt fails', async () => {
    const { output } = await gate({ home: ['503', 'page'] });
    expect(output).toContain('home page renders (has hero__title)');
  }, 30_000);

  test('names the HTTP status when every attempt fails', async () => {
    const { output } = await gate({ home: ['503'] });
    expect(output).toContain('curl exited 22 (HTTP 503)');
    expect(output).not.toContain('home page renders');
  }, 30_000);

  test('does not read the marker from a dropped attempt when the next attempt lacks it', async () => {
    const { output } = await gate({ home: ['dropped', 'no-marker'] });
    expect(output).toContain('did not return HTML with hero__title');
    expect(output).not.toContain('home page renders');
  }, 30_000);

  test('does not pass a redirect whose body carries the marker', async () => {
    const { output } = await gate({ home: ['moved-with-marker'] });
    expect(output).toContain('did not return HTML with hero__title (HTTP 301 to');
    expect(output).not.toContain('home page renders');
  }, 30_000);

  test('does not sleep through a long Retry-After', async () => {
    const { elapsedMs, output } = await gate({ home: ['503-retry-after'] });
    expect(elapsedMs).toBeLessThan(25_000);
    expect(output).not.toContain('home page renders');
  }, 30_000);

  test('the score row recovers from a failed attempt and names a persistent failure', async () => {
    const recovered = await gate({ score: ['503', 'score'] });
    expect(recovered.output).toContain('registry hit returns tier=registry');
    const failed = await gate({ score: ['503'] });
    expect(failed.output).toContain('curl exited 22');
    expect(failed.output).toContain('HTTP 503');
  }, 30_000);

  test('the score row fails a truncated transfer whose bytes still parse', async () => {
    const { output } = await gate({ score: ['score-truncated'] });
    expect(output).toContain('curl exited 18');
    expect(output).not.toContain('registry hit returns tier=registry');
  }, 30_000);

  test('the score row does not re-send its POST on a permanent error', async () => {
    const { output, served } = await gate({ score: ['403'] });
    expect(served.score).toBe(1);
    expect(output).toContain('curl exited 22');
    expect(output).toContain('HTTP 403');
  }, 30_000);

  test('does not send the Access secret to a redirect target, and names the target', async () => {
    const { elsewhere, otherPort, output } = await gate({ home: ['redirect'], token: true });
    expect(elsewhere).toEqual([]);
    expect(output).toContain(`(HTTP 302 to http://127.0.0.1:${otherPort}/)`);
    expect(output).not.toContain(SECRET);
  }, 30_000);
});

describe('a staging run against a local preview', () => {
  test('needs no token, because a local preview sits behind no Access', async () => {
    const { output } = await gate({ staging: true });
    expect(output).not.toContain('no CF Access service token');
    expect(output).toContain('home page renders (has hero__title)');
  }, 30_000);
});

describe('fetches carrying the CF Access credentials', () => {
  const CURL = /\be?curl\b/;
  const CREDENTIALED = /\becurl\s|\s-K\s|\s--config\s|\s-H @|CF-Access-Client|ACCESS_HEADERS/;
  const FOLLOWS_REDIRECTS = /\s-[a-zA-Z]*L[a-zA-Z]*(?:\s|$)|\s--location\b/;

  const sources = trackedPaths().filter(
    (path) =>
      /\.(?:sh|bash)$/.test(path) ||
      /^scripts\/hooks\//.test(path) ||
      /^\.github\/.*\.ya?ml$/.test(path) ||
      /^RELEASES[^/]*\.md$/.test(path) ||
      /^docs\/runbooks\/.*\.md$/.test(path),
  );

  test('the scan reaches the release scripts, a workflow and the runbooks', () => {
    expect(sources).toEqual(
      expect.arrayContaining([
        'scripts/release/postflight.sh',
        'scripts/release/preflight.sh',
        'scripts/release/mcp-smoke.sh',
        '.github/workflows/mcp-sweep.yml',
        'RELEASES-PREFLIGHT.md',
        'scripts/staging-cache-smoke.sh',
      ]),
    );
  });

  test('none follows a redirect, in a script, a workflow or a recipe', () => {
    const offenders = sources.flatMap((path) => {
      const absolute = join(REPO_ROOT, path);
      if (!lstatSync(absolute, { throwIfNoEntry: false })?.isFile()) return [];
      return readFileSync(absolute, 'utf8')
        .replace(/\\\n\s*/g, ' ')
        .split('\n')
        .filter((line) => CURL.test(line) && CREDENTIALED.test(line) && FOLLOWS_REDIRECTS.test(line))
        .map((line) => `${path}: ${line.trim().slice(0, 90)}`);
    });
    expect(offenders).toEqual([]);
  });

  test('the manual recipes against ENV_URL never follow a redirect, because staging runs add the headers', () => {
    const recipes = readFileSync(join(REPO_ROOT, 'RELEASES-POSTFLIGHT.md'), 'utf8')
      .replace(/\\\n\s*/g, ' ')
      .split('\n')
      .filter((line) => /\bcurl\b/.test(line) && line.includes('ENV_URL'));
    expect(recipes.length).toBeGreaterThan(0);
    expect(recipes.filter((line) => FOLLOWS_REDIRECTS.test(line))).toEqual([]);
  });

  test.each([
    ['a config file on disk', /-K\s+"?\$/],
    ['a config written to a file', /header = "CF-Access.*>>/],
    ['an exported credential', /^\s*export\s+CF_ACCESS_/m],
  ])('no release script keeps the credentials in %s', (_shape, pattern) => {
    const offenders = sources
      .filter((path) => path.startsWith('scripts/release/') && path.endsWith('.sh'))
      .filter((path) => pattern.test(readFileSync(join(REPO_ROOT, path), 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('every retry in postflight bounds how long curl may sleep through a Retry-After', () => {
    const lines = readFileSync(POSTFLIGHT, 'utf8')
      .replace(/\\\n\s*/g, ' ')
      .split('\n');
    const retried = lines.filter((line) => /\s--retry\s/.test(line));
    expect(retried.length).toBeGreaterThan(0);
    expect(retried.filter((line) => !line.includes('--retry-max-time'))).toEqual([]);
  });
});
