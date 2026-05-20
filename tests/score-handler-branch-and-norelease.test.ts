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

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Sandbox } from '../src/worker/score/do';
import { _resetAccessibilityCache } from '../src/worker/score/github-accessibility';
import { _resetIndexCache, handleScore, type ScoreEnv } from '../src/worker/score/handler';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';
import { validateInput } from '../src/worker/score/validate';

// Snapshot globalThis.fetch BEFORE the first makeEnv() override so afterAll
// can restore it. Bun runs tests in a single process; if this file leaves
// the global fetch pointing at our compositeFetcher, subsequent test
// files (score-do.test.ts uses bare `fetch()` in allowedInstall handlers)
// get the wrong dispatcher and surface as `unexpected fetch` errors.
const ORIGINAL_FETCH = globalThis.fetch;

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
// Global fetch tracker captures both the Turnstile siteverify and the
// github HEAD pre-check. Tests assert that the HEAD probe was issued for
// the expected owner/repo (or skipped, when a hint exists / branch is set).
type GithubHeadResponse = { kind: 'status'; status: number } | { kind: 'throw'; error: unknown };

type StubOverrides = Partial<{
  doResponse: unknown;
  doStatus: number;
  tracker: CallTracker;
  cacheContent: Record<string, unknown>;
  // Keys are `<owner>/<repo>` lowercased. The pre-check uses lowercase
  // owner+repo in its in-isolate cache key; we mirror that here so a
  // case-mismatched paste still finds the mock.
  githubHeadResponses: Record<string, GithubHeadResponse>;
  githubFetchTracker: { calls: string[] };
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

  // globalThis.fetch dispatch: Turnstile siteverify and the github HEAD
  // pre-check both read globalThis.fetch in production. We dispatch on URL
  // so a single override covers both. Default for github.com is "accessible"
  // (200) — tests that need a private/nonexistent repo pass an explicit
  // `githubHeadResponses` entry. Default for Turnstile is success — these
  // tests don't exercise the bot-defense gate.
  const githubHeadResponses = overrides.githubHeadResponses ?? {};
  const githubFetchTracker = overrides.githubFetchTracker;
  const compositeFetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('https://github.com/')) {
      const ownerRepo = url.slice('https://github.com/'.length).toLowerCase();
      if (githubFetchTracker) githubFetchTracker.calls.push(ownerRepo);
      const mock = githubHeadResponses[ownerRepo];
      if (mock?.kind === 'throw') throw mock.error;
      // Default behavior: HEAD returns 200 (repo accessible). Tests that
      // need a 404 or 5xx pass an explicit mock entry above.
      const status = mock?.kind === 'status' ? mock.status : 200;
      // Sanity guard against accidentally letting a method other than HEAD
      // sneak through: the real handler ONLY issues HEAD here, and if a
      // future regression switched to GET, this test would surface it.
      expect(init?.method).toBe('HEAD');
      return new Response(null, { status, headers: { 'content-type': 'text/html' } });
    }
    // Anything else (unexpected) — surface the URL so a stray fetch is
    // visible in test output rather than silently returning success.
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  (globalThis as { fetch: typeof fetch }).fetch = compositeFetcher as unknown as typeof fetch;

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
  _resetAccessibilityCache();
});

// Restore the original globalThis.fetch so this file doesn't poison
// subsequent test files (score-do.test.ts in particular uses bare fetch()
// inside allowedInstall handlers and depends on the unmocked global).
afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
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

// ---------------------------------------------------------------------------
// /api/score — github accessibility pre-check (private / nonexistent repo)
//
// Avoids paying the DO sandbox cold-start cost on a request that cannot
// resolve a binary regardless: github 404 on the repo root means private,
// renamed, or never existed. Fast-fail with `github_repo_not_accessible`
// instead of spinning up the sandbox to discover the same fact.
//
// Skip matrix (proceed to DO without probing):
//   - github-url with explicit branch (DO clones; HEAD on root is silent
//     about branch existence)
//   - github-url that matched a curated discovery hint (we already know
//     the install path; a transient github 404 shouldn't break a curated
//     repo)
//   - curated registry hits (never reach the pre-check; the lookupScorecard
//     tier returns 'curated' before we get here)
//   - non-github-url inputs (no repo to probe)
//
// Fail-OPEN matrix (proceed to DO when github itself misbehaves):
//   - HEAD returns 5xx
//   - HEAD throws (timeout, network error)
// ---------------------------------------------------------------------------

