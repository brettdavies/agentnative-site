// /api/score handler orchestration tests.
//
// Plan U5 verification — exercises the full pipeline against stubbed
// bindings (ASSETS / DO / KV / rate-limit / Turnstile fetcher). Each test
// reaches one branch of the handler and asserts on status + envelope
// shape + R11 triad presence.
//
// DO mock fidelity (U6 plan amendment, 2026-05-15):
//
//   The U5-era stub returned `{error: 'sandbox_stub_until_u6'}` from a
//   hand-rolled `.fetch()` mock that bypassed the binding-boundary check
//   the production runtime enforces. PR #93 shipped a real DO class with
//   no `fetch()` method and the first staging POST threw `Handler does
//   not export a fetch() function` (Cloudflare error 1101). The mock had
//   a `.fetch` property; the real DO didn't.
//
//   This file tightens the mock by typing the stub's fetch handler via
//   `Sandbox['fetch']` so any future Sandbox class that loses or renames
//   `fetch` is a compile error here, not a first-deploy 5xx. See
//   docs/solutions/integration-issues/cloudflare-workers-do-mock-must-mirror-binding-shape-2026-05-15.md
//   for the full pattern + prevention recipe.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Sandbox } from '../src/worker/score/do';
import { _resetIndexCache, handleScore, type ScoreEnv } from '../src/worker/score/handler';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    'no-card-tool': {
      name: 'no-card-tool',
      binary: 'no-card-tool',
      install: 'brew install no-card-tool',
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

const HINTS_INDEX = { by_owner_repo: {} };

type CallTracker = { doCalls: number };

type StubOverrides = Partial<{
  kvDisabled: boolean;
  turnstileSecret: string;
  hmacSecret: string;
  turnstileResponse: { success: boolean };
  doResponse: unknown;
  doStatus: number;
  rateLimit: boolean;
  ipRateLimit: boolean;
  // Plan U7: prefill SCORE_CACHE with these payloads (key → JSON-encoded body).
  cacheContent: Record<string, unknown>;
  // Plan U7: if true, the SCORE_CACHE.get stub throws — exercises the
  // best-effort read-failure path in cache.get.
  cacheThrows: boolean;
  // Optional tracker so cache-tier tests can assert the DO was NOT
  // dispatched. Mutated in place by the stub fetch.
  tracker: CallTracker;
}>;

function makeEnv(overrides: StubOverrides = {}): ScoreEnv {
  const kvDisabled = overrides.kvDisabled ?? false;
  const turnstileSecret = overrides.turnstileSecret ?? 'test-turnstile-secret';
  const hmacSecret = overrides.hmacSecret ?? 'test-hmac-secret-please';
  const turnstileResponse = overrides.turnstileResponse ?? { success: true };
  const doResponse = overrides.doResponse ?? { error: 'sandbox_stub_until_u6' };
  const doStatus = overrides.doStatus ?? 200;
  const rateLimit = overrides.rateLimit ?? true;
  const ipRateLimit = overrides.ipRateLimit ?? true;

  const stubKv = {
    async get(key: string) {
      if (key === 'scoring_disabled') return kvDisabled ? 'true' : null;
      return null;
    },
  };

  const tracker = overrides.tracker;
  // Type the stub's fetch via `Sandbox['fetch']` so any future Sandbox
  // class that loses or renames `fetch` (or changes its signature) is a
  // TypeScript compile error AND a runtime invocation error in this
  // file. Closes the drift class that PR #93 hit. See file header.
  const stubFetch: Sandbox['fetch'] = async (_req) => {
    if (tracker) tracker.doCalls += 1;
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

  const turnstileFetcher = async () =>
    new Response(JSON.stringify(turnstileResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  // The handler reads globalThis.fetch for Turnstile; we monkey-patch it
  // by swapping it on the env's symbol-keyed slot via the stub at runtime.
  // verifyTurnstile accepts a `fetcher` override in production code but
  // not via env, so we override globalThis.fetch for the test.
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = turnstileFetcher as unknown as typeof fetch;
  // Reset after the test — Bun's afterEach scope is per-describe, so each
  // test resets at the start of the next makeEnv() call. We bind the
  // restore on `env` for explicit teardown if a test wants it.
  void originalFetch;

  const cacheStore = new Map<string, string>();
  for (const [k, v] of Object.entries(overrides.cacheContent ?? {})) {
    cacheStore.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const cacheStub = {
    async get(key: string) {
      if (overrides.cacheThrows) throw new Error('r2_get_failed');
      const raw = cacheStore.get(key);
      if (raw === undefined) return null;
      // Mirror R2's R2ObjectBody surface — `.json()` is the only method
      // src/worker/score/cache.ts actually calls.
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
    SCORE_KV: stubKv as unknown as KVNamespace,
    SCORE_CACHE: cacheStub as unknown as R2Bucket,
    SCORE_LIMITER: {
      async limit() {
        return { success: rateLimit };
      },
    },
    SCORE_LIMITER_IP: {
      async limit() {
        return { success: ipRateLimit };
      },
    },
    TURNSTILE_SECRET: turnstileSecret,
    SESSION_HMAC_SECRET: hmacSecret,
  };
}

function postScore(input: string, opts: { token?: string; cookie?: string; pathSuffix?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`https://anc.dev/api/score${opts.pathSuffix ?? ''}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input, turnstile_token: opts.token ?? 'tok' }),
  });
}

function getScore(input: string | null, pathSuffix = ''): Request {
  const url = new URL(`https://anc.dev/api/score${pathSuffix}`);
  if (input !== null) url.searchParams.set('input', input);
  return new Request(url.toString(), { method: 'GET' });
}

beforeEach(() => {
  _resetIndexCache();
  _resetKillSwitchCache();
});

// ---------------------------------------------------------------------------
// Method gate + input validation
// ---------------------------------------------------------------------------

describe('/api/score — method gate', () => {
  test('DELETE → 405', async () => {
    const res = await handleScore(new Request('https://anc.dev/api/score', { method: 'DELETE' }), makeEnv());
    expect(res.status).toBe(405);
  });
});

describe('/api/score — input validation', () => {
  test('POST without input → 400 unrecognized_input', async () => {
    const res = await handleScore(
      new Request('https://anc.dev/api/score', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turnstile_token: 'tok' }),
      }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unrecognized_input');
  });

  test('GET without input → 400', async () => {
    const res = await handleScore(getScore(null), makeEnv());
    expect(res.status).toBe(400);
  });

  test('POST with malformed body → 400', async () => {
    const res = await handleScore(
      new Request('https://anc.dev/api/score', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Registry-fast-path (unmetered)
// ---------------------------------------------------------------------------

describe('/api/score — registry fast-path', () => {
  test('POST {input: "ripgrep"} → 200 registry_hit with R11 triad', async () => {
    const res = await handleScore(postScore('ripgrep'), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scorecard: { kind: string; scorecard_url: string };
      spec_version: string;
      anc_version: string;
      checker_url: string;
    };
    expect(body.scorecard.kind).toBe('registry_hit');
    expect(body.scorecard.scorecard_url).toBe('/score/ripgrep');
    expect(body.anc_version).toBe('0.3.0');
    expect(body.spec_version).toBeTruthy();
    expect(body.checker_url).toBeTruthy();
  });

  test('GET ?input=ripgrep → 200 (read-only path) with cache-friendly headers', async () => {
    const res = await handleScore(getScore('ripgrep'), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  test('GET ?input=https://github.com/BurntSushi/ripgrep → 200 (URL → registry)', async () => {
    const res = await handleScore(getScore('https://github.com/BurntSushi/ripgrep'), makeEnv());
    expect(res.status).toBe(200);
  });

  test('GET ?input=unknown → 404 chain_no_resolve (GET is registry-only)', async () => {
    // 'unknown-tool' fails validate (not a slug, not a URL, no prefix) →
    // unrecognized_input (400). Use a parseable URL instead.
    const res = await handleScore(getScore('https://github.com/foo/bar'), makeEnv());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('chain_no_resolve');
  });

  test('registry entry without scorecard_url is NOT a fast-path hit', async () => {
    // no-card-tool has no version/anc_version/scorecard_url, so the
    // handler falls through to the live path. POST will exercise the
    // full pipeline; GET will fail with chain_no_resolve at the GET gate.
    const res = await handleScore(getScore('no-card-tool'), makeEnv());
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Kill switch + Turnstile + rate-limit + DO stub (POST-only chain)
// ---------------------------------------------------------------------------

describe('/api/score — POST pipeline error paths', () => {
  test('kill switch on → 503 scoring_disabled with Retry-After: 3600', async () => {
    const res = await handleScore(postScore('https://github.com/foo/bar'), makeEnv({ kvDisabled: true }));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('3600');
  });

  test('turnstile rejection → 400 turnstile_failed', async () => {
    const res = await handleScore(
      postScore('https://github.com/foo/bar'),
      makeEnv({ turnstileResponse: { success: false } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('turnstile_failed');
  });

  test('rate-limited → 429 with Retry-After: 60', async () => {
    const res = await handleScore(postScore('https://github.com/foo/bar'), makeEnv({ rateLimit: false }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  test('per-IP fallback limiter triggers 429 even when session limiter passes', async () => {
    const res = await handleScore(
      postScore('https://github.com/foo/bar'),
      makeEnv({ rateLimit: true, ipRateLimit: false }),
    );
    expect(res.status).toBe(429);
  });

  test('DO stub envelope passthrough → 503 sandbox_stub_until_u6 (defense-in-depth)', async () => {
    // Defense-in-depth: if the production DO binding ever points back at
    // the U3 stub (e.g. via a botched rollback or a misconfigured
    // wrangler.jsonc), the handler still bounces with the sandbox_stub
    // envelope instead of leaking the raw stub error to the user. The
    // isStubError() check in handler.ts is what makes this safe.
    const res = await handleScore(
      postScore('https://github.com/foo/bar'),
      makeEnv({ doResponse: { error: 'sandbox_stub_until_u6' } }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('sandbox_stub_until_u6');
  });

  test('DO returns valid scorecard envelope → 200 with R11 triad', async () => {
    // Post-U6 success path: DO returns {scorecard, anc_version} from
    // sandbox-exec.score(). The handler wraps it into the response shape
    // with spec_version + checker_url. This is the test that pins the
    // U6 → U5 contract.
    const res = await handleScore(
      postScore('https://github.com/foo/bar'),
      makeEnv({
        doResponse: {
          scorecard: { tool: { name: 'bar', binary: 'bar' }, score: { value: 73 } },
          anc_version: '0.3.1',
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      spec_version: string;
      anc_version: string;
      checker_url: string;
      scorecard: { tool: { name: string } };
    };
    expect(body.scorecard.tool.name).toBe('bar');
    expect(body.spec_version).toBeTruthy();
    expect(body.checker_url).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Session cookie issue + verify
// ---------------------------------------------------------------------------

describe('/api/score — session cookie', () => {
  test('first POST issues Set-Cookie with __Host-anc-session', async () => {
    const res = await handleScore(postScore('https://github.com/foo/bar'), makeEnv());
    const cookie = res.headers.get('Set-Cookie');
    expect(cookie).toContain('__Host-anc-session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  test('returning request with valid cookie does NOT re-issue', async () => {
    const env = makeEnv();
    const first = await handleScore(postScore('https://github.com/foo/bar'), env);
    const cookie = first.headers.get('Set-Cookie');
    expect(cookie).toBeTruthy();
    if (!cookie) return;
    // Extract the cookie name=value pair (Set-Cookie includes attributes after `;`)
    const cookiePair = cookie.split(';')[0];

    const second = await handleScore(postScore('https://github.com/foo/bar', { cookie: cookiePair }), env);
    expect(second.headers.get('Set-Cookie')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Service misconfiguration (fail-fast on missing secrets)
// ---------------------------------------------------------------------------

describe('/api/score — service misconfiguration', () => {
  test('missing TURNSTILE_SECRET on POST → 500 service_misconfigured', async () => {
    const env = makeEnv({ turnstileSecret: '' });
    const res = await handleScore(postScore('https://github.com/foo/bar'), env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('service_misconfigured');
  });

  test('missing SESSION_HMAC_SECRET on POST → 500 service_misconfigured', async () => {
    const env = makeEnv({ hmacSecret: '' });
    const res = await handleScore(postScore('https://github.com/foo/bar'), env);
    expect(res.status).toBe(500);
  });

  test('registry-fast-path bypass works even without secrets configured', async () => {
    // The unmetered registry hit must not touch Turnstile or sessions,
    // so a misconfigured Worker can still serve registry-known tools.
    const env = makeEnv({ turnstileSecret: '', hmacSecret: '' });
    const res = await handleScore(postScore('ripgrep'), env);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Content negotiation
// ---------------------------------------------------------------------------

describe('/api/score — content negotiation', () => {
  test('GET /api/score.json?input=ripgrep → JSON', async () => {
    const res = await handleScore(getScore('ripgrep', '.json'), makeEnv());
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  test('GET /api/score.md?input=ripgrep → markdown', async () => {
    const res = await handleScore(getScore('ripgrep', '.md'), makeEnv());
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    const body = await res.text();
    expect(body).toContain('# anc.dev');
  });

  test('Accept: text/markdown;q=0.1, application/json;q=0.9 → JSON (q-value, not substring)', async () => {
    const url = new URL('https://anc.dev/api/score');
    url.searchParams.set('input', 'ripgrep');
    const req = new Request(url.toString(), {
      method: 'GET',
      headers: { accept: 'text/markdown;q=0.1, application/json;q=0.9' },
    });
    const res = await handleScore(req, makeEnv());
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  test('Accept: text/markdown,application/json;q=0.5 → markdown', async () => {
    const url = new URL('https://anc.dev/api/score');
    url.searchParams.set('input', 'ripgrep');
    const req = new Request(url.toString(), {
      method: 'GET',
      headers: { accept: 'text/markdown,application/json;q=0.5' },
    });
    const res = await handleScore(req, makeEnv());
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
  });
});

// ---------------------------------------------------------------------------
// R2 cache tier (plan U7)
// ---------------------------------------------------------------------------

// The cache key uses SPEC_VERSION (build-time constant) as the
// anc-version proxy. The constant currently reads 0.4.0 from
// src/worker/spec-version.gen.ts; if it bumps, update the keys here.
const CACHE_KEY_RIPGREP = 'scores/ripgrep/0.4.0.json';

const CACHED_RIPGREP_PAYLOAD = {
  spec_version: '0.4.0',
  anc_version: '0.3.1',
  tool_version: '15.1.0',
  scorecard: { tool: { name: 'ripgrep', binary: 'ripgrep', version: '15.1.0' }, score: { value: 92 } },
};

describe('/api/score — R2 cache tier (plan U7)', () => {
  test('install-command + R2 hit → 200 cached, DO never dispatched, gates bypassed', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheContent: { [CACHE_KEY_RIPGREP]: CACHED_RIPGREP_PAYLOAD },
      tracker,
      // Hard-fail every metered gate. The cached hit must bypass all of
      // them — proving the unmetered contract (R6 extended to cache).
      turnstileResponse: { success: false },
      rateLimit: false,
      ipRateLimit: false,
    });
    const res = await handleScore(postScore('cargo binstall ripgrep'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(0);
    const body = (await res.json()) as {
      scorecard: { tool: { name: string }; score: { value: number } };
      anc_version: string;
      spec_version: string;
      checker_url: string;
    };
    expect(body.scorecard.tool.name).toBe('ripgrep');
    expect(body.scorecard.score.value).toBe(92);
    expect(body.anc_version).toBe('0.3.1');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  test('install-command + R2 miss → live path runs (DO dispatched)', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheContent: {},
      tracker,
      doResponse: {
        scorecard: { tool: { name: 'ripgrep', version: '15.1.0' } },
        anc_version: '0.3.1',
      },
    });
    const res = await handleScore(postScore('cargo binstall ripgrep'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(1);
    const body = (await res.json()) as { scorecard: { tool: { name: string } } };
    expect(body.scorecard.tool.name).toBe('ripgrep');
  });

  test('?fromCache=false bypasses R2 read, live path runs even with cache prefilled', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheContent: { [CACHE_KEY_RIPGREP]: CACHED_RIPGREP_PAYLOAD },
      tracker,
      doResponse: {
        scorecard: { tool: { name: 'ripgrep', version: '15.1.0' }, score: { value: 50 } },
        anc_version: '0.3.1',
      },
    });
    const req = new Request('https://anc.dev/api/score?fromCache=false', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'cargo binstall ripgrep', turnstile_token: 'tok' }),
    });
    const res = await handleScore(req, env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(1);
    const body = (await res.json()) as { scorecard: { score: { value: number } } };
    // The DO's scorecard (value: 50), not the cached one (value: 92).
    expect(body.scorecard.score.value).toBe(50);
  });

  test('curated registry hit still wins over R2 cache (commit ordering)', async () => {
    // If a curated entry AND a cached entry both exist for the same
    // binary, the curated one must win because it points at a stable
    // /score/<slug> page. Cached entries are launch-time live scores
    // and should never override committed scorecards.
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      // Pre-seed the cache under the slug's binary key. The registry
      // already has ripgrep with scorecard_url + anc_version.
      cacheContent: { 'scores/rg/0.4.0.json': CACHED_RIPGREP_PAYLOAD },
      tracker,
    });
    const res = await handleScore(postScore('ripgrep'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(0);
    const body = (await res.json()) as { scorecard: { kind?: string; scorecard_url?: string } };
    expect(body.scorecard.kind).toBe('registry_hit');
    expect(body.scorecard.scorecard_url).toBe('/score/ripgrep');
  });

  test('R2 read failure → treated as miss, live path runs', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheThrows: true,
      tracker,
      doResponse: {
        scorecard: { tool: { name: 'ripgrep', version: '15.1.0' } },
        anc_version: '0.3.1',
      },
    });
    const res = await handleScore(postScore('cargo binstall ripgrep'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(1);
  });

  test('GET install-command with cached hit returns 200 (unmetered read-only tier)', async () => {
    // GET ?input=<install-command> normally validates fine; the existing
    // contract was "GET only hits the registry, otherwise 404". With U7
    // the cache tier is also a read-only/unmetered tier, so a GET that
    // matches a cached binary returns 200.
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheContent: { [CACHE_KEY_RIPGREP]: CACHED_RIPGREP_PAYLOAD },
      tracker,
    });
    const res = await handleScore(getScore('cargo binstall ripgrep'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(0);
  });

  test('GET install-command with cache miss returns 404 (read-only contract)', async () => {
    const env = makeEnv({ cacheContent: {} });
    const res = await handleScore(getScore('cargo binstall ripgrep'), env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('chain_no_resolve');
  });

  test('cached scorecard preserves R11 triad', async () => {
    const env = makeEnv({ cacheContent: { [CACHE_KEY_RIPGREP]: CACHED_RIPGREP_PAYLOAD } });
    const res = await handleScore(postScore('cargo binstall ripgrep'), env);
    const body = (await res.json()) as {
      spec_version: string;
      anc_version: string;
      checker_url: string;
    };
    expect(body.spec_version).toBeTruthy();
    expect(body.anc_version).toBe('0.3.1');
    expect(body.checker_url).toBeTruthy();
  });
});
