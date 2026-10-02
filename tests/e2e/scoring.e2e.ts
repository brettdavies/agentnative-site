// Playwright e2e: the /scoring progress page, default chromium project.
//
// The local Worker serves the page; page.route() answers /api/score and the
// Turnstile script, so the page's state machine runs offline and
// deterministically. The stash an entry page would write is seeded with an
// init script. Asserts the stashed click, the tokenless probe and the Start
// gesture, streamed rows and the ?v= forward, the 2 s floor on hits, the
// bounce, the verification wait state, the inline collision that survives a
// reload, the website result that saved nothing rendering in place with Run
// again repeating the opt-out, the entry form's opt-out reaching the POST,
// a later followed submit superseding a kept opted-out result, a reload mid
// opt-out run keeping the opt-out on the probe and on Start, a website run's
// waiting line, its endpoint's declarer, and each streamed row's host and
// result line, and that the page never loads the WebMCP script.

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
async function seedStash(page: Page, target: string, lane: 'cli' | 'web', follow = true): Promise<void> {
  await page.addInitScript(
    ([t, l, f]) => {
      if (location.pathname !== '/scoring' || sessionStorage.getItem('e2e-seeded')) return;
      sessionStorage.setItem('e2e-seeded', '1');
      const ts = Date.now();
      sessionStorage.setItem(
        `audit-stash:${t}`,
        JSON.stringify({ token: 'stashed-token', listing: null, follow: f, entered_lane: l, refresh: false, ts }),
      );
      sessionStorage.setItem(`audit-lane:${t}`, JSON.stringify({ lane: l, ts }));
    },
    [target, lane, follow] as const,
  );
}

const NOT_SAVED = 'Not saved: declared hosts were not followed for this run.';

// What the endpoint streams for a website run that did not follow the hosts
// the site declares: rows, then a complete line with no URLs and the body.
function transientRun(target: string): Answer {
  return stream([
    { type: 'accepted', lane: 'web', target, started_at: AT },
    { type: 'discovery', mcp_endpoint: null },
    { type: 'check', id: 'robots-txt', principle: 'P7', keyword: 'should', status: 'pass', evidence: null },
    envelope({
      type: 'complete',
      kind: 'web',
      tier: 'live',
      target,
      scorecard_url: null,
      markdown_url: null,
      json_url: null,
      freshness: { cached: false, scored_at: AT, refresh_after: null },
      summary_html: `<article class="e2e-transient"><span data-web-audit-transient>${NOT_SAVED}</span></article>`,
    }),
  ]);
}

// A saved website result the endpoint answers a followed request with.
function webHit(target: string): Answer {
  return json(
    200,
    envelope({
      kind: 'web',
      tier: 'cache',
      target,
      scorecard_url: `/score/${target}`,
      markdown_url: `/score/${target}/md`,
      json_url: `/score/${target}/json`,
      freshness: { cached: true, scored_at: AT, refresh_after: null },
    }),
  );
}

// The entry form's submit of a website target, following declared hosts or not.
async function submitWebsite(page: Page, target: string, follow: boolean): Promise<void> {
  await page.goto('/audit');
  await page.locator('label[for="s-web"]').click();
  await page.fill('[data-audit-target]', target);
  await page.locator('[data-audit-follow]').setChecked(follow);
  await page.click('[data-audit-submit]');
  await page.waitForURL(`**/scoring?target=${target}`);
}

type StreamHooks = { __e2eSend: (line: unknown) => void };

