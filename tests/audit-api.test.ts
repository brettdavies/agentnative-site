// POST /api/score accepts both lanes with one gate stack and one response
// contract. These tests post a website target and a CLI target through the
// same endpoint against stubbed bindings and assert the shared error object
// and envelope on every outcome enumerated below.

import { beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import { type AuditApiEnv, handleAuditApi, isAuditApiPath } from '../src/worker/audit/api';
import { keyFor as webKeyFor } from '../src/worker/audit-web/cache';
import { keyFor as cliKeyFor } from '../src/worker/score/cache';
import type { Sandbox } from '../src/worker/score/do';
import { _resetIndexCache } from '../src/worker/score/handler';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';
import { captureLogs } from './helpers/log-capture';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

let registryJsonPromise: Promise<string> | null = null;
async function webRegistryJson(): Promise<string> {
  if (!registryJsonPromise) {
    registryJsonPromise = (async () => {
      const raw = await readFile(join(REPO_ROOT, 'src', 'data', 'web-audit', 'registry.yaml'), 'utf8');
      return JSON.stringify(normalizeWebAuditRegistry(yaml.load(raw) as object));
    })();
  }
  return registryJsonPromise;
}

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
      score_pct: 92,
    },
  },
  by_owner_repo: {},
};
const HINTS_INDEX = { by_owner_repo: {} };

type Tracker = {
  doCalls: number;
  siteverifyCalls: number;
  r2Gets: string[];
  probeCalls: string[];
  limiterCalls: string[];
  kvPuts: string[];
};

function newTracker(): Tracker {
  return { doCalls: 0, siteverifyCalls: 0, r2Gets: [], probeCalls: [], limiterCalls: [], kvPuts: [] };
}

type Overrides = Partial<{
  tracker: Tracker;
  cacheContent: Record<string, unknown>;
  turnstile: 'pass' | 'reject' | 'transport' | 'timeout' | 'non2xx' | 'malformed' | 'no-secret';
  cliKill: boolean;
  webKill: boolean;
  limiterThrows: boolean;
  limiter: boolean;
  ipLimiter: boolean;
  noKv: boolean;
  noLimiter: boolean;
  doResponse: unknown;
  doThrows: boolean;
  onDoFetch: () => void;
  cachePutThrows: boolean;
  probe: 'ok' | 'unreachable';
  kvSeed: Record<string, string>;
}>;

function makeKv(seed: Record<string, string>, tracker?: Tracker): KVNamespace {
  const store = new Map(Object.entries(seed));
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      tracker?.kvPuts.push(key);
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    _store: store,
  } as unknown as KVNamespace;
}

