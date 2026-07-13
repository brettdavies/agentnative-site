// Live-network e2e for the web audit against the staging Worker (plan U16).
//
// Opt-in suite (project: web-audit). Excluded from the default
// `bun run test:e2e` run because it hits the real CF staging Worker and
// makes real outbound probes to a live target (anc.dev — a controlled
// target we operate, so the run is deterministic in what it exercises).
// Use it to validate a staging deploy before promoting to production.
//
// Run with:
//   ANC_STAGING_BASE_URL=https://agentnative-site-staging.brettdavies.workers.dev \
//     bun x playwright test --project=web-audit
//
// Local `wrangler dev --local` cannot serve this repo's entry module (its
// non-handler named exports fail workerd's module validation), so like the
// other live suites this targets the deployed staging Worker. When running
// it, put a dummy listener on :8787 so the unconditional webServer block
// (reuseExistingServer) skips the local wrangler-dev boot.
//
// The staging Worker is gated by Cloudflare Access. Set
// ANC_STAGING_ACCESS_CLIENT_ID + ANC_STAGING_ACCESS_CLIENT_SECRET to a
// service-token pair for headless runs; interactive browser auth works
// otherwise. Staging binds WEB_AUDIT_ENABLED="true" so the form and the
// MCP fresh path are live.

import { expect, test } from '@playwright/test';

const STAGING_BASE = process.env.ANC_STAGING_BASE_URL;

test.skip(!STAGING_BASE, 'ANC_STAGING_BASE_URL not set — opt-in staging web-audit suite.');

const ACCESS_HEADERS: Record<string, string> = {};
if (process.env.ANC_STAGING_ACCESS_CLIENT_ID && process.env.ANC_STAGING_ACCESS_CLIENT_SECRET) {
  ACCESS_HEADERS['CF-Access-Client-Id'] = process.env.ANC_STAGING_ACCESS_CLIENT_ID;
  ACCESS_HEADERS['CF-Access-Client-Secret'] = process.env.ANC_STAGING_ACCESS_CLIENT_SECRET;
}

// Target both `page` navigations and `request` calls at the staging Worker
// with the Access service-token headers applied.
test.use({ baseURL: STAGING_BASE, extraHTTPHeaders: ACCESS_HEADERS });

const TARGET_DOMAIN = 'anc.dev';

test.describe('web audit — streaming form and shareable result', () => {
  test('form streams per-check rows then lands on the shareable /web/<domain> page', async ({ page }) => {
    await page.goto('/web-audit');
    await expect(page.locator('[data-web-audit-form]')).toBeVisible();

    await page.fill('[data-web-audit-input]', TARGET_DOMAIN);
    await page.click('[data-web-audit-submit]');

    // Per-check rows stream into the results table as each check resolves.
    await expect(page.locator('[data-web-audit-results] tr').first()).toBeVisible({ timeout: 45_000 });

    // On completion the client redirects to the shareable result page.
    await page.waitForURL(`**/web/${TARGET_DOMAIN}`, { timeout: 75_000 });
    await expect(page.locator('.scorecard-score-badge__pct')).toContainText('%');
    await expect(page.locator('.scorecard-audits')).toBeVisible();
  });

  test('/api/audit-web streams NDJSON check events then a terminal complete', async ({ request }) => {
    const res = await request.post('/api/audit-web', {
      headers: { 'content-type': 'application/json' },
      data: { url: TARGET_DOMAIN },
      timeout: 75_000,
    });
    expect(res.status()).toBe(200);
    const lines = (await res.text())
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type: string; share_url?: string });
    const checks = lines.filter((l) => l.type === 'check');
    expect(checks.length).toBeGreaterThan(0);
    const terminal = lines.at(-1);
    // complete (streamed fresh) or a cache-hit single JSON object — both carry share_url.
    expect(terminal?.share_url ?? lines[0].share_url).toBe(`/web/${TARGET_DOMAIN}`);
  });

  test('the /web/<domain> markdown twin renders the score', async ({ request }) => {
    const res = await request.get(`/web/${TARGET_DOMAIN}.md`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/markdown');
    const body = await res.text();
    expect(body).toContain('Agent-Readiness Audit');
    expect(body).toMatch(/\d+% pass rate/);
  });
});

test.describe('web audit — MCP fresh path', () => {
  const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

  async function initialize(request: import('@playwright/test').APIRequestContext) {
    await request.post('/mcp', {
      headers: MCP_HEADERS,
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
      },
    });
  }

  function firstJsonContent(body: { result?: { content?: Array<{ text: string }> } }): Record<string, unknown> {
    const text = body.result?.content?.[0]?.text;
    expect(typeof text).toBe('string');
    return JSON.parse(text as string) as Record<string, unknown>;
  }

  test('audit_website returns a single terminal scorecard (no progress notifications)', async ({ request }) => {
    await initialize(request);
    const res = await request.post('/mcp', {
      headers: MCP_HEADERS,
      data: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'audit_website', arguments: { url: TARGET_DOMAIN } },
      },
      timeout: 75_000,
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { result?: { content?: Array<{ text: string }>; isError?: boolean } };
    expect(body.result?.isError).toBeFalsy();
    const content = firstJsonContent(body);
    expect(content.share_url).toBe(`https://anc.dev/web/${TARGET_DOMAIN}`);
    expect((content.scorecard as { badge?: { score_pct?: number } })?.badge?.score_pct).toBeGreaterThanOrEqual(0);
  });

  test('get_web_remediation returns the fix doc for a check', async ({ request }) => {
    await initialize(request);
    const res = await request.post('/mcp', {
      headers: MCP_HEADERS,
      data: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_web_remediation', arguments: { check_id: 'openapi' } },
      },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } };
    const content = firstJsonContent(body);
    expect(content.found).toBe(true);
    expect((content.remediation as { body?: string })?.body).toContain('OpenAPI');
  });
});
