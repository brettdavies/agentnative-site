// Post-discovery share-URL derivation tests. See TODO 025.
//
// Bug class: for github-url inputs without a hint, the handler computed
// share_url upfront via deriveShareBinary(input, hints) — which returns
// null when no hint matches. The DO would still discover the binary and
// write the scorecard to R2 under scores/<binary>/<spec_version>.json,
// but the response carried no share_url, so the homepage form fell into
// the "no shareable URL yet" branch and the user could never re-visit
// /score/live/<binary> even though R2 held the entry.
//
// This file pins:
//   - github-url WITHOUT a hint → live discovery → share_url derives
//     from spec.binary (DO's R2 write key).
//   - The same applies to the post-discovery cache-hit branch.
//   - Branch-scoped pastes stay null.
//   - install-command + github-url-with-hint stay unchanged.
//
// Red-team:
//   - spec.binary returns a slug the /score/live/<binary> route rejects
//     (uppercase, underscore, dot) — share_url is null, not a 404-bound URL.
//   - DO success envelope where scorecard.tool.binary disagrees with
//     spec.binary — the DO writes the cache by spec.binary, so share_url
//     must follow spec.binary, not the scorecard payload.
//   - Discovery resolves but the binary contains shell-special characters
//     somehow (defense in depth past validate.ts) — share_url is null.

import { beforeEach, describe, expect, test } from 'bun:test';
import { keyFor } from '../src/worker/score/cache';
import type { Sandbox } from '../src/worker/score/do';
import { _resetAccessibilityCache } from '../src/worker/score/github-accessibility';
import { _resetIndexCache, handleScore, type ScoreEnv } from '../src/worker/score/handler';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

const REGISTRY_INDEX = {
  by_slug: {},
  by_owner_repo: {},
};

// No hints — the bug class is precisely github-url WITHOUT a curated hint.
const HINTS_INDEX = {
  by_owner_repo: {},
};

type CallTracker = { doCalls: number; lastSpecBinary: string | null };

type SmartFetchOverrides = {
  // The Releases asset name the discovery chain accepts as Step 2 hit.
  // Defaults to a well-formed linux-x86_64 archive.
  releaseAssetName?: string;
  // If true, the github accessibility HEAD probe returns 200; otherwise 404.
  githubAccessible?: boolean;
};

