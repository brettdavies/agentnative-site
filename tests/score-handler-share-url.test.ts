// Integration: /api/score sets `share_url` to `/score/live/<binary>` on
// inline-scorecard success branches; omits it for registry_hit (which
// carries scorecard_url) and for github-url-without-hint live runs.
//
// The share URL is derived from the cache-tier binary, so the same key
// the DO + cached lookup write to is the key the share page reads from.

import { beforeEach, describe, expect, test } from 'bun:test';
import { _resetIndexCache, handleScore, type ScoreEnv } from '../src/worker/score/handler';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';

const REGISTRY_INDEX = {
  by_slug: {
    ripgrep: {
      name: 'ripgrep',
      binary: 'rg',
      install: 'cargo install ripgrep',
      version: '14.1.0',
      anc_version: '0.3.1',
      scorecard_url: '/score/ripgrep',
      score_pct: 92,
    },
    bat: {
      name: 'bat',
      binary: 'bat',
      install: 'cargo install bat',
      version: '0.26.1',
      anc_version: '0.3.1',
      scorecard_url: '/score/bat',
      score_pct: 78,
    },
  },
  by_owner_repo: {},
};

const HINTS_INDEX = {
  by_owner_repo: {
    'Aider-AI/aider': { pm: 'pip', package: 'aider-chat', binary: 'aider' },
  },
};

