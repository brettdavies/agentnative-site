// /api/score regression tests for two real-world input classes that hit
// the live path in distinct ways and need to stay regression-proof:
//
//   1. owner/repo shorthand pointing at a repo with NO install path and
//      NO releases (e.g. brettdavies/dotfiles). Validator routes to
//      github-url. Registry + hints miss. Cache tier skipped (no
//      derivable binary). Live DO runs and returns chain_no_resolve
//      because nothing on the discovery chain produced a binary. The
//      handler must bounce 404 with no share_url AND preserve the R11
//      triad (spec_version + checker_url; anc_version is success-only).
//
//   2. github-url with an explicit branch (`/tree/<branch>`). Per
//      b295e3b: branch-scoped inputs ALWAYS skip the curated + cache
//      tiers and go straight to live scoring. The cache write after
//      the live run is also skipped (do.ts) because caching under the
//      bare binary name would clobber the default-branch scorecard.
//      Two contract checks: branch URL on an uncurated repo runs live;
//      branch URL on a CURATED repo also runs live (curated cross-check
//      is skipped when branch is set).
//
// All tests mock at the DO boundary using the same Sandbox['fetch']
// stub shape score-handler.test.ts uses, so any future Sandbox class
// drift (renamed fetch, changed signature) is a TypeScript error here.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Sandbox } from '../src/worker/score/do';
import { _resetIndexCache, handleScore, type ScoreEnv } from '../src/worker/score/handler';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';
import { validateInput } from '../src/worker/score/validate';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Mirrors score-handler.test.ts: ripgrep is curated under by_slug AND
// by_owner_repo so the branch-vs-curated contract test can prove that
// an explicit branch URL on a curated repo STILL goes live.
const REGISTRY_INDEX = {
  by_slug: {
    ripgrep: {
      name: 'ripgrep',
      binary: 'rg',
      install: 'brew install ripgrep',
      repo: 'BurntSushi/ripgrep',
      version: '15.1.0',
      anc_version: '0.3.0',
      scorecard_url: '/score/ripgrep',
    },
  },
  by_owner_repo: {
    'BurntSushi/ripgrep': {
      name: 'ripgrep',
      binary: 'rg',
      install: 'brew install ripgrep',
      repo: 'BurntSushi/ripgrep',
      version: '15.1.0',
      anc_version: '0.3.0',
      scorecard_url: '/score/ripgrep',
    },
  },
};

// Deliberately empty hints index — brettdavies/dotfiles and orf/gping
// have no hint, so the github-url tier skips cache (no binary derivable
// upfront) and falls through to the live DO path.
const HINTS_INDEX = {
  by_owner_repo: {},
};

type CallTracker = { doCalls: number; lastBody?: unknown };

type StubOverrides = Partial<{
  doResponse: unknown;
  doStatus: number;
  tracker: CallTracker;
  cacheContent: Record<string, unknown>;
}>;

