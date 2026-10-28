// The card's logo lookup: homepage icon, then the brand's published logo,
// one stored result per registrable domain. Network and R2 are stubbed.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { sha256Hex } from '../src/worker/audit-web/cache';
import { brandLogoUrls } from '../src/worker/og/brand-logo';
import { findLogo } from '../src/worker/og/find-logo';
import type { LogoFetch } from '../src/worker/og/logo';
import type { ScoreOgFonts } from '../src/worker/og/render';

const FONT_DIR = new URL('../src/worker/og/fonts/', import.meta.url);
const BRAND_ENDPOINT = 'https://api.context.dev/v1/brand/retrieve';

async function fonts(): Promise<ScoreOgFonts> {
  const [regular, bold, mono] = await Promise.all([
    readFile(new URL('uncut-sans-600.ttf', FONT_DIR)),
    readFile(new URL('uncut-sans-700.ttf', FONT_DIR)),
    readFile(new URL('monaspace-xenon-500.otf', FONT_DIR)),
  ]);
  return [new Uint8Array(regular), new Uint8Array(bold), new Uint8Array(mono)];
}

async function png(size: number): Promise<Uint8Array<ArrayBuffer>> {
  return Uint8Array.from(
    await sharp({ create: { width: size, height: size, channels: 4, background: '#2f6fed' } })
      .png()
      .toBuffer(),
  );
}

type Stored = { bytes: Uint8Array; contentType?: string; meta: Record<string, string> };

function bucket() {
  const objects = new Map<string, Stored>();
  const r2 = {
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        customMetadata: object.meta,
        httpMetadata: { contentType: object.contentType },
        arrayBuffer: async () => object.bytes.slice().buffer,
      };
    },
    async put(
      key: string,
      value: Uint8Array,
      opts: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
    ) {
      objects.set(key, { bytes: value, contentType: opts.httpMetadata?.contentType, meta: opts.customMetadata ?? {} });
    },
  };
  return { objects, r2: r2 as unknown as R2Bucket };
}

const homepage = (iconSize: number | null) => {
  const head = iconSize === null ? '' : '<link rel="apple-touch-icon" href="/apple.png">';
  return `<html><head>${head}</head></html>`;
};

/** A fetch stub that records every URL and answers from a route table; unknown URLs 404. */
function stub(routes: Record<string, () => Promise<Response> | Response>) {
  const sent: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: LogoFetch = async (input, init) => {
    const url = String(input);
    sent.push({ url, init });
    const route = routes[url];
    return route ? route() : new Response('no', { status: 404 });
  };
  return { sent, fetchImpl };
}

async function logoKey(host: string): Promise<string> {
  return `og/logo/${await sha256Hex(host)}`;
}