export function makeEnv(overrides: Overrides = {}): AuditApiEnv & { _kv: Map<string, string> } {
  const tracker = overrides.tracker ?? newTracker();
  const cacheStore = new Map<string, string>();
  for (const [k, v] of Object.entries(overrides.cacheContent ?? {})) cacheStore.set(k, JSON.stringify(v));
  const kv = makeKv(
    { ...(overrides.cliKill ? { scoring_disabled: 'true' } : {}), ...(overrides.kvSeed ?? {}) },
    tracker,
  );
  const doResponse = overrides.doResponse ?? {
    scorecard: { tool: { name: 'ouch', binary: 'ouch', version: '0.5.0' }, badge: { score_pct: 71, eligible: true } },
    anc_version: ANC_VERSION,
  };
  const stubFetch: Sandbox['fetch'] = async () => {
    tracker.doCalls += 1;
    overrides.onDoFetch?.();
    if (overrides.doThrows) throw new Error('DO exploded');
    return new Response(JSON.stringify(doResponse), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const limiter = (name: string, ok: boolean) => ({
    async limit() {
      tracker.limiterCalls.push(name);
      if (overrides.limiterThrows) throw new Error('limiter exploded');
      return { success: ok };
    },
  });
  const turnstileStub = async () => {
    tracker.siteverifyCalls += 1;
    switch (overrides.turnstile ?? 'pass') {
      case 'reject':
        return new Response(JSON.stringify({ success: false }), { status: 200 });
      case 'transport':
        throw new Error('ECONNRESET');
      case 'timeout':
        return new Promise<Response>(() => {});
      case 'non2xx':
        return new Response('bad gateway', { status: 502 });
      case 'malformed':
        return new Response('not json', { status: 200 });
      default:
        return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
  };
  const turnstileFetch = turnstileStub as unknown as typeof fetch;
  const env = {
    ASSETS: {
      async fetch(req: Request | string): Promise<Response> {
        const path = new URL(typeof req === 'string' ? req : req.url).pathname;
        if (path === '/registry-index.json') return new Response(JSON.stringify(REGISTRY_INDEX), { status: 200 });
        if (path === '/discovery-hints-index.json') return new Response(JSON.stringify(HINTS_INDEX), { status: 200 });
        if (path === '/_internal/web-audit-registry.json')
          return new Response(await webRegistryJson(), { status: 200 });
        if (path === '/_internal/web-seed.json') return new Response('[]', { status: 200 });
        return new Response('not found', { status: 404 });
      },
    } as Fetcher,
    SCORE_KV: overrides.noKv ? undefined : kv,
    SCORE_CACHE: {
      async get(key: string) {
        tracker.r2Gets.push(key);
        const raw = cacheStore.get(key);
        if (raw === undefined) return null;
        return { json: async () => JSON.parse(raw), text: async () => raw };
      },
      async put(key: string, value: unknown) {
        if (overrides.cachePutThrows) throw new Error('r2 exploded');
        cacheStore.set(key, typeof value === 'string' ? value : String(value));
      },
      async delete(key: string) {
        cacheStore.delete(key);
      },
    } as unknown as R2Bucket,
    SCORE: {
      idFromName: () => ({ id: 'stub' }),
      get: () => ({ fetch: stubFetch }),
    } as unknown as DurableObjectNamespace,
    SCORE_LIMITER: overrides.noLimiter ? undefined : limiter('cli', overrides.limiter ?? true),
    SCORE_LIMITER_IP: limiter('cli-ip', overrides.ipLimiter ?? true),
    WEB_AUDIT_LIMITER: overrides.noLimiter ? undefined : limiter('web', overrides.limiter ?? true),
    WEB_AUDIT_LIMITER_IP: limiter('web-ip', overrides.ipLimiter ?? true),
    WEB_AUDIT_ENABLED: overrides.webKill ? 'false' : 'true',
    TURNSTILE_SECRET: overrides.turnstile === 'no-secret' ? undefined : 'test-turnstile-secret',
    SESSION_HMAC_SECRET: 'test-hmac-secret-please',
    SCORE_TELEMETRY: { writeDataPoint() {} },
    _kv: (kv as unknown as { _store: Map<string, string> })._store,
  } as unknown as AuditApiEnv & { _kv: Map<string, string> };
  return Object.assign(env, {
    _deps: { turnstileFetch, siteverifyTimeoutMs: 50, probeFetch: probeFetchFor(tracker, overrides.probe ?? 'ok') },
  });
}

function probeFetchFor(tracker: Tracker, probe: 'ok' | 'unreachable'): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    tracker.probeCalls.push(url);
    if (probe === 'unreachable') return new Response('', { status: 530 });
    if (url.includes('dns-query') || url.includes('/resolve')) {
      return new Response(JSON.stringify({ Status: 3, Answer: [] }), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
    }
    return new Response('# ok', { status: 200 });
  }) as typeof fetch;
}

function makeCtx(): ExecutionContext & { _promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => promises.push(p),
    passThroughOnException: () => {},
    props: {},
    _promises: promises,
  } as unknown as ExecutionContext & { _promises: Promise<unknown>[] };
}

type Deps = { turnstileFetch: typeof fetch; siteverifyTimeoutMs: number; probeFetch: typeof fetch };

function post(
  body: Record<string, unknown> | string,
  opts: { ip?: string | null; accept?: string; contentType?: string; query?: string; cookie?: string } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': opts.contentType ?? 'application/json' };
  if (opts.ip !== null) headers['cf-connecting-ip'] = opts.ip ?? '203.0.113.9';
  if (opts.accept) headers.accept = opts.accept;
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`https://anc.dev/api/score${opts.query ?? ''}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function call(req: Request, env: ReturnType<typeof makeEnv>, ctx = makeCtx()) {
  const res = await handleAuditApi(req, env, ctx, (env as unknown as { _deps: Deps })._deps);
  return { res, ctx };
}

async function errorOf(res: Response): Promise<{ code: string; message: string; cta: string; retry_after?: number }> {
  const body = (await res.json()) as { error: { code: string; message: string; cta: string; retry_after?: number } };
  return body.error;
}

async function ndjson(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

const WEB_RECORD = (host: string) => ({
  spec_version: SPEC_VERSION,
  target_url: `https://${host}/`,
  scorecard: { target_url: `https://${host}/`, score_pct: 64, results: [] },
  scored_at: new Date().toISOString(),
});

