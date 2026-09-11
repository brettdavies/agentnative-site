// The endpoint test environment: bindings, stubs, and request helpers
// shared by the transact endpoint suite and the stream suite.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry } from '../../src/build/13-web-audit-registry.mjs';
import { type AuditApiDeps, type AuditApiEnv, handleAuditApi } from '../../src/worker/audit/api';
import type { Sandbox } from '../../src/worker/score/do';
import { ANC_VERSION, SPEC_VERSION } from '../../src/worker/spec-version.gen';

// POST /api/score accepts both lanes with one gate stack and one response
// contract. These tests post a website target and a CLI target through the
// same endpoint against stubbed bindings and assert the shared error object
// and envelope on every outcome enumerated below.

export const REPO_ROOT = new URL('../..', import.meta.url).pathname;

export let registryJsonPromise: Promise<string> | null = null;
export async function webRegistryJson(): Promise<string> {
  if (!registryJsonPromise) {
    registryJsonPromise = (async () => {
      const raw = await readFile(join(REPO_ROOT, 'src', 'data', 'web-audit', 'registry.yaml'), 'utf8');
      return JSON.stringify(normalizeWebAuditRegistry(yaml.load(raw) as object));
    })();
  }
  return registryJsonPromise;
}

export const REGISTRY_INDEX = {
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
export const HINTS_INDEX = { by_owner_repo: {} };

export type Tracker = {
  doCalls: number;
  siteverifyCalls: number;
  r2Gets: string[];
  probeCalls: string[];
  limiterCalls: string[];
  kvPuts: string[];
};

export function newTracker(): Tracker {
  return { doCalls: 0, siteverifyCalls: 0, r2Gets: [], probeCalls: [], limiterCalls: [], kvPuts: [] };
}

export type Overrides = Partial<{
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
  /** Replaces the JSON-body Durable Object stub with a fetch of the caller's own. */
  doFetch: Sandbox['fetch'];
  doThrows: boolean;
  onDoFetch: () => void;
  /** Merged into the deps the caller passes to handleAuditApi. */
  deps: Partial<AuditApiDeps>;
  cachePutThrows: boolean;
  probe: 'ok' | 'unreachable';
  kvSeed: Record<string, string>;
}>;

export function makeKv(seed: Record<string, string>, tracker?: Tracker): KVNamespace {
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

export function makeEnv(overrides: Overrides = {}): AuditApiEnv & { _kv: Map<string, string>; _deps: AuditApiDeps } {
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
  const stubFetch: Sandbox['fetch'] = async (req) => {
    tracker.doCalls += 1;
    overrides.onDoFetch?.();
    if (overrides.doThrows) throw new Error('DO exploded');
    if (overrides.doFetch) return overrides.doFetch(req);
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
    _deps: {
      turnstileFetch,
      siteverifyTimeoutMs: 50,
      probeFetch: probeFetchFor(tracker, overrides.probe ?? 'ok'),
      ...(overrides.deps ?? {}),
    },
  });
}

export function probeFetchFor(tracker: Tracker, probe: 'ok' | 'unreachable'): typeof fetch {
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

export function makeCtx(): ExecutionContext & { _promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => promises.push(p),
    passThroughOnException: () => {},
    props: {},
    _promises: promises,
  } as unknown as ExecutionContext & { _promises: Promise<unknown>[] };
}

export type Deps = AuditApiDeps;

export function post(
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

export async function call(req: Request, env: ReturnType<typeof makeEnv>, ctx = makeCtx()) {
  const res = await handleAuditApi(req, env, ctx, (env as unknown as { _deps: Deps })._deps);
  return { res, ctx };
}

export async function errorOf(
  res: Response,
): Promise<{ code: string; message: string; cta: string; retry_after?: number }> {
  const body = (await res.json()) as { error: { code: string; message: string; cta: string; retry_after?: number } };
  return body.error;
}

export async function ndjson(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

export const WEB_RECORD = (host: string) => ({
  spec_version: SPEC_VERSION,
  target_url: `https://${host}/`,
  scorecard: { target_url: `https://${host}/`, score_pct: 64, results: [] },
  scored_at: new Date().toISOString(),
});

export const CLI_RECORD = {
  spec_version: SPEC_VERSION,
  anc_version: ANC_VERSION,
  tool_version: '0.5.0',
  scorecard: { tool: { name: 'ouch', binary: 'ouch', version: '0.5.0' }, badge: { score_pct: 71, eligible: true } },
};
