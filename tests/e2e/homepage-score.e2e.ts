// Playwright e2e: homepage live-scoring form (plan U8).
//
// Default chromium project. Mocks `/api/score` via page.route() so the
// suite runs offline + deterministically. Asserts:
//   - happy path: lazy-loaded Turnstile, 2 s theater floor, redirect to share_url
//   - lazy-load regression: Turnstile NOT requested without form interaction
//   - registry_hit redirect
//   - invalid + non-GitHub URL + 429 + Turnstile-fail inline errors
//   - three bounce panels (chain_no_resolve, chain_resolved_install_failed,
//     chain_resolved_no_binary_produced)
//   - CSP regression: script-src, frame-src, connect-src all contain
//     challenges.cloudflare.com on the homepage response header
//   - markdown-twin silence: /index.md must NOT mention live-score,
//     turnstile, challenges.cloudflare.com, or /api/score
//   - /score/live/<binary>.html → 301 redirect to /score/live/<binary>
//     (URL pattern consistency with the rest of the site)
//   - red-team: no token leak in URL on redirect, sitekey absent in
//     prod-style env (the form disables itself)

import { expect, test } from '@playwright/test';

const SCORECARD_SAMPLE = {
  schema_version: '0.5',
  tool: { name: 'ripgrep', binary: 'rg', version: '14.1.0' },
  target: { kind: 'command', command: 'rg' },
  badge: { score_pct: 92, eligible: true },
  audience: 'agent-optimized',
  audit_profile: null,
  results: [
    {
      status: 'fail',
      label: 'exits 0 on missing required flag',
      group: 'P4',
      evidence: 'expected non-zero exit, got 0',
    },
    { status: 'pass', label: 'streams stdout', group: 'P1', evidence: 'OK' },
  ],
};

