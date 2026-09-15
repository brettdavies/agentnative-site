// Playwright e2e: the audit entry form, on the homepage and on /audit.
//
// Default chromium project. The form never audits: it validates the target,
// acquires a Turnstile token on the submit click, stashes it, and leaves for
// the progress page. So these assert the entry gesture and the handoff, and
// `/api/score` is stubbed only to keep the progress page from starting a real
// audit; the run itself belongs to tests/e2e/scoring.e2e.ts.
//
// Also asserts the homepage regressions that outlive the form: the Turnstile
// CSP directives, the markdown twins' silence about the form, and the

import { expect, type Page, test } from '@playwright/test';

const ENTRY_PAGES = [
  { name: 'homepage', path: '/', inputId: 'home-target' },
  { name: 'audit page', path: '/audit', inputId: 'audit-target' },
] as const;

// The real script lazy-loads on first interaction; the stub hands back a
// token the same way, asynchronously, without the network.
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

// The progress page POSTs whatever the entry form stashed. Refusing it there
// keeps the run offline while still recording what the click spent.
async function stubScore(page: Page): Promise<Array<Record<string, unknown>>> {
  const posts: Array<Record<string, unknown>> = [];
  await page.route('**/api/score', async (route) => {
    posts.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 403,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ error: { code: 'turnstile_failed', message: 'Verification failed.', cta: 'Start.' } }),
    });
  });
  return posts;
}

for (const entry of ENTRY_PAGES) {
  test.describe(`audit entry form — ${entry.name}`, () => {
    test('renders both lanes and loads no Turnstile before a gesture', async ({ page }) => {
      const turnstile = await mockTurnstile(page);
      await page.goto(entry.path);

      await expect(page.locator(`#${entry.inputId}`)).toBeVisible();
      await expect(page.locator('[data-audit-submit]')).toBeVisible();
      await expect(page.locator('#s-cli')).toBeChecked();
      // Scrolling past the form is not a gesture; only focus, a chip, or the
      // submit may spend a script load.
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(1000);
      expect(turnstile.loads()).toBe(0);
    });

    test('a CLI chip fills the target and lazy-loads Turnstile', async ({ page }) => {
      const turnstile = await mockTurnstile(page);
      await page.goto(entry.path);

      await page.locator('[data-audit-example="cargo binstall ouch"]').click();
      await expect(page.locator(`#${entry.inputId}`)).toHaveValue('cargo binstall ouch');
      await page.waitForFunction(() => Boolean((window as { turnstile?: object }).turnstile), { timeout: 5_000 });
      expect(turnstile.loads()).toBe(1);
    });

    test('the Website lane swaps the placeholder and its own examples', async ({ page }) => {
      await mockTurnstile(page);
      await page.goto(entry.path);

      await page.locator('label[for="s-web"]').click();
      await expect(page.locator('#s-web')).toBeChecked();
      await expect(page.locator(`#${entry.inputId}`)).toHaveAttribute('placeholder', 'anc.dev');
      await page.locator('[data-audit-example="anc.dev"]').click();
      await expect(page.locator(`#${entry.inputId}`)).toHaveValue('anc.dev');
    });

    test('submitting a target leaves for the progress page, which spends the stashed token', async ({ page }) => {
      await mockTurnstile(page);
      const posts = await stubScore(page);
      await page.goto(entry.path);

      await page.locator(`#${entry.inputId}`).fill('ripgrep');
      await page.locator('[data-audit-submit]').click();

      await page.waitForURL('**/scoring?target=ripgrep', { timeout: 10_000 });
      await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
      expect(posts[0]).toMatchObject({ target: 'ripgrep', turnstile_token: 'fake-token' });
    });

    test('a target that is no tool, repo, or site says so inline and never leaves the page', async ({ page }) => {
      await mockTurnstile(page);
      const posts = await stubScore(page);
      await page.goto(entry.path);

      // Client-side classification rejects a shape it cannot route, not
      // every odd string: a bare name it cannot resolve is the server's
      // call, and reaches the progress page.
      await page.locator(`#${entry.inputId}`).fill('javascript://github.com/x/y');
      await page.locator('[data-audit-submit]').click();

      const status = page.locator('[data-audit-status]');
      await expect(status).toBeVisible({ timeout: 5_000 });
      await expect(status).toContainText(/does not look like/i);
      await page.waitForTimeout(500);
      expect(page.url()).not.toContain('/scoring');
      expect(posts).toHaveLength(0);
    });

    test('a successful submit leaves no token in the URL', async ({ page }) => {
      await mockTurnstile(page);
      await stubScore(page);
      await page.goto(entry.path);

      await page.locator(`#${entry.inputId}`).fill('ripgrep');
      await page.locator('[data-audit-submit]').click();
      await page.waitForURL('**/scoring?target=ripgrep', { timeout: 10_000 });

      const finalUrl = page.url();
      expect(finalUrl).not.toContain('fake-token');
      expect(finalUrl).not.toContain('turnstile_token');
    });
  });
}