const CLI_RECORD = {
  spec_version: SPEC_VERSION,
  anc_version: ANC_VERSION,
  tool_version: '0.5.0',
  scorecard: { tool: { name: 'ouch', binary: 'ouch', version: '0.5.0' }, badge: { score_pct: 71, eligible: true } },
};

beforeEach(() => {
  _resetIndexCache();
  _resetKillSwitchCache();
});

describe('POST /api/score: request contract', () => {
  test('the route predicate matches the endpoint only', () => {
    expect(isAuditApiPath('/api/score')).toBe(true);
    expect(isAuditApiPath('/api/score.md')).toBe(false);
    expect(isAuditApiPath('/api/audit-web')).toBe(false);
  });

  test('a text/plain body is rejected before any gate', async () => {
    const tracker = newTracker();
    const { res } = await call(post('target=anc.dev', { contentType: 'text/plain' }), makeEnv({ tracker }));
    expect(res.status).toBe(415);
    expect((await errorOf(res)).code).toBe('invalid_body');
    expect(tracker.limiterCalls).toEqual([]);
  });

  test('a 129-character target is rejected with the shared error object before classification', async () => {
    const { res } = await call(post({ target: 'a'.repeat(129), turnstile_token: 'x' }), makeEnv());
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('target_too_long');
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.cta.length).toBeGreaterThan(0);
  });

  test('bodies with input and with target both succeed during the phased landing', async () => {
    const a = await call(post({ input: 'ripgrep', turnstile_token: 'x' }), makeEnv());
    const b = await call(post({ target: 'ripgrep', turnstile_token: 'x' }), makeEnv());
    expect(a.res.status).toBe(200);
    expect(b.res.status).toBe(200);
  });
});

