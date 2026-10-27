// Scorecard card: the cache key, the lockup fallbacks, and a real 1200×630 PNG.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  brandName,
  cliOgIdentity,
  fitName,
  isImmutableScoreOgKey,
  logoCandidatesFromHtml,
  parseScoreOgPath,
  renderScoreOgSvg,
  SCORE_OG_TEMPLATE,
  type ScoreOgCard,
  scoreOgAlt,
  scoreOgEdition,
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

const WEB_EDITION = scoreOgEdition({ lane: 'web', scoredAt: '2026-10-26T23:30:00.000Z' });

const CARD: ScoreOgCard = {
  name: 'Railway',
  subtitle: 'railway.com',
  lane: 'web',
  scorePct: 80,
  pending: false,
  specVersion: '0.6.0',
  edition: WEB_EDITION,
  logo: null,
};

const R = `-r${SCORE_OG_TEMPLATE}`;

function roundTrips(target: string, key: string): boolean {
  return parseScoreOgPath(scoreOgPath(target, key))?.key === key;
}

describe('scorecard OG key', () => {
  test('a web card keys on the rounded score, the spec, the UTC audit date, and the template', () => {
    expect(WEB_EDITION).toEqual({ token: 'd20261026', label: '2026-10-26' });
    const key = scoreOgKey({ scorePct: 80, specVersion: '0.6.0', edition: WEB_EDITION });
    expect(key).toBe(`s80-v0.6.0-d20261026${R}`);
    expect(scoreOgKey({ scorePct: 79.5, specVersion: '0.6.0', edition: WEB_EDITION })).toBe(key);
    expect(scoreOgKey({ scorePct: 80, specVersion: '0.7.0', edition: WEB_EDITION })).toBe(`s80-v0.7.0-d20261026${R}`);
    expect(scoreOgKey({ scorePct: 0, specVersion: '0.6.0', edition: WEB_EDITION })).toBe(`s0-v0.6.0-d20261026${R}`);
    expect(scoreOgPath('railway.com', key)).toBe(`/og/score/railway.com/${key}.png`);
    expect(scoreOgUrl('https://anc.dev', 'owner/repo@branch', key)).toBe(
      `https://anc.dev/og/score/owner/repo@branch/${key}.png`,
    );
    expect(roundTrips('railway.com', key)).toBe(true);
  });

  test('a same-score re-audit on a later date mints a new key', () => {
    const later = scoreOgEdition({ lane: 'web', scoredAt: '2026-10-27T00:00:01.000Z' });
    expect(scoreOgKey({ scorePct: 80, specVersion: '0.6.0', edition: later })).not.toBe(
      scoreOgKey({ scorePct: 80, specVersion: '0.6.0', edition: WEB_EDITION }),
    );
  });

  test('a CLI card keys on its tool version and shows it with a v', () => {
    const edition = scoreOgEdition({ lane: 'cli', toolVersion: '15.1.0' });
    expect(edition).toEqual({ token: 't15.1.0', label: 'v15.1.0' });
    expect(scoreOgEdition({ lane: 'cli', toolVersion: 'v15.1.0' })).toEqual(edition);
    expect(scoreOgKey({ scorePct: 92, specVersion: '0.6.0', edition })).toBe(`s92-v0.6.0-t15.1.0${R}`);
    expect(scoreOgEdition({ lane: 'cli', toolVersion: '1.0.0-beta.1' })).toEqual({
      token: 't1.0.0_beta.1',
      label: 'v1.0.0-beta.1',
    });
  });

  test("a tool's raw --version line keys and shows the version number in it", () => {
    expect(scoreOgEdition({ lane: 'cli', toolVersion: 'ripgrep 15.2.0' })).toEqual(
      scoreOgEdition({ lane: 'cli', toolVersion: '15.2.0' }),
    );
    expect(
      scoreOgEdition({
        lane: 'cli',
        toolVersion: 'curl 8.22.0 (x86_64-pc-linux-gnu) libcurl/8.22.0 OpenSSL/3.6.5 zlib/1.3.1.zlib-ng',
      }),
    ).toEqual({ token: 't8.22.0', label: 'v8.22.0' });
  });

  test('a version outside the key alphabet is hashed, stays distinct, and still parses back', () => {
    const upper = scoreOgEdition({ lane: 'cli', toolVersion: '1.0.0-RC1' });
    const lower = scoreOgEdition({ lane: 'cli', toolVersion: '1.0.0-rc1' });
    const mixed = scoreOgEdition({ lane: 'cli', toolVersion: 'tool 1.0.0-Beta.2' });
    const long = scoreOgEdition({ lane: 'cli', toolVersion: `1.2.3-${'a'.repeat(30)}` });
    for (const edition of [upper, mixed, long]) {
      expect(edition?.token).toMatch(/^h[0-9a-f]{8}$/);
      expect(roundTrips('ouch', scoreOgKey({ scorePct: 70, specVersion: '0.6.0', edition }))).toBe(true);
    }
    expect(lower?.token).toBe('t1.0.0_rc1');
    expect(new Set([upper?.token, lower?.token, mixed?.token, long?.token]).size).toBe(4);
    expect(scoreOgEdition({ lane: 'cli', toolVersion: '1.0.0-RC1' })).toEqual(upper);
    expect(upper?.label).toBe('v1.0.0-RC1');
    expect(mixed?.label).toBe('v1.0.0-Beta.2');
    expect(long?.label).toBe(`v1.2.3-${'a'.repeat(18)}…`);
  });

  test('a --version line with no version number in it gives the card no edition', () => {
    for (const line of [
      'Warning: could not connect to a running Ollama instance',
      'ShellCheck - shell script analysis tool',
      'Yazi',
      'dev-build',
    ]) {
      expect([line, scoreOgEdition({ lane: 'cli', toolVersion: line })]).toEqual([line, null]);
    }
  });

  test('a branch card keys on its short source sha, which wins over a tool version', () => {
    const edition = scoreOgEdition({ lane: 'cli', toolVersion: '', sourceSha: 'ABCDEF1234567890' });
    expect(edition).toEqual({ token: 'gabcdef1', label: 'abcdef1' });
    expect(scoreOgEdition({ lane: 'cli', toolVersion: '2.0.0', sourceSha: 'abcdef1234' })?.token).toBe('gabcdef1');
    const key = scoreOgKey({ scorePct: 51, specVersion: '0.6.0', edition });
    expect(key).toBe(`s51-v0.6.0-gabcdef1${R}`);
    expect(roundTrips('owner/repo@feature', key)).toBe(true);
  });

  test('a record with no usable date, version, or sha keys without an edition', () => {
    expect(scoreOgEdition({ lane: 'web', scoredAt: null })).toBeNull();
    expect(scoreOgEdition({ lane: 'web', scoredAt: 'not a date' })).toBeNull();
    expect(scoreOgEdition({ lane: 'cli', toolVersion: '' })).toBeNull();
    expect(scoreOgEdition({ lane: 'cli', toolVersion: '  ', sourceSha: 'xyz' })).toBeNull();
    expect(scoreOgKey({ scorePct: 80, specVersion: '0.6.0', edition: null })).toBe(`s80-v0.6.0${R}`);
    expect(roundTrips('railway.com', `s80-v0.6.0${R}`)).toBe(true);
  });

  test('pending and unscored keys carry no edition and are never immutable', () => {
    expect(scoreOgKey({ scorePct: 80, specVersion: '0.6.0', pending: true, edition: WEB_EDITION })).toBe('pending');
    expect(scoreOgKey({ scorePct: null, specVersion: '0.6.0', edition: WEB_EDITION })).toBe('unscored');
    expect(scoreOgKey({ scorePct: Number.NaN, specVersion: '0.6.0', edition: null })).toBe('unscored');
    expect(scoreOgKey({ scorePct: 140, specVersion: '0.6.0', edition: null })).toBe('unscored');
    expect(isImmutableScoreOgKey('pending')).toBe(false);
    expect(isImmutableScoreOgKey('unscored')).toBe(false);
    expect(isImmutableScoreOgKey(`s80-v0.6.0-d20261026${R}`)).toBe(true);
  });

  test('a key in the earlier grammar no longer parses', () => {
    expect(parseScoreOgPath('/og/score/railway.com/s80-v0.6.0.png')).toBeNull();
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
    expect(logo.logo?.mime).toBe('image/png');
    expect(logo.logo?.bytes.byteLength).toBe(icon.byteLength);
    expect(logo.cutShort).toBe(false);
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
    expect(await resolveLogo({ pages: ['https://example.com/'], fonts: await fonts(), fetchImpl })).toEqual({
      logo: null,
      cutShort: false,
    });
  });
});

