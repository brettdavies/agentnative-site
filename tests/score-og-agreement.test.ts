// A curated scorecard page is baked at build time, and its card is served by
// the Worker. The build keys the card from the scorecard file and the route
// from the registry index and the baked JSON, so the two can disagree while
// each looks right alone. This reads every shipped page and asks the route.

import { beforeEach, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleScoreOg } from '../src/worker/og/route';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import { distAssetsEnv, requireDistBuild } from './helpers/dist';

const DIST = join(fileURLToPath(import.meta.url), '..', '..', 'dist');

/** A card stored under every key, so the route answers from R2 instead of drawing. */
const CARDS_EVERYWHERE = {
  async get(key: string) {
    if (!key.startsWith('og/score/')) return null;
    return { customMetadata: {}, arrayBuffer: async () => new Uint8Array([0x89]).buffer };
  },
};

beforeEach(() => {
  _resetRegistryIndexCache();
});

describe('curated scorecard card agreement', () => {
  test("every curated page's og:image is the card path the route serves without a redirect", async () => {
    requireDistBuild(DIST);
    const env = { ...distAssetsEnv(DIST), SCORE_CACHE: CARDS_EVERYWHERE };
    const pages = (await readdir(join(DIST, 'score'))).filter((file) => file.endsWith('.html'));
    expect(pages.length).toBeGreaterThan(0);
    const disagreements: string[] = [];
    for (const page of pages) {
      const html = await readFile(join(DIST, 'score', page), 'utf8');
      const image = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
      if (!image || !/-(?:t[a-z0-9._]+|h[0-9a-f]{8})-r\d+\.png$/.test(image)) {
        disagreements.push(`${page}: og:image ${image ?? 'missing'} names no tool version`);
        continue;
      }
      const res = await handleScoreOg(new Request(image), env as never);
      if (res.status !== 200) disagreements.push(`${page}: ${res.status} ${res.headers.get('location') ?? ''}`);
    }
    expect(disagreements).toEqual([]);
  });
});