// page.route() answers with a whole body at once, so a run's waiting state
// never shows. This stands in for the endpoint with a stream the test feeds
// one line at a time; the page cancels it once a terminal line arrives.
async function controlledStream(page: Page): Promise<{
  /** Resolves once the page has asked for its run. */
  opened: () => Promise<unknown>;
  send: (line: unknown) => Promise<void>;
}> {
  await page.addInitScript(() => {
    type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    const win = window as unknown as { fetch: Fetch };
    const original = win.fetch.bind(window);
    win.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('/api/score')) return original(input, init);
      const encoder = new TextEncoder();
      const hooks = window as unknown as StreamHooks;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          hooks.__e2eSend = (line) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    };
  });
  return {
    opened: () =>
      page.waitForFunction(() => typeof (window as unknown as Partial<StreamHooks>).__e2eSend === 'function'),
    send: (line) => page.evaluate((l) => (window as unknown as StreamHooks).__e2eSend(l), line),
  };
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

  test('a run already in flight keeps an escape on screen while the page waits', async ({ page }) => {
    await mockTurnstile(page);
    const posts = await mockScore(page, [json(202, { in_progress: true, started_at: AT })]);
    await page.goto('/scoring?target=ouch');
    await expect(page.locator('[data-scoring-status]')).toContainText('already running');
    // The wait repeats on the visitor's own budget, so it never leaves them
    // with a status line and no way out.
    await expect(page.locator('[data-scoring-other]')).toBeVisible();
    await expect.poll(() => posts.length, { timeout: 10_000 }).toBeGreaterThan(1);
  });

  test('a cached result with no URL of its own renders inline instead of promising a page', async ({ page }) => {
    await mockTurnstile(page);
    await mockScore(page, [
      json(
        200,
        envelope({
          tier: 'cache',
          target: 'rg',
          scorecard_url: null,
          markdown_url: null,
          json_url: null,
          summary_html: '<section class="e2e-cached-inline">the cached inline result</section>',
          freshness: { cached: true, scored_at: AT, refresh_after: null },
        }),
      ),
    ]);
    await seedStash(page, 'rg', 'cli');
    await page.goto('/scoring?target=rg');
    await expect(page.locator('.e2e-cached-inline')).toBeVisible();
    await expect(page).toHaveURL(/\/scoring\?target=rg$/);
  });

  test('a website run that saved nothing renders in place, never navigates, and Run again repeats the opt-out', async ({
    page,
  }) => {
    await mockTurnstile(page);
    const posts = await mockScore(page, [transientRun('stripe.dev')]);
    await seedStash(page, 'stripe.dev', 'web', false);
    await page.goto('/scoring?target=stripe.dev');
    await expect(page.locator('.e2e-transient')).toContainText(NOT_SAVED);
    await expect(page.locator('[data-scoring-subline]')).toHaveText('This result was not saved.');
    await expect(page).toHaveURL(/\/scoring\?target=stripe\.dev$/);
    expect(posts[0]).toEqual({ target: 'stripe.dev', turnstile_token: 'stashed-token', follow_declarations: false });
    const start = page.locator('[data-scoring-start]');
    await expect(start).toHaveText('Run again');
    await start.click();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]).toEqual({ target: 'stripe.dev', turnstile_token: 'fake-token', follow_declarations: false });
    await expect(page.locator('.e2e-transient')).toBeVisible();
    // A same-tab reload restores the result and keeps the opt-out for the next Run again.
    await page.reload();
    await expect(page.locator('.e2e-transient')).toBeVisible();
    expect(posts).toHaveLength(2);
    await page.locator('[data-scoring-start]').click();
    await expect.poll(() => posts.length).toBe(3);
    expect(posts[2]).toMatchObject({ follow_declarations: false });
    await expect(page).toHaveURL(/\/scoring\?target=stripe\.dev$/);
  });

  test('unticking follow on the form disables the listing box with its note, and the opt-out posts with no listing', async ({
    page,
  }) => {
    await mockTurnstile(page);
    const posts = await mockScore(page, [transientRun('stripe.dev')]);
    await page.goto('/audit');
    await page.locator('label[for="s-web"]').click();
    await page.fill('[data-audit-target]', 'stripe.dev');
    const follow = page.locator('[data-audit-follow]');
    const listing = page.locator('[data-audit-listing]');
    const note = page.locator('[data-audit-listing-note]');
    await expect(follow).toBeChecked();
    await expect(follow).toHaveAttribute('aria-describedby', /-follow-help$/);
    await expect(listing).toBeEnabled();
    await expect(note).toBeHidden();
    await follow.uncheck();
    await expect(listing).toBeDisabled();
    await expect(note).toBeVisible();
    await expect(note).toHaveText('Results without declared hosts are not saved or listed.');
    const noteId = await note.getAttribute('id');
    await expect(listing).toHaveAttribute('aria-describedby', noteId ?? '');
    await follow.check();
    await expect(listing).toBeEnabled();
    await expect(note).toBeHidden();
    await expect(listing).not.toHaveAttribute('aria-describedby', /.+/);
    await follow.uncheck();
    await page.click('[data-audit-submit]');
    await page.waitForURL('**/scoring?target=stripe.dev');
    await expect(page.locator('.e2e-transient')).toBeVisible();
    expect(posts[0]).toEqual({ target: 'stripe.dev', turnstile_token: 'fake-token', follow_declarations: false });
  });

  test('an opted-out result kept in the tab does not answer a later followed submit of the same site', async ({
    page,
  }) => {
    await mockTurnstile(page);
    const posts = await mockScore(page, [transientRun('stripe.dev'), webHit('stripe.dev')]);
    await submitWebsite(page, 'stripe.dev', false);
    await expect(page.locator('.e2e-transient')).toBeVisible();
    await submitWebsite(page, 'stripe.dev', true);
    await expect(page.locator('.e2e-transient')).toHaveCount(0);
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]).toMatchObject({ target: 'stripe.dev', turnstile_token: 'fake-token' });
    expect(posts[1]).not.toHaveProperty('follow_declarations');
    await page.waitForURL('**/score/stripe.dev');
  });

  test('a reload mid opt-out run keeps the opt-out: the probe and Start both send follow_declarations false', async ({
    page,
  }) => {
    await mockTurnstile(page);
    const posts: Array<Record<string, unknown>> = [];
    let release: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The server's answer to a tokenless opted-out probe, then the run Start begins.
    const later = [
      json(403, { error: { code: 'turnstile_failed', message: 'Verification failed.', cta: 'Start the audit.' } }),
      transientRun('stripe.dev'),
    ];
    await page.route('**/api/score', async (route) => {
      const n = posts.push(route.request().postDataJSON() as Record<string, unknown>);
      if (n === 1) {
        // The first run is still going when the visitor reloads; the reload cancels this request.
        await running;
        await route.fulfill(transientRun('stripe.dev')).catch(() => {});
        return;
      }
      await route.fulfill(later[Math.min(n - 2, later.length - 1)]);
    });
    await submitWebsite(page, 'stripe.dev', false);
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ follow_declarations: false });
    await page.reload();
    release();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]).toEqual({ target: 'stripe.dev', follow_declarations: false });
    const start = page.locator('[data-scoring-start]');
    await expect(start).toHaveText('Start');
    await start.click();
    await expect.poll(() => posts.length).toBe(3);
    expect(posts[2]).toEqual({ target: 'stripe.dev', turnstile_token: 'fake-token', follow_declarations: false });
    await expect(page.locator('.e2e-transient')).toBeVisible();
  });

  test('a website run reads the hosts a site declares while it waits, then names each row where its evidence came from', async ({
    page,
  }) => {
    await mockTurnstile(page);
    await seedStash(page, 'stripe.dev', 'web');
    const stream = await controlledStream(page);
    await page.goto('/scoring?target=stripe.dev');
    await expect(page.locator('[data-scoring-subline]')).toContainText(
      'Usually under 30 seconds; longer when the site declares other hosts.',
    );
    await stream.opened();
    const status = page.locator('[data-scoring-status]');
    await stream.send({ type: 'accepted', lane: 'web', target: 'stripe.dev', started_at: AT });
    await expect(status).toHaveText('Reading stripe.dev and any hosts it declares…');
    await stream.send({ type: 'discovery', mcp_endpoint: 'https://mcp.stripe.com/' });
    await expect(status).toContainText(
      'MCP endpoint found at https://mcp.stripe.com/, declared by stripe.dev. Checks:',
    );
    const check = (id: string, fields: Record<string, unknown>) => ({
      type: 'check',
      id,
      principle: 'P2',
      keyword: 'should',
      status: 'n_a',
      evidence: null,
      ...fields,
    });
    await stream.send(check('mcp-initialize', { na_reason: 'auth-required', host: 'mcp.stripe.com', evidence: '401' }));
    await stream.send(
      check('json-errors', { status: 'pass', host: 'api.stripe.com', evidence: '404 with a JSON body' }),
    );
    await stream.send(check('mcp-card', { na_reason: 'reciprocity-refused', host: 'mcp.example.net' }));
    await stream.send(check('robots-txt', { status: 'pass' }));
    const row = (id: string) => page.locator('.scoring__row', { has: page.locator(`.scoring__id:text-is("${id}")`) });
    // Before the run completes, each row already reads the line its saved page shows.
    await expect(row('mcp-initialize').locator('.pscore__evidence')).toHaveText(
      'Not evaluated: mcp.stripe.com requires sign-in (401)',
    );
    await expect(row('mcp-card').locator('.pscore__evidence')).toHaveText(
      'Not evaluated: mcp.example.net did not confirm this endpoint',
    );
    await expect(row('json-errors').locator('.pscore__evidence')).toHaveText('Verified (404 with a JSON body)');
    await expect(row('mcp-initialize')).toHaveAttribute('data-host', 'mcp.stripe.com');
    await expect(row('robots-txt')).toHaveAttribute('data-host', 'stripe.dev');
    // Only a host that is neither the target nor the endpoint is named in the title.
    await expect(row('json-errors').locator('.scoring__host')).toHaveText('evaluated at api.stripe.com');
    // A row the audit could not run names its host in its line, not as where it was evaluated.
    await expect(row('mcp-card').locator('.scoring__host')).toHaveCount(0);
    await expect(row('mcp-card')).toHaveAttribute('data-host', 'mcp.example.net');
    await expect(row('mcp-initialize').locator('.scoring__host')).toHaveCount(0);
    await expect(row('robots-txt').locator('.scoring__host')).toHaveCount(0);
    await stream.send(
      envelope({
        type: 'complete',
        kind: 'web',
        tier: 'live',
        target: 'stripe.dev',
        scorecard_url: null,
        markdown_url: null,
        json_url: null,
        freshness: { cached: false, scored_at: AT, refresh_after: null },
        summary_html: '<article class="e2e-done">done</article>',
      }),
    );
    await expect(page.locator('.e2e-done')).toBeVisible();
  });

  test('a website endpoint on the target itself is named without a declarer', async ({ page }) => {
    await mockTurnstile(page);
    await seedStash(page, 'anc.dev', 'web');
    const stream = await controlledStream(page);
    await page.goto('/scoring?target=anc.dev');
    await stream.opened();
    await stream.send({ type: 'accepted', lane: 'web', target: 'anc.dev', started_at: AT });
    await stream.send({ type: 'discovery', mcp_endpoint: 'https://anc.dev/mcp' });
    await expect(page.locator('[data-scoring-status]')).toContainText(
      'MCP endpoint found at https://anc.dev/mcp. Checks:',
    );
    await expect(page.locator('[data-scoring-status]')).not.toContainText('declared by');
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
