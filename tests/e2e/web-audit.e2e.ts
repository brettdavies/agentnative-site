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
// Setting ANC_STAGING_BASE_URL makes playwright.config skip the local
// wrangler-dev webServer and target that origin. The web-audit routes run
// entirely in-Worker (no DO/container), so pointing ANC_STAGING_BASE_URL at a
// local `wrangler dev --local --env staging` on :8787 also runs this suite
// locally for a pre-deploy check.
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

test.describe('web audit — scoring-page flow and shareable result', () => {
  test('form navigates to /web/scoring, streams, and forwards to the shareable /web/<domain> page', async ({
    page,
  }) => {
    await page.goto('/web-audit');
    await expect(page.locator('[data-web-audit-form]')).toBeVisible();

    await page.fill('[data-web-audit-input]', TARGET_DOMAIN);
    await page.click('[data-web-audit-submit]');

    // Submit navigates to the dedicated in-progress page.
    await page.waitForURL(`**/web/scoring/${TARGET_DOMAIN}`, { timeout: 30_000 });

    // The scoring page acquires a token, POSTs, and either streams per-check
    // rows (fresh audit) or forwards immediately (cache hit). Either way the
    // flow ends on the shareable result page.
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

    // The scoring page used location.replace(), so it never entered history:
    // back from the result page returns to the form, not the scoring page.
    await page.goBack();
    await expect(page).toHaveURL(/\/web-audit$/);
  });

  test('/web/scoring/<domain> serves the JS-required in-progress page with a noscript fallback', async ({
    request,
  }) => {
    const res = await request.get(`/web/scoring/${TARGET_DOMAIN}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(res.headers()['x-robots-tag']).toBe('noindex');
    const html = await res.text();
    expect(html).toContain('meta name="turnstile-sitekey"');
    expect(html).toContain('/js/web-audit-scoring.js');
    expect(html).toContain('<noscript>');

    // The transient page still answers markdown with a pointer.
    const md = await request.get(`/web/scoring/${TARGET_DOMAIN}`, { headers: { accept: 'text/markdown' } });
    expect(md.headers()['content-type']).toContain('text/markdown');
    expect(await md.text()).toContain(`/web/${TARGET_DOMAIN}.md`);
  });

  test('/api/audit-web streams NDJSON check events then a terminal complete', async ({ request }) => {
    // Staging binds the Turnstile always-passes test secret, so "x" verifies.
    const res = await request.post('/api/audit-web', {
      headers: { 'content-type': 'application/json' },
      data: { url: TARGET_DOMAIN, turnstile_token: 'x' },
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
    expect(body).toMatch(/## API \(\d+\/\d+\)/);
    expect(body).toMatch(/## MCP \(\d+\/\d+\)/);
  });

  test('@render the result page groups by category and headlines RELATIVE with GLOBAL secondary', async ({ page }) => {
    await page.goto(`/web/${TARGET_DOMAIN}`);
    await expect(page.locator('.scorecard-hero .bigscore__n').first()).toContainText(/\d/);
    await expect(page.locator('.scorecard-hero .bigscore__l').first()).toContainText('site score');
    // Two notes share the class: the score explainer, then freshness.
    await expect(page.locator('.scorecard-hero__note').first()).toContainText('maximally agent-ready');
    // Whether the entry carries a scoring instant or not, the freshness line
    // says a fresh audit is still gated.
    await expect(page.locator('[data-web-audit-freshness]')).toContainText('subject to service limits');
    const groups = page.locator('.audit-group__title');
    await expect(groups.first()).toContainText('Discoverability');
    await expect(page.locator('.audit-group__rollup').first()).toContainText('/');
    // No P1..P8 principle headings on the web surface.
    await expect(page.locator('.scorecard-audits')).not.toContainText('P2:');
  });

  test('a site_type-scoped audit gates the api-only checks to n_a', async ({ request }) => {
    const res = await request.post('/api/audit-web', {
      headers: { 'content-type': 'application/json' },
      data: { url: TARGET_DOMAIN, site_type: 'content', turnstile_token: 'x' },
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
  test('/web-audit/skill/<id> HTML carries the copy mechanism (no fenced prompt); the .md keeps it', async ({
    request,
  }) => {
    const htmlRes = await request.get('/web-audit/skill/openapi');
    expect(htmlRes.status()).toBe(200);
    expect(htmlRes.headers()['content-type']).toContain('text/html');
    const html = await htmlRes.text();
    // The prompt rides in a hidden carrier, not a rendered fence.
    expect(html).toContain('data-copy-text=');
    expect(html).not.toContain('<pre>');
    expect(html).not.toContain("Issue: <the audit's finding for this check>");

    const mdRes = await request.get('/web-audit/skill/openapi.md');
    expect(mdRes.status()).toBe(200);
    expect(mdRes.headers()['content-type']).toContain('text/markdown');
    const md = await mdRes.text();
    expect(md).toContain('# Fix: ');
    expect(md).toContain('## Copy-paste prompt');
    expect(md).toContain('```text');
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

test.describe('web audit — public_listing opt-in transport', () => {
  // Serial: these tests write and then read the one shared staging flag
  // for TARGET_DOMAIN, so each page-driven write must settle (forward or
  // terminal error state) before the next test touches the flag. The
  // "form navigates" test above also patches an explicit false (its box
  // is unchecked) and can overlap this block in wall clock; its write
  // settles inside that test, so the overlap window is the moments
  // between this block's two round-trip POSTs.
  test.describe.configure({ mode: 'serial' });

  function isAuditPost(r: import('@playwright/test').Request): boolean {
    return r.method() === 'POST' && r.url().includes('/api/audit-web');
  }

  /** The page's audit flow has settled: forwarded to the saved result, or ended on the retry state. */
  async function settled(page: import('@playwright/test').Page): Promise<void> {
    await Promise.race([
      page.waitForURL(`**/web/${TARGET_DOMAIN}`, { timeout: 75_000 }),
      page.locator('[data-web-audit-retry]').waitFor({ state: 'visible', timeout: 75_000 }),
    ]);
  }

  test('a checked box sends public_listing: true in the POST body', async ({ page }) => {
    await page.goto('/web-audit');
    await page.fill('[data-web-audit-input]', TARGET_DOMAIN);
    await page.check('[data-web-audit-listing]');
    const posted = page.waitForRequest(isAuditPost, { timeout: 60_000 });
    await page.click('[data-web-audit-submit]');
    const body = (await posted).postDataJSON() as Record<string, unknown>;
    expect(body.public_listing).toBe(true);
    await settled(page);
  });

  test('an unchecked box (the default) sends an explicit public_listing: false', async ({ page }) => {
    await page.goto('/web-audit');
    await page.fill('[data-web-audit-input]', TARGET_DOMAIN);
    await expect(page.locator('[data-web-audit-listing]')).not.toBeChecked();
    const posted = page.waitForRequest(isAuditPost, { timeout: 60_000 });
    await page.click('[data-web-audit-submit]');
    const body = (await posted).postDataJSON() as Record<string, unknown>;
    expect(body.public_listing).toBe(false);
    await settled(page);
  });

  test('a direct scoring-page visit omits public_listing entirely', async ({ page }) => {
    // No preceding form submit means no stashed choice: the POST must omit
    // the field (never send false) so a shared-link re-audit preserves the
    // stored choice.
    const posted = page.waitForRequest(isAuditPost, { timeout: 60_000 });
    await page.goto(`/web/scoring/${TARGET_DOMAIN}`);
    const body = (await posted).postDataJSON() as Record<string, unknown>;
    expect('public_listing' in body).toBe(false);
  });

  test('an explicit true round-trips to the stored flag and a blank preserves it', async ({ request }) => {
    // Serve-cached, patch, and fresh-stream responses all carry the
    // envelope this helper extracts.
    async function envelopeOf(res: import('@playwright/test').APIResponse): Promise<Record<string, unknown>> {
      const contentType = res.headers()['content-type'] ?? '';
      if (contentType.includes('application/json')) {
        const body = (await res.json()) as { scorecard?: Record<string, unknown> };
        return body.scorecard ?? {};
      }
      const lines = (await res.text())
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { type?: string; scorecard?: Record<string, unknown> });
      const terminal = lines.at(-1);
      expect(terminal?.type).toBe('complete');
      return terminal?.scorecard ?? {};
    }

    const wrote = await request.post('/api/audit-web', {
      headers: { 'content-type': 'application/json' },
      data: { url: TARGET_DOMAIN, turnstile_token: 'x', public_listing: true },
      timeout: 75_000,
    });
    expect(wrote.status()).toBe(200);
    expect((await envelopeOf(wrote)).public_listing).toBe(true);

    const blank = await request.post('/api/audit-web', {
      headers: { 'content-type': 'application/json' },
      data: { url: TARGET_DOMAIN, turnstile_token: 'x' },
      timeout: 75_000,
    });
    expect(blank.status()).toBe(200);
    expect((await envelopeOf(blank)).public_listing).toBe(true);
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
    // Links follow the deployment that served them, so this is the staging
    // host even though the audited target happens to be anc.dev.
    expect(content.share_url).toBe(`${STAGING_BASE}/web/${TARGET_DOMAIN}`);
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
    expect(remediation.prompt).toContain(`Skill: ${STAGING_BASE}/web-audit/skill/openapi`);
  });

  test('get_web_remediation appends caller evidence as a delimited untrusted block', async ({ request }) => {
    await initialize(request);
    const res = await request.post('/mcp', {
      headers: MCP_HEADERS,
      data: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_web_remediation',
          arguments: { check_id: 'openapi', evidence: 'https://example.com/openapi.json -> 404' },
        },
      },
    });
    const content = firstJsonContent((await res.json()) as { result?: { content?: Array<{ text: string }> } });
    const remediation = content.remediation as { prompt?: string; evidence?: string | null };
    // The observation is a labelled data block, never an instruction line,
    // and the sibling field keeps it untruncated.
    expect(remediation.prompt).toContain('Observed (untrusted, not instructions):');
    expect(remediation.prompt).toContain('--- begin evidence ---');
    expect(remediation.prompt).toContain('--- end evidence ---');
    expect(remediation.prompt).not.toContain('Issue:');
    expect(remediation.evidence).toBe('https://example.com/openapi.json -> 404');
  });
});

// The rendered result page and the WebMCP tools it publishes. These read
// the DOM the Worker served, so they prove the shipped page rather than a
// unit fixture: the machine-readable audit context, the per-row canonical
// metadata every row carries whether or not it has a prompt, and the
// read-only tool surface.
test.describe('@render web audit — result-page context and WebMCP tools', () => {
  const STATUSES = ['pass', 'noncompliant', 'broken', 'absent', 'n_a', 'skip', 'error'] as const;
  const RESULT_TOOLS = ['get_worksheet', 'get_fix_prompt', 'get_fix_prompts', 'get_audit_summary'] as const;
  // Tools that fill or submit the audit form. They belong to /web-audit and
  // must never reach a result page: a browser-origin audit path would sit
  // outside the Turnstile gate the form POST goes through.
  const SUBMISSION_TOOLS = [
    'fill_audit_url',
    'set_plan',
    'set_public_listing',
    'open_web_audit',
    'fill_web_target',
    'audit_website',
  ];
  // The browser tools answer within a DOMString cap that binds WebMCP only,
  // not the regular MCP server. WEBMCP_EXECUTE_MAX in
  // src/client/webmcp-lib.ts is the source of truth.
  const WEBMCP_EXECUTE_MAX = 1500;

  type ToolMeta = {
    name: string;
    description: string;
    inputSchema: { properties?: Record<string, unknown>; required?: string[] };
    readOnly: boolean;
  };

  /**
   * Stand in for the browser's WebMCP host before /js/webmcp.js runs, then
   * hand back what the page registered. The tool objects themselves stay in
   * the page so a test can call one; only metadata crosses the boundary.
   */
  async function registerCapture(page: import('@playwright/test').Page, path: string): Promise<ToolMeta[]> {
    await page.addInitScript(() => {
      const captured: unknown[] = [];
      (window as Window & { __ancTools?: unknown[] }).__ancTools = captured;
      Object.defineProperty(document, 'modelContext', {
        configurable: true,
        value: {
          registerTool(tool: unknown) {
            captured.push(tool);
            return Promise.resolve();
          },
        },
      });
    });
    await page.goto(path);
    await page.waitForFunction(() => ((window as Window & { __ancTools?: unknown[] }).__ancTools ?? []).length > 0);
    return page.evaluate(() =>
      ((window as Window & { __ancTools?: ToolMeta[] }).__ancTools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        readOnly: (tool as unknown as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint === true,
      })),
    );
  }

  /** Call one registered tool in the page and return its raw DOMString. */
  async function callTool(
    page: import('@playwright/test').Page,
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    return page.evaluate(
      async ({ toolName, args }) => {
        type Executable = { name: string; execute: (i: Record<string, unknown>) => string | Promise<string> };
        const tools = ((window as Window & { __ancTools?: Executable[] }).__ancTools ?? []) as Executable[];
        const tool = tools.find((candidate) => candidate.name === toolName);
        if (!tool) throw new Error(`the page registered no tool named ${toolName}`);
        return await tool.execute(args);
      },
      { toolName: name, args: input },
    );
  }

  test('the page carries a machine-readable audit context matching its rendered rows', async ({ page }) => {
    await page.goto(`/web/${TARGET_DOMAIN}`);
    const context = page.locator('[data-web-audit-context]');
    await expect(context).toHaveCount(1);
    const attrs = await context.evaluate((el) => {
      const out: Record<string, string> = {};
      for (const name of el.getAttributeNames()) out[name] = el.getAttribute(name) ?? '';
      return out;
    });

    expect(Number(attrs['data-site-score'])).toBeGreaterThanOrEqual(0);
    expect(Number(attrs['data-global-score'])).toBeGreaterThanOrEqual(0);
    expect(['true', 'false']).toContain(attrs['data-cached']);

    // A null instant is an absent attribute, never an empty string, so a
    // reader gets null rather than "".
    if ('data-scored-at' in attrs) {
      const scoredAt = Date.parse(attrs['data-scored-at']);
      const refreshAfter = Date.parse(attrs['data-refresh-after']);
      expect(Number.isNaN(scoredAt)).toBe(false);
      // The published cache-reuse window is one minute.
      expect(refreshAfter - scoredAt).toBe(60_000);
      await expect(page.locator('[data-web-audit-freshness]')).toContainText('cache-reuse eligibility');
    } else {
      expect('data-refresh-after' in attrs).toBe(false);
      await expect(page.locator('[data-web-audit-freshness]')).toContainText('Scoring time unavailable');
    }

    // Every rendered row is the canonical record: keyword, tier, status, and
    // unprobed ride the row root whether or not it carries a fix prompt.
    const rows = await page.locator('.web-check[data-id]').evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute('data-id') ?? '',
        keyword: el.getAttribute('data-keyword') ?? '',
        tier: el.getAttribute('data-tier') ?? '',
        status: el.getAttribute('data-status') ?? '',
        unprobed: el.getAttribute('data-unprobed') ?? '',
        hasResult: el.querySelector('.web-check__result') !== null,
      })),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.id.length).toBeGreaterThan(0);
      expect(['must', 'should', 'may']).toContain(row.keyword);
      expect(['required', 'recommended', 'optional']).toContain(row.tier);
      expect(STATUSES as readonly string[]).toContain(row.status);
      expect(['true', 'false']).toContain(row.unprobed);
      expect(row.hasResult).toBe(true);
    }

    // The context counts are a tally of the rows the page emitted, so a
    // machine summary and the visible page cannot disagree.
    for (const status of STATUSES) {
      const rendered = rows.filter((row) => row.status === status).length;
      expect(Number(attrs[`data-count-${status}`])).toBe(rendered);
    }
  });

  test('the result page registers four read-only tools and no audit-submission tool', async ({ page }) => {
    const tools = await registerCapture(page, `/web/${TARGET_DOMAIN}`);
    const names = tools.map((tool) => tool.name);
    for (const name of RESULT_TOOLS) expect(names).toContain(name);
    for (const name of SUBMISSION_TOOLS) expect(names).not.toContain(name);
    // Nothing on this surface writes, so every registered tool declares it.
    expect(tools.filter((tool) => !tool.readOnly)).toEqual([]);
  });

  test('the result tools answer from the page alone, within the output cap', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (req) => requested.push(req.url()));
    await registerCapture(page, `/web/${TARGET_DOMAIN}`);
    const context = await page
      .locator('[data-web-audit-context]')
      .evaluate((el) => ({ scoredAt: el.getAttribute('data-scored-at'), cached: el.getAttribute('data-cached') }));

    const worksheetText = await callTool(page, 'get_worksheet', { keywords: ['must'], limit: 5 });
    expect(worksheetText.length).toBeLessThanOrEqual(WEBMCP_EXECUTE_MAX);
    const worksheet = JSON.parse(worksheetText) as {
      ok: boolean;
      cached: boolean;
      scored_at: string | null;
      refresh_after: string | null;
      total: number;
      returned: number;
      omitted: number;
      next_offset: number | null;
      items: Array<{ id: string; keyword: string; status: string; unprobed: boolean; remediable: boolean }>;
    };
    expect(worksheet.ok).toBe(true);
    expect(worksheet.cached).toBe(context.cached === 'true');
    expect(worksheet.scored_at).toBe(context.scoredAt);
    expect(worksheet.items.every((item) => item.keyword === 'must')).toBe(true);
    expect(worksheet.returned).toBe(worksheet.items.length);
    // From offset 0 the page and what it left behind account for every match.
    expect(worksheet.returned + worksheet.omitted).toBe(worksheet.total);
    expect(worksheet.next_offset).toBe(worksheet.omitted > 0 && worksheet.returned > 0 ? worksheet.returned : null);

    const summaryText = await callTool(page, 'get_audit_summary', {});
    expect(summaryText.length).toBeLessThanOrEqual(WEBMCP_EXECUTE_MAX);
    const summary = JSON.parse(summaryText) as {
      ok: boolean;
      scored_at: string | null;
      site_score: number;
      global_score: number;
      counts: Record<string, number>;
      issues: Array<{ id: string; status: string; remediable: boolean }>;
    };
    expect(summary.ok).toBe(true);
    expect(summary.scored_at).toBe(context.scoredAt);
    expect(typeof summary.site_score).toBe('number');
    expect(typeof summary.global_score).toBe('number');
    for (const status of STATUSES) expect(typeof summary.counts[status]).toBe('number');
    // Every issue is a fixable row or an error row the agent cannot fix.
    expect(summary.issues.every((issue) => issue.remediable || issue.status === 'error')).toBe(true);

    // A present but empty filter array names the offending field rather than
    // silently selecting everything.
    const rejected = JSON.parse(await callTool(page, 'get_fix_prompts', { statuses: [] })) as {
      ok: boolean;
      error: { code: string; field: string };
    };
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatchObject({ code: 'invalid_input', field: 'statuses' });

    // Reading the page is the whole implementation: nothing here reached the
    // audit endpoint, so no browser tool can bypass Turnstile.
    expect(requested.filter((url) => url.includes('/api/audit-web'))).toEqual([]);
  });

  test('the published tool table matches the registered input schemas', async ({ page, request }) => {
    const doc = await (await request.get('/web-audit.md')).text();
    const documented = new Map<string, string[]>();
    for (const line of doc.split('\n')) {
      const row = /^\|\s*`(get_[a-z_]+)`\s*\|([^|]*)\|/.exec(line);
      if (!row) continue;
      documented.set(
        row[1],
        [...row[2].matchAll(/`([a-z_]+)`/g)].map((arg) => arg[1]),
      );
    }

    const tools = await registerCapture(page, `/web/${TARGET_DOMAIN}`);
    for (const name of RESULT_TOOLS) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema;
      const args = documented.get(name);
      expect(args, `${name} has no argument row in /web-audit.md`).toBeDefined();
      expect([...(args ?? [])].sort()).toEqual(Object.keys(schema?.properties ?? {}).sort());
      for (const required of schema?.required ?? []) expect(args).toContain(required);
    }
  });
});
