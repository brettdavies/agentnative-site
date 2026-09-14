// Playwright e2e: the /scoring progress page, default chromium project.
//
// The local Worker serves the page; page.route() answers /api/score and the
// Turnstile script, so the page's state machine runs offline and
// deterministically. The stash an entry page would write is seeded with an
// init script. Asserts the stashed click, the tokenless probe and the Start
// gesture, streamed rows and the ?v= forward, the 2 s floor on hits, the
// bounce, the verification wait state, the inline collision that survives a
// reload, and that the page never loads the WebMCP script.

import { expect, type Page, test } from '@playwright/test';

const AT = '2026-09-11T00:00:00.000Z';

type Answer = { status: number; contentType: string; body: string };

const json = (status: number, body: unknown): Answer => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(body),
});

const stream = (lines: unknown[]): Answer => ({
  status: 200,
  contentType: 'application/x-ndjson; charset=utf-8',
  body: `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
});

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'cli',
    tier: 'registry',
    target: 'ripgrep',
    scorecard_url: '/score/ripgrep',
    markdown_url: '/score/ripgrep/md',
    json_url: '/score/ripgrep/json',
    freshness: { cached: true, scored_at: null, refresh_after: null },
    spec_version: '0.4.0',
    scorecard: {},
    ...over,
  };
}

const accepted = (target: string) => ({ type: 'accepted', lane: 'cli', target, started_at: AT });
const phase = (name: string) => ({ type: 'phase', phase: name, at: AT });

// The invisible widget clears on execute(); the stub hands back a token the
// same way, asynchronously, without the network.
async function mockTurnstile(page: Page): Promise<{ loads: () => number }> {
  let loads = 0;
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js**', async (route) => {
    loads += 1;
    await route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.turnstile = {
          render(_el, opts) { window.__turnstileCallback = opts.callback; return 'fake-widget-id'; },
          execute() { const cb = window.__turnstileCallback; if (cb) setTimeout(() => cb('fake-token'), 10); },
          reset() {},
          remove() {},
        };
      `,
    });
  });
  return { loads: () => loads };
}

async function mockScore(page: Page, answers: Answer[]): Promise<Array<Record<string, unknown>>> {
  const posts: Array<Record<string, unknown>> = [];
  await page.route('**/api/score', async (route) => {
    posts.push(route.request().postDataJSON() as Record<string, unknown>);
    const answer = answers[Math.min(posts.length - 1, answers.length - 1)];
    await route.fulfill(answer);
  });
  return posts;
}

// What an entry page's click leaves behind: the token record and the lane
// the visitor had selected. Seeded once, so a reload finds the stash spent.
async function seedStash(page: Page, target: string, lane: 'cli' | 'web'): Promise<void> {
  await page.addInitScript(
    ([t, l]) => {
      if (location.pathname !== '/scoring' || sessionStorage.getItem('e2e-seeded')) return;
      sessionStorage.setItem('e2e-seeded', '1');
      const ts = Date.now();
      sessionStorage.setItem(
        `audit-stash:${t}`,
        JSON.stringify({ token: 'stashed-token', listing: null, entered_lane: l, refresh: false, ts }),
      );
      sessionStorage.setItem(`audit-lane:${t}`, JSON.stringify({ lane: l, ts }));
    },
    [target, lane],
  );
}

