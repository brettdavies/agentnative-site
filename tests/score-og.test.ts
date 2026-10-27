// Scorecard card: the cache key, the lockup fallbacks, and a real 1200×630 PNG.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  brandName,
  cliOgIdentity,
  fitName,
  logoCandidatesFromHtml,
  renderScoreOgSvg,
  type ScoreOgCard,
  scoreOgAlt,
  scoreOgKey,
  scoreOgPath,
  scoreOgUrl,
  wordmarkInitials,
} from '../src/shared/score-og';
import { MIN_RASTER_PX, rasterSize, resolveLogo } from '../src/worker/og/logo';
import { rasterizeSvgLogo, renderScoreOgPng, type ScoreOgFonts } from '../src/worker/og/render';

const FONT_DIR = new URL('../src/worker/og/fonts/', import.meta.url);

async function fonts(): Promise<ScoreOgFonts> {
  const [regular, bold, mono] = await Promise.all([
    readFile(new URL('uncut-sans-600.ttf', FONT_DIR)),
    readFile(new URL('uncut-sans-700.ttf', FONT_DIR)),
    readFile(new URL('monaspace-xenon-500.otf', FONT_DIR)),
  ]);
  return [new Uint8Array(regular), new Uint8Array(bold), new Uint8Array(mono)];
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect(bytes[0]).toBe(0x89);
  expect(bytes[1]).toBe(0x50);
  expect(bytes[2]).toBe(0x4e);
  expect(bytes[3]).toBe(0x47);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const CARD: ScoreOgCard = {
  name: 'Railway',
  subtitle: 'railway.com',
  lane: 'web',
  scorePct: 80,
  pending: false,
  specVersion: '0.6.0',
  logo: null,
};

describe('scorecard OG key', () => {
  test('the key changes when the rounded score or the spec changes, and zero is a score', () => {
    expect(scoreOgKey({ scorePct: 80.4, specVersion: '0.6.0' })).toBe('s80-v0.6.0');
    expect(scoreOgKey({ scorePct: 79.5, specVersion: '0.6.0' })).toBe('s80-v0.6.0');
    expect(scoreOgKey({ scorePct: 80, specVersion: '0.7.0' })).toBe('s80-v0.7.0');
    expect(scoreOgKey({ scorePct: 0, specVersion: '0.6.0' })).toBe('s0-v0.6.0');
    expect(scoreOgPath('railway.com', 's80-v0.6.0')).toBe('/og/score/railway.com/s80-v0.6.0.png');
    expect(scoreOgUrl('https://anc.dev', 'owner/repo@branch', 's80-v0.6.0')).toBe(
      'https://anc.dev/og/score/owner/repo@branch/s80-v0.6.0.png',
    );
  });

  test('pending wins, and a missing or out-of-range percent is unscored', () => {
    expect(scoreOgKey({ scorePct: 80, specVersion: '0.6.0', pending: true })).toBe('pending');
    expect(scoreOgKey({ scorePct: null, specVersion: '0.6.0' })).toBe('unscored');
    expect(scoreOgKey({ scorePct: Number.NaN, specVersion: '0.6.0' })).toBe('unscored');
    expect(scoreOgKey({ scorePct: 140, specVersion: '0.6.0' })).toBe('unscored');
  });
});

describe('lockup fallbacks', () => {
  test('an apex domain becomes a brand, a seed label wins, and a CLI slug beats the binary', () => {
    expect(brandName('railway.com', null)).toEqual({ name: 'Railway', subtitle: 'railway.com' });
    expect(brandName('railway.com', 'Railway')).toEqual({ name: 'Railway', subtitle: 'railway.com' });
    expect(brandName('news.ycombinator.com', null)).toEqual({ name: 'news.ycombinator.com', subtitle: null });
    expect(brandName('anc.dev', null)).toEqual({ name: 'Anc', subtitle: 'anc.dev' });
    expect(cliOgIdentity('ripgrep', { name: 'rg', binary: 'rg' }, 'ripgrep')).toEqual({
      name: 'ripgrep',
      subtitle: 'rg',
    });
    expect(wordmarkInitials('ripgrep')).toBe('RI');
    expect(wordmarkInitials('sqlite-utils')).toBe('SU');
  });

  test('a long name shrinks, then ellipsizes, and a subtitle is capped', () => {
    const fitted = fitName('internationalized-software-foundation-registry');
    expect(fitted.fontSize).toBeLessThan(68);
    expect(fitted.text.endsWith('…')).toBe(true);
    expect(fitted.text.length).toBeLessThan(50);
  });

  test('icon candidates prefer an apple touch icon over a favicon and og:image', () => {
    const html = `<html><head>
      <link rel="icon" href="/favicon.ico" sizes="32x32" />
      <link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32" />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />
      <meta property="og:image" content="https://cdn.example/card.png" />
    </head></html>`;
    const urls = logoCandidatesFromHtml(html, 'https://railway.com/docs');
    expect(urls[0]).toBe('https://railway.com/apple-touch-icon.png');
    expect(urls.indexOf('https://railway.com/favicon-32.png')).toBeLessThan(
      urls.indexOf('https://cdn.example/card.png'),
    );
    expect(urls.indexOf('https://cdn.example/card.png')).toBeLessThan(urls.indexOf('https://railway.com/favicon.ico'));
  });
});

const TINY_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (char) => char.charCodeAt(0),
);