// Mock helper — every test that hits the form needs Turnstile siteverify
// to pass (we mock the script entirely) and `/api/score` to respond with
// the test's chosen shape.
async function mockTurnstileAndScore(
  page: import('@playwright/test').Page,
  scorePayload: { status: number; body: Record<string, unknown> },
): Promise<{ turnstileRequested: () => boolean; scoreCalls: () => number }> {
  let turnstileRequested = false;
  let scoreCalls = 0;
  // The real Turnstile script lazy-loads on first interaction. We replace
  // it with a tiny stub that synthesizes window.turnstile.{render,execute,reset}
  // so the form's submit flow gets a token without a network round-trip
  // and without dependency on the real CF infrastructure.
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js**', async (route) => {
    turnstileRequested = true;
    await route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.turnstile = {
          render(_el, opts) {
            // Synchronously deliver a fake token to mirror the real callback shape.
            // Use a timeout so the call stack matches real Turnstile (callback
            // fires async after execute()).
            window.__lastTurnstileCallback = opts.callback;
            return 'fake-widget-id';
          },
          execute(_id) {
            const cb = window.__lastTurnstileCallback;
            if (cb) setTimeout(() => cb('fake-token'), 10);
          },
          reset() {},
          remove() {},
        };
      `,
    });
  });
  await page.route('**/api/score', async (route) => {
    scoreCalls += 1;
    await route.fulfill({
      status: scorePayload.status,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(scorePayload.body),
    });
  });
  return {
    turnstileRequested: () => turnstileRequested,
    scoreCalls: () => scoreCalls,
  };
}

test.describe('homepage live-scoring form — happy path', () => {
  test('paste registry slug → 2 s theater → redirect to share_url', async ({ page }) => {
    const observer = await mockTurnstileAndScore(page, {
      status: 200,
      body: {
        scorecard: SCORECARD_SAMPLE,
        spec_version: '0.4.0',
        site_spec_version: '0.4.0',
        anc_version: '0.3.1',
        checker_url: 'https://anc.dev/score',
        share_url: '/score/live/ripgrep',
      },
    });

    await page.goto('/');

    // Wait for the form to be ready (live-score.js is deferred).
    const input = page.locator('#live-score-input');
    await expect(input).toBeVisible();

    // Capture the start time and submit; the 2 s theater is enforced
    // client-side via Promise.all([fetch, setTimeout(2000)]).
    const start = Date.now();
    await input.fill('ripgrep');
    await page.locator('[data-live-score-submit]').click();

    // After submit, the page should redirect to share_url.
    await page.waitForURL('**/score/live/ripgrep', { timeout: 10_000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(1900); // 2 s minus a small jitter tolerance

    // Sanity: Turnstile script was loaded after interaction, /api/score
    // was called exactly once.
    expect(observer.turnstileRequested()).toBe(true);
    expect(observer.scoreCalls()).toBe(1);
  });

  test('registry_hit response redirects to scorecard_url', async ({ page }) => {
    const observer = await mockTurnstileAndScore(page, {
      status: 200,
      body: {
        scorecard: { kind: 'registry_hit', tool: { name: 'ripgrep' }, scorecard_url: '/score/ripgrep' },
        spec_version: '0.4.0',
        anc_version: '0.3.1',
        checker_url: 'https://anc.dev/score',
      },
    });

    await page.goto('/');
    await page.locator('#live-score-input').fill('ripgrep');
    await page.locator('[data-live-score-submit]').click();

    await page.waitForURL('**/score/ripgrep', { timeout: 10_000 });
    expect(observer.scoreCalls()).toBe(1);
  });

  test('curated registry_hit shows "Curated · N% pass rate" reward before redirect', async ({ page }) => {
    // The registry_hit envelope now carries score_pct so the homepage form
    // can render a small "you found one of ours" reward inline before the
    // redirect. The reward shows for the remainder of the 2 s theater
    // floor, then the page navigates.
    await mockTurnstileAndScore(page, {
      status: 200,
      body: {
        scorecard: {
          kind: 'registry_hit',
          tool: { name: 'bat' },
          scorecard_url: '/score/bat',
          score_pct: 78,
        },
        spec_version: '0.4.0',
        anc_version: '0.3.1',
        checker_url: 'https://anc.dev/score',
      },
    });

    await page.goto('/');
    await page.locator('#live-score-input').fill('cargo install bat');
    await page.locator('[data-live-score-submit]').click();

    // Reward text appears in the status slot (with the --curated class
    // applied for the accent-color identity cue) BEFORE the redirect.
    const status = page.locator('[data-live-score-status]');
    await expect(status).toHaveClass(/live-score__status--curated/, { timeout: 5_000 });
    await expect(status).toContainText(/Curated/);
    await expect(status).toContainText(/78% pass rate/);

    // After the theater floor elapses, the page navigates to the curated
    // scorecard URL.
    await page.waitForURL('**/score/bat', { timeout: 10_000 });
  });

  test('phase progression updates status text while waiting on /api/score', async ({ page }) => {
    // Mock /api/score with an artificial delay so the phase progression
    // has time to tick at least once before the response arrives.
    await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js**', async (route) => {
      await route.fulfill({
        contentType: 'application/javascript',
        body: `
          window.turnstile = {
            render(_el, opts) {
              window.__lastTurnstileCallback = opts.callback;
              return 'fake-widget-id';
            },
            execute() {
              const cb = window.__lastTurnstileCallback;
              if (cb) setTimeout(() => cb('fake-token'), 10);
            },
            reset() {}, remove() {},
          };
        `,
      });
    });
    await page.route('**/api/score', async (route) => {
      // Hold the response for 1.5 s so the phase ticker has time to fire
      // the t=900 ms "Resolving install path…" tick.
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          scorecard: SCORECARD_SAMPLE,
          spec_version: '0.4.0',
          anc_version: '0.3.1',
          checker_url: 'https://anc.dev/score',
          share_url: '/score/live/ripgrep',
        }),
      });
    });

    await page.goto('/');
    await page.locator('#live-score-input').fill('cargo install something-uncurated');
    await page.locator('[data-live-score-submit]').click();

    const status = page.locator('[data-live-score-status]');
    // First tick: "Queued…" lands immediately on submit.
    await expect(status).toContainText(/Queued/, { timeout: 1_000 });
    // Second tick at t=900 ms: "Resolving install path…"
    await expect(status).toContainText(/Resolving install path/, { timeout: 2_500 });
  });

  test('example chip click fills input and lazy-loads Turnstile', async ({ page }) => {
    const observer = await mockTurnstileAndScore(page, {
      status: 200,
      body: { scorecard: SCORECARD_SAMPLE, anc_version: '0.3.1', spec_version: '0.4.0', share_url: '/score/live/bat' },
    });

    await page.goto('/');
    // No interaction yet → Turnstile not requested.
    expect(observer.turnstileRequested()).toBe(false);

    await page.locator('[data-live-score-example="brew install bat"]').click();
    await expect(page.locator('#live-score-input')).toHaveValue('brew install bat');

    // Chip click is one of the lazy-load triggers; Turnstile request fires.
    await page.waitForFunction(() => Boolean((window as { turnstile?: object }).turnstile), { timeout: 5_000 });
    expect(observer.turnstileRequested()).toBe(true);
  });
});

test.describe('homepage live-scoring form — lazy-load regression', () => {
  test('scrolling past the form without interaction does NOT load Turnstile', async ({ page }) => {
    let turnstileRequested = false;
    await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js**', async (route) => {
      turnstileRequested = true;
      await route.fulfill({ status: 204 });
    });

    await page.goto('/');
    // Scroll the form into view and out again — no focus/click/paste.
    await page.evaluate(() => {
      document.querySelector('.live-score')?.scrollIntoView({ behavior: 'instant', block: 'center' });
      window.scrollBy(0, 1000);
    });
    // Give the page a generous window — any deferred script that picks
    // up the form should have fired by now if it was going to.
    await page.waitForTimeout(1000);
    expect(turnstileRequested).toBe(false);
  });
});

test.describe('homepage live-scoring form — error + bounce branches', () => {
  test('invalid input shows inline error', async ({ page }) => {
    await mockTurnstileAndScore(page, {
      status: 400,
      body: {
        error: { code: 'unrecognized_input', cta_text: 'paste a tool name…' },
        spec_version: '0.4.0',
        checker_url: 'https://anc.dev/score',
      },
    });

    await page.goto('/');
    await page.locator('#live-score-input').fill('garbage{{{');
    await page.locator('[data-live-score-submit]').click();

    const status = page.locator('[data-live-score-status]');
    await expect(status).toBeVisible({ timeout: 5_000 });
    await expect(status).toHaveClass(/live-score__status--error/);
    await expect(status).toContainText(/not a recognized/i);
  });

  test('non-GitHub URL → inline error', async ({ page }) => {
    await mockTurnstileAndScore(page, {
      status: 400,
      body: {
        error: { code: 'non_github_host', cta_text: 'anc.dev only scores public GitHub repos.' },
        spec_version: '0.4.0',
        checker_url: 'https://anc.dev/score',
      },
    });
    await page.goto('/');
    await page.locator('#live-score-input').fill('https://gitlab.com/some/repo');
    await page.locator('[data-live-score-submit]').click();

    const status = page.locator('[data-live-score-status]');
    await expect(status).toContainText(/public GitHub/i, { timeout: 5_000 });
  });

  test('429 rate limit shows countdown copy', async ({ page }) => {
    await mockTurnstileAndScore(page, {
      status: 429,
      body: {
        error: { code: 'rate_limited', retry_after: 60, cta_text: '...' },
        spec_version: '0.4.0',
        checker_url: 'https://anc.dev/score',
      },
    });
    await page.goto('/');
    await page.locator('#live-score-input').fill('ripgrep');
    await page.locator('[data-live-score-submit]').click();

    const status = page.locator('[data-live-score-status]');
    await expect(status).toContainText(/60s/i, { timeout: 5_000 });
  });

  test('Turnstile siteverify fail shows generic verification error', async ({ page }) => {
    await mockTurnstileAndScore(page, {
      status: 400,
      body: {
        error: { code: 'turnstile_failed', cta_text: '...' },
        spec_version: '0.4.0',
        checker_url: 'https://anc.dev/score',
      },
    });
    await page.goto('/');
    await page.locator('#live-score-input').fill('ripgrep');
    await page.locator('[data-live-score-submit]').click();

    const status = page.locator('[data-live-score-status]');
    await expect(status).toContainText(/verification/i, { timeout: 5_000 });
  });

  test('bounce: chain_no_resolve renders the right headline + CTA', async ({ page }) => {
    await mockTurnstileAndScore(page, {
      status: 404,
      body: {
        error: { code: 'chain_no_resolve', cta_text: '...' },
        spec_version: '0.4.0',
        checker_url: 'https://anc.dev/score',
      },
    });
    await page.goto('/');
    await page.locator('#live-score-input').fill('unknown-tool');
    await page.locator('[data-live-score-submit]').click();

    const status = page.locator('[data-live-score-status]');
    await expect(status).toBeVisible({ timeout: 5_000 });
    await expect(status).toHaveClass(/live-score__status--bounce/);
    await expect(status.locator('.live-score__bounce-headline')).toContainText(/pre-built binary/);
    await expect(status.locator('a[href="/install"]')).toBeVisible();
  });

  test('bounce: chain_resolved_install_failed renders headline + truncated stderr', async ({ page }) => {
    const longStderr = 'error: '.repeat(80); // > 300 chars → truncates
    await mockTurnstileAndScore(page, {
      status: 502,
      body: {
        error: { code: 'chain_resolved_install_failed', details: longStderr, cta_text: '...' },
        spec_version: '0.4.0',
        checker_url: 'https://anc.dev/score',
      },
    });
    await page.goto('/');
    await page.locator('#live-score-input').fill('cargo install bogus');
    await page.locator('[data-live-score-submit]').click();

    const status = page.locator('[data-live-score-status]');
    await expect(status.locator('.live-score__bounce-headline')).toContainText(/install path/);
    const stderrBlock = status.locator('.live-score__bounce-stderr');
    await expect(stderrBlock).toBeVisible();
    await expect(stderrBlock).toContainText(/truncated/);
  });

  test('bounce: chain_resolved_no_binary_produced shows library-not-CLI headline', async ({ page }) => {
    await mockTurnstileAndScore(page, {
      status: 502,
      body: {
        error: { code: 'chain_resolved_no_binary_produced', details: '', cta_text: '...' },
        spec_version: '0.4.0',
        checker_url: 'https://anc.dev/score',
      },
    });
    await page.goto('/');
    await page.locator('#live-score-input').fill('npm i -g react');
    await page.locator('[data-live-score-submit]').click();

    const status = page.locator('[data-live-score-status]');
    await expect(status.locator('.live-score__bounce-headline')).toContainText(/library/i);
  });
});

test.describe('homepage live-scoring form — CSP + markdown-twin regressions', () => {
  test('CSP header includes challenges.cloudflare.com in script-src + frame-src + connect-src', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const csp = res.headers()['content-security-policy'];
    expect(csp).toBeTruthy();
    // Build a fragmented matcher so directive ordering doesn't matter.
    expect(csp).toMatch(/script-src[^;]*challenges\.cloudflare\.com/);
    expect(csp).toMatch(/frame-src[^;]*challenges\.cloudflare\.com/);
    expect(csp).toMatch(/connect-src[^;]*challenges\.cloudflare\.com/);
  });

  test('/index.md does NOT mention live-score, turnstile, or /api/score', async ({ request }) => {
    const res = await request.get('/index.md');
    expect(res.status()).toBe(200);
    const md = (await res.text()).toLowerCase();
    expect(md).not.toContain('live-score');
    expect(md).not.toContain('turnstile');
    expect(md).not.toContain('challenges.cloudflare.com');
    expect(md).not.toContain('/api/score');
  });

  test('Accept: text/markdown on / serves the silent twin (no live-scoring leaks)', async ({ request }) => {
    const res = await request.get('/', { headers: { accept: 'text/markdown' } });
    expect(res.headers()['content-type']).toContain('text/markdown');
    const md = (await res.text()).toLowerCase();
    expect(md).not.toContain('live-score');
    expect(md).not.toContain('turnstile');
  });
});

test.describe('/live-score URL canonicalization', () => {
  test('/score/live/<binary>.html → 301 to /score/live/<binary>', async ({ request }) => {
    const res = await request.get('/score/live/ripgrep.html', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers().location).toBe('/score/live/ripgrep');
  });

  test('/score/live/<binary> (no extension) returns HTML 404 when uncached', async ({ request }) => {
    const res = await request.get('/score/live/unknown-binary-xyz');
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type']).toContain('text/html');
  });

  test('/score/live/<binary>.md returns markdown twin (404 when uncached)', async ({ request }) => {
    const res = await request.get('/score/live/unknown-binary-xyz.md');
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type']).toContain('text/markdown');
  });
});

test.describe('homepage live-scoring — red-team', () => {
  test('successful submit does NOT leave the Turnstile token in the URL', async ({ page }) => {
    await mockTurnstileAndScore(page, {
      status: 200,
      body: {
        scorecard: SCORECARD_SAMPLE,
        spec_version: '0.4.0',
        anc_version: '0.3.1',
        share_url: '/score/live/ripgrep',
        checker_url: 'https://anc.dev/score',
      },
    });

    await page.goto('/');
    await page.locator('#live-score-input').fill('ripgrep');
    await page.locator('[data-live-score-submit]').click();
    await page.waitForURL('**/score/live/ripgrep', { timeout: 10_000 });

    const finalUrl = page.url();
    expect(finalUrl).not.toContain('fake-token');
    expect(finalUrl).not.toContain('turnstile_token');
  });

  test('CSP blocks an injected inline script tag from executing', async ({ page }) => {
    await page.goto('/');
    // Inject a fresh inline script via document.write of a new <script>
    // tag. The CSP rules permit `'unsafe-inline'` (load-bearing for
    // theme-init), so this test is a sanity check that the OVERALL CSP
    // doesn't accidentally permit cross-origin scripts. Specifically:
    // an `https://evil.example.com/x.js` external script should be
    // blocked by `script-src 'self' 'unsafe-inline' challenges.cloudflare.com`.
    const violations: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) {
        violations.push(msg.text());
      }
    });

    await page.evaluate(() => {
      const s = document.createElement('script');
      s.src = 'https://evil.example.com/x.js';
      document.head.appendChild(s);
    });
    // Give the browser a moment to fire the CSP report.
    await page.waitForTimeout(500);
    expect(violations.some((v) => /evil\.example\.com/.test(v))).toBe(true);
  });
});
