// The postflight pages gate over real curl and a local socket, for what a stand-in
// cannot show: what curl does between attempts and on a redirect. Also holds that no
// fetch carrying the CF Access credentials follows a redirect, because curl keeps
// custom headers across hosts, so following one hands the secret to wherever it points.

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const POSTFLIGHT = join(REPO_ROOT, 'scripts/release/postflight.sh');
const SECRET = 'fixture-access-secret';
const SCORE = JSON.stringify({
  tier: 'registry',
  scorecard_url: 'http://127.0.0.1/score/ripgrep',
  spec_version: '0.0.0',
});

type Answer = 'page' | 'score' | 'no-marker' | 'dropped' | '503' | '503-retry-after' | 'redirect';

interface Plan {
  home?: Answer[];
  score?: Answer[];
  token?: boolean;
}

function respond(status: string, body: string, headers = ''): string {
  return `HTTP/1.1 ${status}\r\ncontent-type: text/html\r\ncontent-length: ${body.length}\r\nconnection: close\r\n${headers}\r\n${body}`;
}

/** The real gate and real curl against a socket that answers `/` and `/api/score` in turn from `plan`. */
async function gate({ home = ['page'], score = ['score'], token = false }: Plan) {
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
    const target = token ? ['--env', 'staging', '--staging-url', url] : ['--env', 'prod', '--prod-url', url];
    const proc = Bun.spawn(['bash', POSTFLIGHT, ...target, 'pages'], {
      cwd: REPO_ROOT,
      env: { ...process.env, OP_SKILL: op },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { elapsedMs: Date.now() - started, output: out + err, elsewhere, otherPort: otherHost.port };
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

  test('does not send the Access secret to a redirect target, and names the target', async () => {
    const { elsewhere, otherPort, output } = await gate({ home: ['redirect'], token: true });
    expect(elsewhere).toEqual([]);
    expect(output).toContain(`(HTTP 302 to http://127.0.0.1:${otherPort}/)`);
    expect(output).not.toContain(SECRET);
  }, 30_000);
});

describe('fetches carrying the CF Access credentials', () => {
  test.each(['scripts/release/postflight.sh', 'scripts/release/preflight.sh', 'scripts/release/mcp-smoke.sh'])(
    '%s never follows a redirect',
    (script) => {
      const lines = readFileSync(join(REPO_ROOT, script), 'utf8')
        .replace(/\\\n\s*/g, ' ')
        .split('\n');
      const credentialed = lines.filter(
        (line) => /\becurl\s|\bcurl\b.*\s-K\s/.test(line) && !line.trim().startsWith('#'),
      );
      expect(credentialed.length).toBeGreaterThan(0);
      expect(credentialed.filter((line) => /\s-[a-zA-Z]*L[a-zA-Z]*\s|\s--location\b/.test(line))).toEqual([]);
    },
  );
});