/** A real PNG of the given square size. */
async function iconPng(size: number): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = await sharp({ create: { width: size, height: size, channels: 4, background: '#2f6fed' } })
    .png()
    .toBuffer();
  return Uint8Array.from(buffer);
}

describe('logo fetch', () => {
  test('a homepage larger than the read cap still yields the icon in its head', async () => {
    const icon = await iconPng(MIN_RASTER_PX);
    const html = `<html><head><link rel="apple-touch-icon" href="/apple.png"></head><body>${'x'.repeat(250_000)}</body></html>`;
    const logo = await resolveLogo({
      pages: ['https://example.com/'],
      fonts: await fonts(),
      fetchImpl: async (url) => {
        const target = String(url);
        if (target === 'https://example.com/') {
          return new Response(html, {
            headers: { 'content-type': 'text/html', 'content-length': String(html.length) },
          });
        }
        if (target === 'https://example.com/apple.png') {
          return new Response(icon, { headers: { 'content-type': 'image/png' } });
        }
        return new Response('no', { status: 404 });
      },
    });
    expect(logo?.mime).toBe('image/png');
    expect(logo?.bytes.byteLength).toBe(icon.byteLength);
  });

  test('an icon smaller than the tile on either side is skipped', async () => {
    const html = '<html><head><link rel="apple-touch-icon" href="/apple.png"></head></html>';
    const fetchImpl = async (url: string | URL | Request) => {
      const target = String(url);
      if (target === 'https://example.com/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      if (target === 'https://example.com/apple.png') {
        return new Response(TINY_PNG, { headers: { 'content-type': 'image/png' } });
      }
      return new Response('no', { status: 404 });
    };
    expect(rasterSize(TINY_PNG)).toEqual({ width: 1, height: 1 });
    expect(await resolveLogo({ pages: ['https://example.com/'], fonts: await fonts(), fetchImpl })).toBeNull();
  });
});

describe('card svg and png', () => {
  test('the svg names the score, draws the ANC mark, and uses a wordmark when there is no logo', () => {
    const svg = renderScoreOgSvg(CARD);
    expect(svg).toContain('>80%<');
    expect(svg).toContain('Railway');
    expect(svg).toContain('railway.com');
    expect(svg).toContain('<polyline points="9,10 15,16 9,22"/>');
    expect(svg).not.toContain('<image ');
    expect(svg).toContain('>RA<');
    const pending = renderScoreOgSvg({ ...CARD, scorePct: null, pending: true });
    expect(pending).toContain('>Pending<');
    expect(pending).not.toContain('%');
    expect(scoreOgAlt({ name: 'Railway', lane: 'web', scorePct: 80 })).toBe(
      'Railway scored 80%. agent-readiness audit on anc.dev.',
    );
  });

  test('a logo is embedded as a data uri and both cards rasterize to 1200×630', async () => {
    const face = await fonts();
    const logoSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#e11"/></svg>';
    const logo = await rasterizeSvgLogo(logoSvg, face);
    expect(logo).not.toBeNull();
    const withLogo = renderScoreOgSvg({ ...CARD, logo });
    expect(withLogo).toContain('data:image/png;base64,');
    const bare = pngSize(await renderScoreOgPng(CARD, face));
    const marked = pngSize(await renderScoreOgPng({ ...CARD, logo }, face));
    expect(bare).toEqual({ width: 1200, height: 630 });
    expect(marked).toEqual({ width: 1200, height: 630 });
  });
});