function makeEnv(cacheContent: Record<string, unknown> = {}): ScoreEnv & { __cacheStore: Map<string, string> } {
  const cacheStore = new Map<string, string>();
  for (const [k, v] of Object.entries(cacheContent)) {
    cacheStore.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const cacheStub = {
    async get(key: string) {
      const raw = cacheStore.get(key);
      if (raw === undefined) return null;
      return {
        async json() {
          return JSON.parse(raw);
        },
        async text() {
          return raw;
        },
      };
    },
    async put(key: string, value: unknown) {
      cacheStore.set(key, typeof value === 'string' ? value : String(value));
    },
    async delete(key: string) {
      cacheStore.delete(key);
    },
  };

  return {
    ASSETS: {
      async fetch(req: Request | string): Promise<Response> {
        const url = typeof req === 'string' ? req : req.url;
        const path = new URL(url).pathname;
        if (path === '/registry-index.json') {
          return new Response(JSON.stringify(REGISTRY_INDEX), { status: 200 });
        }
        if (path === '/discovery-hints-index.json') {
          return new Response(JSON.stringify(HINTS_INDEX), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      },
    } as Fetcher,
    SCORE: {} as DurableObjectNamespace,
    SCORE_KV: {
      async get() {
        return null;
      },
    } as unknown as KVNamespace,
    SCORE_CACHE: cacheStub as unknown as R2Bucket,
    SCORE_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
    SCORE_LIMITER_IP: {
      async limit() {
        return { success: true };
      },
    },
    TURNSTILE_SECRET: 'test',
    SESSION_HMAC_SECRET: 'test-hmac-secret-long-enough',
    __cacheStore: cacheStore,
  } as ScoreEnv & { __cacheStore: Map<string, string> };
}

function postScore(input: string): Request {
  return new Request('https://anc.dev/api/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, turnstile_token: 'tok' }),
  });
}

beforeEach(() => {
  _resetIndexCache();
  _resetKillSwitchCache();
});

describe('/api/score — share_url derivation', () => {
  // `cargo install uncurated-tool` → parser binary='uncurated-tool' →
  // cache key scores/uncurated-tool/<SPEC_VERSION>.json. share_url should
  // be the matching /score/live/uncurated-tool URL.
  //
  // Deliberately fictional package name: NOT in this file's REGISTRY_INDEX
  // (ripgrep + bat are curated there), so the install-command cross-check
  // (registry-lookup.ts) doesn't intercept and the input flows through to
  // the cache tier — which is what these share_url tests need to exercise.
  const CACHED_KEY = 'scores/uncurated-tool/0.4.0.json';
  const CACHED_PAYLOAD = {
    spec_version: '0.4.0',
    anc_version: '0.3.1',
    tool_version: '0.1.0',
    scorecard: { badge: { score_pct: 70, eligible: false }, results: [] },
  };

  test('cached install-command hit: share_url = /score/live/<binary>', async () => {
    const env = makeEnv({ [CACHED_KEY]: CACHED_PAYLOAD });
    const res = await handleScore(postScore('cargo install uncurated-tool'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { share_url?: string; scorecard: unknown };
    expect(body.share_url).toBe('/score/live/uncurated-tool');
  });

  test('cached install-command hit: share_url stable across requests', async () => {
    const env = makeEnv({ [CACHED_KEY]: CACHED_PAYLOAD });
    const r1 = await handleScore(postScore('cargo install uncurated-tool'), env);
    const r2 = await handleScore(postScore('cargo install uncurated-tool'), env);
    const b1 = (await r1.json()) as { share_url?: string };
    const b2 = (await r2.json()) as { share_url?: string };
    // Same binary → same share URL. This is the design improvement over
    // session-id minting: shareable URLs map to scored binaries, not to
    // request instances.
    expect(b1.share_url).toBe('/score/live/uncurated-tool');
    expect(b2.share_url).toBe('/score/live/uncurated-tool');
  });

  test('registry_hit does NOT carry share_url (scorecard_url is the share surface)', async () => {
    const env = makeEnv();
    const res = await handleScore(postScore('ripgrep'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      share_url?: string;
      scorecard: { kind?: string; scorecard_url?: string; score_pct?: number | null };
    };
    expect(body.share_url).toBeUndefined();
    expect(body.scorecard.kind).toBe('registry_hit');
    expect(body.scorecard.scorecard_url).toBe('/score/ripgrep');
  });

  test('registry_hit carries score_pct for the curated-reward UX', async () => {
    const env = makeEnv();
    const res = await handleScore(postScore('ripgrep'), env);
    const body = (await res.json()) as {
      scorecard: { kind?: string; score_pct?: number | null };
    };
    expect(body.scorecard.kind).toBe('registry_hit');
    expect(body.scorecard.score_pct).toBe(92);
  });

  test('install-command resolving to a curated tool returns registry_hit, not live (bat fix)', async () => {
    // `cargo install bat` parses to binary='bat'. With the install-command
    // binary cross-check against by_slug in lookupRegistry,
    // this should hit by_slug.bat and return registry_hit, NOT fall through
    // to the cache + live path. Pre-fix behavior would have run the
    // sandbox; post-fix is instant.
    const env = makeEnv();
    const res = await handleScore(postScore('cargo install bat'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scorecard: { kind?: string; scorecard_url?: string; score_pct?: number | null };
      share_url?: string;
    };
    expect(body.scorecard.kind).toBe('registry_hit');
    expect(body.scorecard.scorecard_url).toBe('/score/bat');
    expect(body.scorecard.score_pct).toBe(78);
    // No share_url: registry_hit uses scorecard_url, not /live-score.
    expect(body.share_url).toBeUndefined();
  });

  test('github-url with hint: share_url derives from hint.binary', async () => {
    // Aider-AI/aider has a hint → binary='aider' → cache key
    // scores/aider/<SPEC_VERSION>.json. Prefill that key so the cached
    // branch fires.
    const env = makeEnv({
      'scores/aider/0.4.0.json': {
        spec_version: '0.4.0',
        anc_version: '0.3.1',
        tool_version: '0.50.0',
        scorecard: { badge: { score_pct: 80, eligible: true }, results: [] },
      },
    });
    const res = await handleScore(postScore('https://github.com/Aider-AI/aider'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { share_url?: string };
    expect(body.share_url).toBe('/score/live/aider');
  });

  test('github-url with hint: case-insensitive matching (hintsIndex)', async () => {
    // Lowercase repo path should match the case-preserved hint
    // ('Aider-AI/aider' in HINTS_INDEX).
    const env = makeEnv({
      'scores/aider/0.4.0.json': {
        spec_version: '0.4.0',
        anc_version: '0.3.1',
        tool_version: '0.50.0',
        scorecard: { badge: { score_pct: 80, eligible: true }, results: [] },
      },
    });
    const res = await handleScore(postScore('https://github.com/aider-ai/aider'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { share_url?: string };
    expect(body.share_url).toBe('/score/live/aider');
  });

  test('go-install command: share_url uses last-segment binary derivation', async () => {
    // `go install github.com/user/tool@latest` → parser binary='tool'.
    const env = makeEnv({
      'scores/sqlc/0.4.0.json': {
        spec_version: '0.4.0',
        anc_version: '0.3.1',
        tool_version: '1.27.0',
        scorecard: { badge: { score_pct: 75, eligible: false }, results: [] },
      },
    });
    const res = await handleScore(postScore('go install github.com/sqlc-dev/sqlc@latest'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { share_url?: string };
    expect(body.share_url).toBe('/score/live/sqlc');
  });
});