describe('findLogo', () => {
  test('a homepage icon at least 128px is used and stored, with no brand lookup', async () => {
    const icon = await png(180);
    const { objects, r2 } = bucket();
    const { sent, fetchImpl } = stub({
      'https://www.example.com/': () => new Response(homepage(180), { headers: { 'content-type': 'text/html' } }),
      'https://www.example.com/apple.png': () => new Response(icon, { headers: { 'content-type': 'image/png' } }),
    });
    const logo = await findLogo({
      pages: ['https://www.example.com/'],
      fonts: await fonts(),
      bucket: r2,
      brandApiKey: 'k',
      fetchImpl,
    });
    expect(logo.logo?.bytes).toEqual(icon);
    expect(logo.source).toBe('homepage');
    expect(sent.some((s) => s.url === BRAND_ENDPOINT)).toBe(false);
    const stored = objects.get(await logoKey('www.example.com'));
    expect(stored?.contentType).toBe('image/png');
    expect(stored?.meta.source).toBe('homepage');
  });

  test("a favicon below 128px falls through to the brand's logo, looked up by registrable domain", async () => {
    const brandIcon = await png(512);
    const { objects, r2 } = bucket();
    const { sent, fetchImpl } = stub({
      'https://www.example.com/': () => new Response(homepage(32), { headers: { 'content-type': 'text/html' } }),
      'https://www.example.com/apple.png': async () =>
        new Response(await png(32), { headers: { 'content-type': 'image/png' } }),
      [BRAND_ENDPOINT]: () =>
        Response.json({
          brand: {
            logos: [
              {
                url: 'https://media.brand.dev/wide.svg',
                type: 'logo',
                mode: 'dark',
                resolution: { width: 111, height: 24 },
              },
              {
                url: 'https://media.brand.dev/icon.png',
                type: 'icon',
                mode: 'has_opaque_background',
                resolution: { width: 512, height: 512 },
              },
            ],
          },
        }),
      'https://media.brand.dev/icon.png': () => new Response(brandIcon, { headers: { 'content-type': 'image/png' } }),
    });
    const logo = await findLogo({
      pages: ['https://www.example.com/'],
      fonts: await fonts(),
      bucket: r2,
      brandApiKey: 'secret-key',
      fetchImpl,
    });
    expect(logo.logo?.bytes).toEqual(brandIcon);
    expect(logo.source).toBe('brand');
    const call = sent.find((s) => s.url === BRAND_ENDPOINT);
    expect(JSON.parse(String(call?.init?.body))).toEqual({ type: 'by_domain', domain: 'example.com' });
    expect(new Headers(call?.init?.headers).get('authorization')).toBe('Bearer secret-key');
    expect(objects.get(await logoKey('www.example.com'))?.meta.source).toBe('brand');
  });

  test('a stored logo or a stored miss answers without any request', async () => {
    const icon = await png(256);
    const { objects, r2 } = bucket();
    objects.set(await logoKey('example.com'), {
      bytes: icon,
      contentType: 'image/png',
      meta: { domain: 'example.com' },
    });
    objects.set(await logoKey('nologo.dev'), { bytes: new Uint8Array(0), meta: { domain: 'nologo.dev', miss: '1' } });
    const { sent, fetchImpl } = stub({});
    const hit = await findLogo({
      pages: ['https://example.com/'],
      fonts: await fonts(),
      bucket: r2,
      brandApiKey: 'k',
      fetchImpl,
    });
    const miss = await findLogo({
      pages: ['https://nologo.dev/'],
      fonts: await fonts(),
      bucket: r2,
      brandApiKey: 'k',
      fetchImpl,
    });
    expect(hit).toEqual({ logo: { mime: 'image/png', bytes: icon }, source: 'stored', settled: true });
    expect(miss).toEqual({ logo: null, source: 'tile', settled: true });
    expect(sent).toEqual([]);
  });

  test('a code-host homepage and a missing key skip the brand lookup and store a miss', async () => {
    const { objects, r2 } = bucket();
    const { sent, fetchImpl } = stub({});
    expect(
      await findLogo({
        pages: ['https://github.com/owner/tool'],
        fonts: await fonts(),
        bucket: r2,
        brandApiKey: 'k',
        fetchImpl,
      }),
    ).toEqual({ logo: null, source: 'tile', settled: true });
    expect(await findLogo({ pages: ['https://tool.example/'], fonts: await fonts(), bucket: r2, fetchImpl })).toEqual({
      logo: null,
      source: 'tile',
      settled: true,
    });
    expect(sent.some((s) => s.url === BRAND_ENDPOINT)).toBe(false);
    expect(objects.get(await logoKey('github.com'))?.meta.miss).toBe('1');
    expect(objects.get(await logoKey('tool.example'))?.meta.miss).toBe('1');
  });

  test('a homepage lookup cut short by its budget yields the tile and stores nothing', async () => {
    const { objects, r2 } = bucket();
    const fetchImpl: LogoFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const found = await findLogo({
      pages: ['https://slow.example/'],
      fonts: await fonts(),
      bucket: r2,
      fetchImpl,
      budgetMs: 30,
    });
    expect(found).toEqual({ logo: null, source: 'tile', settled: false });
    expect(objects.size).toBe(0);
  });

  test('a brand lookup the API could not answer stores no miss', async () => {
    const { objects, r2 } = bucket();
    const { fetchImpl } = stub({
      'https://www.example.com/': () => new Response(homepage(null), { headers: { 'content-type': 'text/html' } }),
      [BRAND_ENDPOINT]: () => new Response('busy', { status: 503 }),
    });
    const found = await findLogo({
      pages: ['https://www.example.com/'],
      fonts: await fonts(),
      bucket: r2,
      brandApiKey: 'k',
      fetchImpl,
    });
    expect(found).toEqual({ logo: null, source: 'tile', settled: false });
    expect(objects.size).toBe(0);
  });

  test.each([
    ['a network error', () => Promise.reject(new TypeError('connection reset'))],
    ['a 503', () => Promise.resolve(new Response('busy', { status: 503 }))],
    ['a 429', () => Promise.resolve(new Response('slow down', { status: 429 }))],
  ])('a homepage that answers with %s stores nothing', async (_label, answer) => {
    const { objects, r2 } = bucket();
    const fetchImpl: LogoFetch = () => answer();
    const found = await findLogo({ pages: ['https://down.example/'], fonts: await fonts(), bucket: r2, fetchImpl });
    expect(found).toEqual({ logo: null, source: 'tile', settled: false });
    expect(objects.size).toBe(0);
  });

  test('a settled brand answer is stored, so a slow homepage does not repeat the paid lookup', async () => {
    const { objects, r2 } = bucket();
    let brandCalls = 0;
    const fetchImpl: LogoFetch = (input, init) => {
      if (String(input) === BRAND_ENDPOINT) {
        brandCalls += 1;
        return Promise.resolve(Response.json({ brand: { logos: [] } }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    };
    const face = await fonts();
    const lookup = () =>
      findLogo({
        pages: ['https://www.slow.example/'],
        fonts: face,
        bucket: r2,
        brandApiKey: 'k',
        fetchImpl,
        budgetMs: 30,
      });
    expect(await lookup()).toEqual({ logo: null, source: 'tile', settled: false });
    expect(await lookup()).toEqual({ logo: null, source: 'tile', settled: false });
    expect(brandCalls).toBe(1);
    expect(objects.has(await logoKey('www.slow.example'))).toBe(false);
  });

  test('a brand answer with no logos stores a miss', async () => {
    const { objects, r2 } = bucket();
    const { fetchImpl } = stub({
      'https://www.example.com/': () => new Response(homepage(null), { headers: { 'content-type': 'text/html' } }),
      [BRAND_ENDPOINT]: () => Response.json({ brand: { logos: [] } }),
    });
    const found = await findLogo({
      pages: ['https://www.example.com/'],
      fonts: await fonts(),
      bucket: r2,
      brandApiKey: 'k',
      fetchImpl,
    });
    expect(found).toEqual({ logo: null, source: 'tile', settled: true });
    expect(objects.get(await logoKey('www.example.com'))?.meta.miss).toBe('1');
  });
});

describe('brandLogoUrls', () => {
  test('ranks square icons before wordmarks and larger before smaller, and fails closed', async () => {
    const { fetchImpl } = stub({
      [BRAND_ENDPOINT]: () =>
        Response.json({
          brand: {
            logos: [
              { url: 'https://media.brand.dev/small-icon.png', type: 'icon', resolution: { width: 180, height: 180 } },
              { url: 'https://media.brand.dev/wordmark.svg', type: 'logo', resolution: { width: 300, height: 60 } },
              { url: 'http://media.brand.dev/insecure.png', type: 'icon', resolution: { width: 512, height: 512 } },
              { url: 'https://media.brand.dev/big-icon.png', type: 'icon', resolution: { width: 512, height: 512 } },
            ],
          },
        }),
    });
    expect(await brandLogoUrls('example.com', 'k', fetchImpl, 1_000)).toEqual({
      urls: [
        'https://media.brand.dev/big-icon.png',
        'https://media.brand.dev/small-icon.png',
        'https://media.brand.dev/wordmark.svg',
      ],
      settled: true,
    });
    const down = stub({ [BRAND_ENDPOINT]: () => new Response('err', { status: 500 }) });
    expect(await brandLogoUrls('example.com', 'k', down.fetchImpl, 1_000)).toEqual({ urls: [], settled: false });
  });

  test.each([
    [404, true],
    [400, true],
    [401, false],
    [402, false],
    [403, false],
    [408, false],
    [429, false],
    [503, false],
  ])('an HTTP %i answer settles the lookup: %p', async (status, settled) => {
    const { fetchImpl } = stub({ [BRAND_ENDPOINT]: () => new Response('no', { status }) });
    expect(await brandLogoUrls('example.com', 'k', fetchImpl, 1_000)).toEqual({ urls: [], settled });
  });

  test('a brand request that fails without an answer leaves the lookup unsettled', async () => {
    const { fetchImpl } = stub({ [BRAND_ENDPOINT]: () => Promise.reject(new TypeError('connection reset')) });
    expect(await brandLogoUrls('example.com', 'k', fetchImpl, 1_000)).toEqual({ urls: [], settled: false });
  });
});
