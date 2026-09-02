// Human critical-path flows from the eng review test plan.
// Exercises interactions: theme toggle persistence, copy-to-clipboard,
// anchor navigation, skip-link, keyboard-only nav, mobile layout.

import { expect, type Page, test } from '@playwright/test';
import { checkA11y, injectAxe } from 'axe-playwright';

// A bare overflow delta names no culprit, and these assertions have failed on
// the Linux CI runner against layouts that measure clean on a developer
// machine. Collect the elements whose right edge clears the client box and
// that no ancestor clips: those are the ones actually widening the document,
// and their identity is what the failure message has to carry.
async function measureOverflow(page: Page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const clientWidth = de.clientWidth;
    const offenders: string[] = [];
    for (const el of document.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.right <= clientWidth + 0.5) continue;
      let clipped = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;
      const name =
        typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
      offenders.push(`${el.tagName.toLowerCase()}${name}@${Math.round(rect.right)}`);
    }
    return {
      overflow: de.scrollWidth - clientWidth,
      clientWidth,
      scrollWidth: de.scrollWidth,
      offenders: offenders.slice(0, 6),
    };
  });
}

const overflowDetail = (m: Awaited<ReturnType<typeof measureOverflow>>) =>
  `client=${m.clientWidth} scroll=${m.scrollWidth} unclipped=[${m.offenders.join(', ') || 'none'}]`;

test.describe('cold HN land → browse principles → theme dark → reload still dark', () => {
  test('landing on / shows hero + spec index with 8 principle rows', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.hero__title')).toBeVisible();
    const entries = page.locator('.spec[data-s="cli"] .spec__row');
    await expect(entries).toHaveCount(8);
  });

  test('clicking a principle row navigates to its detail page', async ({ page }) => {
    await page.goto('/');
    await page.locator('.spec__title[href="/p3"]').click();
    await expect(page).toHaveURL(/\/p3$/);
    await expect(page.locator('h1')).toContainText('Progressive Help Discovery');
  });

  test('theme button toggles to the opposite of OS preference and persists across reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    const btn = page.locator('[data-theme-cycle]').first();
    // Unset → follows OS (light). One click pins dark.
    await expect(btn).toHaveAttribute('data-theme-choice', 'light');
    await btn.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('[data-theme-cycle]').first()).toHaveAttribute('data-theme-choice', 'dark');
  });

  test('second click swaps back to light (no system stop in the cycle)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    const btn = page.locator('[data-theme-cycle]').first();
    await btn.click(); // → dark
    await btn.click(); // → light
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(btn).toHaveAttribute('data-theme-choice', 'light');
  });
});

test.describe('privacy posture page', () => {
  test('/privacy renders the posture article', async ({ page }) => {
    await page.goto('/privacy');
    await expect(page.locator('h1')).toContainText('Privacy');
    await expect(page.locator('article.doc')).toBeVisible();
  });

  test('/privacy.md serves the markdown twin', async ({ request }) => {
    const res = await request.get('/privacy.md');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/markdown');
    expect(await res.text()).toContain('# Privacy');
  });
});

