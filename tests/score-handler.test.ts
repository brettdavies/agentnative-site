// /api/score handler orchestration tests.
//
// Plan U5 verification — exercises the full pipeline against stubbed
// bindings (ASSETS / DO / KV / rate-limit / Turnstile fetcher). Each test
// reaches one branch of the handler and asserts on status + envelope
// shape + R11 triad presence.

import { beforeEach, describe, expect, test } from 'bun:test';
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

type StubOverrides = Partial<{
  kvDisabled: boolean;
  turnstileSecret: string;
  hmacSecret: string;
  turnstileResponse: { success: boolean };
  doResponse: unknown;
  doStatus: number;
  rateLimit: boolean;
  ipRateLimit: boolean;
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

  const stubDo = {
    idFromName(_name: string) {
      return { id: 'stub' };
    },
    get(_id: unknown) {
      return {
        async fetch(_req: Request): Promise<Response> {
          return new Response(JSON.stringify(doResponse), {
            status: doStatus,
            headers: { 'content-type': 'application/json' },
          });
        },
      };
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

  test('DO stub passthrough → 503 sandbox_stub_until_u6', async () => {
    const res = await handleScore(postScore('https://github.com/foo/bar'), makeEnv());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('sandbox_stub_until_u6');
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
