// Live scorecard-card and clip smoke against a deployed site Worker (or `wrangler dev`). scripts/og/smoke.sh deploys
// tests/e2e/og-cards-fixture on fresh og-<kind>-<run>.anc.dev hosts and passes them in OG_FIXTURE_HOSTS; each test
// audits one host over MCP, follows its scorecard's og:image, and checks the card: a 1200x630 PNG, immutable caching,
// the logo tier that drew it, and the same bytes on a second request (an edge replay or the R2 copy). It then waits for
// the page to name its clip in og:video and checks the clip: an MP4 at 1200x630, a byte range answered 206 by the edge
// cache, and the same bytes twice. A local run (`bun run dev`) stores the committed stand-in clip, so it skips the range
// and track-size checks, which need the edge cache and a real encode. Each test ends with one result line.

import { type APIRequestContext, expect, test } from '@playwright/test';
import { CARD_FALLBACK, CLIP_CAUSES, fillCommand } from './og-clip-causes';

const BASE = process.env.ANC_STAGING_BASE_URL;
const HOSTS = (process.env.OG_FIXTURE_HOSTS ?? '').split(',').filter(Boolean);
const LOCAL = BASE ? /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE.replace(/\/$/, '')) : false;
const CLIP_WAIT_MS = 60_000;

test.skip(!BASE || HOSTS.length === 0, 'Run through scripts/og/smoke.sh, which deploys the fixture hosts.');

const ACCESS_HEADERS: Record<string, string> = {};
if (process.env.ANC_STAGING_ACCESS_CLIENT_ID && process.env.ANC_STAGING_ACCESS_CLIENT_SECRET) {
  ACCESS_HEADERS['CF-Access-Client-Id'] = process.env.ANC_STAGING_ACCESS_CLIENT_ID;
  ACCESS_HEADERS['CF-Access-Client-Secret'] = process.env.ANC_STAGING_ACCESS_CLIENT_SECRET;
}
test.use({ baseURL: BASE, extraHTTPHeaders: ACCESS_HEADERS });

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const HTML = { accept: 'text/html' };

/** The logo tier each fixture kind must draw with. A low-res or broken icon falls through to anc.dev's brand logo. */
const EXPECTED_LOGO: Record<string, string> = { hires: 'homepage', lowres: 'brand', baddata: 'brand' };

async function auditWebsite(request: APIRequestContext, host: string): Promise<void> {
  await request.post('/mcp', {
    headers: MCP_HEADERS,
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'og-cards-smoke', version: '0' } },
    },
  });
  const res = await request.post('/mcp', {
    headers: MCP_HEADERS,
    data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'audit_website', arguments: { url: host } } },
    timeout: 90_000,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
  expect(body.result?.isError, body.result?.content?.[0]?.text).toBeFalsy();
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function metaContent(html: string, property: string): string | undefined {
  return new RegExp(`<meta property="${property}" content="([^"]+)"`).exec(html)?.[1];
}

/** Width and height from the video track's tkhd box: 16.16 fixed point, the box's last eight bytes. */
function trackSize(mp4: Buffer): { width: number; height: number } | null {
  for (let at = mp4.indexOf('tkhd'); at !== -1; at = mp4.indexOf('tkhd', at + 4)) {
    const end = at - 4 + mp4.readUInt32BE(at - 4);
    const size = { width: mp4.readUInt32BE(end - 8) >>> 16, height: mp4.readUInt32BE(end - 4) >>> 16 };
    if (size.width > 0) return size;
  }
  return null;
}

