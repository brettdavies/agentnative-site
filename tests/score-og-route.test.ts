// GET /og/score/<target>/<key>.png against stubbed bindings. The renderer is
// the real one; the network is not.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { scoreOgPath } from '../src/shared/score-og';
import { keyFor as webKeyFor } from '../src/worker/audit-web/cache';
import type { LogoFetch } from '../src/worker/og/logo';
import type { ScoreOgFonts } from '../src/worker/og/render';
import { handleScoreOg } from '../src/worker/og/route';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';

const ORIGIN = 'https://anc.dev';
const FONT_DIR = new URL('../src/worker/og/fonts/', import.meta.url);

let fontBuffers: ScoreOgFonts | null = null;
async function fonts(): Promise<ScoreOgFonts> {
  if (fontBuffers) return fontBuffers;
  const [regular, bold, mono] = await Promise.all([
    readFile(new URL('uncut-sans-600.ttf', FONT_DIR)),
    readFile(new URL('uncut-sans-700.ttf', FONT_DIR)),
    readFile(new URL('monaspace-xenon-500.otf', FONT_DIR)),
  ]);
  fontBuffers = [new Uint8Array(regular), new Uint8Array(bold), new Uint8Array(mono)];
  return fontBuffers;
}

const WEB_RECORD = {
  spec_version: SPEC_VERSION,
  target_url: 'https://anc.dev/',
  scorecard: { score_pct: 64, score: { relative: 64, global: 40 } },
};

const REGISTRY = {
  by_slug: {
    ripgrep: {
      name: 'ripgrep',
      binary: 'rg',
      install: 'brew install ripgrep',
      repo: 'BurntSushi/ripgrep',
      anc_version: ANC_VERSION,
      scorecard_url: '/score/ripgrep',
      score_pct: 92,
    },
  },
  by_owner_repo: {},
};

const CURATED_JSON = JSON.stringify({
  spec_version: SPEC_VERSION,
  scorecard: {
    spec_version: SPEC_VERSION,
    tool: { name: 'rg', binary: 'rg' },
    badge: { score_pct: 92 },
  },
});

type Overrides = { cache?: Record<string, unknown>; kv?: Record<string, string>; failRegistry?: boolean };

function makeEnv(overrides: Overrides = {}) {
  const cache = new Map(Object.entries(overrides.cache ?? {}).map(([key, value]) => [key, JSON.stringify(value)]));
  const kv = new Map(Object.entries(overrides.kv ?? {}));
  const objects = new Map<string, Uint8Array>();
  return {
    ASSETS: {
      async fetch(req: Request) {
        const path = new URL(req.url).pathname;
        if (path === '/registry-index.json') {
          if (overrides.failRegistry) return new Response('down', { status: 500 });
          return new Response(JSON.stringify(REGISTRY));
        }
        if (path === '/score/ripgrep.json') return new Response(CURATED_JSON);
        return new Response('missing', { status: 404 });
      },
    },
    objects,
    SCORE_CACHE: {
      async get(key: string) {
        const bytes = objects.get(key);
        if (bytes) return { arrayBuffer: async () => bytes.slice().buffer };
        const raw = cache.get(key);
        if (raw === undefined) return null;
        return { json: async () => JSON.parse(raw) };
      },
      async put(key: string, value: Uint8Array) {
        objects.set(key, new Uint8Array(value));
      },
      async list({ prefix }: { prefix: string }) {
        return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
      },
      async delete(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      },
    },
    SCORE_KV: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
    },
  };
}

function request(path: string, method = 'GET'): Request {
  return new Request(`${ORIGIN}${path}`, { method });
}

function png(bytes: Uint8Array): void {
  expect(bytes[0]).toBe(0x89);
  expect(bytes[1]).toBe(0x50);
  expect(bytes[2]).toBe(0x4e);
  expect(bytes[3]).toBe(0x47);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(16)).toBe(1200);
  expect(view.getUint32(20)).toBe(630);
}

beforeEach(() => {
  _resetRegistryIndexCache();
});

afterEach(() => {
  _resetRegistryIndexCache();
});

