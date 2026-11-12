// GET /sitemap.xml: the Worker serves the build's sitemap with the days only
// stored scorecards know. Each curated website result takes its board row's
// scoring day, and `/` and `/scorecards` take the later of their build date
// and the newest row their board shows. Runs against the built dist/ file, so
// the Worker's reading of the entries tracks the build's writing of them.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SCORECARDS_PATH, scorePath } from '../src/shared/audit-routes';
import { aggregateKeyFor, type WebAggregateEntry, type WebAggregateKind } from '../src/worker/audit-web/cache';
import worker, { type Env } from '../src/worker/index';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

const DIST = join(new URL('..', import.meta.url).pathname, 'dist');

type SeedEntry = { domain: string; url: string; name: string; description: string };

function row(entry: SeedEntry, scoredAt?: string): WebAggregateEntry {
  return {
    domain: entry.domain,
    url: entry.url,
    name: entry.name,
    description: entry.description,
    score_pct: 50,
    score: { relative: 50, global: 50 },
    ...(scoredAt === undefined ? {} : { scored_at: scoredAt }),
  };
}

function makeEnv(sitemap: string, seed: SeedEntry[], boards: Record<WebAggregateKind, WebAggregateEntry[]>): Env {
  const store = new Map(
    Object.entries(boards).map(([kind, entries]) => [
      aggregateKeyFor(kind as WebAggregateKind, SPEC_VERSION),
      JSON.stringify({ spec_version: SPEC_VERSION, generated_at: '2030-01-01T00:00:00.000Z', entries }),
    ]),
  );
  return {
    ASSETS: {
      async fetch(request: Request | string): Promise<Response> {
        const path = new URL(typeof request === 'string' ? request : request.url).pathname;
        if (path === '/sitemap.xml') {
          return new Response(sitemap, { status: 200, headers: { 'content-type': 'application/xml' } });
        }
        if (path === '/_internal/web-seed.json') return new Response(JSON.stringify(seed), { status: 200 });
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher,
    SCORE_CACHE: {
      async get(key: string) {
        const raw = store.get(key);
        return raw === undefined ? null : { json: async () => JSON.parse(raw) };
      },
      async put() {},
      async delete() {},
      async list() {
        return { objects: [], truncated: false };
      },
    } as unknown as R2Bucket,
  } as unknown as Env;
}

function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

function entries(xml: string): Map<string, string | null> {
  return new Map(
    [
      ...xml.matchAll(/<url>\s*<loc>https:\/\/anc\.dev([^<]*)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?\s*<\/url>/g),
    ].map(([, path, lastmod]) => [path || '/', lastmod ?? null]),
  );
}

async function built(): Promise<{ sitemap: string; seed: SeedEntry[] }> {
  return {
    sitemap: await readFile(join(DIST, 'sitemap.xml'), 'utf8'),
    seed: JSON.parse(await readFile(join(DIST, '_internal', 'web-seed.json'), 'utf8')) as SeedEntry[],
  };
}

async function served(env: Env): Promise<Response> {
  const res = await worker.fetch(new Request('https://anc.dev/sitemap.xml'), env, ctx());
  expect(res.status).toBe(200);
  return res;
}

describe('the served sitemap dates the pages stored scorecards fill', () => {
  test('every curated website page carries its row scoring day, and the board pages their newest row', async () => {
    const { sitemap, seed } = await built();
    expect(seed.length).toBeGreaterThan(0);
    // Days well after any build date, one per row, so each is told apart.
    const dayOf = (i: number) => new Date(Date.UTC(2030, 0, 1 + i)).toISOString().slice(0, 10);
    const board = seed.map((entry, i) => row(entry, `${dayOf(i)}T12:00:00.000Z`));
    const frontpage = board.slice(0, 2);
    const res = await served(makeEnv(sitemap, seed, { leaderboard: board, 'leaderboard-frontpage': frontpage }));
    const before = entries(sitemap);
    const after = entries(await res.text());

    const expected = new Map(before);
    for (const [i, entry] of seed.entries()) expected.set(scorePath(entry.domain), dayOf(i));
    expected.set('/', dayOf(1));
    expected.set(SCORECARDS_PATH, dayOf(seed.length - 1));
    expect([...after]).toEqual([...expected]);
    expect({
      tag: res.headers.get('cache-tag'),
      cdn: res.headers.get('cloudflare-cdn-cache-control'),
      browser: res.headers.get('cache-control'),
    }).toEqual({ tag: 'home', cdn: 'public, max-age=300', browser: 'public, max-age=0, must-revalidate' });
  });

  test('a curated row with no scoring date leaves its page undated', async () => {
    const { sitemap, seed } = await built();
    const [dated, undated] = seed;
    const board = [row(dated, '2030-03-04T05:06:07.000Z'), row(undated)];
    const after = entries(
      await (await served(makeEnv(sitemap, seed, { leaderboard: board, 'leaderboard-frontpage': [] }))).text(),
    );
    expect({
      dated: after.get(scorePath(dated.domain)),
      undated: after.get(scorePath(undated.domain)),
    }).toEqual({ dated: '2030-03-04', undated: null });
  });
});