describe('/api/score — github accessibility pre-check', () => {
  // -------------------------------------------------------------------------
  // 1. Private / nonexistent repo: HEAD 404 → fast-fail, no DO dispatched.
  //    This is the user-reported case (brettdavies/solutions is private; the
  //    sandbox would otherwise burn a cold-start trying to discover a
  //    binary). The fast-fail status is 404 — same as chain_no_resolve —
  //    but the error.code differs so the client can render a precise
  //    "GitHub couldn't find that repo" bounce panel instead of the
  //    generic "no pre-built binary" copy.
  // -------------------------------------------------------------------------

  test('private/nonexistent repo → fast-fail with github_repo_not_accessible, no DO dispatched', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      tracker,
      githubHeadResponses: {
        'brettdavies/solutions': { kind: 'status', status: 404 },
      },
    });
    const res = await handleScore(postScore('brettdavies/solutions'), env);
    expect(res.status).toBe(404);
    expect(tracker.doCalls).toBe(0);
    const body = (await res.json()) as {
      error: { code: string };
      spec_version: string;
      checker_url: string;
    };
    expect(body.error.code).toBe('github_repo_not_accessible');
    // R11 triad on error.
    expect(body.spec_version).toBeTruthy();
    expect(body.checker_url).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 2. Public repo: HEAD 200 → DO dispatched as usual. Mirrors the existing
  //    brettdavies/dotfiles test but pins the pre-check explicitly so a
  //    future change that flipped the default (e.g., treating all 2xx as
  //    not_accessible) would fail loudly here.
  // -------------------------------------------------------------------------

  test('public repo → HEAD 200, DO dispatched', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const headTracker = { calls: [] as string[] };
    const env = makeEnv({
      tracker,
      githubFetchTracker: headTracker,
      githubHeadResponses: {
        'brettdavies/dotfiles': { kind: 'status', status: 200 },
      },
      doResponse: { error: 'chain_no_resolve' },
    });
    const res = await handleScore(postScore('brettdavies/dotfiles'), env);
    // chain_no_resolve from DO, but the important thing is the DO was
    // reached. The chain_no_resolve case is already covered above; here
    // we're proving the pre-check did NOT short-circuit the live path.
    expect(res.status).toBe(404);
    expect(tracker.doCalls).toBe(1);
    expect(headTracker.calls).toContain('brettdavies/dotfiles');
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('chain_no_resolve');
  });

  // -------------------------------------------------------------------------
  // 3. Branch URL skips the pre-check. The DO needs to clone regardless,
  //    and HEAD on the repo root is silent about whether the branch ref
  //    exists — so the probe wouldn't add information. The skip path also
  //    avoids a confusing UX where a public-repo + nonexistent-branch
  //    paste 200s on the pre-check and then errors at the DO with the
  //    real failure code.
  // -------------------------------------------------------------------------

  test('explicit branch URL → skips pre-check (DO needs to clone regardless)', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const headTracker = { calls: [] as string[] };
    const env = makeEnv({
      tracker,
      githubFetchTracker: headTracker,
      // Intentionally NOT providing a githubHeadResponses entry: the
      // compositeFetcher would throw `unexpected fetch` if the handler
      // tried to probe github here, and the test would fail loudly.
      doResponse: {
        scorecard: { tool: { name: 'gping', binary: 'gping', version: null } },
        anc_version: '0.3.1',
      },
    });
    const res = await handleScore(postScore('https://github.com/orf/gping/tree/master'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(1);
    expect(headTracker.calls).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 4. Hint-matched repo skips the pre-check. Curated install metadata
  //    already exists; a transient github 404 shouldn't break the live
  //    path for a repo we explicitly know how to install. (We DON'T match
  //    on score-card existence — that's the curated-registry tier above.)
  //    The hint case is github-url that matched discovery-hints, not
  //    by_owner_repo.
  // -------------------------------------------------------------------------

  test('hint-matched repo → skips pre-check', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const headTracker = { calls: [] as string[] };
    // Per-test env override: inject a hint for aider-ai/aider so the
    // registry-lookup tier returns 'hint', which the handler treats as
    // "skip the HEAD probe" (we already curate install metadata).
    const baseEnv = makeEnv({
      tracker,
      githubFetchTracker: headTracker,
      doResponse: {
        scorecard: { tool: { name: 'aider', binary: 'aider', version: '0.50.0' } },
        anc_version: '0.3.1',
      },
    });
    const envWithHints: ScoreEnv = {
      ...baseEnv,
      ASSETS: {
        async fetch(req: Request | string): Promise<Response> {
          const url = typeof req === 'string' ? req : req.url;
          const path = new URL(url).pathname;
          if (path === '/registry-index.json') {
            return new Response(JSON.stringify(REGISTRY_INDEX), { status: 200 });
          }
          if (path === '/discovery-hints-index.json') {
            // Aider hint: matches what discovery-hints index ships for
            // aider-ai/aider in production. The presence of this hint
            // gates the pre-check skip.
            return new Response(
              JSON.stringify({
                by_owner_repo: {
                  'Aider-AI/aider': { pm: 'pip', package: 'aider-chat', binary: 'aider' },
                },
              }),
              { status: 200 },
            );
          }
          return new Response('not found', { status: 404 });
        },
      } as Fetcher,
    };
    const res = await handleScore(postScore('https://github.com/Aider-AI/aider'), envWithHints);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(1);
    // The whole point: no HEAD probe was issued. compositeFetcher would
    // throw `unexpected fetch` if one had been — but additionally we
    // assert the tracker for clarity.
    expect(headTracker.calls).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 5. Curated registry hit never reaches the pre-check. The
  //    lookupScorecard tier returns 'curated' for slugs / curated
  //    by_owner_repo entries; the handler short-circuits at step 2 with
  //    a `registry_hit` envelope and never touches Turnstile, rate-limit,
  //    HEAD probe, or DO.
  // -------------------------------------------------------------------------

  test('curated by_owner_repo → registry-fast-path wins, no HEAD probe', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const headTracker = { calls: [] as string[] };
    const env = makeEnv({
      tracker,
      githubFetchTracker: headTracker,
    });
    const res = await handleScore(postScore('https://github.com/BurntSushi/ripgrep'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scorecard: { kind?: string; scorecard_url?: string } };
    expect(body.scorecard.kind).toBe('registry_hit');
    expect(body.scorecard.scorecard_url).toBe('/score/ripgrep');
    // Registry hit unmetered: no Turnstile, no DO, no HEAD probe.
    expect(tracker.doCalls).toBe(0);
    expect(headTracker.calls).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 6. Fail-OPEN: github HEAD 5xx → proceed to DO. A transient github
  //    outage must not silently break scoring; the DO will run its own
  //    probe and produce an honest error if the repo is genuinely
  //    broken. Same contract for HEAD throwing (timeout, network).
  // -------------------------------------------------------------------------

  test('github HEAD 5xx → fail-open, DO dispatched', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      tracker,
      githubHeadResponses: {
        'brettdavies/dotfiles': { kind: 'status', status: 503 },
      },
      doResponse: { error: 'chain_no_resolve' },
    });
    const res = await handleScore(postScore('brettdavies/dotfiles'), env);
    // DO ran, returned chain_no_resolve. The point is that the pre-check
    // did NOT fast-fail with github_repo_not_accessible.
    expect(res.status).toBe(404);
    expect(tracker.doCalls).toBe(1);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('chain_no_resolve');
  });

  test('github HEAD throws (network timeout) → fail-open, DO dispatched', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      tracker,
      githubHeadResponses: {
        // The probe's AbortController uses DOMException('AbortError'); we
        // surface that shape so the accessibility module sees a real
        // timeout and tags reason='timeout'. The handler's fail-open
        // path doesn't actually branch on the reason — any 'unknown'
        // proceeds — but we throw the realistic shape for honesty.
        'brettdavies/dotfiles': { kind: 'throw', error: new DOMException('aborted', 'AbortError') },
      },
      doResponse: { error: 'chain_no_resolve' },
    });
    const res = await handleScore(postScore('brettdavies/dotfiles'), env);
    expect(res.status).toBe(404);
    expect(tracker.doCalls).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 7. Red-team: slug validation must happen BEFORE the URL is built.
  //    validate.ts already enforces this at the Worker boundary, so a
  //    bad slug never reaches the handler; this test pins the module's
  //    own guard in place against a future caller that bypasses
  //    validate.ts (e.g., a new internal route). We call the
  //    accessibility module directly because the integration path is
  //    sealed.
  // -------------------------------------------------------------------------

  test('accessibility module refuses invalid slug without issuing fetch (defense-in-depth)', async () => {
    const { checkGithubAccessibility } = await import('../src/worker/score/github-accessibility');
    let fetchCalls = 0;
    const sentinelFetcher = (async () => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    // Each input is something validate.ts already rejects (path traversal,
    // spaces, semicolons). The module's OWNER_RE / REPO_RE refuse them
    // independently so a regression in validate.ts doesn't open a
    // probe-URL injection.
    const bad: Array<[string, string]> = [
      ['../etc', 'passwd'],
      ['foo bar', 'baz'],
      ['ok-owner', 'evil; rm -rf'],
      ['-leading-hyphen', 'ok'],
      ['', 'ok'],
      ['ok', ''],
    ];
    for (const [owner, repo] of bad) {
      const result = await checkGithubAccessibility(owner, repo, { fetcher: sentinelFetcher });
      expect(result.state).toBe('unknown');
      if (result.state === 'unknown') {
        expect(result.reason).toBe('invalid_slug');
      }
    }
    expect(fetchCalls).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 8. Red-team: HEAD must not follow redirects to non-github hosts. A
  //    hypothetical github 30x to evil.com is benign in production
  //    (github doesn't do that), but the manual-redirect mode makes the
  //    safety property structural. We pin the behavior so a future
  //    refactor that switched to `redirect: 'follow'` would fail here.
  // -------------------------------------------------------------------------

  test('accessibility module treats 30x as accessible without dereferencing Location', async () => {
    const { checkGithubAccessibility, _resetAccessibilityCache: resetCache } = await import(
      '../src/worker/score/github-accessibility'
    );
    resetCache();
    let calls = 0;
    const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      // Redirect mode MUST be 'manual' — otherwise a follow could pivot
      // off-host. This assertion fires if a future refactor relaxes it.
      expect(init?.redirect).toBe('manual');
      return new Response(null, {
        status: 301,
        headers: { Location: 'https://evil.com/owner/repo' },
      });
    }) as unknown as typeof fetch;
    const result = await checkGithubAccessibility('Renamed-Owner', 'renamed-repo', { fetcher });
    expect(result.state).toBe('accessible');
    // Exactly one fetch — no follow.
    expect(calls).toBe(1);
  });
});