test.describe('/scoring progress page', () => {
  test('a stashed click POSTs once with its token and loads no Turnstile; a registry hit forwards after the floor', async ({
    page,
  }) => {
    const turnstile = await mockTurnstile(page);
    const posts = await mockScore(page, [json(200, envelope())]);
    await seedStash(page, 'ripgrep', 'cli');
    const loadedAt = Date.now();
    await page.goto('/scoring?target=ripgrep');
    await expect(page.locator('[data-scoring-status]')).toContainText('curated');
    await page.waitForURL('**/score/ripgrep');
    expect(Date.now() - loadedAt).toBeGreaterThanOrEqual(1900);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ target: 'ripgrep', turnstile_token: 'stashed-token' });
    expect(turnstile.loads()).toBe(0);
  });

  test('without a stash the page probes with no token; a 403 renders Start, whose click acquires a token and POSTs it', async ({
    page,
  }) => {
    const turnstile = await mockTurnstile(page);
    const posts = await mockScore(page, [
      json(403, { error: { code: 'turnstile_failed', message: 'Verification failed.', cta: 'Start the audit.' } }),
      stream([
        accepted('ouch'),
        phase('resolving'),
        { type: 'bounce', error: { code: 'chain_no_resolve', message: 'x', cta: 'y' } },
      ]),
    ]);
    await page.goto('/scoring?target=ouch');
    const start = page.locator('[data-scoring-start]');
    await expect(start).toBeVisible();
    await expect(start).toHaveText('Start');
    expect(posts).toEqual([{ target: 'ouch' }]);
    expect(turnstile.loads()).toBe(0);
    await start.click();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]).toMatchObject({ target: 'ouch', turnstile_token: 'fake-token' });
  });

  test('a streamed miss renders one row per phase, then forwards to the result with ?v=<scored_at>', async ({
    page,
  }) => {
    await mockTurnstile(page);
    await mockScore(page, [
      stream([
        accepted('ouch'),
        phase('resolving'),
        phase('installing'),
        phase('auditing'),
        envelope({
          type: 'complete',
          tier: 'live',
          target: 'ouch',
          scorecard_url: '/score/ouch',
          freshness: { cached: false, scored_at: AT, refresh_after: null },
        }),
      ]),
    ]);
    await seedStash(page, 'ouch', 'cli');
    await page.goto('/scoring?target=ouch');
    await expect(page.locator('.scoring__row')).toHaveCount(3);
    await page.waitForURL(`**/score/ouch?v=${encodeURIComponent(AT)}`);
  });

  test('a bounce renders its panel and both actions, and moves focus to the heading', async ({ page }) => {
    await mockTurnstile(page);
    await mockScore(page, [
      stream([
        accepted('ouch'),
        phase('resolving'),
        { type: 'bounce', error: { code: 'chain_no_resolve', message: 'x', cta: 'y' } },
      ]),
    ]);
    await seedStash(page, 'ouch', 'cli');
    await page.goto('/scoring?target=ouch');
    await expect(page.locator('.scoring__bounce')).toContainText("couldn't find a pre-built binary");
    await expect(page.locator('[data-scoring-start]')).toHaveText('Run again');
    await expect(page.locator('[data-scoring-other]')).toBeVisible();
    await expect(page.locator('[data-scoring-heading]')).toBeFocused();
    await expect(page).toHaveURL(/\/scoring\?target=ouch$/);
  });

  test('verification being unavailable holds Start through the countdown, then says Ready to retry, never that it failed', async ({
    page,
  }) => {
    await mockTurnstile(page);
    await mockScore(page, [
      json(503, {
        error: {
          code: 'turnstile_unavailable',
          message: 'Verification is briefly unavailable.',
          cta: 'y',
          retry_after: 2,
        },
      }),
    ]);
    await seedStash(page, 'ouch', 'cli');
    await page.goto('/scoring?target=ouch');
    const status = page.locator('[data-scoring-status]');
    await expect(status).toContainText('briefly unavailable');
    await expect(page.locator('[data-scoring-start]')).toHaveAttribute('aria-disabled', 'true');
    await expect(status).toHaveText('Ready to retry.', { timeout: 5_000 });
    await expect(page.locator('[data-scoring-start]')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(status).not.toContainText('failed');
  });

  test('a result with no URL of its own renders inline, stays put, and a same-tab reload restores it with no request', async ({
    page,
  }) => {
    await mockTurnstile(page);
    const posts = await mockScore(page, [
      stream([
        accepted('rg'),
        envelope({
          type: 'complete',
          tier: 'live',
          target: 'rg',
          scorecard_url: null,
          markdown_url: null,
          json_url: null,
          summary_html: '<section class="e2e-inline">the inline result</section>',
        }),
      ]),
    ]);
    await seedStash(page, 'rg', 'cli');
    await page.goto('/scoring?target=rg');
    await expect(page.locator('.e2e-inline')).toBeVisible();
    await expect(page.locator('[data-scoring-subline]')).toContainText('no URL');
    await expect(page).toHaveURL(/\/scoring\?target=rg$/);
    const before = posts.length;
    await page.reload();
    await expect(page.locator('.e2e-inline')).toBeVisible();
    expect(posts.length).toBe(before);
  });

  test('the page never loads the WebMCP script', async ({ page }) => {
    await mockTurnstile(page);
    await mockScore(page, [json(403, { error: { code: 'turnstile_failed', message: 'x', cta: 'y' } })]);
    const scripts: string[] = [];
    page.on('request', (req) => {
      if (req.resourceType() === 'script') scripts.push(req.url());
    });
    await page.goto('/scoring?target=ouch');
    await expect(page.locator('[data-scoring-start]')).toBeVisible();
    expect(scripts.some((url) => url.includes('/js/scoring.js'))).toBe(true);
    expect(scripts.some((url) => url.includes('webmcp'))).toBe(false);
  });

  test('/scoring with no target serves the prose pointer to the audit page', async ({ page }) => {
    await page.goto('/scoring');
    await expect(page.locator('h1')).toHaveText('Audit progress');
    await expect(page.locator('[data-scoring]')).toHaveCount(0);
    await expect(page.locator('main a[href="/audit"]')).toBeVisible();
  });
});
