// scripts/og/status.sh against a fake site, and the one x-anc-clip cause map
// held where it is copied: the smoke's map (tests/e2e/og-clip-causes.ts),
// status.sh, and the reason-code table in RELEASES-PREFLIGHT.md. Both og
// scripts emit only reasons from the contract's closed set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_FALLBACK, CLIP_CAUSES, fillCommand } from './e2e/og-clip-causes';
import { REPO_ROOT } from './helpers/workflows';

const STATUS = join(REPO_ROOT, 'scripts/og/status.sh');
const KEY = 's64-v0.6.0-d20261026-r1';

type Page = { clip: string; run?: string; video: boolean; card: string };

let page: Page = { clip: 'present', video: true, card: 'stored' };
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/score/railway.com') {
        const headers: Record<string, string> = { 'content-type': 'text/html', 'x-anc-clip': page.clip };
        if (page.run) headers['x-anc-clip-run'] = page.run;
        const video = page.video
          ? `<meta property="og:video" content="https://anc.dev/og/clip/railway.com/${KEY}.mp4" />`
          : '';
        const html = `<html><head><meta property="og:image" content="https://anc.dev/og/score/railway.com/${KEY}.png" />${video}</head></html>`;
        return new Response(html, { headers });
      }
      if (url.pathname === `/og/score/railway.com/${KEY}.png`) {
        const headers: Record<string, string> = { 'content-type': 'image/png', 'x-anc-card': page.card };
        if (page.card !== 'fallback') headers['x-anc-card-logo'] = 'brand';
        return new Response(new Uint8Array([0x89]), { headers });
      }
      return new Response('not found', { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

async function status(...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bash', STATUS, base, 'railway.com', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { code: await proc.exited, out };
}

async function raw(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bash', STATUS, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr };
}

async function statusJson(state: Page): Promise<Record<string, unknown> & { next_step: { command: string } }> {
  page = state;
  return JSON.parse((await status('--json')).out.trim().split('\n').at(-1) ?? '{}');
}

const CLOSED_SET = readFileSync(join(REPO_ROOT, 'scripts/og/contract.sh'), 'utf8')
  .split("OG_REASONS='")[1]
  .split("'")[0]
  .trim()
  .split('\n')
  .map((line) => line.split(' '));

describe('scripts/og/status.sh', () => {
  test('a named clip reads ok with the key, the card, its logo tier and og:video in one line', async () => {
    page = { clip: 'present', video: true, card: 'stored' };
    const run = await status();
    expect(run.code).toBe(0);
    expect(run.out).toContain(`ok: railway.com key=${KEY} card=stored logo=brand clip=present run=- og:video=named`);
  });

  test.each(Object.entries(CLIP_CAUSES))(
    'x-anc-clip %s maps to the reason and command the smoke names',
    async (clip, cause) => {
      const run = clip === 'present' ? undefined : 'run-42';
      const result = await statusJson({ clip, run, video: clip === 'present', card: 'stored' });
      expect(result.reason).toBe(cause.reason);
      expect(result.next_step.command).toBe(fillCommand(cause.command, { base, target: 'railway.com', run }));
      expect(result.value).toMatchObject({ key: KEY, clip, card: 'stored', logo: 'brand' });
    },
  );

  test('a missing or malformed run id leaves the search out of the next command', async () => {
    for (const run of [undefined, 'x; rm -rf /']) {
      const result = await statusJson({ clip: 'rendering', run, video: false, card: 'stored' });
      expect(result.next_step.command).toBe('bunx wrangler tail anc-og-render-staging --format json');
      expect(result.next_step.command).toBe(
        fillCommand(CLIP_CAUSES.rendering.command, { base, target: 'railway.com' }),
      );
    }
  });

  test('a page that does not answer 200 names the access and target checks, not the render logs', async () => {
    const proc = Bun.spawn(['bash', STATUS, base, 'no-such.example', '--json'], { stdout: 'pipe', stderr: 'pipe' });
    const result = JSON.parse((await new Response(proc.stdout).text()).trim()) as {
      reason: string;
      message: string;
      next_step: { command: string };
    };
    expect(await proc.exited).toBe(20);
    expect(result.reason).toBe('clip-missing');
    expect(result.message).toContain('answered 404');
    expect(result.next_step.command).toBe(`curl -sS -o /dev/null -w '%{http_code}\\n' ${base}/score/no-such.example`);
  });

  test('a page that cannot be fetched reports through curl alone, with no noise from the missing body', async () => {
    const run = await raw('http://127.0.0.1:1', 'railway.com', '--json');
    expect(run.code).toBe(20);
    expect(JSON.parse(run.stdout.trim()).reason).toBe('clip-missing');
    expect(run.stderr).not.toContain('No such file');
  });

  test('a fallback card maps to card-fallback ahead of the clip', async () => {
    const result = await statusJson({ clip: 'none', video: false, card: 'fallback' });
    expect(result.reason).toBe(CARD_FALLBACK.reason);
    expect(result.next_step.command).toBe(fillCommand(CARD_FALLBACK.command, { base, target: 'railway.com' }));
  });

  test('each failure exits with its reason code', async () => {
    page = { clip: 'failed', run: 'run-7', video: false, card: 'stored' };
    const code = Number(CLOSED_SET.find(([reason]) => reason === 'clip-failed')?.[1]);
    expect((await status()).code).toBe(code);
  });
});

describe('one reason set and one cause map', () => {
  const closed = new Set(CLOSED_SET.map(([reason]) => reason));

  test('both og scripts emit only reasons from the closed set', () => {
    const setup = readFileSync(join(REPO_ROOT, 'scripts/og/setup.sh'), 'utf8');
    const statusScript = readFileSync(STATUS, 'utf8');
    const emitted = [
      ...[...setup.matchAll(/finish ([a-z-]+) /g)].map((m) => m[1]),
      ...[...statusScript.matchAll(/reason='?([a-z-]+)/g)].map((m) => m[1]),
    ];
    expect(emitted.length).toBeGreaterThan(8);
    expect(emitted.filter((reason) => !closed.has(reason))).toEqual([]);
    for (const cause of [...Object.values(CLIP_CAUSES), CARD_FALLBACK]) expect(closed.has(cause.reason)).toBe(true);
  });

  test('the RELEASES-PREFLIGHT.md table lists every reason with its exit code, and the smoke map’s headers and commands', () => {
    const doc = readFileSync(join(REPO_ROOT, 'RELEASES-PREFLIGHT.md'), 'utf8');
    const section = doc.split('#### og:video reason codes')[1]?.split('\n#')[0] ?? '';
    const rows = section
      .split('\n')
      .filter((line) => /^\| `[a-z-]+` \|/.test(line))
      .map((line) => line.split('|').map((cell) => cell.trim()));
    const byReason = new Map(rows.map((cells) => [cells[1].replaceAll('`', ''), cells]));
    for (const [reason, code] of CLOSED_SET) expect([reason, byReason.get(reason)?.[2]]).toEqual([reason, code]);
    for (const [clip, cause] of Object.entries(CLIP_CAUSES)) {
      const row = byReason.get(cause.reason);
      expect([clip, row?.[3]]).toEqual([clip, expect.stringContaining(`\`${clip}\``)]);
      expect([clip, row?.[5]]).toEqual([clip, `\`${cause.command}\``]);
    }
    expect(byReason.get(CARD_FALLBACK.reason)?.[5]).toBe(`\`${CARD_FALLBACK.command}\``);
  });
});
