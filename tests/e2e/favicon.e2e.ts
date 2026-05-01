// Favicon link tags + asset delivery — verified against a rendered page
// AND against the running worker. The previous shape pointed `<link
// rel="icon">` at /og-image.png (a 1200×630 social card downscaled to a
// 32×32 thumbnail); this suite locks in the decoupled favicon surface
// so a future regression can't quietly re-couple them. See todo `018`.

import { expect, test } from '@playwright/test';

test('favicon link tags reference the decoupled assets', async ({ page }) => {
  await page.goto('/');

  const svg = page.locator('link[rel="icon"][type="image/svg+xml"]');
  await expect(svg).toHaveAttribute('href', '/favicon.svg');

  const png = page.locator('link[rel="icon"][type="image/png"]');
  await expect(png).toHaveAttribute('href', '/favicon-32.png');
  await expect(png).toHaveAttribute('sizes', '32x32');

  const apple = page.locator('link[rel="apple-touch-icon"]');
  await expect(apple).toHaveAttribute('href', '/apple-touch-icon-180.png');
  await expect(apple).toHaveAttribute('sizes', '180x180');

  // The OG card must NOT be referenced as a favicon source — that was the
  // smell todo `018` decoupled. If this fails, someone re-coupled them.
  const iconHrefs = await page
    .locator('link[rel~="icon"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('href')));
  expect(iconHrefs).not.toContain('/og-image.png');
});

test('favicon assets resolve with the correct MIME type', async ({ request }) => {
  const cases = [
    { path: '/favicon.svg', mime: 'image/svg+xml' },
    { path: '/favicon-32.png', mime: 'image/png' },
    { path: '/apple-touch-icon-180.png', mime: 'image/png' },
  ];

  for (const { path, mime } of cases) {
    const res = await request.get(path);
    expect(res.status(), `GET ${path}`).toBe(200);
    expect(res.headers()['content-type'], `Content-Type of ${path}`).toContain(mime);
  }
});