describe('POST /api/score: unmetered tiers', () => {
  test('a registry hit is one JSON body carrying the envelope with tier registry plus the legacy nested fields', async () => {
    const tracker = newTracker();
    const { res } = await call(
      post({ target: 'ripgrep', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      makeEnv({ tracker }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, unknown> & { scorecard: Record<string, unknown> };
    expect(body).toMatchObject({
      kind: 'cli',
      tier: 'registry',
      target: 'ripgrep',
      scorecard_url: 'https://anc.dev/score/ripgrep',
      json_url: 'https://anc.dev/score/ripgrep/json',
      score_pct: 92,
      spec_version: SPEC_VERSION,
      auditor_url: expect.any(String),
    });
    expect(body.scorecard).toMatchObject({ kind: 'registry_hit', scorecard_url: '/score/ripgrep' });
    expect(tracker.limiterCalls).toEqual([]);
  });

  test('a cache-hit target with no client identity and a limiter that throws returns 200 and spends no budget (both lanes)', async () => {
    const tracker = newTracker();
    const env = makeEnv({
      tracker,
      limiterThrows: true,
      cacheContent: {
        [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: WEB_RECORD('anc.dev'),
        [cliKeyFor('ouch', SPEC_VERSION)]: CLI_RECORD,
      },
    });
    const web = await call(post({ target: 'anc.dev' }, { ip: null }), env);
    expect(web.res.status).toBe(200);
    const webBody = (await web.res.json()) as Record<string, unknown>;
    expect(webBody).toMatchObject({
      kind: 'web',
      tier: 'cache',
      target: 'anc.dev',
      scorecard_url: 'https://anc.dev/score/anc.dev',
    });
    expect((webBody.freshness as { cached: boolean }).cached).toBe(true);
    const cli = await call(post({ target: 'cargo binstall ouch' }, { ip: null }), env);
    expect(cli.res.status).toBe(200);
    const cliBody = (await cli.res.json()) as Record<string, unknown>;
    expect(cliBody).toMatchObject({
      kind: 'cli',
      tier: 'cache',
      target: 'ouch',
      share_url: 'https://anc.dev/score/live/ouch',
    });
    expect(tracker.limiterCalls).toEqual([]);
    expect(tracker.doCalls).toBe(0);
  });

  test('a website target the SSRF gate refuses returns 400 with no R2 read and no probe', async () => {
    for (const target of ['10.0.0.1', 'localhost', '[::1]', '0x7f000001']) {
      const tracker = newTracker();
      const { res } = await call(post({ target, turnstile_token: 'x' }), makeEnv({ tracker }));
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe('invalid_target');
      expect(tracker.r2Gets).toEqual([]);
      expect(tracker.probeCalls).toEqual([]);
    }
  });

  test('?fromCache=false skips both cache tiers and still consults the registry', async () => {
    const tracker = newTracker();
    const env = makeEnv({ tracker, cacheContent: { [cliKeyFor('ouch', SPEC_VERSION)]: CLI_RECORD } });
    const hit = await call(post({ target: 'ripgrep', turnstile_token: 'x' }, { query: '?fromCache=false' }), env);
    expect(((await hit.res.json()) as { tier: string }).tier).toBe('registry');
    const { res } = await call(
      post({ target: 'cargo binstall ouch', turnstile_token: 'x' }, { query: '?fromCache=false' }),
      env,
    );
    expect(res.status).toBe(200);
    expect(tracker.r2Gets).toEqual([]);
    expect(tracker.doCalls).toBe(1);
  });
});

describe('POST /api/score: admission', () => {
  test('a missing token is 403 turnstile_failed and spends no limiter budget', async () => {
    const tracker = newTracker();
    const { res } = await call(post({ target: 'cargo binstall ouch' }), makeEnv({ tracker }));
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('turnstile_failed');
    expect(tracker.limiterCalls).toEqual([]);
  });

  test('a rejected token is 403 turnstile_failed', async () => {
    const { res } = await call(
      post({ target: 'cargo binstall ouch', turnstile_token: 'bad' }),
      makeEnv({ turnstile: 'reject' }),
    );
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('turnstile_failed');
  });

  test('a siteverify transport failure, timeout, non-2xx, or malformed response is 503 turnstile_unavailable with retry_after', async () => {
    for (const mode of ['transport', 'timeout', 'non2xx', 'malformed'] as const) {
      const { res } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv({ turnstile: mode }));
      expect(res.status).toBe(503);
      const error = await errorOf(res);
      expect(error.code).toBe('turnstile_unavailable');
      expect(typeof error.retry_after).toBe('number');
      expect(res.headers.get('retry-after')).toBe(String(error.retry_after));
    }
  });

  test('a missing Turnstile secret is 503 turnstile_unavailable with retry_after (KTD3)', async () => {
    const { res } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv({ turnstile: 'no-secret' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect((await errorOf(res)).code).toBe('turnstile_unavailable');
  });

  test('a request with no cf-connecting-ip is denied before siteverify; an IPv6 client is keyed by its /48', async () => {
    const noIp = newTracker();
    const denied = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { ip: null }),
      makeEnv({ tracker: noIp }),
    );
    expect(denied.res.status).toBe(403);
    expect((await errorOf(denied.res)).code).toBe('turnstile_failed');
    expect(noIp.siteverifyCalls).toBe(0);
    const tracker = newTracker();
    const env = makeEnv({ tracker });
    await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { ip: '2001:db8:abcd:0012:0000:0000:0000:0001' }),
      env,
    );
    const hourly = tracker.kvPuts.find((k) => k.startsWith('audit:web:'));
    expect(hourly).toBeDefined();
    expect(hourly).toContain('2001:db8:abcd::/48');
  });

  test('a missing limiter or KV binding is service_misconfigured', async () => {
    const noLimiter = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv({ noLimiter: true }));
    expect(noLimiter.res.status).toBe(500);
    expect((await errorOf(noLimiter.res)).code).toBe('service_misconfigured');
    const noKv = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), makeEnv({ noKv: true }));
    expect(noKv.res.status).toBe(500);
    expect((await errorOf(noKv.res)).code).toBe('service_misconfigured');
  });

  test('a rate-limited request returns JSON with retry_after and never opens a stream', async () => {
    const { res } = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      makeEnv({ limiter: false }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toContain('application/json');
    const error = await errorOf(res);
    expect(error).toMatchObject({ code: 'rate_limited', retry_after: 60 });
    expect(res.headers.get('retry-after')).toBe('60');
  });

  test('the two lanes share the shared error object on a limiter denial', async () => {
    const env = makeEnv({ limiter: false });
    const web = await errorOf((await call(post({ target: 'anc.dev', turnstile_token: 'x' }), env)).res);
    const cli = await errorOf((await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), env)).res);
    expect(Object.keys(web).sort()).toEqual(Object.keys(cli).sort());
    expect(web.code).toBe('rate_limited');
    expect(cli.code).toBe('rate_limited');
  });

  test('exhausting the CLI hourly window leaves the website window untouched for the same IP', async () => {
    const bucket = Math.floor(Date.now() / 3_600_000);
    const env = makeEnv({ kvSeed: { [`audit:cli:203.0.113.9:${bucket}`]: '30' } });
    const cli = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), env);
    expect(cli.res.status).toBe(429);
    const web = await call(post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }), env);
    expect(web.res.status).toBe(200);
  });

  test('the website kill switch denies the website lane while the CLI lane proceeds', async () => {
    const env = makeEnv({ webKill: true });
    const web = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), env);
    expect(web.res.status).toBe(503);
    expect((await errorOf(web.res)).code).toBe('web_audit_disabled');
    const cli = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), env);
    expect(cli.res.status).toBe(200);
  });

  test('the website kill switch still serves a stale hit as data', async () => {
    const stale = { ...WEB_RECORD('anc.dev'), scored_at: new Date(Date.now() - 600_000).toISOString() };
    const env = makeEnv({
      webKill: true,
      cacheContent: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: stale },
    });
    const { res } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tier: string }).tier).toBe('cache');
  });

  test('the CLI kill switch denies the CLI lane with a Retry-After', async () => {
    const { res } = await call(
      post({ target: 'cargo binstall ouch', turnstile_token: 'x' }),
      makeEnv({ cliKill: true }),
    );
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe('scoring_disabled');
    expect(res.headers.get('retry-after')).toBe('3600');
  });

  test('a passing admission mints the shared session cookie once', async () => {
    const env = makeEnv();
    const first = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      env,
    );
    const cookie = first.res.headers.get('set-cookie');
    expect(cookie).toContain('__Host-anc-session=');
    const value = cookie?.split(';')[0] ?? '';
    const second = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }, { cookie: value }), env);
    expect(second.res.headers.get('set-cookie')).toBeNull();
  });
});

