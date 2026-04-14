// Open Graph + Twitter card metadata — verified against a rendered page.

import { expect, test } from '@playwright/test';

test('index has OG + Twitter card meta with 1200×630 image', async ({ page }) => {
  await page.goto('/');

  async function meta(name: string) {
    return page.evaluate((n) => {
      const byProperty = document.querySelector<HTMLMetaElement>(`meta[property="${n}"]`);
      if (byProperty) return byProperty.content;
      const byName = document.querySelector<HTMLMetaElement>(`meta[name="${n}"]`);
      return byName ? byName.content : null;
    }, name);
  }

  expect(await meta('og:type')).toBe('article');
  expect(await meta('og:title')).toBeTruthy();
  expect(await meta('og:description')).toBeTruthy();
  expect(await meta('og:url')).toContain('agentnative.dev');
  expect(await meta('og:image')).toContain('/og-image.png');
  expect(await meta('og:image:width')).toBe('1200');
  expect(await meta('og:image:height')).toBe('630');
  expect(await meta('og:site_name')).toBe('agentnative.dev');

  expect(await meta('twitter:card')).toBe('summary_large_image');
  expect(await meta('twitter:title')).toBeTruthy();
  expect(await meta('twitter:image')).toContain('/og-image.png');
});

test('JSON-LD TechArticle present and parses', async ({ page }) => {
  await page.goto('/');
  const raw = await page.locator('script[type="application/ld+json"]').first().textContent();
  expect(raw).toBeTruthy();
  const data = JSON.parse(raw ?? '{}');
  expect(data['@type']).toBe('TechArticle');
  expect(data.headline).toBeTruthy();
  expect(data.url).toContain('agentnative.dev');
});

test('principle pages inherit the same OG shape', async ({ page }) => {
  await page.goto('/p3');
  const ogImage = await page.locator('meta[property="og:image"]').first().getAttribute('content');
  expect(ogImage).toContain('/og-image.png');
  const width = await page.locator('meta[property="og:image:width"]').first().getAttribute('content');
  expect(width).toBe('1200');
});