// A card is stored and edge-cached forever under its key, so a change to what
// the card draws must ship with a new SCORE_OG_TEMPLATE. Record the new
// template's fingerprint here; never overwrite an existing one.
const FACE_FINGERPRINTS: Record<number, string> = {
  1: 'c02c0019c91ee3dd',
};

describe('template version', () => {
  test('the card face matches the fingerprint recorded for the current template', () => {
    const faces = [
      CARD,
      {
        ...CARD,
        name: 'ripgrep',
        subtitle: 'rg',
        lane: 'cli' as const,
        scorePct: 92,
        edition: scoreOgEdition({ lane: 'cli', toolVersion: '15.2.0' }),
      },
      {
        ...CARD,
        name: 'r',
        subtitle: 'o/r@feature',
        lane: 'cli' as const,
        scorePct: 51,
        edition: scoreOgEdition({ lane: 'cli', sourceSha: 'abcdef1234' }),
      },
      { ...CARD, scorePct: null, pending: true, edition: null },
    ].map(renderScoreOgSvg);
    const fingerprint = createHash('sha256').update(faces.join('\n')).digest('hex').slice(0, 16);
    expect(FACE_FINGERPRINTS[SCORE_OG_TEMPLATE]).toBe(fingerprint);
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
    const pending = renderScoreOgSvg({ ...CARD, scorePct: null, pending: true, edition: null });
    expect(pending).toContain('>Pending<');
    expect(pending).not.toContain('%');
  });

  test('the footer shows the edition where the spec was, and the description names the spec', () => {
    expect(renderScoreOgSvg(CARD)).toContain('· website audit  ·  2026-10-26<');
    expect(renderScoreOgSvg(CARD)).not.toContain('spec v');
    const cli = renderScoreOgSvg({
      ...CARD,
      name: 'ripgrep',
      subtitle: 'rg',
      lane: 'cli',
      edition: scoreOgEdition({ lane: 'cli', toolVersion: '15.1.0' }),
    });
    expect(cli).toContain('· CLI scorecard  ·  v15.1.0<');
    expect(renderScoreOgSvg({ ...CARD, edition: null })).toContain('· website audit<');
    expect(scoreOgAlt({ name: 'Railway', lane: 'web', scorePct: 80, specVersion: '0.6.0' })).toBe(
      'Railway scored 80% against spec v0.6.0. agent-readiness audit on anc.dev.',
    );
    expect(scoreOgAlt({ name: 'ripgrep', lane: 'cli', scorePct: 92, specVersion: null })).toBe(
      'ripgrep scored 92%. agent-native CLI scorecard on anc.dev.',
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