describe('POST /api/score: response mode', () => {
  test('Accept x-ndjson on a website cache miss streams accepted first, then discovery and checks, then complete', async () => {
    const { res, ctx } = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = await ndjson(res);
    await Promise.all(ctx._promises);
    expect(lines[0]).toMatchObject({ type: 'accepted', lane: 'web', target: 'anc.dev' });
    expect(lines.some((l) => l.type === 'discovery')).toBe(true);
    expect(lines.some((l) => l.type === 'check')).toBe(true);
    const last = lines[lines.length - 1];
    expect(last).toMatchObject({
      type: 'complete',
      kind: 'web',
      tier: 'live',
      target: 'anc.dev',
      scorecard_url: 'https://anc.dev/score/anc.dev',
    });
    expect((last.freshness as { cached: boolean }).cached).toBe(false);
  });

  test('a plain Accept on a website cache miss yields one JSON envelope', async () => {
    const { res, ctx } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    await Promise.all(ctx._promises);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'web', tier: 'live', target: 'anc.dev', target_url: 'https://anc.dev/' });
  });

  test('a CLI cache miss with a plain Accept yields the envelope beside the legacy triad and share_url', async () => {
    const tracker = newTracker();
    const { res } = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), makeEnv({ tracker }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      kind: 'cli',
      tier: 'live',
      target: 'ouch',
      scorecard_url: 'https://anc.dev/score/ouch',
      anc_version: ANC_VERSION,
      share_url: 'https://anc.dev/score/live/ouch',
    });
    expect(tracker.doCalls).toBe(1);
  });

  test('a CLI cache miss with Accept x-ndjson streams accepted then the resolving phase then complete', async () => {
    const { res } = await call(
      post({ target: 'cargo binstall ouch', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const lines = await ndjson(res);
    expect(lines[0]).toMatchObject({ type: 'accepted', lane: 'cli', target: 'cargo binstall ouch' });
    expect(lines[1]).toMatchObject({ type: 'phase', phase: 'resolving' });
    expect(lines[lines.length - 1]).toMatchObject({ type: 'complete', tier: 'live', target: 'ouch' });
  });

  test('a CLI bounce after accepted arrives as a bounce event with the shared error object', async () => {
    const { res } = await call(
      post({ target: 'cargo binstall ouch', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      makeEnv({ doResponse: { error: 'chain_resolved_install_failed', details: 'cargo exploded' } }),
    );
    const lines = await ndjson(res);
    const last = lines[lines.length - 1] as { type: string; error: { code: string; details: string } };
    expect(last.type).toBe('bounce');
    expect(last.error).toMatchObject({ code: 'chain_resolved_install_failed', details: 'cargo exploded' });
  });
});

describe('POST /api/score: refresh and branch snapshots', () => {
  test('refresh: true with a cached binary record skips the cache and dispatches one run', async () => {
    const tracker = newTracker();
    const env = makeEnv({ tracker, cacheContent: { [cliKeyFor('ouch', SPEC_VERSION)]: CLI_RECORD } });
    const { res } = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x', refresh: true }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tier: string }).tier).toBe('live');
    expect(tracker.doCalls).toBe(1);
  });

  test('refresh: true without a valid token is 403 like any transact', async () => {
    const tracker = newTracker();
    const env = makeEnv({ tracker, cacheContent: { [cliKeyFor('ouch', SPEC_VERSION)]: CLI_RECORD } });
    const { res } = await call(post({ target: 'cargo binstall ouch', refresh: true }), env);
    expect(res.status).toBe(403);
    expect(tracker.doCalls).toBe(0);
  });

  test('refresh: true is a no-op on a registry hit and on the website lane', async () => {
    const tracker = newTracker();
    const env = makeEnv({
      tracker,
      cacheContent: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: WEB_RECORD('anc.dev') },
    });
    const hit = await call(post({ target: 'ripgrep', turnstile_token: 'x', refresh: true }), env);
    expect(((await hit.res.json()) as { tier: string }).tier).toBe('registry');
    const web = await call(post({ target: 'anc.dev', turnstile_token: 'x', refresh: true }), env);
    expect(((await web.res.json()) as { tier: string }).tier).toBe('cache');
    expect(tracker.probeCalls).toEqual([]);
  });

  test('a tokened branch-target POST dispatches even with a snapshot; a tokenless one is 403 and reads no R2', async () => {
    const tracker = newTracker();
    const env = makeEnv({
      tracker,
      cacheContent: { [cliKeyFor('o/r@main', SPEC_VERSION)]: CLI_RECORD },
      doResponse: {
        scorecard: { tool: { name: 'r', binary: 'r', version: null }, badge: { score_pct: 50, eligible: false } },
        anc_version: ANC_VERSION,
        source_sha: 'abc1234',
      },
    });
    const tokenless = await call(post({ target: 'o/r@main' }), env);
    expect(tokenless.res.status).toBe(403);
    expect(tracker.r2Gets).toEqual([]);
    const tokened = await call(post({ target: 'o/r@main', turnstile_token: 'x' }), env);
    expect(tokened.res.status).toBe(200);
    const body = (await tokened.res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ tier: 'live', target: 'o/r@main', scorecard_url: 'https://anc.dev/score/o/r@main' });
    expect(tracker.doCalls).toBe(1);
  });
});

describe('POST /api/score: in-flight flags', () => {
  test('the input-keyed flag is written at accepted and deleted at the terminal line', async () => {
    const env = makeEnv();
    const { res, ctx } = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      env,
    );
    const reader = res.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('"accepted"');
    expect(env._kv.get('inflight:web:anc.dev')).toBeDefined();
    expect(JSON.parse(env._kv.get('inflight:web:anc.dev') ?? '{}')).toMatchObject({ started_at: expect.any(String) });
    while (!(await reader?.read())?.done) {}
    await Promise.all(ctx._promises);
    expect(env._kv.get('inflight:web:anc.dev')).toBeUndefined();
  });

  test('a tokenless POST returns 202 in_progress while the input is in flight and spends no budget', async () => {
    const tracker = newTracker();
    const env = makeEnv({
      tracker,
      kvSeed: { 'inflight:cli:cargo binstall ouch': JSON.stringify({ started_at: new Date().toISOString() }) },
    });
    const { res } = await call(post({ target: 'cargo binstall ouch' }), env);
    expect(res.status).toBe(202);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      in_progress: true,
      started_at: expect.any(String),
    });
    expect(tracker.limiterCalls).toEqual([]);
  });
});

