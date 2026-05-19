// Live-network e2e for /api/score against the staging Worker.
//
// Plan U8 — opt-in suite (project: homepage-score-live). Excluded from
// the default `bun run test:e2e` run because it hits the real CF
// staging Worker, the real Sandbox container, real Turnstile siteverify
// (with the always-passes test secret), and real R2. Use to validate a
// staging deploy before merging or to triage a regression that mocks
// can't reproduce.
//
// Run with:
//   ANC_STAGING_BASE_URL=https://agentnative-site-staging.brettdavies.workers.dev \
//     bun x playwright test --project=homepage-score-live
//
// The staging Worker is gated by Cloudflare Access. Set
// ANC_STAGING_ACCESS_CLIENT_ID + ANC_STAGING_ACCESS_CLIENT_SECRET to a
// service-token pair if running headless (CI / cron); otherwise interactive
// auth works in a real browser via the Access challenge.
//
// Turnstile note: staging uses CF's always-passes test SECRET, so a
// turnstile_token of "x" passes siteverify. This test posts a real token
// because the homepage script lazy-loads the real CF Turnstile widget;
// the always-passes test SITEKEY makes that widget hand back a valid
// (test-shape) token without a user interaction.

import { expect, test } from '@playwright/test';

const STAGING_BASE = process.env.ANC_STAGING_BASE_URL;

test.skip(
  !STAGING_BASE,
  'ANC_STAGING_BASE_URL not set — opt-in live-sandbox suite. Set it to the staging Worker URL to run.',
);

const ACCESS_HEADERS: Record<string, string> = {};
if (process.env.ANC_STAGING_ACCESS_CLIENT_ID && process.env.ANC_STAGING_ACCESS_CLIENT_SECRET) {
  ACCESS_HEADERS['CF-Access-Client-Id'] = process.env.ANC_STAGING_ACCESS_CLIENT_ID;
  ACCESS_HEADERS['CF-Access-Client-Secret'] = process.env.ANC_STAGING_ACCESS_CLIENT_SECRET;
}

test.describe('staging /api/score — live round-trip', () => {
  test('POST {input: "ripgrep"} returns curated registry_hit with R11 triad', async ({ request }) => {
    const res = await request.post(`${STAGING_BASE}/api/score`, {
      headers: { 'content-type': 'application/json', ...ACCESS_HEADERS },
      data: JSON.stringify({ input: 'ripgrep', turnstile_token: 'x' }),
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      scorecard: { kind?: string; scorecard_url?: string };
      spec_version: string;
      site_spec_version: string;
      anc_version: string;
      checker_url: string;
    };
    expect(body.scorecard.kind).toBe('registry_hit');
    expect(body.scorecard.scorecard_url).toBe('/score/ripgrep');
    expect(body.spec_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.site_spec_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.anc_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.checker_url).toContain('anc.dev');
  });

  test('POST {input: "cargo install ripgrep"} hits cache OR live path, gets share_url', async ({ request }) => {
    test.setTimeout(120_000); // live path may take ~30-60s on cold cache
    const res = await request.post(`${STAGING_BASE}/api/score`, {
      headers: { 'content-type': 'application/json', ...ACCESS_HEADERS },
      data: JSON.stringify({ input: 'cargo install ripgrep', turnstile_token: 'x' }),
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { share_url?: string; scorecard: unknown };
    expect(body.share_url).toBe('/score/live/ripgrep');
    expect(body.scorecard).toBeTruthy();
  });

  test('GET /score/live/ripgrep renders the cached scorecard as HTML', async ({ request }) => {
    test.setTimeout(60_000);
    // Prime the cache first via a POST (cached or live).
    await request.post(`${STAGING_BASE}/api/score`, {
      headers: { 'content-type': 'application/json', ...ACCESS_HEADERS },
      data: JSON.stringify({ input: 'cargo install ripgrep', turnstile_token: 'x' }),
    });
    const res = await request.get(`${STAGING_BASE}/score/live/ripgrep`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('ripgrep');
    expect(html).toContain('pass rate');
    expect(html).toContain('href="/install"');
  });

  test('GET /score/live/ripgrep.md returns markdown twin', async ({ request }) => {
    test.setTimeout(60_000);
    await request.post(`${STAGING_BASE}/api/score`, {
      headers: { 'content-type': 'application/json', ...ACCESS_HEADERS },
      data: JSON.stringify({ input: 'cargo install ripgrep', turnstile_token: 'x' }),
    });
    const res = await request.get(`${STAGING_BASE}/score/live/ripgrep.md`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/markdown');
    const md = await res.text();
    expect(md).toContain('# ripgrep');
    expect(md).toContain('**Score:**');
  });

  test('GET /score/live/ripgrep.html → 301 to /score/live/ripgrep', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/score/live/ripgrep.html`, {
      headers: ACCESS_HEADERS,
      maxRedirects: 0,
    });
    expect(res.status()).toBe(301);
    expect(res.headers().location).toBe('/score/live/ripgrep');
  });

  test('GET /score/live/unknown-binary-xyz → 404 HTML', async ({ request }) => {
    const res = await request.get(`${STAGING_BASE}/score/live/unknown-binary-xyz`, { headers: ACCESS_HEADERS });
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type']).toContain('text/html');
  });
});

test.describe('staging homepage form — real Turnstile + real /api/score', () => {
  test('full submit flow: paste registry slug → redirect to /score/ripgrep', async ({ page }) => {
    test.setTimeout(60_000);
    // Cloudflare Access challenge happens on first navigation. If the
    // session is already authenticated, the page loads directly. Service-
    // token headers are scoped to API requests; full-browser nav uses
    // interactive Access auth or a pre-warmed cookie.
    await page.goto(`${STAGING_BASE}/`);
    await expect(page.locator('#live-score-input')).toBeVisible({ timeout: 30_000 });

    await page.locator('#live-score-input').fill('ripgrep');
    await page.locator('[data-live-score-submit]').click();

    // ripgrep is curated → registry_hit → redirect to /score/ripgrep.
    await page.waitForURL(/\/score\/ripgrep/, { timeout: 30_000 });
    await expect(page.locator('h1')).toContainText(/ripgrep/i);
  });
});