function makeEnv(overrides: StubOverrides = {}): ScoreEnv {
  const doResponse = overrides.doResponse ?? { error: 'sandbox_stub_until_u6' };
  const doStatus = overrides.doStatus ?? 200;

  const tracker = overrides.tracker;
  // Sandbox['fetch'] typing: any future signature change becomes a
  // compile error here, mirroring the pattern documented in
  // score-handler.test.ts's file header.
  const stubFetch: Sandbox['fetch'] = async (req) => {
    if (tracker) {
      tracker.doCalls += 1;
      try {
        tracker.lastBody = await req.clone().json();
      } catch {
        tracker.lastBody = null;
      }
    }
    return new Response(JSON.stringify(doResponse), {
      status: doStatus,
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

  // Turnstile siteverify success — these tests aren't exercising the
  // bot-defense gate, they're exercising the post-Turnstile pipeline.
  const turnstileFetcher = async () =>
    new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  (globalThis as { fetch: typeof fetch }).fetch = turnstileFetcher as unknown as typeof fetch;

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
    SCORE: stubDo as unknown as DurableObjectNamespace,
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
    TURNSTILE_SECRET: 'test-turnstile-secret',
    SESSION_HMAC_SECRET: 'test-hmac-secret-please',
  };
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/api/score — branch URLs + no-release repos', () => {
  // -------------------------------------------------------------------------
  // 1. owner/repo shorthand on a repo that has no install path and no
  //    releases. The live probe against brettdavies/dotfiles returns
  //    chain_no_resolve with no details. The handler maps that to 404.
  // -------------------------------------------------------------------------

  test('owner/repo shorthand validates to github-url with no branch', () => {
    // Pure validator test: `brettdavies/dotfiles` (raw string, no
    // https:// prefix) routes through SHORTHAND_RE → github-url with
    // owner+repo populated and branch undefined.
    const result = validateInput('brettdavies/dotfiles', REGISTRY_INDEX);
    expect(result).toEqual({
      kind: 'github-url',
      owner: 'brettdavies',
      repo: 'dotfiles',
    });
  });

  test('owner/repo shorthand for no-release repo → 404 chain_no_resolve, R11 triad preserved', async () => {
    // Mocks the live-probed behavior: DO clones the repo, runs the
    // discovery chain, finds no install path + no GitHub releases + no
    // binary, returns {error: 'chain_no_resolve'} with no details. The
    // handler must surface 404, preserve spec_version + checker_url,
    // and emit no share_url (no binary derivable for the share surface).
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      tracker,
      doResponse: { error: 'chain_no_resolve' },
    });
    const res = await handleScore(postScore('brettdavies/dotfiles'), env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string };
      spec_version: string;
      checker_url: string;
      share_url?: string;
    };
    expect(body.error.code).toBe('chain_no_resolve');
    expect(body.spec_version).toBeTruthy();
    expect(body.checker_url).toBeTruthy();
    expect(body.share_url).toBeUndefined();
    // Live path WAS reached (cache tier skipped because no derivable binary).
    expect(tracker.doCalls).toBe(1);
  });

  test('owner/repo shorthand for no-binary repo → 502 chain_resolved_no_binary_produced, R11 triad preserved', async () => {
    // Alternate failure mode for the same shape: discovery resolved an
    // install path but the install completed without producing a binary
    // on PATH. Different status (502 vs 404), same triad guarantee, no
    // share_url.
    const env = makeEnv({
      doResponse: {
        error: 'chain_resolved_no_binary_produced',
        details: 'install ran but no binary appeared on PATH',
      },
    });
    const res = await handleScore(postScore('brettdavies/dotfiles'), env);
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { code: string; details?: string };
      spec_version: string;
      checker_url: string;
      share_url?: string;
    };
    expect(body.error.code).toBe('chain_resolved_no_binary_produced');
    expect(body.error.details).toContain('install ran but no binary');
    expect(body.spec_version).toBeTruthy();
    expect(body.checker_url).toBeTruthy();
    expect(body.share_url).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 2. Branch URL on an UNCURATED repo. Live path runs (validates to
  //    github-url with branch set; no hint to derive a cache binary; no
  //    curated entry). Mock DO returns success; assert the response
  //    carries the live scorecard and NO share_url (branch-scoped).
  // -------------------------------------------------------------------------

  test('branch URL on uncurated repo validates to github-url with branch set', () => {
    const result = validateInput('https://github.com/orf/gping/tree/master', REGISTRY_INDEX);
    expect(result).toEqual({
      kind: 'github-url',
      owner: 'orf',
      repo: 'gping',
      branch: 'master',
    });
  });

  test('branch URL on uncurated repo → live DO dispatched, NO share_url on response', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      tracker,
      doResponse: {
        scorecard: {
          tool: { name: 'gping', binary: 'gping', version: null },
          badge: { score_pct: 50, eligible: false },
          score: { value: 50 },
        },
        anc_version: '0.3.1',
      },
    });
    const res = await handleScore(postScore('https://github.com/orf/gping/tree/master'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(1);

    // Verify the DO received the validated input with branch set — the
    // do.ts side uses this to thread the branch into the git clone.
    const sent = tracker.lastBody as { input?: { kind?: string; branch?: string } } | undefined;
    expect(sent?.input?.kind).toBe('github-url');
    expect(sent?.input?.branch).toBe('master');

    const body = (await res.json()) as {
      scorecard: { kind?: string; tool: { name: string } };
      share_url?: string;
      anc_version: string;
      spec_version: string;
      checker_url: string;
    };
    // NOT registry_hit — branch-scoped inputs never wear the curated kind.
    expect(body.scorecard.kind).toBeUndefined();
    expect(body.scorecard.tool.name).toBe('gping');
    // Branch-scoped inputs never get a share URL (per deriveShareBinary).
    expect(body.share_url).toBeUndefined();
    // R11 triad on success.
    expect(body.spec_version).toBeTruthy();
    expect(body.checker_url).toBeTruthy();
    expect(body.anc_version).toBe('0.3.1');
  });

  // -------------------------------------------------------------------------
  // 3. Branch URL on a CURATED repo. This is the contract test that pins
  //    "explicit branch ALWAYS goes live, even for curated repos." If a
  //    future change accidentally re-enables the curated cross-check for
  //    branch URLs, this test fails loudly.
  // -------------------------------------------------------------------------

  test('branch URL on curated repo → curated cross-check SKIPPED, live DO dispatched', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      tracker,
      doResponse: {
        scorecard: {
          tool: { name: 'ripgrep', binary: 'rg', version: '15.1.0' },
          badge: { score_pct: 88, eligible: true },
          score: { value: 88 },
        },
        anc_version: '0.3.1',
      },
    });
    const res = await handleScore(postScore('https://github.com/BurntSushi/ripgrep/tree/master'), env);
    expect(res.status).toBe(200);
    // The whole point: curated registry has BurntSushi/ripgrep, but the
    // branch URL still went live.
    expect(tracker.doCalls).toBe(1);

    const body = (await res.json()) as {
      scorecard: { kind?: string; scorecard_url?: string; tool: { name: string }; score?: { value: number } };
      share_url?: string;
      anc_version: string;
    };
    // NOT registry_hit — even though by_owner_repo['BurntSushi/ripgrep']
    // exists, the branch flag forced the live path.
    expect(body.scorecard.kind).toBeUndefined();
    expect(body.scorecard.scorecard_url).toBeUndefined();
    expect(body.scorecard.tool.name).toBe('ripgrep');
    expect(body.scorecard.score?.value).toBe(88);
    // No share_url — branch-scoped, even for curated.
    expect(body.share_url).toBeUndefined();
    expect(body.anc_version).toBe('0.3.1');
  });

  test('branch URL on curated repo bypasses R2 cache too (prefilled curated key unreachable)', async () => {
    // Defense-in-depth on the cache tier: if someone prefills the cache
    // under the curated binary's key (scores/rg/...), a branch-scoped
    // request must still go live. This pins the "branch URL skips both
    // tiers" contract; not just the registry tier.
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      tracker,
      cacheContent: {
        'scores/rg/0.4.0.json': {
          spec_version: '0.4.0',
          anc_version: '0.3.1',
          tool_version: '15.1.0',
          scorecard: { tool: { name: 'ripgrep', binary: 'rg', version: '15.1.0' }, score: { value: 99 } },
        },
      },
      doResponse: {
        scorecard: { tool: { name: 'ripgrep', binary: 'rg', version: '15.1.0' }, score: { value: 77 } },
        anc_version: '0.3.1',
      },
    });
    const res = await handleScore(postScore('https://github.com/BurntSushi/ripgrep/tree/master'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(1);
    const body = (await res.json()) as { scorecard: { score?: { value: number } } };
    // The live DO's score (77), not the prefilled cache's (99).
    expect(body.scorecard.score?.value).toBe(77);
  });
});
