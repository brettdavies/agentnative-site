// admitTransact is the one gate stack a transact POST passes on either
// lane: kill switch, siteverify with an explicit verdict map, session,
// the lane's session limiter, the IP limiter, and the lane's hourly KV
// window. These tests pin the order, the fail-closed rules, and the
// verdict-to-status map.

import { beforeEach, describe, expect, test } from 'bun:test';
import { type AdmitEnv, admitTransact, clientIpKey } from '../src/worker/audit/admit';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';
import { type VerifyResult, verifyTurnstile } from '../src/worker/score/turnstile';

type Calls = string[];

function limiter(name: string, calls: Calls, ok = true, throws = false) {
  return {
    async limit() {
      calls.push(name);
      if (throws) throw new Error(`${name} exploded`);
      return { success: ok };
    },
  };
}

function makeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    kv: {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
    } as unknown as KVNamespace,
    store,
  };
}

function siteverify(mode: 'pass' | 'reject' | 'transport' | 'hang' | 'non2xx' | 'malformed'): typeof fetch {
  const stub = async () => {
    switch (mode) {
      case 'reject':
        return new Response(JSON.stringify({ success: false }), { status: 200 });
      case 'transport':
        throw new Error('ECONNRESET');
      case 'hang':
        return new Promise<Response>(() => {});
      case 'non2xx':
        return new Response('nope', { status: 502 });
      case 'malformed':
        return new Response('not json', { status: 200 });
      default:
        return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
  };
  return stub as unknown as typeof fetch;
}

function makeEnv(calls: Calls, over: Partial<AdmitEnv> = {}): AdmitEnv {
  const { kv } = makeKv();
  return {
    SCORE_KV: kv,
    SCORE_LIMITER: limiter('cli', calls),
    SCORE_LIMITER_IP: limiter('cli-ip', calls),
    WEB_AUDIT_LIMITER: limiter('web', calls),
    WEB_AUDIT_LIMITER_IP: limiter('web-ip', calls),
    WEB_AUDIT_ENABLED: 'true',
    TURNSTILE_SECRET: 's',
    SESSION_HMAC_SECRET: 'h',
    ...over,
  };
}

function req(headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.9' }): Request {
  return new Request('https://anc.dev/api/score', { method: 'POST', headers });
}

beforeEach(() => {
  _resetKillSwitchCache();
});

describe('verifyTurnstile verdicts', () => {
  const env = { TURNSTILE_SECRET: 's' };
  test('missing token and a rejected token are distinct rejections', async () => {
    expect(await verifyTurnstile(env, null, { fetcher: siteverify('pass') })).toEqual({
      ok: false,
      reason: 'missing_token',
    });
    expect(await verifyTurnstile(env, 'x', { fetcher: siteverify('reject') })).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });

  test('a transport failure, a timeout, a non-2xx, and a malformed body are unavailability, not rejection', async () => {
    const results: VerifyResult[] = [];
    for (const mode of ['transport', 'hang', 'non2xx', 'malformed'] as const) {
      results.push(await verifyTurnstile(env, 'x', { fetcher: siteverify(mode), timeoutMs: 20 }));
    }
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual([
      'transport_error',
      'timeout',
      'transport_error',
      'malformed',
    ]);
  });
});

describe('clientIpKey', () => {
  test('an IPv4 address keys itself and an IPv6 address keys its /48', () => {
    expect(clientIpKey('203.0.113.9')).toBe('203.0.113.9');
    expect(clientIpKey('2001:db8:abcd:0012:0000:0000:0000:0001')).toBe('2001:db8:abcd::/48');
    expect(clientIpKey('2001:DB8::1')).toBe('2001:db8:0::/48');
    expect(clientIpKey('')).toBeNull();
  });
});

describe('admitTransact', () => {
  test('the CLI kill switch denies before siteverify; the web var denies only the web lane', async () => {
    const calls: Calls = [];
    const { kv } = makeKv({ scoring_disabled: 'true' });
    const env = makeEnv(calls, { SCORE_KV: kv, WEB_AUDIT_ENABLED: 'false' });
    let verified = 0;
    const deps = {
      turnstileFetch: (async (...a: Parameters<typeof fetch>) => {
        verified++;
        return siteverify('pass')(...a);
      }) as unknown as typeof fetch,
    };
    const cli = await admitTransact({ lane: 'cli', request: req(), token: 'x', target: 'ouch', env, deps });
    expect(cli).toMatchObject({ ok: false, status: 503, error: { code: 'scoring_disabled' }, retryAfter: 3600 });
    const web = await admitTransact({ lane: 'web', request: req(), token: 'x', target: 'anc.dev', env, deps });
    expect(web).toMatchObject({ ok: false, status: 503, error: { code: 'web_audit_disabled' } });
    expect(verified).toBe(0);
    expect(calls).toEqual([]);
  });

  test('an absent web var is disabled, an absent CLI key is enabled', async () => {
    const calls: Calls = [];
    const env = makeEnv(calls, { WEB_AUDIT_ENABLED: undefined });
    const deps = { turnstileFetch: siteverify('pass') };
    expect((await admitTransact({ lane: 'web', request: req(), token: 'x', target: 'anc.dev', env, deps })).ok).toBe(
      false,
    );
    expect((await admitTransact({ lane: 'cli', request: req(), token: 'x', target: 'ouch', env, deps })).ok).toBe(true);
  });

  test('the siteverify verdict map: rejected and missing are 403, unavailability is 503 with retry_after', async () => {
    const calls: Calls = [];
    const env = makeEnv(calls);
    const missing = await admitTransact({
      lane: 'cli',
      request: req(),
      token: null,
      target: 'ouch',
      env,
      deps: { turnstileFetch: siteverify('pass') },
    });
    expect(missing).toMatchObject({ ok: false, status: 403, error: { code: 'turnstile_failed' } });
    const rejected = await admitTransact({
      lane: 'cli',
      request: req(),
      token: 'x',
      target: 'ouch',
      env,
      deps: { turnstileFetch: siteverify('reject') },
    });
    expect(rejected).toMatchObject({ ok: false, status: 403, error: { code: 'turnstile_failed' } });
    for (const mode of ['transport', 'hang', 'non2xx', 'malformed'] as const) {
      const r = await admitTransact({
        lane: 'cli',
        request: req(),
        token: 'x',
        target: 'ouch',
        env,
        deps: { turnstileFetch: siteverify(mode), siteverifyTimeoutMs: 20 },
      });
      expect(r).toMatchObject({
        ok: false,
        status: 503,
        error: { code: 'turnstile_unavailable', retry_after: expect.any(Number) },
      });
    }
    const noSecret = await admitTransact({
      lane: 'cli',
      request: req(),
      token: 'x',
      target: 'ouch',
      env: { ...env, TURNSTILE_SECRET: undefined },
      deps: { turnstileFetch: siteverify('pass') },
    });
    expect(noSecret).toMatchObject({ ok: false, status: 500, error: { code: 'service_misconfigured' } });
    expect(calls).toEqual([]);
  });

  test('a missing client IP is denied after siteverify and before any limiter', async () => {
    const calls: Calls = [];
    const r = await admitTransact({
      lane: 'web',
      request: req({}),
      token: 'x',
      target: 'anc.dev',
      env: makeEnv(calls),
      deps: { turnstileFetch: siteverify('pass') },
    });
    expect(r).toMatchObject({ ok: false, status: 403, error: { code: 'turnstile_failed' } });
    expect(calls).toEqual([]);
  });

  test('the limiters run session then IP then the hourly window, lane-selected, and mint the session', async () => {
    const calls: Calls = [];
    const { kv, store } = makeKv();
    const env = makeEnv(calls, { SCORE_KV: kv });
    const web = await admitTransact({
      lane: 'web',
      request: req(),
      token: 'x',
      target: 'anc.dev',
      env,
      deps: { turnstileFetch: siteverify('pass') },
    });
    expect(web.ok).toBe(true);
    if (!web.ok) return;
    expect(web.setCookie).toContain('__Host-anc-session=');
    expect(calls).toEqual(['web', 'web-ip']);
    expect([...store.keys()].some((k) => k.startsWith('audit:web:203.0.113.9:'))).toBe(true);
    const cli = await admitTransact({
      lane: 'cli',
      request: req(),
      token: 'x',
      target: 'ouch',
      env,
      deps: { turnstileFetch: siteverify('pass') },
    });
    expect(cli.ok).toBe(true);
    expect(calls).toEqual(['web', 'web-ip', 'cli', 'cli-ip']);
    expect([...store.keys()].some((k) => k.startsWith('audit:cli:203.0.113.9:'))).toBe(true);
  });

  test('a denied session limiter, IP limiter, or hourly window is 429 with retry_after', async () => {
    const calls: Calls = [];
    const env = makeEnv(calls, { WEB_AUDIT_LIMITER: limiter('web', calls, false) });
    const r = await admitTransact({
      lane: 'web',
      request: req(),
      token: 'x',
      target: 'anc.dev',
      env,
      deps: { turnstileFetch: siteverify('pass') },
    });
    expect(r).toMatchObject({ ok: false, status: 429, error: { code: 'rate_limited', retry_after: 60 } });
    const bucket = Math.floor(Date.now() / 3_600_000);
    const { kv } = makeKv({ [`audit:cli:203.0.113.9:${bucket}`]: '30' });
    const hourly = await admitTransact({
      lane: 'cli',
      request: req(),
      token: 'x',
      target: 'ouch',
      env: makeEnv(calls, { SCORE_KV: kv }),
      deps: { turnstileFetch: siteverify('pass') },
    });
    expect(hourly).toMatchObject({ ok: false, status: 429, error: { code: 'rate_limited' } });
  });

  test('a missing limiter or KV binding, or a limiter that throws, is service_misconfigured', async () => {
    const calls: Calls = [];
    const deps = { turnstileFetch: siteverify('pass') };
    const noLimiter = await admitTransact({
      lane: 'cli',
      request: req(),
      token: 'x',
      target: 'ouch',
      env: makeEnv(calls, { SCORE_LIMITER: undefined }),
      deps,
    });
    expect(noLimiter).toMatchObject({ ok: false, status: 500, error: { code: 'service_misconfigured' } });
    const noKv = await admitTransact({
      lane: 'cli',
      request: req(),
      token: 'x',
      target: 'ouch',
      env: makeEnv(calls, { SCORE_KV: undefined }),
      deps,
    });
    expect(noKv).toMatchObject({ ok: false, status: 500, error: { code: 'service_misconfigured' } });
    const throwing = await admitTransact({
      lane: 'web',
      request: req(),
      token: 'x',
      target: 'anc.dev',
      env: makeEnv(calls, { WEB_AUDIT_LIMITER: limiter('web', calls, true, true) }),
      deps,
    });
    expect(throwing).toMatchObject({ ok: false, status: 500, error: { code: 'service_misconfigured' } });
  });
});
