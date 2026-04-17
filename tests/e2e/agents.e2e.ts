// Agent-shaped integration tests — exercise the Worker via fetch() rather
// than a rendered browser. Covers the CN decision table from a live-server
// angle (the unit tests cover the logic in isolation; this checks the
// bindings + routing end-to-end) plus the llms.txt / llms-full.txt shape
// and the Link-header advertisement.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const BASE = 'http://localhost:8787';

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

test.describe('CN decision table — live Worker', () => {
  test('GET /p3 no Accept → text/html, Link + X-Llms-Txt headers', async ({ request }) => {
    const res = await request.get(`${BASE}/p3`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    expect(res.headers()['link']).toContain('</p3.md>');
    expect(res.headers()['link']).toContain('rel="alternate"');
    expect(res.headers()['x-llms-txt']).toBe('/llms.txt');
  });

  test('GET /p3 with Accept: text/markdown → markdown body + noindex', async ({ request }) => {
    const res = await request.get(`${BASE}/p3`, { headers: { accept: 'text/markdown' } });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/markdown');
    expect(res.headers()['x-robots-tag']).toBe('noindex');
    // Worker rewrote the asset lookup to /p3.md — body should match source.
    const expected = await sha256(`${process.cwd()}/content/principles/p3-progressive-help-discovery.md`);
    const actual = createHash('sha256')
      .update(await res.text())
      .digest('hex');
    expect(actual).toBe(expected);
  });

  test('GET /p3.md returns source bytes unchanged', async ({ request }) => {
    const res = await request.get(`${BASE}/p3.md`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/markdown');
    const expected = await sha256(`${process.cwd()}/content/principles/p3-progressive-help-discovery.md`);
    const actual = createHash('sha256')
      .update(await res.text())
      .digest('hex');
    expect(actual).toBe(expected);
  });

  test('GET /p3 with q-value header → html wins', async ({ request }) => {
    const res = await request.get(`${BASE}/p3`, {
      headers: { accept: 'text/html,text/markdown;q=0.9' },
    });
    expect(res.headers()['content-type']).toContain('text/html');
  });

  test('GET / Accept: text/markdown → /index.md', async ({ request }) => {
    const res = await request.get(`${BASE}/`, { headers: { accept: 'text/markdown' } });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/markdown');
  });

  test('HEAD /p3 includes Link header', async ({ request }) => {
    const res = await request.fetch(`${BASE}/p3`, { method: 'HEAD' });
    expect(res.headers()['link']).toContain('rel="alternate"');
  });
});

test.describe('llms.txt + llms-full.txt — live', () => {
  test('/llms.txt is the llmstxt.org shape with principles and pages', async ({ request }) => {
    const res = await request.get(`${BASE}/llms.txt`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^#\s+/m);
    expect(body).toMatch(/^>\s+/m);
    expect(body).toContain('## Principles');
    const bullets = body.match(/^-\s+\[[^\]]+\]\([^)]*\/p\d+\.md\)$/gm) ?? [];
    expect(bullets.length).toBe(7);
    // Sub-pages (check, about) present under ## Pages.
    expect(body).toContain('## Pages');
    const pageLinks = body.match(/^-\s+\[[^\]]+\]\([^)]*\/(check|about)\.md\)$/gm) ?? [];
    expect(pageLinks.length).toBe(2);
  });

  test('/llms-full.txt is served in a single fetch with A5 delimiters', async ({ request }) => {
    const res = await request.get(`${BASE}/llms-full.txt`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('Source: ');
    expect(body).toContain('Canonical-Markdown: ');
    expect(body).toContain('\n---\n');
  });
});

test.describe('assets', () => {
  test('GET /fonts/uncut-sans-variable.woff2 serves as immutable', async ({ request }) => {
    const res = await request.get(`${BASE}/fonts/uncut-sans-variable.woff2`);
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toContain('immutable');
  });

  test('GET /og-image.png serves as immutable', async ({ request }) => {
    const res = await request.get(`${BASE}/og-image.png`);
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toContain('immutable');
  });

  test('GET /robots.txt is served', async ({ request }) => {
    const res = await request.get(`${BASE}/robots.txt`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('User-agent: *');
  });
});
