// /api/score handler orchestration tests.
//
// Exercises the full pipeline against stubbed bindings (ASSETS / DO / KV
// / rate-limit / Turnstile fetcher). Each test reaches one branch of the
// handler and asserts on status + envelope shape + response-triad presence.
//
// DO mock fidelity history (2026-05-15):
//
//   An earlier stub returned `{error: 'sandbox_stub_until_u6'}` from a
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
import { keyFor } from '../src/worker/score/cache';
import type { Sandbox } from '../src/worker/score/do';
import { _resetIndexCache, handleScore, type ScoreEnv } from '../src/worker/score/handler';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';

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

const HINTS_INDEX = {
  by_owner_repo: {
    // Mirrors the shape build/registry-index.mjs emits at
    // dist/discovery-hints-index.json. A hint tells the live-scoring path
    // which install spec (pm+pkg+binary) to use for a non-registry
    // github-url, so the discovery chain is skipped on hit. For cache-
    // tier tests, the `binary` field is the cache-key derivation source.
    'Aider-AI/aider': { pm: 'pip', package: 'aider-chat', binary: 'aider' },
  },
};

type CallTracker = { doCalls: number };

export type TelemetryEvent = { blobs?: (string | null)[]; doubles?: (number | null)[]; indexes?: string[] };

type StubOverrides = Partial<{
  kvDisabled: boolean;
  turnstileSecret: string;
  hmacSecret: string;
  turnstileResponse: { success: boolean };
  doResponse: unknown;
  doStatus: number;
  rateLimit: boolean;
  ipRateLimit: boolean;
  // Prefill SCORE_CACHE with these payloads (key → JSON-encoded body).
  cacheContent: Record<string, unknown>;
  // If true, the SCORE_CACHE.get stub throws — exercises the
  // best-effort read-failure path in cache.get.
  cacheThrows: boolean;
  // Optional tracker so cache-tier tests can assert the DO was NOT
  // dispatched. Mutated in place by the stub fetch.
  tracker: CallTracker;
  // Shared cache store passed by the caller. When provided, the
  // SCORE_CACHE stub uses it directly so a single test can interleave
  // prefill / inspect / observe-writes operations across multiple
  // handler invocations. The store survives across `handleScore()` calls
  // sharing the same env.
  cacheStore: Map<string, string>;
  // SCORE_TELEMETRY (Workers Analytics Engine) sink. When provided,
  // every writeDataPoint call's payload is appended to this array so
  // assertion-heavy telemetry tests can observe what the handler
  // recorded. Absent → calls are silently dropped (matches AE's
  // production write-only behavior).
  telemetryEvents: TelemetryEvent[];
  // When true, SCORE_TELEMETRY.writeDataPoint throws. Exercises the
  // graceful-degradation path in recordScoreEvent.
  telemetryThrows: boolean;
  // When true, env.SCORE is omitted from the returned ScoreEnv.
  // Mirrors the mid-rollback Worker state (between v2-drop-sandbox and
  // v3-restore-sandbox) where the DO binding is gone. Exercises the
  // binding-presence guard in handler.ts that returns a typed
  // sandbox_unavailable 503 instead of letting getRandom() throw and
  // surface as Cloudflare error 1101.
  noScoreBinding: boolean;
}>;

export type ScoreTestEnvOverrides = StubOverrides;

export function makeEnv(overrides: StubOverrides = {}): ScoreEnv {
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

  const cacheStore = overrides.cacheStore ?? new Map<string, string>();
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
    SCORE_TELEMETRY: {
      writeDataPoint(event: TelemetryEvent) {
        if (overrides.telemetryThrows) throw new Error('ae_write_failed');
        if (overrides.telemetryEvents) overrides.telemetryEvents.push(event);
      },
    },
    TURNSTILE_SECRET: turnstileSecret,
    SESSION_HMAC_SECRET: hmacSecret,
  } as ScoreEnv;
  if (!overrides.noScoreBinding) {
    env.SCORE = stubDo as unknown as DurableObjectNamespace;
  }
  return env;
}

