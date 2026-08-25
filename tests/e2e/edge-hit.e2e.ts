// Live-network e2e for skip-Worker HIT against the staging Worker.
//
// Opt-in suite (project: edge-hit). Excluded from the default
// `bun run test:e2e` run because it hits the real CF staging Worker and
// Workers Caching. wrangler dev is not evidence of HIT: a HIT without
// Age is Static Assets (the Worker still ran). Use after a staging
// deploy to prove negotiated HTML/markdown skip the inner Worker.
//
// Run with:
//   ANC_STAGING_BASE_URL=https://agentnative-site-staging.brettdavies.workers.dev \
//     bun x playwright test --project=edge-hit
//
// The staging Worker is gated by Cloudflare Access. Set
// ANC_STAGING_ACCESS_CLIENT_ID + ANC_STAGING_ACCESS_CLIENT_SECRET to a
// service-token pair if running headless (CI / cron); interactive auth
// works in a real browser via the Access challenge. Access service-token
// headers must not bypass Workers Caching.
//
// Board-write miss-then-HIT (`/` and `/web` after an aggregate rewrite,
// `/about.md` stays) is a post-deploy operator check. There is no
// `/_canary/purge` route.

import { expect, test } from '@playwright/test';

const STAGING_BASE = process.env.ANC_STAGING_BASE_URL;

test.skip(
  !STAGING_BASE,
  'ANC_STAGING_BASE_URL not set — opt-in staging HIT canary. Set it to the staging Worker URL to run.',
);

const ACCESS_HEADERS: Record<string, string> = {};
if (process.env.ANC_STAGING_ACCESS_CLIENT_ID && process.env.ANC_STAGING_ACCESS_CLIENT_SECRET) {
  ACCESS_HEADERS['CF-Access-Client-Id'] = process.env.ANC_STAGING_ACCESS_CLIENT_ID;
  ACCESS_HEADERS['CF-Access-Client-Secret'] = process.env.ANC_STAGING_ACCESS_CLIENT_SECRET;
}

const CURL = { 'user-agent': 'curl/8.7.1', accept: '*/*' } as const;
const BROWSER = { accept: 'text/html', 'user-agent': 'Mozilla/5.0 Chrome/120.0 Safari/537.36' } as const;

function varyTokens(vary: string | undefined): string[] {
  if (!vary) return [];
  return vary.split(',').map((t) => t.trim().toLowerCase());
}

function varyIsAcceptUserAgent(vary: string | undefined): boolean {
  const tokens = varyTokens(vary);
  return tokens.includes('accept') && tokens.includes('user-agent');
}

function isSkipWorkerHit(headers: Record<string, string>): boolean {
  return headers['cf-cache-status']?.toUpperCase() === 'HIT' && headers['age'] !== undefined;
}

async function warmThenGet(
  request: import('@playwright/test').APIRequestContext,
  path: string,
  extra: Record<string, string>,
) {
  const headers = { ...ACCESS_HEADERS, ...extra };
  await request.get(`${STAGING_BASE}${path}`, { headers });
  return request.get(`${STAGING_BASE}${path}`, { headers });
}

test.describe('skip-Worker HIT — staging Workers Caching', () => {
  test('repeat browser GET /about is HIT with Age, Vary, and HTML; curl is markdown', async ({ request }) => {
    const second = await warmThenGet(request, '/about', BROWSER);
    expect(second.status()).toBe(200);
    expect(second.headers()['content-type']).toContain('text/html');
    expect(varyIsAcceptUserAgent(second.headers()['vary'])).toBe(true);
    expect(isSkipWorkerHit(second.headers())).toBe(true);
    const curl = await request.get(`${STAGING_BASE}/about`, { headers: { ...ACCESS_HEADERS, ...CURL } });
    expect(curl.headers()['content-type']).toContain('text/markdown');
    expect(varyIsAcceptUserAgent(curl.headers()['vary'])).toBe(true);
  });

  test('repeat GET / is HIT with Age, Vary, and homepage boards; curl is markdown', async ({ request }) => {
    const second = await warmThenGet(request, '/', BROWSER);
    expect(second.status()).toBe(200);
    expect(second.headers()['content-type']).toContain('text/html');
    expect(varyIsAcceptUserAgent(second.headers()['vary'])).toBe(true);
    expect(isSkipWorkerHit(second.headers())).toBe(true);
    const html = await second.text();
    expect(html).not.toContain('{{WEB_BOARD_ROWS}}');
    const curl = await request.get(`${STAGING_BASE}/`, { headers: { ...ACCESS_HEADERS, ...CURL } });
    expect(curl.headers()['content-type']).toContain('text/markdown');
    expect(varyIsAcceptUserAgent(curl.headers()['vary'])).toBe(true);
    const md = await curl.text();
    expect(md).toMatch(/## (CLI|Web) /);
    expect(md.toLowerCase()).not.toContain('live-score');
  });

  test('warm HTML HIT on / then Accept text/markdown is markdown, not the HTML object', async ({ request }) => {
    await warmThenGet(request, '/', BROWSER);
    const md = await request.get(`${STAGING_BASE}/`, {
      headers: { ...ACCESS_HEADERS, accept: 'text/markdown' },
    });
    expect(md.headers()['content-type']).toContain('text/markdown');
    expect(varyIsAcceptUserAgent(md.headers()['vary'])).toBe(true);
  });

  test('GET /index.md has no Vary and is HIT-min; /about.md is HIT-1d', async ({ request }) => {
    const index = await warmThenGet(request, '/index.md', {});
    expect(index.headers()['content-type']).toContain('text/markdown');
    expect(index.headers()['vary'] ?? '').toBe('');
    expect(isSkipWorkerHit(index.headers())).toBe(true);
    const about = await warmThenGet(request, '/about.md', {});
    expect(about.headers()['content-type']).toContain('text/markdown');
    expect(about.headers()['vary'] ?? '').toBe('');
    expect(isSkipWorkerHit(about.headers())).toBe(true);
  });

  test('GET /web/scoring is not a skip-Worker HIT', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/web/scoring`, {
      headers: { ...ACCESS_HEADERS, ...BROWSER },
    });
    expect(res.headers()['cf-cache-status']?.toUpperCase()).not.toBe('HIT');
    expect(res.headers()['cache-control'] ?? '').toContain('no-store');
  });

  test('never-audited /web/<host> 404 is not a skip-Worker HIT', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/web/never-audited.dev`, {
      headers: { ...ACCESS_HEADERS, ...BROWSER },
    });
    expect(res.status()).toBe(404);
    expect(res.headers()['cf-cache-status']?.toUpperCase()).not.toBe('HIT');
    expect(res.headers()['cache-control'] ?? '').toContain('no-store');
  });
});