test.describe('keyboard + a11y', () => {
  test('skip-link is the first focusable and jumps to #main', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toHaveAttribute('href', '#main');
  });

  // color-contrast is intentionally disabled: axe-core 4.11.2 misresolves
  // CSS variables defined as oklch() through our :root + data-theme cascade
  // (foundation.css), reporting wildly incorrect foreground colors (e.g.
  // #f3f4f6 for what is actually oklch(0.46 0.015 250) → #525960). The
  // rendered colors pass both WCAG 2.1 AA and APCA Lc ≥ 60 — see the
  // self-verification table in docs/research/design/color-analysis.md (regenerated by
  // scripts/design/generate-palette.mjs whenever the palette changes). All
  // other axe rules under wcag2a/wcag2aa remain enabled and gate this PR.
  const AXE_OPTS = {
    detailedReport: false,
    axeOptions: {
      runOnly: { type: 'tag' as const, values: ['wcag2a', 'wcag2aa'] },
      rules: { 'color-contrast': { enabled: false } },
    },
  };

  test('axe: 0 serious/critical violations on /', async ({ page }) => {
    await page.goto('/');
    await injectAxe(page);
    await checkA11y(page, undefined, AXE_OPTS);
  });

  test('axe: 0 serious/critical violations on /p1', async ({ page }) => {
    await page.goto('/p1');
    await injectAxe(page);
    await checkA11y(page, undefined, AXE_OPTS);
  });

  test('axe: 0 serious/critical violations on / in dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await injectAxe(page);
    await checkA11y(page, undefined, AXE_OPTS);
  });

  test('axe: 0 serious/critical violations on /p1 in dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/p1');
    await injectAxe(page);
    await checkA11y(page, undefined, AXE_OPTS);
  });

  // One representative page per remaining archetype, light and dark.
  // /web renders Worker-side from the R2 aggregate; against the local
  // wrangler-dev server (empty R2) it exercises the scoring-in-progress
  // empty state. The populated result-page archetype is covered by the
  // staging-targeting web-audit project.
  for (const path of ['/score/ripgrep', '/web', '/scorecards', '/web-audit']) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`axe: 0 serious/critical violations on ${path} in ${scheme} mode`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(path);
        await injectAxe(page);
        await checkA11y(page, undefined, AXE_OPTS);
      });
    }
  }

  test('no horizontal overflow at 390/768/1440 on each archetype', async ({ page }) => {
    for (const path of ['/p1', '/score/ripgrep', '/scorecards', '/web', '/web-audit', '/install']) {
      for (const width of [390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        const m = await measureOverflow(page);
        expect(m.overflow, `overflow on ${path} at ${width}px — ${overflowDetail(m)}`).toBeLessThanOrEqual(0);
      }
    }
  });
});