// Build a fetcher that satisfies the live-path's outbound calls without
// requiring a real network. Anything not explicitly modeled returns 404 so
// discovery's parallel fan-out falls through to whichever steps DO match.
function buildSmartFetch(opts: SmartFetchOverrides = {}): typeof fetch {
  const releaseAssetName = opts.releaseAssetName ?? 'hexyl-v0.16.0-x86_64-unknown-linux-gnu.tar.gz';
  const githubAccessible = opts.githubAccessible ?? true;

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);

    if (u.hostname === 'challenges.cloudflare.com') {
      // Turnstile siteverify — accept any token.
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.hostname === 'github.com' && init?.method === 'HEAD') {
      // Accessibility probe.
      return new Response(null, { status: githubAccessible ? 200 : 404 });
    }
    if (u.hostname === 'api.github.com' && u.pathname.endsWith('/releases/latest')) {
      // Discovery step 2 — release asset.
      return new Response(
        JSON.stringify({
          assets: [
            {
              name: releaseAssetName,
              browser_download_url: `https://github.com/owner/repo/releases/download/v1/${releaseAssetName}`,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    // Everything else (brew/crates/npm/pypi/go/readme) misses.
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function makeEnv(
  overrides: {
    cacheContent?: Record<string, unknown>;
    doResponse?: unknown;
    doStatus?: number;
    tracker?: CallTracker;
    noScoreBinding?: boolean;
  } = {},
): ScoreEnv {
  const cacheStore = new Map<string, string>();
  for (const [k, v] of Object.entries(overrides.cacheContent ?? {})) {
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

  const tracker = overrides.tracker;
  const stubFetch: Sandbox['fetch'] = async (req) => {
    if (tracker) {
      tracker.doCalls += 1;
      try {
        const body = (await req.clone().json()) as { spec?: { binary?: string } };
        tracker.lastSpecBinary = body.spec?.binary ?? null;
      } catch {
        tracker.lastSpecBinary = null;
      }
    }
    return new Response(JSON.stringify(overrides.doResponse ?? { error: 'incomplete_response_contract' }), {
      status: overrides.doStatus ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const stubDo = {
    idFromName(_name: string) {
      return { id: 'stub' };
    },
    get(_id: unknown) {
      return { fetch: stubFetch };
    },
  };

  const env: ScoreEnv = {
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
    SCORE_TELEMETRY: { writeDataPoint() {} },
    TURNSTILE_SECRET: 'test',
    SESSION_HMAC_SECRET: 'test-hmac-secret-long-enough',
  } as ScoreEnv;
  if (!overrides.noScoreBinding) {
    env.SCORE = stubDo as unknown as DurableObjectNamespace;
  }
  return env;
}

function postScore(input: string): Request {
  return new Request('https://anc.dev/api/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, turnstile_token: 'tok' }),
  });
}

// Save/restore the global fetch so smart-fetch overrides don't leak across
// describe blocks. Bun's beforeEach scope is per-describe; we rebind here.
let savedFetch: typeof fetch;

beforeEach(() => {
  _resetIndexCache();
  _resetKillSwitchCache();
  _resetAccessibilityCache();
  savedFetch = globalThis.fetch;
});

function installSmartFetch(opts: SmartFetchOverrides = {}): void {
  (globalThis as { fetch: typeof fetch }).fetch = buildSmartFetch(opts);
}

function restoreFetch(): void {
  (globalThis as { fetch: typeof fetch }).fetch = savedFetch;
}

describe('/api/score — share_url for github-url WITHOUT a hint (post-discovery)', () => {
  // Sharkdp/hexyl is one of the two tools reproed on staging (see TODO 025).
  // Not in REGISTRY_INDEX, no hint. Discovery resolves to binary='hexyl'.
  test('live success: share_url derives from discovered spec.binary', async () => {
    installSmartFetch({ releaseAssetName: 'hexyl-v0.16.0-x86_64-unknown-linux-gnu.tar.gz' });
    try {
      const tracker: CallTracker = { doCalls: 0, lastSpecBinary: null };
      const env = makeEnv({
        tracker,
        doResponse: {
          scorecard: { tool: { name: 'hexyl', binary: 'hexyl', version: '0.16.0' }, badge: { score_pct: 70 } },
          anc_version: '0.3.1',
        },
      });
      const res = await handleScore(postScore('https://github.com/sharkdp/hexyl'), env);
      expect(res.status).toBe(200);
      expect(tracker.doCalls).toBe(1);
      // The DO MUST have received spec.binary='hexyl' — pins the
      // cache-key derivation to the same value the share URL uses.
      expect(tracker.lastSpecBinary).toBe('hexyl');
      const body = (await res.json()) as { share_url?: string; scorecard: unknown };
      expect(body.share_url).toBe('/score/live/hexyl');
    } finally {
      restoreFetch();
    }
  });

  // O2sh/onefetch is the second tool reproed on staging.
  test('live success: second tool from TODO repro (onefetch) also gets share_url', async () => {
    installSmartFetch({ releaseAssetName: 'onefetch-linux-x86_64.tar.gz' });
    try {
      const tracker: CallTracker = { doCalls: 0, lastSpecBinary: null };
      const env = makeEnv({
        tracker,
        doResponse: {
          scorecard: { tool: { name: 'onefetch', binary: 'onefetch', version: '2.22.0' }, badge: { score_pct: 65 } },
          anc_version: '0.3.1',
        },
      });
      const res = await handleScore(postScore('https://github.com/o2sh/onefetch'), env);
      expect(res.status).toBe(200);
      expect(tracker.lastSpecBinary).toBe('onefetch');
      const body = (await res.json()) as { share_url?: string };
      expect(body.share_url).toBe('/score/live/onefetch');
    } finally {
      restoreFetch();
    }
  });

  // The fix must derive share_url from spec.binary — NOT from the
  // scorecard.tool.binary the DO returns. The DO writes the cache by
  // spec.binary; if we read tool.binary instead and they disagree,
  // share_url points at a key that doesn't exist.
  test('drift: share_url follows spec.binary even when scorecard.tool.binary differs', async () => {
    installSmartFetch({ releaseAssetName: 'hexyl-v0.16.0-x86_64-unknown-linux-gnu.tar.gz' });
    try {
      const tracker: CallTracker = { doCalls: 0, lastSpecBinary: null };
      const env = makeEnv({
        tracker,
        doResponse: {
          // tool.binary lies — claims 'something-else' even though the DO
          // wrote scores/hexyl/<spec>.json under the spec.binary it
          // received. Defense in depth: trust the spec, not the payload.
          scorecard: {
            tool: { name: 'hexyl', binary: 'something-else', version: '0.16.0' },
            badge: { score_pct: 70 },
          },
          anc_version: '0.3.1',
        },
      });
      const res = await handleScore(postScore('https://github.com/sharkdp/hexyl'), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { share_url?: string };
      // Must follow spec.binary (hexyl, the cache key), not the scorecard.
      expect(body.share_url).toBe('/score/live/hexyl');
    } finally {
      restoreFetch();
    }
  });

  test('post-discovery cache hit: share_url derives from resolved spec.binary', async () => {
    // Discovery resolves binary='hexyl'. R2 already holds a prior scorecard
    // under scores/hexyl/<SPEC_VERSION>.json. The handler short-circuits
    // at the post-discovery cache tier (step 6.5) and must still return
    // share_url.
    installSmartFetch();
    try {
      const tracker: CallTracker = { doCalls: 0, lastSpecBinary: null };
      const env = makeEnv({
        tracker,
        cacheContent: {
          [keyFor('hexyl', SPEC_VERSION)]: {
            spec_version: SPEC_VERSION,
            anc_version: '0.3.1',
            tool_version: '0.16.0',
            scorecard: { tool: { name: 'hexyl', binary: 'hexyl' }, badge: { score_pct: 70 } },
          },
        },
      });
      const res = await handleScore(postScore('https://github.com/sharkdp/hexyl'), env);
      expect(res.status).toBe(200);
      // DO must NOT be dispatched — cache_post tier served the response.
      expect(tracker.doCalls).toBe(0);
      const body = (await res.json()) as { share_url?: string };
      expect(body.share_url).toBe('/score/live/hexyl');
    } finally {
      restoreFetch();
    }
  });
});

describe('/api/score — share_url red-team for github-url WITHOUT a hint', () => {
  test('discovered binary with uppercase letters: share_url is null (route would 404)', async () => {
    // BINARY_SLUG_RE in summary-render.ts (/^[a-z0-9][a-z0-9-]{0,63}$/)
    // rejects uppercase. The DO will still write to R2 under whatever
    // spec.binary contains (no slug enforcement in the cache key), but
    // /score/live/MyTool would 404 at the route. Refuse to mint such a
    // share URL.
    installSmartFetch({ releaseAssetName: 'MyTool-v1-x86_64-linux.tar.gz' });
    try {
      const tracker: CallTracker = { doCalls: 0, lastSpecBinary: null };
      const env = makeEnv({
        tracker,
        doResponse: {
          // Repo discovery returns ctx.repo as binary — if the repo is
          // 'MyTool' (mixed case, which validate.ts allows because GitHub
          // repos can be mixed-case), the binary leaks through.
          scorecard: { tool: { name: 'MyTool', binary: 'MyTool' }, badge: { score_pct: 50 } },
          anc_version: '0.3.1',
        },
      });
      const res = await handleScore(postScore('https://github.com/some-org/MyTool'), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { share_url?: string };
      expect(body.share_url).toBeUndefined();
    } finally {
      restoreFetch();
    }
  });

  test('discovered binary with underscore: share_url is null', async () => {
    // GitHub repos can contain underscores (e.g., `my_tool`). The
    // /score/live/<binary> route's BINARY_SLUG_RE rejects underscores;
    // refuse to mint a share URL that would 404.
    installSmartFetch({ releaseAssetName: 'my_tool-x86_64-linux.tar.gz' });
    try {
      const tracker: CallTracker = { doCalls: 0, lastSpecBinary: null };
      const env = makeEnv({
        tracker,
        doResponse: {
          scorecard: { tool: { name: 'my_tool', binary: 'my_tool' }, badge: { score_pct: 50 } },
          anc_version: '0.3.1',
        },
      });
      const res = await handleScore(postScore('https://github.com/some-org/my_tool'), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { share_url?: string };
      expect(body.share_url).toBeUndefined();
    } finally {
      restoreFetch();
    }
  });

  test('discovered binary with period: share_url is null', async () => {
    // GitHub repos can contain periods (e.g., `tool.js`). The
    // /score/live/<binary> route would reject the dot.
    installSmartFetch({ releaseAssetName: 'tool.js-x86_64-linux.tar.gz' });
    try {
      const tracker: CallTracker = { doCalls: 0, lastSpecBinary: null };
      const env = makeEnv({
        tracker,
        doResponse: {
          scorecard: { tool: { name: 'tool.js', binary: 'tool.js' }, badge: { score_pct: 50 } },
          anc_version: '0.3.1',
        },
      });
      const res = await handleScore(postScore('https://github.com/some-org/tool.js'), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { share_url?: string };
      expect(body.share_url).toBeUndefined();
    } finally {
      restoreFetch();
    }
  });

  test('discovered binary leading hyphen: share_url is null', async () => {
    // BINARY_SLUG_RE requires the first char to be alphanumeric.
    installSmartFetch({ releaseAssetName: '-bad-x86_64-linux.tar.gz' });
    try {
      const env = makeEnv({
        doResponse: {
          scorecard: { tool: { name: '-bad', binary: '-bad' }, badge: { score_pct: 0 } },
          anc_version: '0.3.1',
        },
      });
      const res = await handleScore(postScore('https://github.com/some-org/-bad-repo'), env);
      // Validate.ts rejects owner with leading hyphen, but we hit this via
      // an invented binary value out of the DO regardless of input.
      // (Input itself may or may not pass validate; share-URL guard is
      // the last line of defense.)
      const body = (await res.json()) as { share_url?: string };
      expect(body.share_url).toBeUndefined();
      void res.status;
    } finally {
      restoreFetch();
    }
  });
});

describe('/api/score — branch-scoped pastes (existing behavior unchanged)', () => {
  test('github-url with /tree/<branch>: share_url stays null', async () => {
    installSmartFetch();
    try {
      const tracker: CallTracker = { doCalls: 0, lastSpecBinary: null };
      const env = makeEnv({
        tracker,
        doResponse: {
          scorecard: { tool: { name: 'hexyl', binary: 'hexyl', version: 'branch' }, badge: { score_pct: 70 } },
          anc_version: '0.3.1',
        },
      });
      const res = await handleScore(postScore('https://github.com/sharkdp/hexyl/tree/feature/foo'), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { share_url?: string };
      expect(body.share_url).toBeUndefined();
    } finally {
      restoreFetch();
    }
  });
});