/** The page's clip URL once a crawler's fetch names it, and how long that took. */
async function waitForClip(request: APIRequestContext, host: string): Promise<{ url?: string; seconds: number }> {
  const started = Date.now();
  while (Date.now() - started < CLIP_WAIT_MS) {
    const html = await (await request.get(`/score/${host}`, { headers: HTML })).text();
    const url = metaContent(html, 'og:video');
    if (url) return { url, seconds: (Date.now() - started) / 1000 };
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { seconds: CLIP_WAIT_MS / 1000 };
}

/** Why the clip did not appear, from an uncached fetch, with the command that looks further. */
async function clipDiagnosis(request: APIRequestContext, host: string): Promise<string> {
  const page = await request.get(`/score/${host}?v=${Date.now()}`, { headers: HTML });
  const clip = page.headers()['x-anc-clip'] ?? 'none';
  const run = page.headers()['x-anc-clip-run'];
  const cause = CLIP_CAUSES[clip] ?? CLIP_CAUSES.none;
  const command = fillCommand(cause.command, { base: BASE ?? '', target: host, run });
  return `x-anc-clip: ${clip}${run ? ` (run ${run})` : ''}: ${cause.cause}. Next: ${command}`;
}

for (const host of HOSTS) {
  const kind = /^og-([a-z]+)-/.exec(host)?.[1] ?? '';

  test(`${kind} fixture: the card is drawn with the ${EXPECTED_LOGO[kind]} logo, served twice, and its clip is named`, async ({
    request,
  }) => {
    test.setTimeout(240_000);
    await auditWebsite(request, host);

    const page = await request.get(`/score/${host}`, { headers: HTML });
    expect(page.status()).toBe(200);
    const imageUrl = metaContent(await page.text(), 'og:image');
    expect(imageUrl, 'the scorecard page names a card').toBeDefined();
    const cardPath = new URL(imageUrl as string).pathname;
    expect(cardPath).toMatch(
      new RegExp(`^/og/score/${host.replaceAll('.', '\\.')}/s\\d+-v[\\d.]+-d\\d{8}-r\\d+\\.png$`),
    );

    const first = await request.get(cardPath);
    expect(first.status()).toBe(200);
    expect(first.headers()['content-type']).toContain('image/png');
    expect(first.headers()['cache-control']).toContain('immutable');
    const card = first.headers()['x-anc-card'];
    expect(
      card,
      card === 'fallback' ? fillCommand(CARD_FALLBACK.command, { base: BASE ?? '', target: host }) : '',
    ).toMatch(/^(drawn|stored)$/);
    expect(first.headers()['x-anc-card-logo']).toBe(EXPECTED_LOGO[kind]);
    const firstBytes = await first.body();
    expect(pngSize(firstBytes)).toEqual({ width: 1200, height: 630 });

    const second = await request.get(cardPath);
    expect(second.status()).toBe(200);
    expect(['drawn', 'stored']).toContain(second.headers()['x-anc-card']);
    expect(Buffer.compare(await second.body(), firstBytes)).toBe(0);

    const named = await waitForClip(request, host);
    if (!named.url) {
      const diagnosis = await clipDiagnosis(request, host);
      console.log(
        `${host}  logo=${EXPECTED_LOGO[kind]}  card=${card}  clip=missing after ${named.seconds}s  ${diagnosis}`,
      );
      expect(named.url, diagnosis).toBeDefined();
      return;
    }
    expect(named.url).toContain(cardPath.replace('/og/score/', '/og/clip/').replace(/\.png$/, '.mp4'));
    const clipPath = new URL(named.url).pathname;

    const clip = await request.get(clipPath);
    expect(clip.status()).toBe(200);
    expect(clip.headers()['content-type']).toBe('video/mp4');
    const clipBytes = await clip.body();
    expect(clipBytes.subarray(4, 8).toString('latin1'), 'the clip opens with an ftyp box').toBe('ftyp');
    expect(Buffer.compare(await (await request.get(clipPath)).body(), clipBytes)).toBe(0);

    let range = 'skipped (local)';
    if (!LOCAL) {
      expect(trackSize(clipBytes)).toEqual({ width: 1200, height: 630 });
      const tail = await request.get(clipPath, { headers: { range: 'bytes=-1000' } });
      expect(tail.status()).toBe(206);
      const total = clipBytes.length;
      expect(tail.headers()['content-range']).toBe(`bytes ${total - 1000}-${total - 1}/${total}`);
      expect(Buffer.compare(await tail.body(), clipBytes.subarray(total - 1000))).toBe(0);
      range = '206';
    }
    console.log(
      `${host}  logo=${EXPECTED_LOGO[kind]}  card=${card}  clip=named ${named.seconds.toFixed(1)}s after audit  range=${range}  ${new URL(clipPath, BASE).toString()}`,
    );
  });
}