test.describe('audit entry form — the no-JS form and its prefill', () => {
  test('/audit?lane=web&target= prefills the lane and the target', async ({ page }) => {
    await mockTurnstile(page);
    await page.goto('/audit?lane=web&target=anc.dev');

    await expect(page.locator('#s-web')).toBeChecked();
    await expect(page.locator('#audit-target')).toHaveValue('anc.dev');
  });

  test('the form submits as a GET to /audit without JavaScript', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/');

    const form = page.locator('[data-audit-form]');
    // The build's minifier drops `method="get"` as the form default, so the
    // property is what survives to the browser.
    expect(await form.evaluate((el: HTMLFormElement) => el.method)).toBe('get');
    await expect(form).toHaveAttribute('action', '/audit');
    await context.close();
  });
});

test.describe('entry form — CSP + markdown-twin regressions', () => {
  test('CSP includes challenges.cloudflare.com in script-src + frame-src + connect-src', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const csp = res.headers()['content-security-policy'];
    expect(csp).toBeTruthy();
    // Fragmented matchers so directive ordering does not matter.
    expect(csp).toMatch(/script-src[^;]*challenges\.cloudflare\.com/);
    expect(csp).toMatch(/frame-src[^;]*challenges\.cloudflare\.com/);
    expect(csp).toMatch(/connect-src[^;]*challenges\.cloudflare\.com/);
  });

  test('CSP allows the CF Web Analytics beacon (script-src + connect-src)', async ({ request }) => {
    const res = await request.get('/');
    const csp = res.headers()['content-security-policy'];
    // The edge injects the beacon when Web Analytics is on at the zone
    // level; without these every real-user CWV sample drops silently.
    expect(csp).toMatch(/script-src[^;]*static\.cloudflareinsights\.com/);
    expect(csp).toMatch(/connect-src[^;]*cloudflareinsights\.com/);
  });

  test('CSP blocks a cross-origin script from executing', async ({ page }) => {
    await page.goto('/');
    // The policy permits 'unsafe-inline' because theme-init is load-bearing,
    // so the control that matters is the cross-origin one: a script from
    // another host must be refused. Without this, widening script-src ships
    // green past the positive assertions above.
    const violations: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) violations.push(msg.text());
    });

    await page.evaluate(() => {
      const s = document.createElement('script');
      s.src = 'https://evil.example.com/x.js';
      document.head.appendChild(s);
    });
    await page.waitForTimeout(500);
    expect(violations.some((v) => /evil\.example\.com/.test(v))).toBe(true);
  });

  for (const twin of ['/index.md', '/audit.md']) {
    test(`${twin} mentions no form, Turnstile, or endpoint`, async ({ request }) => {
      const res = await request.get(twin);
      expect(res.status()).toBe(200);
      const md = (await res.text()).toLowerCase();
      expect(md).not.toContain('turnstile');
      expect(md).not.toContain('challenges.cloudflare.com');
      expect(md).not.toContain('/api/score');
      expect(md).not.toContain('data-audit-form');
    });
  }

  test('Accept: text/markdown on / serves the silent twin', async ({ request }) => {
    const res = await request.get('/', { headers: { accept: 'text/markdown' } });
    expect(res.headers()['content-type']).toContain('text/markdown');
    const md = (await res.text()).toLowerCase();
    expect(md).not.toContain('turnstile');
    expect(md).not.toContain('data-audit-form');
  });
});

test.describe('result URL canonicalization', () => {
  test('a curated slug serves the page and its markdown twin', async ({ request }) => {
    const html = await request.get('/score/ripgrep', { maxRedirects: 0 });
    expect(html.status()).toBe(200);
    expect(html.headers()['content-type']).toContain('text/html');
    const md = await request.get('/score/ripgrep/md', { maxRedirects: 0 });
    expect(md.status()).toBe(200);
    expect(md.headers()['content-type']).toContain('text/markdown');
  });

  // One tool owns one page: the binary alias redirects rather than rendering
  // a second copy under a second URL.
  test('a curated binary alias 301s to its slug', async ({ request }) => {
    const res = await request.get('/score/rg', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers().location).toBe('/score/ripgrep');
  });
});