test.describe('code-copy + anchor-copy', () => {
  // WebKit does not expose clipboard-read / clipboard-write as grantable
  // permissions, so the Clipboard-API assertions can't run there. Real
  // iOS / iPadOS Safari users still hit the `execCommand('copy')` fallback
  // path in src/client/clipboard.ts — Chromium covers the primary path.
  test('copy button on <pre> writes code to clipboard', async ({ page, context, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit does not support clipboard permission grants');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // /audit has 4 code blocks. /p3 has none (no shell snippets in p3 prose).
    await page.goto('/audit');
    // The copy button is injected by src/client/clipboard.ts: each <pre> is
    // wrapped in <div class="code-wrap"> and the <button class="copy-button">
    // is appended to the wrap as a SIBLING of <pre> (not a child). Visibility
    // is gated by `:root.js main .code-wrap .copy-button { display: inline-flex }`,
    // so we wait for the .js root class added by theme-init.ts before locating.
    await page.locator('html.js').waitFor();
    const button = page.locator('main .code-wrap .copy-button').first();
    await expect(button.locator('.copy-button__icon svg')).toHaveCount(1);
    await expect(button).toHaveAttribute('aria-label', 'Copy code');
    await button.scrollIntoViewIfNeeded();
    await button.click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.length).toBeGreaterThan(0);
    await expect(button).toHaveAttribute('data-copy-state', 'copied');
    await expect(button).not.toHaveAttribute('data-copy-state', 'copied', { timeout: 3000 });
    await expect(button.locator('.copy-button__icon svg')).toHaveCount(1);
  });

  test('anchor permalink copies canonical URL and updates the hash', async ({ page, context, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit does not support clipboard permission grants');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/p3');
    const anchor = page.locator('h1 a.anchor').first();
    await anchor.click();
    await expect(page).toHaveURL(/#p3-progressive-help-discovery$/);
  });

  // Regression guard for #015: heading-anchor chain icon must return after
  // the "Copied" label fades, so deep-link copy works on every click — not
  // just the first one per page load.
  test('heading anchor restores chain svg after Copied flash and supports repeat clicks', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'WebKit does not support clipboard permission grants');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/p3');
    const anchor = page.locator('h1 a.anchor').first();
    await expect(anchor.locator('svg')).toHaveCount(1);

    await anchor.click();
    await expect(anchor).toHaveAttribute('data-copy-state', 'copied');
    const firstWrite = await page.evaluate(() => navigator.clipboard.readText());
    expect(firstWrite).toMatch(/#p3-progressive-help-discovery$/);

    // Wait past the 1500ms COPIED_MS fade plus a small buffer.
    await expect(anchor).not.toHaveAttribute('data-copy-state', 'copied', { timeout: 3000 });
    await expect(anchor.locator('svg')).toHaveCount(1);

    // Second click must produce another flash and clipboard write.
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await anchor.click();
    await expect(anchor).toHaveAttribute('data-copy-state', 'copied');
    const secondWrite = await page.evaluate(() => navigator.clipboard.readText());
    expect(secondWrite).toMatch(/#p3-progressive-help-discovery$/);
    await expect(anchor).not.toHaveAttribute('data-copy-state', 'copied', { timeout: 3000 });
    await expect(anchor.locator('svg')).toHaveCount(1);
  });
});

// Below the shell's desktop breakpoint the inline .site-nav collapses behind
// the hamburger, so every `[data-*-nav]:visible` assertion resolves to zero
// elements. The mobile and tablet projects otherwise inherit a device viewport
// on the wrong side of that breakpoint, so tests asserting which surface twin
// is displayed pin a width where the links are laid out inline. What they are
// checking is the stored surface preference, not the responsive layout.
const DESKTOP_NAV_VIEWPORT = { width: 1280, height: 900 };

test.describe('homepage surface toggle (CLI ⇆ Web)', () => {
  test('default (CLI) shows the CLI board, 8 principles, and the Score form', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.board[data-s="cli"]')).toBeVisible();
    await expect(page.locator('.board[data-s="web"]')).toBeHidden();
    await expect(page.locator('.spec[data-s="cli"] .spec__row')).toHaveCount(8);
    await expect(page.locator('.spec[data-s="web"]')).toBeHidden();
    await expect(page.locator('form[data-live-score-form]')).toBeVisible();
    await expect(page.locator('.hero__proof > [data-s="cli"]')).toBeVisible();
    await expect(page.locator('.hero__proof > [data-s="web"]')).toBeHidden();
    // Board rows are threaded from the computed leaderboard — non-empty,
    // each with a meter.
    const rows = page.locator('.board[data-s="cli"] .lrow');
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(rows.first().locator('.meter')).toBeVisible();
  });

  test('activating the Website radio swaps board, spec index, hero, and input together (no JS)', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto('/');
    // CLI is the no-JS default.
    await expect(page.locator('.board[data-s="cli"]')).toBeVisible();
    await expect(page.locator('.hero__proof > [data-s="cli"]')).toBeVisible();

    await page.locator('label[for="s-web"]').click();
    await expect(page.locator('.board[data-s="web"]')).toBeVisible();
    await expect(page.locator('.board[data-s="cli"]')).toBeHidden();
    await expect(page.locator('.spec[data-s="web"] .spec__row')).toHaveCount(6);
    await expect(page.locator('.spec[data-s="cli"]')).toBeHidden();
    await expect(page.locator('form[data-s="web"] input[name="url"]')).toBeVisible();
    await expect(page.locator('form[data-live-score-form]')).toBeHidden();
    await expect(page.locator('.hero__proof > [data-s="web"]')).toBeVisible();
    await expect(page.locator('.hero__proof > [data-s="cli"]')).toBeHidden();
    await expect(page.locator('.hero__proof > [data-s="web"]')).toContainText('anc.dev');
    await ctx.close();
  });

  test('principle row links to its detail page', async ({ page }) => {
    await page.goto('/');
    await page.locator('.spec__title[href="/p5"]').click();
    await expect(page).toHaveURL(/\/p5$/);
    await expect(page.locator('h1')).toContainText('Safe Retries');
  });

  test('/p3 renders the reading treatment: tier tag, requirement groups, pager', async ({ page }) => {
    await page.goto('/p3');
    await expect(page.locator('.doc__head .doc__num')).toHaveText('P3');
    await expect(page.locator('.doc__head .tier')).toHaveText('MUST');
    const groups = page.locator('.normative');
    expect(await groups.count()).toBeGreaterThan(0);
    // Full borders / bg tints, never a side-stripe.
    const borders = await groups.first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { left: s.borderLeftWidth, right: s.borderRightWidth, top: s.borderTopWidth };
    });
    expect(borders.left).toBe(borders.right);
    expect(borders.left).toBe(borders.top);
    await expect(page.locator('.audit-note')).toBeVisible();
    // Pager navigates to the neighbor principle.
    await page.locator('.pager .next').click();
    await expect(page).toHaveURL(/\/p4$/);
  });

  test('no horizontal overflow at 390 / 768 / 1440', async ({ page }) => {
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const m = await measureOverflow(page);
      expect(m.overflow, `overflow at ${width}px — ${overflowDetail(m)}`).toBeLessThanOrEqual(0);
    }
  });

  test('selecting Website updates visible Leaderboards href in header', async ({ page }) => {
    await page.setViewportSize(DESKTOP_NAV_VIEWPORT);
    await page.goto('/');
    const nav = page.locator('.site-nav');
    await expect(nav.locator('[data-leaderboards-nav]:visible')).toHaveAttribute('href', '/scorecards');
    await expect(nav.locator('[data-audit-nav]:visible')).toHaveAttribute('href', '/audit');
    await page.locator('label[for="s-web"]').click();
    await expect(nav.locator('[data-leaderboards-nav]:visible')).toHaveAttribute('href', '/web');
    await expect(nav.locator('[data-audit-nav]:visible')).toHaveAttribute('href', '/web-audit');
    await page.reload();
    await expect(nav.locator('[data-leaderboards-nav]:visible')).toHaveAttribute('href', '/web');
    await expect(nav.locator('[data-audit-nav]:visible')).toHaveAttribute('href', '/web-audit');
    await expect(page.locator('#s-web')).toBeChecked();
  });

  test('no-JS: visible Leaderboards href follows homepage segment', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: DESKTOP_NAV_VIEWPORT });
    const page = await ctx.newPage();
    await page.goto('/');
    const nav = page.locator('.site-nav');
    await expect(nav.locator('[data-leaderboards-nav]:visible')).toHaveAttribute('href', '/scorecards');
    await expect(nav.locator('[data-audit-nav]:visible')).toHaveAttribute('href', '/audit');
    await page.locator('label[for="s-web"]').click();
    await expect(nav.locator('[data-leaderboards-nav]:visible')).toHaveAttribute('href', '/web');
    await expect(nav.locator('[data-audit-nav]:visible')).toHaveAttribute('href', '/web-audit');
    await ctx.close();
  });
});