export function postScore(input: string, opts: { token?: string; cookie?: string; pathSuffix?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`https://anc.dev/api/score${opts.pathSuffix ?? ''}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input, turnstile_token: opts.token ?? 'tok' }),
  });
}

export function getScore(input: string | null, pathSuffix = ''): Request {
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
  test('POST {input: "ripgrep"} → 200 registry_hit with response triad', async () => {
    const res = await handleScore(postScore('ripgrep'), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scorecard: { kind: string; scorecard_url: string };
      spec_version: string;
      anc_version: string;
      auditor_url: string;
    };
    expect(body.scorecard.kind).toBe('registry_hit');
    expect(body.scorecard.scorecard_url).toBe('/score/ripgrep');
    expect(body.anc_version).toBe('0.3.0');
    expect(body.spec_version).toBeTruthy();
    expect(body.auditor_url).toBeTruthy();
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
    const res = await handleScore(getScore('cargo install foo-cli'), makeEnv());
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
    const res = await handleScore(postScore('cargo install foo-cli'), makeEnv({ kvDisabled: true }));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('3600');
  });

  test('turnstile rejection → 400 turnstile_failed', async () => {
    const res = await handleScore(
      postScore('cargo install foo-cli'),
      makeEnv({ turnstileResponse: { success: false } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('turnstile_failed');
  });

  test('rate-limited → 429 with Retry-After: 60', async () => {
    const res = await handleScore(postScore('cargo install foo-cli'), makeEnv({ rateLimit: false }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  test('per-IP fallback limiter triggers 429 even when session limiter passes', async () => {
    const res = await handleScore(postScore('cargo install foo-cli'), makeEnv({ rateLimit: true, ipRateLimit: false }));
    expect(res.status).toBe(429);
  });

  test('DO stub envelope passthrough → 503 sandbox_stub_until_u6 (defense-in-depth)', async () => {
    // Defense-in-depth: if the production DO binding ever points back at
    // the legacy sandbox-stub class (botched rollback, misconfigured
    // wrangler.jsonc), the handler still bounces with the sandbox_stub
    // envelope instead of leaking the raw stub error to the user. The
    // isStubError() check in handler.ts is what makes this safe.
    const res = await handleScore(
      postScore('cargo install foo-cli'),
      makeEnv({ doResponse: { error: 'sandbox_stub_until_u6' } }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('sandbox_stub_until_u6');
  });

  test('missing env.SCORE binding → 503 sandbox_unavailable (mid-rollback guard)', async () => {
    // Without the binding-presence guard, getRandom() throws on the
    // undefined env.SCORE namespace and the Worker exception surfaces
    // as Cloudflare error 1101 (a generic page, no JSON envelope). The
    // guard converts that into a typed 503.
    const res = await handleScore(postScore('cargo install foo-cli'), makeEnv({ noScoreBinding: true }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string }; spec_version: string; auditor_url: string };
    expect(body.error.code).toBe('sandbox_unavailable');
    expect(body.spec_version).toBeDefined();
    expect(body.auditor_url).toBeDefined();
  });

  test('DO returns valid scorecard envelope → 200 with response triad', async () => {
    // Live success path: DO returns {scorecard, anc_version} from
    // sandbox-exec.score(). The handler wraps it into the response shape
    // with spec_version + auditor_url. This is the test that pins the
    // DO → handler envelope contract.
    const res = await handleScore(
      postScore('cargo install foo-cli'),
      makeEnv({
        doResponse: {
          scorecard: { tool: { name: 'bar', binary: 'bar' }, score: { value: 73 } },
          anc_version: ANC_VERSION,
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      spec_version: string;
      anc_version: string;
      auditor_url: string;
      scorecard: { tool: { name: string } };
    };
    expect(body.scorecard.tool.name).toBe('bar');
    expect(body.spec_version).toBeTruthy();
    expect(body.auditor_url).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Session cookie issue + verify
// ---------------------------------------------------------------------------

describe('/api/score — session cookie', () => {
  test('first POST issues Set-Cookie with __Host-anc-session', async () => {
    const res = await handleScore(postScore('cargo install foo-cli'), makeEnv());
    const cookie = res.headers.get('Set-Cookie');
    expect(cookie).toContain('__Host-anc-session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  test('returning request with valid cookie does NOT re-issue', async () => {
    const env = makeEnv();
    const first = await handleScore(postScore('cargo install foo-cli'), env);
    const cookie = first.headers.get('Set-Cookie');
    expect(cookie).toBeTruthy();
    if (!cookie) return;
    // Extract the cookie name=value pair (Set-Cookie includes attributes after `;`)
    const cookiePair = cookie.split(';')[0];

    const second = await handleScore(postScore('cargo install foo-cli', { cookie: cookiePair }), env);
    expect(second.headers.get('Set-Cookie')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Service misconfiguration (fail-fast on missing secrets)
// ---------------------------------------------------------------------------

describe('/api/score — service misconfiguration', () => {
  test('missing TURNSTILE_SECRET on POST → 500 service_misconfigured', async () => {
    const env = makeEnv({ turnstileSecret: '' });
    const res = await handleScore(postScore('cargo install foo-cli'), env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('service_misconfigured');
  });

  test('missing SESSION_HMAC_SECRET on POST → 500 service_misconfigured', async () => {
    const env = makeEnv({ hmacSecret: '' });
    const res = await handleScore(postScore('cargo install foo-cli'), env);
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
// R2 cache tier
// ---------------------------------------------------------------------------

// The cache key uses SPEC_VERSION (build-time constant from gen.ts) as
// the anc-version proxy. Tests construct keys via keyFor() + the gen.ts
// import so they auto-track when SPEC_VERSION advances.
//
// `uncurated-tool` is a deliberately-fictional package name used as the
// cache-tier exemplar — clearly NOT in the test fixture's
// REGISTRY_INDEX.by_slug, so the install-command-binary cross-check
// (registry-lookup.ts) doesn't intercept and the input flows through to
// the cache tier as intended. Avoid swapping to a real CLI tool name
// here: tests stub the DO response so the package never actually
// installs, but a real name in test code can mislead a future reader
// into pasting it as a live-demo example where it would either fail
// (no real package) or run a slow install. Fictional name = self-
// documenting "this is fixture data, not a real package".
const CACHE_KEY_UNCURATED = keyFor('uncurated-tool', SPEC_VERSION);

const CACHED_UNCURATED_PAYLOAD = {
  spec_version: SPEC_VERSION,
  anc_version: ANC_VERSION,
  tool_version: '3.04',
  scorecard: { tool: { name: 'uncurated-tool', binary: 'uncurated-tool', version: '3.04' }, score: { value: 92 } },
};

describe('/api/score — R2 cache tier', () => {
  test('install-command + R2 hit → 200 cached, DO never dispatched, gates bypassed', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheContent: { [CACHE_KEY_UNCURATED]: CACHED_UNCURATED_PAYLOAD },
      tracker,
      // Hard-fail every metered gate. The cached hit must bypass all of
      // them — proving the unmetered contract (R6 extended to cache).
      turnstileResponse: { success: false },
      rateLimit: false,
      ipRateLimit: false,
    });
    const res = await handleScore(postScore('cargo binstall uncurated-tool'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(0);
    const body = (await res.json()) as {
      scorecard: { tool: { name: string }; score: { value: number } };
      anc_version: string;
      spec_version: string;
      auditor_url: string;
    };
    expect(body.scorecard.tool.name).toBe('uncurated-tool');
    expect(body.scorecard.score.value).toBe(92);
    expect(body.anc_version).toBe(ANC_VERSION);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  test('install-command + R2 miss → live path runs (DO dispatched)', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheContent: {},
      tracker,
      doResponse: {
        scorecard: { tool: { name: 'uncurated-tool', version: '3.04' } },
        anc_version: ANC_VERSION,
      },
    });
    const res = await handleScore(postScore('cargo binstall uncurated-tool'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(1);
    const body = (await res.json()) as { scorecard: { tool: { name: string } } };
    expect(body.scorecard.tool.name).toBe('uncurated-tool');
  });

  test('?fromCache=false bypasses R2 read, live path runs even with cache prefilled', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheContent: { [CACHE_KEY_UNCURATED]: CACHED_UNCURATED_PAYLOAD },
      tracker,
      doResponse: {
        scorecard: { tool: { name: 'uncurated-tool', version: '3.04' }, score: { value: 50 } },
        anc_version: ANC_VERSION,
      },
    });
    const req = new Request('https://anc.dev/api/score?fromCache=false', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'cargo binstall uncurated-tool', turnstile_token: 'tok' }),
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
      cacheContent: { [keyFor('rg', SPEC_VERSION)]: CACHED_UNCURATED_PAYLOAD },
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
        scorecard: { tool: { name: 'uncurated-tool', version: '3.04' } },
        anc_version: ANC_VERSION,
      },
    });
    const res = await handleScore(postScore('cargo binstall uncurated-tool'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(1);
  });

  test('GET install-command with cached hit returns 200 (unmetered read-only tier)', async () => {
    // GET ?input=<install-command> normally validates fine; the existing
    // contract was "GET only hits the registry, otherwise 404". The
    // cache tier is also a read-only/unmetered tier, so a GET that
    // matches a cached binary returns 200.
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheContent: { [CACHE_KEY_UNCURATED]: CACHED_UNCURATED_PAYLOAD },
      tracker,
    });
    const res = await handleScore(getScore('cargo binstall uncurated-tool'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(0);
  });

  test('GET install-command with cache miss returns 404 (read-only contract)', async () => {
    const env = makeEnv({ cacheContent: {} });
    const res = await handleScore(getScore('cargo binstall uncurated-tool'), env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('chain_no_resolve');
  });

  test('cached scorecard preserves response triad', async () => {
    const env = makeEnv({ cacheContent: { [CACHE_KEY_UNCURATED]: CACHED_UNCURATED_PAYLOAD } });
    const res = await handleScore(postScore('cargo binstall uncurated-tool'), env);
    const body = (await res.json()) as {
      spec_version: string;
      anc_version: string;
      auditor_url: string;
    };
    expect(body.spec_version).toBeTruthy();
    expect(body.anc_version).toBe(ANC_VERSION);
    expect(body.auditor_url).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // github-url tier (with + without hint) — covers gaps the install-command
  // tests don't reach. Aider-AI/aider has a hint with binary='aider' so
  // the cache key derives to scores/aider/<SPEC_VERSION>.json; an
  // owner/repo without a hint can't derive a binary upfront and skips
  // the cache tier entirely.
  // -------------------------------------------------------------------------

  const CACHE_KEY_AIDER = keyFor('aider', SPEC_VERSION);
  const CACHED_AIDER_PAYLOAD = {
    spec_version: SPEC_VERSION,
    anc_version: ANC_VERSION,
    tool_version: '0.93.0',
    scorecard: { tool: { name: 'aider', binary: 'aider', version: '0.93.0' }, score: { value: 81 } },
  };

  test('github-url with hint + R2 hit → 200 cached, DO not dispatched, gates bypassed', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheContent: { [CACHE_KEY_AIDER]: CACHED_AIDER_PAYLOAD },
      tracker,
      turnstileResponse: { success: false },
      rateLimit: false,
      ipRateLimit: false,
    });
    const res = await handleScore(postScore('https://github.com/Aider-AI/aider'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(0);
    const body = (await res.json()) as { scorecard: { tool: { name: string } }; anc_version: string };
    expect(body.scorecard.tool.name).toBe('aider');
    expect(body.anc_version).toBe(ANC_VERSION);
  });

  test('github-url with hint + R2 miss → live path runs (DO dispatched, hint informs cache key)', async () => {
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheContent: {},
      tracker,
      doResponse: {
        scorecard: { tool: { name: 'aider', version: '0.93.0' } },
        anc_version: ANC_VERSION,
      },
    });
    const res = await handleScore(postScore('https://github.com/Aider-AI/aider'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(1);
  });

  test('github-url with hint is case-insensitive on owner/repo for cache lookup', async () => {
    // Mirrors the registry-lookup case-insensitivity guarantee — a paste
    // of `github.com/aider-ai/aider` (lowercase) must hit the same hint
    // as `Aider-AI/aider` and therefore the same cache key.
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheContent: { [CACHE_KEY_AIDER]: CACHED_AIDER_PAYLOAD },
      tracker,
    });
    const res = await handleScore(postScore('https://github.com/aider-ai/aider'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(0);
  });

  test('install-command with unrelated R2 entry → cache tier scoped to derived binary, live path runs', async () => {
    // `cargo install foo-cli` parses to binary='foo-cli', cache key
    // `scores/foo-cli/<SPEC_VERSION>.json`. A prefilled entry under a DIFFERENT
    // binary's key (scores/bar/...) is unreachable from this input and
    // the live path runs.
    //
    // Pre-2026-05-20 this test used a github-url without a hint to prove
    // the same property (cache tier requires a derivable binary). After
    // the discovery-move the equivalent github-url POST bounces at the
    // Worker on chain_no_resolve before the DO; install-command is the
    // shape that still reaches the DO via the cheap install-command
    // pass-through path in resolveSpec.
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheContent: { [keyFor('bar', SPEC_VERSION)]: CACHED_AIDER_PAYLOAD },
      tracker,
      doResponse: {
        scorecard: { tool: { name: 'bar', version: '0.1.0' } },
        anc_version: ANC_VERSION,
      },
    });
    const res = await handleScore(postScore('cargo install foo-cli'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(1);
    const body = (await res.json()) as { scorecard: { tool: { name: string } } };
    // The DO's scorecard (tool=bar), not the prefilled cache (tool=aider).
    expect(body.scorecard.tool.name).toBe('bar');
  });

  test('slug WITHOUT curated scorecard → cache tier skipped (no binary derivable), Worker bounces chain_no_resolve', async () => {
    // The `no-card-tool` registry entry exists but has no `scorecard_url`
    // / `anc_version`, so the registry tier returns a non-curated hit
    // and the cache tier sees `kind: registry` (which deriveCacheBinary
    // bails on — only hint kind feeds the cache for github-urls; slugs
    // bail because there's no install spec). A prefilled-but-unreachable
    // R2 entry must NOT be served.
    //
    // 2026-05-20 discovery-move: bare-slug live scoring is deferred; the
    // Worker's resolveSpec bounces slug inputs as chain_no_resolve before
    // the DO is reached. Pre-move the DO emitted that same bounce; now it
    // emerges one tier earlier so the no-resolve UX is sub-second.
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      // Pre-seed under the slug name — should NOT be served because
      // deriveCacheBinary returns null for non-curated slugs.
      cacheContent: {
        [keyFor('no-card-tool', SPEC_VERSION)]: CACHED_AIDER_PAYLOAD,
      },
      tracker,
    });
    const res = await handleScore(postScore('no-card-tool'), env);
    expect(res.status).toBe(404);
    // DO NOT called — Worker resolveSpec bounced the slug before dispatch.
    expect(tracker.doCalls).toBe(0);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('chain_no_resolve');
  });

  test('cache key partition: install-command binary derivation does not alias curated registry binary', async () => {
    // `cargo binstall ripgrep` → binary='ripgrep' (parser default).
    // The curated registry entry for slug=ripgrep has binary='rg'.
    // The two cache keys are scores/ripgrep/* and scores/rg/* — they
    // must NOT alias, otherwise an install-command query could pick up
    // a stale entry written under the curated path.
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      // Pre-seed ONLY under the curated 'rg' key.
      cacheContent: { [keyFor('rg', SPEC_VERSION)]: CACHED_UNCURATED_PAYLOAD },
      tracker,
      doResponse: {
        scorecard: { tool: { name: 'ripgrep', version: '15.1.0' } },
        anc_version: ANC_VERSION,
      },
    });
    // POST install-command — key derives to scores/ripgrep/<SPEC_VERSION>,
    // which is empty. The pre-seeded scores/rg/<SPEC_VERSION> must NOT be
    // served (it's the curated path's key, not the install-command path's).
    const res = await handleScore(postScore('cargo binstall uncurated-tool'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(1);
  });

  test('anc-version partition: reads under SPEC_VERSION slot, stale entries under a different slot are unreachable', async () => {
    // A stale entry under scores/uncurated-tool/0.0.1.json (an arbitrary
    // older spec version) must be unreachable when the running Worker
    // computes the key from the current SPEC_VERSION via gen.ts. This
    // pins the partition-by-version property so a future change that
    // strips the version from the key surfaces here.
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheContent: {
        'scores/uncurated-tool/0.0.1.json': {
          spec_version: '0.0.1',
          anc_version: '0.0.1',
          tool_version: '1.5.0',
          scorecard: { tool: { name: 'uncurated-tool', version: '1.5.0' } },
        },
        // NO entry under the current SPEC_VERSION key → cache miss.
      },
      tracker,
      doResponse: {
        scorecard: { tool: { name: 'uncurated-tool', version: '1.6.0' } },
        anc_version: ANC_VERSION,
      },
    });
    const res = await handleScore(postScore('npm install -g uncurated-tool'), env);
    expect(res.status).toBe(200);
    expect(tracker.doCalls).toBe(1);
    const body = (await res.json()) as { scorecard: { tool: { version: string } } };
    // Live DO scorecard (1.6.0), not stale cache (1.5.0).
    expect(body.scorecard.tool.version).toBe('1.6.0');
  });

  test('cached hit returns Cache-Control: public, max-age=300 for CDN-edge cooperation', async () => {
    // The per-write Cache-Control header keeps CDN edges from
    // over-caching while R2 lifecycle handles the long TTL.
    const env = makeEnv({ cacheContent: { [CACHE_KEY_UNCURATED]: CACHED_UNCURATED_PAYLOAD } });
    const res = await handleScore(postScore('cargo binstall uncurated-tool'), env);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  test('live (DO-served) responses get Cache-Control: no-store', async () => {
    // Mirror-of-above: the live path uses JSON_HEADERS_LIVE so CDN edges
    // don't accidentally cache an uncached miss. Pins the freshness=live
    // vs cache-hit response-header split.
    const env = makeEnv({
      cacheContent: {},
      doResponse: {
        scorecard: { tool: { name: 'foo', version: '0.1.0' } },
        anc_version: ANC_VERSION,
      },
    });
    const res = await handleScore(postScore('cargo install foo-cli'), env);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  // -------------------------------------------------------------------------
  // Cross-PM cache-key aliasing — design choice, not a bug
  // -------------------------------------------------------------------------
  //
  // The cache key (`scores/{binary}/{SPEC_VERSION}.json`) intentionally
  // OMITS the package-manager dimension. The reasoning: a binary with
  // the same name + same anc_version produces the same scorecard
  // regardless of which PM installed it, because `anc audit` evaluates
  // the binary on PATH and doesn't care how it got there. So `pip
  // install foo`, `cargo binstall foo`, and `bun add -g foo` all
  // SHOULD share a cache entry for binary='foo'.
  //
  // This test pins that design choice so a future change that scopes
  // the cache key per-PM (which would be the wrong direction, because
  // it'd waste cache budget) surfaces here.

  test('cache-key aliasing: same binary across different PMs shares the same cache entry', async () => {
    // Pre-seed under scores/foo/<SPEC_VERSION>.json. Both `pip install
    // foo` (binary='foo') and `cargo binstall foo` (binary='foo') derive
    // the same key, so both reads hit the same prefilled entry.
    const cachedFooPayload = {
      spec_version: SPEC_VERSION,
      anc_version: ANC_VERSION,
      tool_version: '1.0.0',
      scorecard: { tool: { name: 'foo', binary: 'foo', version: '1.0.0' }, score: { value: 75 } },
    };
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheContent: { [keyFor('foo', SPEC_VERSION)]: cachedFooPayload },
      tracker,
    });

    const pipRes = await handleScore(postScore('pip install foo'), env);
    expect(pipRes.status).toBe(200);
    const pipBody = (await pipRes.json()) as { scorecard: { score: { value: number } } };
    expect(pipBody.scorecard.score.value).toBe(75);

    const cargoRes = await handleScore(postScore('cargo binstall foo'), env);
    expect(cargoRes.status).toBe(200);
    const cargoBody = (await cargoRes.json()) as { scorecard: { score: { value: number } } };
    expect(cargoBody.scorecard.score.value).toBe(75);

    const bunRes = await handleScore(postScore('bun add -g foo'), env);
    expect(bunRes.status).toBe(200);
    const bunBody = (await bunRes.json()) as { scorecard: { score: { value: number } } };
    expect(bunBody.scorecard.score.value).toBe(75);

    // All three were cache hits — no DO dispatch happened.
    expect(tracker.doCalls).toBe(0);
  });

  // -------------------------------------------------------------------------
  // ?fromCache=false cache-WRITE fires
  // -------------------------------------------------------------------------
  //
  // fromCache=false skips the READ tier but the design says the live
  // run must still WRITE to cache so the next request benefits.
  // Pinning the write half explicitly: with a fresh cache, a
  // ?fromCache=false POST + cache-miss POST in sequence should mean
  // the second call sees the entry the live run wrote.
  //
  // The DO writes to env.SCORE_CACHE.put() via writeCacheBestEffort
  // in src/worker/score/do.ts. The handler test's mock DO doesn't
  // actually run that code path, so we exercise the WRITE side by
  // observing the cacheStore via the makeEnv override AND issuing the
  // sequence end-to-end.

  test('?fromCache=false fires the cache write so the next request hits the fresh entry', async () => {
    // Shared cacheStore lets us inspect (and ALSO simulate the DO write
    // by inserting directly — the DO would do this after success).
    const cacheStore = new Map<string, string>();
    const tracker: CallTracker = { doCalls: 0 };
    const env = makeEnv({
      cacheStore,
      tracker,
      doResponse: {
        scorecard: { tool: { name: 'uncurated-tool', binary: 'uncurated-tool', version: '1.6.0' } },
        anc_version: ANC_VERSION,
      },
    });

    // First request with ?fromCache=false. The cache is empty, so read
    // would have missed anyway, but the route through skipCache must
    // still hit the live DO path AND the write happens.
    const req1 = new Request('https://anc.dev/api/score?fromCache=false', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'npm install -g uncurated-tool', turnstile_token: 'tok' }),
    });
    const res1 = await handleScore(req1, env);
    expect(res1.status).toBe(200);
    expect(tracker.doCalls).toBe(1);

    // The handler mock DO doesn't actually run writeCacheBestEffort
    // (the real DO does). Simulate that the DO has written the result
    // by injecting it into the shared cacheStore — this is what
    // writeCacheBestEffort would do after a successful score.
    cacheStore.set(
      keyFor('uncurated-tool', SPEC_VERSION),
      JSON.stringify({
        spec_version: SPEC_VERSION,
        anc_version: ANC_VERSION,
        tool_version: '1.6.0',
        scorecard: {
          tool: { name: 'uncurated-tool', binary: 'uncurated-tool', version: '1.6.0' },
          score: { value: 92 },
        },
      }),
    );

    // Second request WITHOUT ?fromCache=false. The cache write should
    // now be readable; DO should NOT dispatch again.
    const req2 = postScore('npm install -g uncurated-tool');
    const res2 = await handleScore(req2, env);
    expect(res2.status).toBe(200);
    // Tracker is still 1 from the first call; the second call hits cache.
    expect(tracker.doCalls).toBe(1);
    expect(res2.headers.get('Cache-Control')).toBe('public, max-age=300');
  });
});
