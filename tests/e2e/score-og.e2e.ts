// A curated scorecard's social meta points at a card route that returns a PNG.
// The absolute og:image URL is the canonical host; the request uses the path
// against this server.

import { expect, test } from '@playwright/test';

test('ripgrep scorecard meta points at a working PNG card', async ({ page, request }) => {
  await page.goto('/score/ripgrep');
  const og = await page.locator('meta[property="og:image"]').first().getAttribute('content');
  const twitter = await page.locator('meta[name="twitter:image"]').first().getAttribute('content');
  expect(og).toBeTruthy();
  expect(twitter).toBe(og);
  expect(await page.locator('meta[property="og:image:width"]').first().getAttribute('content')).toBe('1200');
  expect(await page.locator('meta[property="og:image:height"]').first().getAttribute('content')).toBe('630');
  expect(await page.locator('meta[name="twitter:card"]').first().getAttribute('content')).toBe('summary_large_image');
  expect(await page.locator('meta[property="og:title"]').first().getAttribute('content')).toContain('ripgrep');
  expect(await page.locator('meta[property="og:description"]').first().getAttribute('content')).toBeTruthy();

  const pathname = new URL(og ?? '').pathname;
  expect(pathname).toMatch(/^\/og\/score\/ripgrep\/s(?:100|[1-9]?\d)-v\d+(?:\.\d+){1,3}\.png$/);
  const image = await request.get(pathname);
  expect(image.status()).toBe(200);
  expect(image.headers()['content-type']).toContain('image/png');
  const body = await image.body();
  expect(body[0]).toBe(0x89);
  expect(body[1]).toBe(0x50);
  expect(body[2]).toBe(0x4e);
  expect(body[3]).toBe(0x47);
});