describe('POST /api/score: telemetry', () => {
  test('one audit.request line per call with lane, tier, and outcome', async () => {
    const seen = captureLogs();
    try {
      await call(post({ target: 'ripgrep', turnstile_token: 'x' }), makeEnv());
    } finally {
      seen.restore();
    }
    const rows = seen.records.filter((r) => r.record.scope === 'audit.request').map((r) => r.record);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lane: 'cli', tier: 'registry', outcome: 'hit' });
  });
});

describe('POST /api/score: review pins', () => {
  test('the website lane ignores ?fromCache=false: a fresh listed record is served with its listing kept and no flip budget spent', async () => {
    const tracker = newTracker();
    const listed = {
      ...WEB_RECORD('anc.dev'),
      scorecard: { ...WEB_RECORD('anc.dev').scorecard, public_listing: true },
    };
    const env = makeEnv({ tracker, cacheContent: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: listed } });
    const { res } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }, { query: '?fromCache=false' }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tier: string; scorecard: { public_listing?: boolean } };
    expect(body.tier).toBe('cache');
    expect(body.scorecard.public_listing).toBe(true);
    expect(tracker.probeCalls).toEqual([]);
    expect(tracker.limiterCalls).toEqual([]);
    expect(tracker.kvPuts.some((k) => k.startsWith('web_audit_flip:'))).toBe(false);
  });

  test('?fromCache=false bypasses the in-flight flag on the CLI lane (KTD14) while refresh: true attaches', async () => {
    const flag = JSON.stringify({ started_at: new Date().toISOString() });
    const env = makeEnv({ kvSeed: { 'inflight:cli:cargo binstall ouch': flag } });
    const attached = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x', refresh: true }), env);
    expect(attached.res.status).toBe(202);
    const hatch = await call(
      post({ target: 'cargo binstall ouch', turnstile_token: 'x' }, { query: '?fromCache=false' }),
      makeEnv({ kvSeed: { 'inflight:cli:cargo binstall ouch': flag } }),
    );
    expect(hatch.res.status).toBe(200);
    expect(((await hatch.res.json()) as { tier: string }).tier).toBe('live');
  });

  test('the legacy input key is CLI-only during the phased landing: a website under it is 400 unrecognized_input with no probe, R2 read, or budget', async () => {
    const tracker = newTracker();
    const { res } = await call(post({ input: 'anc.dev', turnstile_token: 'x' }), makeEnv({ tracker }));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('unrecognized_input');
    expect(tracker.probeCalls).toEqual([]);
    expect(tracker.r2Gets).toEqual([]);
    expect(tracker.limiterCalls).toEqual([]);
    const viaTarget = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv());
    expect(viaTarget.res.status).toBe(200);
  });

  test('body validation: invalid JSON, a non-object body, no target, a bad site_type, and a non-boolean public_listing are each 400 with their code and no top-level status', async () => {
    const cases: Array<[Record<string, unknown> | string, string]> = [
      ['not json', 'invalid_body'],
      ['null', 'invalid_body'],
      ['[]', 'invalid_body'],
      [{}, 'target_empty'],
      [{ target: 'anc.dev', site_type: 'bogus' }, 'invalid_site_type'],
      [{ target: 'anc.dev', public_listing: 'yes' }, 'invalid_public_listing'],
    ];
    for (const [body, code] of cases) {
      const { res } = await call(post(body), makeEnv());
      expect(res.status).toBe(400);
      const json = (await res.json()) as { status?: unknown; error: { code: string } };
      expect(json.error.code).toBe(code);
      expect(json.status).toBeUndefined();
    }
  });

  test('a streamed run emits its audit.request row from the relay with the terminal outcome', async () => {
    const seen = captureLogs();
    try {
      const { res, ctx } = await call(
        post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
        makeEnv(),
      );
      await res.text();
      await Promise.all(ctx._promises);
    } finally {
      seen.restore();
    }
    const rows = seen.records.filter((r) => r.record.scope === 'audit.request').map((r) => r.record);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lane: 'web', tier: 'live', outcome: 'complete', status: 200, stream: true });
  });

  test('a throw from the CLI core yields a terminal error line on the stream, a 500 error object on the JSON path, and clears the flag', async () => {
    const env = makeEnv({ doThrows: true });
    const stream = await call(
      post({ target: 'cargo binstall ouch', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      env,
    );
    const lines = await ndjson(stream.res);
    await Promise.all(stream.ctx._promises);
    expect(lines[lines.length - 1]).toMatchObject({ type: 'error', error: { code: 'incomplete_response_contract' } });
    expect([...env._kv.keys()].some((k) => k.startsWith('inflight:'))).toBe(false);
    const json = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), makeEnv({ doThrows: true }));
    expect(json.res.status).toBe(500);
    expect((await errorOf(json.res)).code).toBe('incomplete_response_contract');
  });

  test('a heartbeat never follows the terminal line', async () => {
    const { res, ctx } = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      makeEnv(),
    );
    const lines = await ndjson(res);
    await Promise.all(ctx._promises);
    expect(lines[lines.length - 1].type).toBe('complete');
  });

  test('an unreachable website target ends the stream with an error event and answers 502 on the JSON path', async () => {
    const stream = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      makeEnv({ probe: 'unreachable' }),
    );
    const lines = await ndjson(stream.res);
    await Promise.all(stream.ctx._promises);
    expect(lines[lines.length - 1]).toMatchObject({ type: 'error', error: { code: 'unreachable' } });
    const json = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv({ probe: 'unreachable' }));
    expect(json.res.status).toBe(502);
    expect((await errorOf(json.res)).code).toBe('unreachable');
  });

  test('a differing explicit public_listing on a fresh website record is patched in place; the flip ceiling answers 429; a failed write answers 500', async () => {
    const key = await webKeyFor('https://anc.dev/', SPEC_VERSION);
    const listed = {
      ...WEB_RECORD('anc.dev'),
      scorecard: { ...WEB_RECORD('anc.dev').scorecard, public_listing: true },
    };
    const tracker = newTracker();
    const patched = await call(
      post({ target: 'anc.dev', turnstile_token: 'x', public_listing: false }),
      makeEnv({ tracker, cacheContent: { [key]: listed } }),
    );
    expect(patched.res.status).toBe(200);
    const body = (await patched.res.json()) as { tier: string; scorecard: { public_listing?: boolean } };
    expect(body.tier).toBe('cache');
    expect(body.scorecard.public_listing).toBe(false);
    expect(tracker.probeCalls).toEqual([]);
    expect(tracker.kvPuts.some((k) => k.startsWith('web_audit_flip:'))).toBe(true);

    const bucket = Math.floor(Date.now() / 3_600_000);
    const flipKey = tracker.kvPuts.find((k) => k.startsWith('web_audit_flip:')) ?? '';
    expect(flipKey.endsWith(`:${bucket}`)).toBe(true);
    const capped = await call(
      post({ target: 'anc.dev', turnstile_token: 'x', public_listing: false }),
      makeEnv({ cacheContent: { [key]: listed }, kvSeed: { [flipKey]: '5' } }),
    );
    expect(capped.res.status).toBe(429);
    expect((await errorOf(capped.res)).code).toBe('flip_rate_limited');

    const failed = await call(
      post({ target: 'anc.dev', turnstile_token: 'x', public_listing: false }),
      makeEnv({ cacheContent: { [key]: listed }, cachePutThrows: true }),
    );
    expect(failed.res.status).toBe(500);
    expect((await errorOf(failed.res)).code).toBe('patch_failed');
  });

  test('the website lane draws from the hourly bucket the legacy route and the MCP tool share', async () => {
    const bucket = Math.floor(Date.now() / 3_600_000);
    const env = makeEnv({ kvSeed: { [`audit:web:203.0.113.9:${bucket}`]: '30' } });
    const { res } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), env);
    expect(res.status).toBe(429);
    expect((await errorOf(res)).code).toBe('rate_limited');
  });

  test('the result-keyed in-flight twin exists before the sandbox dispatch', async () => {
    let twinAtDispatch = false;
    const env = makeEnv({
      onDoFetch: () => {
        twinAtDispatch = env._kv.has('inflight:cli:ouch');
      },
    });
    const { res, ctx } = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), env);
    expect(res.status).toBe(200);
    await Promise.all(ctx._promises);
    expect(twinAtDispatch).toBe(true);
    expect(env._kv.has('inflight:cli:ouch')).toBe(false);
  });

  test('a post-mint denial still sets the session cookie and its body carries no server detail', async () => {
    const { res } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv({ limiter: false }));
    expect(res.status).toBe(429);
    expect(res.headers.get('set-cookie')).toContain('__Host-anc-session=');
    const noSecret = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv({ turnstile: 'no-secret' }));
    expect(await noSecret.res.text()).not.toMatch(/TURNSTILE_SECRET|binding missing|limiter failed|no client address/);
    const unavailable = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }),
      makeEnv({ turnstile: 'transport' }),
    );
    const unavailableBody = (await unavailable.res.json()) as { error: { details?: string } };
    expect(unavailableBody.error.details).toBeUndefined();
  });
});
