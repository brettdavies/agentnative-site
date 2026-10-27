// Live scorecard-card smoke against a deployed site Worker (or `wrangler dev`). scripts/og/smoke.sh deploys
// tests/e2e/og-cards-fixture on fresh og-<kind>-<run>.anc.dev hosts and passes them in OG_FIXTURE_HOSTS; each test
// audits one host over MCP, follows its scorecard's og:image, and checks the card: a 1200x630 PNG, immutable caching,
// the logo tier that drew it, and the same bytes on a second request (an edge replay or the R2 copy).

import { type APIRequestContext, expect, test } from '@playwright/test';

const BASE = process.env.ANC_STAGING_BASE_URL;
const HOSTS = (process.env.OG_FIXTURE_HOSTS ?? '').split(',').filter(Boolean);

test.skip(!BASE || HOSTS.length === 0, 'Run through scripts/og/smoke.sh, which deploys the fixture hosts.');

const ACCESS_HEADERS: Record<string, string> = {};
if (process.env.ANC_STAGING_ACCESS_CLIENT_ID && process.env.ANC_STAGING_ACCESS_CLIENT_SECRET) {
  ACCESS_HEADERS['CF-Access-Client-Id'] = process.env.ANC_STAGING_ACCESS_CLIENT_ID;
  ACCESS_HEADERS['CF-Access-Client-Secret'] = process.env.ANC_STAGING_ACCESS_CLIENT_SECRET;
}
test.use({ baseURL: BASE, extraHTTPHeaders: ACCESS_HEADERS });

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

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

for (const host of HOSTS) {
  const kind = /^og-([a-z]+)-/.exec(host)?.[1] ?? '';

  test(`${kind} fixture: the card is drawn with the ${EXPECTED_LOGO[kind]} logo and served twice`, async ({
    request,
  }) => {
    test.setTimeout(150_000);
    await auditWebsite(request, host);

    const page = await request.get(`/score/${host}`, { headers: { accept: 'text/html' } });
    expect(page.status()).toBe(200);
    const html = await page.text();
    const imageUrl = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
    expect(imageUrl, 'the scorecard page names a card').toBeDefined();
    const cardPath = new URL(imageUrl as string).pathname;
    expect(cardPath).toMatch(new RegExp(`^/og/score/${host.replaceAll('.', '\\.')}/s\\d+-v[\\d.]+\\.png$`));

    const first = await request.get(cardPath);
    expect(first.status()).toBe(200);
    expect(first.headers()['content-type']).toContain('image/png');
    expect(first.headers()['cache-control']).toContain('immutable');
    expect(first.headers()['x-anc-card']).toBe('drawn');
    expect(first.headers()['x-anc-card-logo']).toBe(EXPECTED_LOGO[kind]);
    const firstBytes = await first.body();
    expect(pngSize(firstBytes)).toEqual({ width: 1200, height: 630 });

    const second = await request.get(cardPath);
    expect(second.status()).toBe(200);
    expect(['drawn', 'stored']).toContain(second.headers()['x-anc-card']);
    expect(Buffer.compare(await second.body(), firstBytes)).toBe(0);
  });
}