// Every NAV_LINKS entry in src/build/shell.mjs renders one anchor, except
// the dual-surface entries (Leaderboards, Audit), which each emit a CLI and
// a Website twin and display only the one matching the active surface. So a
// new dual-surface entry raises the anchor total without raising the visible
// count — the two numbers move independently and must not be bumped together.
const NAV_ENTRIES = 6;
const DUAL_SURFACE_NAV_ENTRIES = 2;
const NAV_ANCHORS = NAV_ENTRIES + DUAL_SURFACE_NAV_ENTRIES;

test.describe('shell — grouped nav, hamburger, footer rows', () => {
  test('desktop (1440): grouped nav links inline, hamburger hidden, footer rows present', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav).toBeVisible();
    await expect(nav.locator('a')).toHaveCount(NAV_ANCHORS);
    await expect(nav.locator('a:visible')).toHaveCount(NAV_ENTRIES);
    await expect(nav.locator('[data-leaderboards-nav]:visible')).toHaveCount(1);
    await expect(nav.locator('[data-audit-nav]:visible')).toHaveCount(1);
    await expect(page.locator('.nav-burger')).toBeHidden();
    await expect(page.locator('.site-footer__source')).toBeVisible();
    await expect(page.locator('.site-footer__meta')).toBeVisible();
  });

  for (const width of [1100, 1180, 1280] as const) {
    test(`laptop (${width}): full nav inline, hamburger hidden, no header overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const nav = page.getByRole('navigation', { name: 'Primary' });
      await expect(nav).toBeVisible();
      await expect(nav.locator('a')).toHaveCount(NAV_ANCHORS);
      await expect(nav.locator('a:visible')).toHaveCount(NAV_ENTRIES);
      await expect(nav.locator('[data-leaderboards-nav]:visible')).toHaveCount(1);
      await expect(nav.locator('[data-audit-nav]:visible')).toHaveCount(1);
      await expect(page.locator('.nav-burger')).toBeHidden();

      const overflow = await page.evaluate(() => {
        const row = document.querySelector('.site-header__row');
        if (!row) return { ok: false, reason: 'missing row' };
        const style = getComputedStyle(row);
        const navEl = document.querySelector('.site-nav');
        const burger = document.querySelector('.nav-burger');
        const links = [...(navEl?.querySelectorAll('a') ?? [])].map((a) => ({
          text: a.textContent?.trim() ?? '',
          visible: (a as HTMLElement).offsetParent !== null && getComputedStyle(a).display !== 'none',
        }));
        return {
          ok: true,
          rowWidth: row.clientWidth,
          scrollWidth: row.scrollWidth,
          overflows: row.scrollWidth > row.clientWidth + 1,
          flexWrap: style.flexWrap,
          burgerDisplay: burger ? getComputedStyle(burger).display : null,
          navDisplay: navEl ? getComputedStyle(navEl).display : null,
          links,
          tagVisible: getComputedStyle(document.querySelector('.site-brand__tag')!).display !== 'none',
        };
      });
      expect(overflow.ok).toBe(true);
      expect(overflow.overflows).toBe(false);
      expect(overflow.burgerDisplay).toBe('none');
      expect(overflow.navDisplay).toBe('flex');
      expect(overflow.links).toBeDefined();
      expect(overflow.links!.filter((l) => l.visible).length).toBe(NAV_ENTRIES);
      expect(overflow.links!.filter((l) => !l.visible).length).toBe(DUAL_SURFACE_NAV_ENTRIES);
    });
  }

  test('tablet (1024): hamburger replaces inline nav', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
    await expect(page.locator('.nav-burger')).toBeVisible();
  });

  test('mobile (390): inline links hidden, hamburger toggles the panel by pointer', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav).toBeHidden();
    const burger = page.locator('.nav-burger');
    await expect(burger).toBeVisible();
    // 44px touch target.
    const box = await burger.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);

    await burger.click();
    await expect(nav).toBeVisible();
    await burger.click();
    await expect(nav).toBeHidden();

    await expect(page.locator('.site-footer__source')).toBeVisible();
    await expect(page.locator('.site-footer__meta')).toBeVisible();
  });

  test('mobile (390): hamburger checkbox is keyboard-operable (Space opens and closes, no JS needed)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    const cb = page.locator('.nav-burger__cb');
    await cb.focus();
    await page.keyboard.press('Space');
    await expect(nav).toBeVisible();
    // The same focusable control closes the open panel.
    await page.keyboard.press('Space');
    await expect(nav).toBeHidden();
  });

  test('mobile (390): tagline is hidden under 640px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.locator('.site-brand__tag')).toBeHidden();
  });

  test('mobile (390): Escape closes the open panel and refocuses the hamburger', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await page.locator('.nav-burger').click();
    await expect(nav).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(nav).toBeHidden();
    await expect(page.locator('.nav-burger__cb')).toBeFocused();
  });
});

test.describe('leaderboard surface nav', () => {
  test('stored web preference flips visible Leaderboards off homepage', async ({ page }) => {
    await page.setViewportSize(DESKTOP_NAV_VIEWPORT);
    await page.goto('/');
    await page.locator('label[for="s-web"]').click();
    await page.goto('/about');
    await expect(page.locator('.site-nav [data-leaderboards-nav]:visible')).toHaveAttribute('href', '/web');
  });

  test('cold /web visit does not write preference (Leaderboards stays CLI default)', async ({ page }) => {
    await page.setViewportSize(DESKTOP_NAV_VIEWPORT);
    await page.addInitScript(() => localStorage.removeItem('anc-surface'));
    await page.goto('/web');
    await expect(page.locator('.site-nav [data-leaderboards-nav]:visible')).toHaveAttribute('href', '/scorecards');
    const stored = await page.evaluate(() => localStorage.getItem('anc-surface'));
    expect(stored).toBeNull();
  });

  test('Probe A navigates CLI → Website and writes preference', async ({ page }) => {
    await page.setViewportSize(DESKTOP_NAV_VIEWPORT);
    await page.goto('/scorecards');
    await page.locator('label[for="board-s-web"]').click();
    await expect(page).toHaveURL(/\/web$/);
    expect(await page.evaluate(() => localStorage.getItem('anc-surface'))).toBe('web');
    await expect(page.locator('.site-nav [data-leaderboards-nav]:visible')).toHaveAttribute('href', '/web');
  });

  test('Probe A navigates Website → CLI and writes preference', async ({ page }) => {
    await page.goto('/');
    await page.locator('label[for="s-web"]').click();
    await page.goto('/web');
    await page.locator('label[for="board-s-cli"]').click();
    await expect(page).toHaveURL(/\/scorecards$/);
    expect(await page.evaluate(() => localStorage.getItem('anc-surface'))).toBe('cli');
  });
});

test.describe('audit surface nav', () => {
  test('stored web preference flips visible Audit off homepage', async ({ page }) => {
    await page.setViewportSize(DESKTOP_NAV_VIEWPORT);
    await page.goto('/');
    await page.locator('label[for="s-web"]').click();
    await page.goto('/about');
    await expect(page.locator('.site-nav [data-audit-nav]:visible')).toHaveAttribute('href', '/web-audit');
  });

  test('cold /web-audit visit does not write preference (Audit stays CLI default)', async ({ page }) => {
    await page.setViewportSize(DESKTOP_NAV_VIEWPORT);
    await page.addInitScript(() => localStorage.removeItem('anc-surface'));
    await page.goto('/web-audit');
    await expect(page.locator('.site-nav [data-audit-nav]:visible')).toHaveAttribute('href', '/audit');
    const stored = await page.evaluate(() => localStorage.getItem('anc-surface'));
    expect(stored).toBeNull();
  });

  test('Probe A navigates CLI audit → web audit and writes preference', async ({ page }) => {
    await page.setViewportSize(DESKTOP_NAV_VIEWPORT);
    await page.goto('/audit');
    await page.locator('label[for="audit-s-web"]').click();
    await expect(page).toHaveURL(/\/web-audit$/);
    expect(await page.evaluate(() => localStorage.getItem('anc-surface'))).toBe('web');
    await expect(page.locator('.site-nav [data-audit-nav]:visible')).toHaveAttribute('href', '/web-audit');
  });

  test('Probe A navigates web audit → CLI audit and writes preference', async ({ page }) => {
    await page.goto('/');
    await page.locator('label[for="s-web"]').click();
    await page.goto('/web-audit');
    await page.locator('label[for="audit-s-cli"]').click();
    await expect(page).toHaveURL(/\/audit$/);
    expect(await page.evaluate(() => localStorage.getItem('anc-surface'))).toBe('cli');
  });
});

test.describe('scorecard remediation copy-prompt', () => {
  test('copy prompt writes the remediation prompt to the clipboard', async ({ page, context, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit does not support clipboard permission grants');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/score/ripgrep');
    const btn = page.locator('[data-copy-prompt]').first();
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('agent-native CLI standard');
    expect(copied).toContain('Requirements: https://anc.dev/p');
  });
});

test.describe('footer AI-provider icons', () => {
  // Regression guard for #016: iOS Safari paints inline <svg> with viewBox
  // but no width/height as 0×0. Anchor stays tappable, glyph disappears.
  // The CSS rule on `.ai-summary__link svg` forces a non-zero box.
  test('every footer ai-provider icon has a non-zero rendered bounding box', async ({ page }) => {
    await page.goto('/');
    const svgs = page.locator('.ai-summary__link svg');
    await expect(svgs).toHaveCount(5);
    const count = await svgs.count();
    for (let i = 0; i < count; i++) {
      const box = await svgs.nth(i).boundingBox();
      expect(box, `provider svg #${i} has no bounding box`).not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
    }
  });
});