describe('scorecard OG route', () => {
  test('a key that is not the stored score 301s to the key that is', async () => {
    const env = makeEnv({ cache: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: WEB_RECORD } });
    const res = await handleScoreOg(request('/og/score/anc.dev/s1-v0.0.0.png'), env as never);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(scoreOgPath('anc.dev', `s64-v${SPEC_VERSION}`));
    expect(res.headers.get('cache-control')).not.toContain('immutable');
  });

  test('a query string 301s to the bare canonical path', async () => {
    const env = makeEnv({ cache: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: WEB_RECORD } });
    const res = await handleScoreOg(request(`/og/score/anc.dev/s64-v${SPEC_VERSION}.png?v=1`), env as never);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(scoreOgPath('anc.dev', `s64-v${SPEC_VERSION}`));
  });

  test('an unknown target is a 404 and a registry outage is a 503', async () => {
    const missing = await handleScoreOg(request('/og/score/not-a-tool.example/s10-v0.6.0.png'), makeEnv() as never);
    expect(missing.status).toBe(404);
    const down = await handleScoreOg(
      request('/og/score/ripgrep/s92-v0.6.0.png'),
      makeEnv({ failRegistry: true }) as never,
    );
    expect(down.status).toBe(503);
    expect(down.headers.get('retry-after')).toBe('30');
  });

  test('a binary alias 301s once, to the slug and the stored score', async () => {
    const res = await handleScoreOg(request('/og/score/rg/s1-v0.0.0.png'), makeEnv() as never);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(scoreOgPath('ripgrep', `s92-v${SPEC_VERSION}`));
  });

  test('the canonical card is a 1200×630 PNG cached immutably', async () => {
    const env = makeEnv({ cache: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: WEB_RECORD } });
    const res = await handleScoreOg(request(`/og/score/anc.dev/s64-v${SPEC_VERSION}.png`), env as never, {
      fonts: await fonts(),
      fetchImpl: async () => new Response('no', { status: 404 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    png(new Uint8Array(await res.arrayBuffer()));
  });

  test('an in-flight audit with no record redirects to pending.png, which is a PNG and not immutable', async () => {
    const env = makeEnv({
      kv: {
        'inflight:web:railway.com': JSON.stringify({ started_at: '2026-10-14T00:00:00.000Z', job: 'web:railway.com' }),
      },
    });
    const wrong = await handleScoreOg(request('/og/score/railway.com/s1-v0.0.0.png'), env as never);
    expect(wrong.status).toBe(301);
    expect(wrong.headers.get('location')).toBe('/og/score/railway.com/pending.png');
    const res = await handleScoreOg(request('/og/score/railway.com/pending.png'), env as never, {
      fonts: await fonts(),
      fetchImpl: async () => new Response('no', { status: 404 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('cache-control')).not.toContain('immutable');
    png(new Uint8Array(await res.arrayBuffer()));
  });

  test('a logo fetch that never returns still produces a wordmark PNG', async () => {
    const env = makeEnv({ cache: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: WEB_RECORD } });
    const fetchImpl: LogoFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const res = await handleScoreOg(request(`/og/score/anc.dev/s64-v${SPEC_VERSION}.png`), env as never, {
      fonts: await fonts(),
      fetchImpl,
      budgetMs: 30,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    png(new Uint8Array(await res.arrayBuffer()));
  });

  test.each([
    ['base64 that does not decode', 'data:image/png;base64,%%%%'],
    ['a percent escape that does not decode', 'data:image/svg+xml,%E0%A4%A'],
  ])('a homepage icon given as %s falls back to the wordmark', async (_label, href) => {
    const env = makeEnv({ cache: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: WEB_RECORD } });
    const fetchImpl: LogoFetch = async () =>
      new Response(`<html><head><link rel="icon" href="${href}"></head></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    const res = await handleScoreOg(request(`/og/score/anc.dev/s64-v${SPEC_VERSION}.png`), env as never, {
      fonts: await fonts(),
      fetchImpl,
    });
    expect(res.status).toBe(200);
    png(new Uint8Array(await res.arrayBuffer()));
  });

  test('a finished card is stored in R2 and the next request reads it without drawing', async () => {
    const env = makeEnv({ cache: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: WEB_RECORD } });
    const path = `/og/score/anc.dev/s64-v${SPEC_VERSION}.png`;
    const drawn = await handleScoreOg(request(path), env as never, {
      fonts: await fonts(),
      fetchImpl: async () => new Response('no', { status: 404 }),
    });
    const drawnBytes = new Uint8Array(await drawn.arrayBuffer());
    const stored = [...env.objects.keys()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(new RegExp(`^og/score/[0-9a-f]{64}/s64-v${SPEC_VERSION.replaceAll('.', '\\.')}\\.png$`));
    const read = await handleScoreOg(request(path), env as never, {
      fetchImpl: async () => {
        throw new Error('a stored card is not drawn again');
      },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(drawnBytes);
  });

  test("storing a new score's card deletes the target's previous card", async () => {
    const env = makeEnv({ cache: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: WEB_RECORD } });
    const deps = { fonts: await fonts(), fetchImpl: async () => new Response('no', { status: 404 }) };
    await handleScoreOg(request(`/og/score/anc.dev/s64-v${SPEC_VERSION}.png`), env as never, deps);
    const [first] = [...env.objects.keys()];
    const prefix = first.slice(0, first.lastIndexOf('/') + 1);
    env.objects.set(`${prefix}s51-v${SPEC_VERSION}.png`, new Uint8Array([1]));
    env.objects.delete(first);
    await handleScoreOg(request(`/og/score/anc.dev/s64-v${SPEC_VERSION}.png`), env as never, deps);
    expect([...env.objects.keys()]).toEqual([first]);
  });

  test('a pending card is not stored', async () => {
    const env = makeEnv({
      kv: {
        'inflight:web:railway.com': JSON.stringify({ started_at: '2026-10-14T00:00:00.000Z', job: 'web:railway.com' }),
      },
    });
    const res = await handleScoreOg(request('/og/score/railway.com/pending.png'), env as never, {
      fonts: await fonts(),
      fetchImpl: async () => new Response('no', { status: 404 }),
    });
    expect(res.status).toBe(200);
    expect(env.objects.size).toBe(0);
  });

  test('POST is rejected', async () => {
    const res = await handleScoreOg(request('/og/score/anc.dev/s64-v0.6.0.png', 'POST'), makeEnv() as never);
    expect(res.status).toBe(405);
  });
});
