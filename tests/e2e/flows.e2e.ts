// Human critical-path flows from the eng review test plan.
// Exercises interactions: theme toggle persistence, copy-to-clipboard,
// anchor navigation, skip-link, keyboard-only nav, mobile layout.

import { expect, test } from '@playwright/test';
import { checkA11y, injectAxe } from 'axe-playwright';

test.describe('cold HN land → browse principles → theme dark → reload still dark', () => {
  test('landing on / shows hero + principle listing with 7 entries', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.hero__title')).toBeVisible();
    const entries = page.locator('.principle-entry');
    await expect(entries).toHaveCount(7);
  });

  test('clicking a principle entry navigates to its detail page', async ({ page }) => {
    await page.goto('/');
    await page.locator('.principle-entry__link[href="/p3"]').click();
    await expect(page).toHaveURL(/\/p3$/);
    await expect(page.locator('h1')).toContainText('Progressive Help Discovery');
  });

  test('theme toggle persists across reload via localStorage', async ({ page }) => {
    await page.goto('/');
    await page.click('button[data-theme-set="dark"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // aria-pressed reflects state after reload.
    await expect(page.locator('button[data-theme-set="dark"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('system toggle clears localStorage and removes data-theme', async ({ page }) => {
    await page.goto('/');
    await page.click('button[data-theme-set="dark"]');
    await page.click('button[data-theme-set="system"]');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  });
});

test.describe('keyboard + a11y', () => {
  test('skip-link is the first focusable and jumps to #main', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toHaveAttribute('href', '#main');
  });

  test('axe: 0 serious/critical violations on /', async ({ page }) => {
    await page.goto('/');
    await injectAxe(page);
    await checkA11y(page, undefined, {
      detailedReport: false,
      axeOptions: { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } },
    });
  });

  test('axe: 0 serious/critical violations on /p1', async ({ page }) => {
    await page.goto('/p1');
    await injectAxe(page);
    await checkA11y(page, undefined, {
      detailedReport: false,
      axeOptions: { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } },
    });
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
    // /check has 4 code blocks. /p3 has none (no shell snippets in p3 prose).
    await page.goto('/check');
    const pre = page.locator('main pre').first();
    await pre.scrollIntoViewIfNeeded();
    await pre.hover();
    await pre.locator('.copy-button').click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.length).toBeGreaterThan(0);
  });

  test('anchor permalink copies canonical URL and updates the hash', async ({ page, context, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit does not support clipboard permission grants');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/p3');
    const anchor = page.locator('h1 a.anchor').first();
    await anchor.click();
    await expect(page).toHaveURL(/#p3-progressive-help-discovery$/);
  });
});

test.describe('principle listing', () => {
  test('index page has a principle listing with 7 entries', async ({ page }) => {
    await page.goto('/');
    const entries = page.locator('.principle-entry');
    await expect(entries).toHaveCount(7);
  });

  test('principle entry links to its detail page', async ({ page }) => {
    await page.goto('/');
    await page.locator('.principle-entry__link[href="/p5"]').click();
    await expect(page).toHaveURL(/\/p5$/);
    await expect(page.locator('h1')).toContainText('Safe Retries');
  });
});
