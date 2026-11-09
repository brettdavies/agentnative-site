// The site Worker's og bindings under Bun: scorecard records in a fake R2
// bucket, the registry and curated pages behind ASSETS, in-flight flags in
// KV, and a RENDER service binding that records every call.

import type { DrawnCard, RenderInputs, RenderJobStatus, RenderService } from '../../src/shared/og-render';
import { SCORE_OG_TEMPLATE } from '../../src/shared/score-og';
import { keyFor as webKeyFor } from '../../src/worker/audit-web/cache';
import { ANC_VERSION, SPEC_VERSION } from '../../src/worker/spec-version.gen';
import { type FakeBucket, fakeBucket, seedJson } from './og-render-fakes';

export const SCORED_AT = '2026-10-26T10:00:00.000Z';
export const R = `-r${SCORE_OG_TEMPLATE}`;
export const WEB_KEY = `s64-v${SPEC_VERSION}-d20261026${R}`;
export const CURATED_KEY = `s92-v${SPEC_VERSION}-t15.2.0${R}`;
export const STALE_KEY = `s1-v0.0.0${R}`;

export const WEB_RECORD = {
  spec_version: SPEC_VERSION,
  target_url: 'https://anc.dev/',
  scorecard: { score_pct: 64, score: { relative: 64, global: 40 } },
  scored_at: SCORED_AT,
};

export const REGISTRY = {
  by_slug: {
    ripgrep: {
      name: 'ripgrep',
      binary: 'rg',
      install: 'brew install ripgrep',
      repo: 'BurntSushi/ripgrep',
      url: 'https://github.com/BurntSushi/ripgrep',
      anc_version: ANC_VERSION,
      scorecard_url: '/score/ripgrep',
      score_pct: 92,
      version: '15.2.0',
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
    run: { started_at: '2026-10-05T18:42:23.480Z' },
  },
});

export const DEFAULT_CARD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

export const DRAWN_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

type RenderCall =
  | { method: 'request'; inputs: RenderInputs }
  | { method: 'requestMany'; inputs: RenderInputs[] }
  | { method: 'status'; target: string; key: string }
  | { method: 'drawCard'; inputs: RenderInputs };

export type FakeRender = RenderService & { calls: RenderCall[] };

const QUEUED: RenderJobStatus = { state: 'queued', run: 'run-1', attempt: 0 };

/** A render Worker that draws DRAWN_PNG with a settled tile and claims every job, unless a call is overridden. */
export function fakeRender(overrides: Partial<RenderService> = {}): FakeRender {
  const calls: RenderCall[] = [];
  return {
    calls,
    async request(inputs) {
      calls.push({ method: 'request', inputs });
      return overrides.request ? overrides.request(inputs) : QUEUED;
    },
    async requestMany(inputs) {
      calls.push({ method: 'requestMany', inputs });
      return overrides.requestMany ? overrides.requestMany(inputs) : inputs.map(() => QUEUED);
    },
    async status(target, key) {
      calls.push({ method: 'status', target, key });
      return overrides.status ? overrides.status(target, key) : { state: 'none' };
    },
    async drawCard(inputs): Promise<DrawnCard> {
      calls.push({ method: 'drawCard', inputs });
      if (overrides.drawCard) return overrides.drawCard(inputs);
      return { outcome: 'card', png: DRAWN_PNG, card: 'drawn', logo: 'tile', settled: true };
    },
  };
}

export type SiteEnvOptions = {
  records?: Record<string, unknown>;
  seed?: string[];
  registry?: unknown;
  kv?: Record<string, string>;
  failRegistry?: boolean;
  failReads?: boolean;
  render?: RenderService;
  ogVideo?: string;
};

export type SiteEnv = {
  ASSETS: Fetcher;
  SCORE_CACHE: FakeBucket;
  SCORE_KV: KVNamespace;
  RENDER?: RenderService;
  OG_VIDEO_ENABLED?: string;
};

export function siteEnv(options: SiteEnvOptions = {}): SiteEnv {
  const bucket = fakeBucket({ failReads: options.failReads });
  for (const [key, value] of Object.entries(options.records ?? {})) seedJson(bucket, key, value);
  const kv = new Map(Object.entries(options.kv ?? {}));
  return {
    ASSETS: {
      async fetch(req: Request) {
        const path = new URL(req.url).pathname;
        if (path === '/registry-index.json') {
          if (options.failRegistry) return new Response('down', { status: 500 });
          return new Response(JSON.stringify(options.registry ?? REGISTRY));
        }
        if (path === '/_internal/web-seed.json') {
          const seed = (options.seed ?? []).map((domain) => ({ domain, url: `https://${domain}/`, name: domain }));
          return new Response(JSON.stringify(seed), { headers: { 'content-type': 'application/json' } });
        }
        if (path === '/score/ripgrep.json') return new Response(CURATED_JSON);
        if (path === '/og-image.png') return new Response(DEFAULT_CARD, { headers: { 'content-type': 'image/png' } });
        return new Response('missing', { status: 404 });
      },
    } as unknown as Fetcher,
    SCORE_CACHE: bucket,
    SCORE_KV: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
    } as unknown as KVNamespace,
    RENDER: options.render ?? fakeRender(),
    OG_VIDEO_ENABLED: options.ogVideo,
  };
}

export function webRecord(host: string, pct: number) {
  return {
    spec_version: SPEC_VERSION,
    target_url: `https://${host}/`,
    scorecard: { score_pct: pct, score: { relative: pct, global: pct } },
    scored_at: SCORED_AT,
  };
}

/** An env whose web cache holds anc.dev's audit. */
export async function webEnv(options: SiteEnvOptions = {}): Promise<SiteEnv> {
  return siteEnv({
    ...options,
    records: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: WEB_RECORD, ...options.records },
  });
}
