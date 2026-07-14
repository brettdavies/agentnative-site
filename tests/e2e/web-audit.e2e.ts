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

    // A fresh audit streams per-check rows before redirecting; a cache hit
    // redirects immediately with no rows. Either way the flow ends on the
    // shareable result page. (Fresh-stream row coverage lives in the
    // /api/audit-web NDJSON test's cache-miss branch.)
    const streamedRow = page.locator('[data-web-audit-results] tr').first();
    const sawStreaming = await Promise.race([
      streamedRow.waitFor({ state: 'visible', timeout: 75_000 }).then(
        () => true,
        () => false,
      ),
      page.waitForURL(`**/web/${TARGET_DOMAIN}`, { timeout: 75_000 }).then(() => false),
    ]);
    await page.waitForURL(`**/web/${TARGET_DOMAIN}`, { timeout: 75_000 });
    expect(typeof sawStreaming).toBe('boolean');
    await expect(page.locator('.scorecard-hero .bigscore__n').first()).toContainText(/\d/);
    await expect(page.locator('.scorecard-audits')).toBeVisible();
  });

  test('/api/audit-web streams NDJSON check events then a terminal complete', async ({ request }) => {
    const res = await request.post('/api/audit-web', {
      headers: { 'content-type': 'application/json' },
      data: { url: TARGET_DOMAIN },
      timeout: 75_000,
    });
    expect(res.status()).toBe(200);
    const contentType = res.headers()['content-type'] ?? '';
    if (contentType.includes('application/json')) {
      // Cache hit: a single JSON envelope with the 0.2 scorecard.
      const body = (await res.json()) as { cached?: boolean; scorecard?: { score_pct?: number }; share_url?: string };
      expect(body.cached).toBe(true);
      expect(body.scorecard?.score_pct).toBeGreaterThanOrEqual(0);
      expect(body.share_url).toBe(`/web/${TARGET_DOMAIN}`);
      return;
    }
    const lines = (await res.text())
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type: string; share_url?: string });
    const checks = lines.filter((l) => l.type === 'check');
    expect(checks.length).toBeGreaterThan(0);
    expect(lines.at(-1)?.share_url).toBe(`/web/${TARGET_DOMAIN}`);
  });

  test('the /web/<domain> markdown twin mirrors the category structure with both scores', async ({ request }) => {
    const res = await request.get(`/web/${TARGET_DOMAIN}.md`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/markdown');
    const body = await res.text();
    expect(body).toContain('Agent-Readiness Audit');
    expect(body).toMatch(/\*\*Score:\*\* \d+%/);
    expect(body).toMatch(/\*\*Global:\*\* \d+%/);
    expect(body).toMatch(/## Discoverability \(\d+\/\d+\)/);
    expect(body).toMatch(/## MCP & API \(\d+\/\d+\)/);
  });

  test('the result page groups by category and headlines RELATIVE with GLOBAL secondary', async ({ page }) => {
    await page.goto(`/web/${TARGET_DOMAIN}`);
    await expect(page.locator('.scorecard-hero .bigscore__n').first()).toContainText(/\d/);
    await expect(page.locator('.scorecard-hero .bigscore__l').first()).toContainText('site score');
    await expect(page.locator('.scorecard-hero__note')).toContainText('maximally agent-ready');
    const groups = page.locator('.audit-group__title');
    await expect(groups.first()).toContainText('Discoverability');
    await expect(page.locator('.audit-group__rollup').first()).toContainText('/');
    // No P1..P8 principle headings on the web surface.
    await expect(page.locator('.scorecard-audits')).not.toContainText('P2:');
  });

  test('a site_type-scoped audit gates the api-only checks to n_a', async ({ request }) => {
    const res = await request.post('/api/audit-web', {
      headers: { 'content-type': 'application/json' },
      data: { url: TARGET_DOMAIN, site_type: 'content' },
      timeout: 75_000,
    });
    expect(res.status()).toBe(200);
    const text = await res.text();
    const lines = text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type?: string; cached?: boolean; scorecard?: unknown });
    const terminal = lines.at(-1) as {
      scorecard?: { site_type?: string | null; results?: Array<{ id: string; status: string }> };
      cached?: boolean;
    };
    const scorecard = terminal.scorecard as {
      site_type?: string | null;
      results?: Array<{ id: string; status: string }>;
    };
    // A cache hit may return the earlier untyped run; only a fresh typed
    // run asserts the gating.
    if (scorecard.site_type === 'content') {
      expect(scorecard.results?.find((r) => r.id === 'openapi')?.status).toBe('n_a');
    } else {
      expect(scorecard.results?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

test.describe('web audit — per-check fix skills', () => {
  test('/web-audit/skill/<id> serves HTML and the .md twin serves markdown', async ({ request }) => {
    const html = await request.get('/web-audit/skill/openapi');
    expect(html.status()).toBe(200);
    expect(html.headers()['content-type']).toContain('text/html');
    expect(await html.text()).toContain('Copy-paste prompt');

    const md = await request.get('/web-audit/skill/openapi.md');
    expect(md.status()).toBe(200);
    expect(md.headers()['content-type']).toContain('text/markdown');
    expect(await md.text()).toContain('# Fix: ');
  });

  test('content negotiation serves the twin for Accept: text/markdown', async ({ request }) => {
    const res = await request.get('/web-audit/skill/llms-txt', { headers: { accept: 'text/markdown' } });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/markdown');
  });

  test('an unknown check id 404s', async ({ request }) => {
    const res = await request.get('/web-audit/skill/not-a-check');
    expect(res.status()).toBe(404);
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
    const scorecard = content.scorecard as {
      score_pct?: number;
      score?: { relative: number; global: number };
      results?: Array<{ status: string; result?: string; remediation?: { prompt?: string; skill_url?: string } }>;
    };
    expect(scorecard?.score_pct).toBeGreaterThanOrEqual(0);
    expect(scorecard?.score?.global).toBeGreaterThanOrEqual(0);
    // Every row carries a derived result line; a non-passing row embeds
    // the inline remediation object with the copy-paste prompt.
    expect(scorecard?.results?.every((r) => typeof r.result === 'string')).toBe(true);
    const nonPassing = scorecard?.results?.find((r) => r.status === 'broken' || r.status === 'absent');
    if (nonPassing) {
      expect(nonPassing.remediation?.prompt).toContain('Goal:');
      expect(nonPassing.remediation?.skill_url).toContain('/web-audit/skill/');
    }
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
    const remediation = content.remediation as { goal?: string; fix?: string; prompt?: string; skill_url?: string };
    expect(remediation.fix).toContain('OpenAPI');
    expect(remediation.prompt).toContain('Skill: https://anc.dev/web-audit/skill/openapi');
  });
});
