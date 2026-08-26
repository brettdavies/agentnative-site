// Web-audit route tests (plan U7 + U8): the /api/audit-web streaming
// dispatch gate chain, and the /web/<domain> shareable result page.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry, normalizeWebRemediation } from '../src/build/13-web-audit-registry.mjs';
import { type CachedWebAudit, keyFor } from '../src/worker/audit-web/cache';
import { decidePublicListingWrite } from '../src/worker/audit-web/public-listing';
import {
  handleWebAudit,
  handleWebResultPage,
  handleWebScoringPage,
  isWebAuditPath,
  isWebScoringPath,
  parseWebResultPath,
  parseWebScoringPath,
  type WebAuditRouteEnv,
} from '../src/worker/audit-web/route';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

let registryJsonPromise: Promise<string> | null = null;
async function registryJson(): Promise<string> {
  if (!registryJsonPromise) {
    registryJsonPromise = (async () => {
      const raw = await readFile(join(REPO_ROOT, 'src', 'data', 'web-audit', 'registry.yaml'), 'utf8');
      return JSON.stringify(normalizeWebAuditRegistry(yaml.load(raw) as object));
    })();
  }
  return registryJsonPromise;
}

let remediationJsonPromise: Promise<string> | null = null;
async function remediationJson(): Promise<string> {
  if (!remediationJsonPromise) {
    remediationJsonPromise = (async () => {
      const dataDir = join(REPO_ROOT, 'src', 'data', 'web-audit');
      const registry = normalizeWebAuditRegistry(
        yaml.load(await readFile(join(dataDir, 'registry.yaml'), 'utf8')) as object,
      );
      const checks = registry.checks as Array<{ id: string }>;
      const remediation = normalizeWebRemediation(
        yaml.load(await readFile(join(dataDir, 'remediation.yaml'), 'utf8')) as object,
        checks.map((c) => c.id),
      );
      return JSON.stringify(remediation);
    })();
  }
  return remediationJsonPromise;
}

const SEED_FIXTURE = [{ domain: 'seeded.dev', url: 'https://seeded.dev/', name: 'seeded.dev', description: 'seeded' }];

function makeAssets(opts: { failRegistry?: boolean } = {}): Fetcher {
  return {
    async fetch(input: RequestInfo | URL) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/_internal/web-audit-registry.json')) {
        if (opts.failRegistry) return new Response('boom', { status: 500 });
        return new Response(await registryJson(), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/_internal/web-remediation.json')) {
        return new Response(await remediationJson(), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/_internal/web-seed.json')) {
        return new Response(JSON.stringify(SEED_FIXTURE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/_internal/score-live-shell.html')) {
        return new Response(
          '<!doctype html><title>{{TITLE}}</title><meta name="description" content="{{DESCRIPTION}}"><link rel="canonical" href="{{CANONICAL_PATH}}"><main>{{BODY}}</main>',
          {
            status: 200,
            headers: { 'content-type': 'text/html' },
          },
        );
      }
      return new Response('not found', { status: 404 });
    },
  } as unknown as Fetcher;
}

function makeR2(prefill: Record<string, unknown> = {}): { bucket: R2Bucket; store: Map<string, string> } {
  const store = new Map<string, string>();
  for (const [k, v] of Object.entries(prefill)) store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const bucket = {
    async get(key: string) {
      const raw = store.get(key);
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
      store.set(key, typeof value === 'string' ? value : String(value));
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as R2Bucket;
  return { bucket, store };
}

function alwaysPassLimiter() {
  return { limit: async () => ({ success: true }) };
}

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

function stubProbeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/mcp') && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { serverInfo: { name: 'anc' }, protocolVersion: '2025-06-18' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (
      url.endsWith('/llms.txt') ||
      url.endsWith('/robots.txt') ||
      url.endsWith('/openapi.json') ||
      url === 'https://example.com/'
    ) {
      return new Response('# ok\n[x](https://example.com/x)', { status: 200 });
    }
    if (url.includes('dns-query') || url.includes('/resolve')) {
      return new Response(JSON.stringify({ Status: 3, Answer: [] }), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

/** Turnstile siteverify stub — accepts any token so fresh-path tests pass. */
function stubTurnstileFetch(): typeof fetch {
  return (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

function makeEnv(overrides: Partial<WebAuditRouteEnv> = {}): WebAuditRouteEnv {
  return {
    ASSETS: makeAssets(),
    SCORE_CACHE: makeR2().bucket,
    SCORE_KV: makeKv(),
    WEB_AUDIT_ENABLED: 'true',
    TURNSTILE_SECRET: 'test-turnstile-secret',
    SESSION_HMAC_SECRET: 'test-session-secret',
    WEB_AUDIT_LIMITER: alwaysPassLimiter(),
    WEB_AUDIT_LIMITER_IP: alwaysPassLimiter(),
    ...overrides,
  };
}

/** Dispatch with a passing Turnstile stub by default; per-test deps override. */
function runAudit(
  request: Request,
  env: WebAuditRouteEnv,
  ctx: ExecutionContext,
  deps: Parameters<typeof handleWebAudit>[3] = {},
): Promise<Response> {
  return handleWebAudit(request, env, ctx, { turnstileFetch: stubTurnstileFetch(), ...deps });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeCtx(): ExecutionContext {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => promises.push(p),
    passThroughOnException: () => {},
    props: {},
    _promises: promises,
  } as unknown as ExecutionContext & { _promises: Promise<unknown>[] };
}

function auditRequest(
  url: string,
  headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.9' },
  body: Record<string, unknown> = {},
): Request {
  return new Request('https://anc.dev/api/audit-web', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ url, turnstile_token: 'x', ...body }),
  });
}

async function readNdjson(resp: Response): Promise<Array<Record<string, unknown>>> {
  const text = await resp.text();
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe('isWebAuditPath', () => {
  test('matches only /api/audit-web', () => {
    expect(isWebAuditPath('/api/audit-web')).toBe(true);
    expect(isWebAuditPath('/api/score')).toBe(false);
    expect(isWebAuditPath('/web/example.com')).toBe(false);
  });
});

describe('handleWebAudit gate chain', () => {
  test('kill switch off returns 503 Retry-After on a cache miss', async () => {
    const env = makeEnv({ WEB_AUDIT_ENABLED: undefined });
    const resp = await runAudit(auditRequest('https://example.com/'), env, makeCtx());
    expect(resp.status).toBe(503);
    expect(resp.headers.get('retry-after')).toBe('3600');
  });

  test('kill switch off still serves a cache hit as data', async () => {
    const url = 'https://example.com/';
    const key = await keyFor(url, SPEC_VERSION);
    const cached = {
      spec_version: SPEC_VERSION,
      target_url: url,
      scorecard: { schema_version: '0.2', target_url: url, score_pct: 64, results: [] },
    };
    const { bucket } = makeR2({ [key]: cached });
    const env = makeEnv({ WEB_AUDIT_ENABLED: undefined, SCORE_CACHE: bucket });
    const resp = await runAudit(auditRequest(url, {}), env, makeCtx());
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { cached: boolean; scorecard: { score_pct: number } };
    expect(body.cached).toBe(true);
    expect(body.scorecard.score_pct).toBe(64);
  });

  test('non-POST returns 405', async () => {
    const env = makeEnv();
    const resp = await handleWebAudit(new Request('https://anc.dev/api/audit-web', { method: 'GET' }), env, makeCtx());
    expect(resp.status).toBe(405);
  });

  test('private-URL input is rejected by the SSRF pre-flight before any probe', async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const resp = await runAudit(auditRequest('http://169.254.169.254/'), env, ctx, {
      probeFetch: (() => {
        throw new Error('probe should never run');
      }) as unknown as typeof fetch,
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain('blocked');
  });

  test('session limiter breach returns 429 with the session cookie', async () => {
    const env = makeEnv({ WEB_AUDIT_LIMITER: { limit: async () => ({ success: false }) } });
    const resp = await runAudit(auditRequest('https://example.com/'), env, makeCtx());
    expect(resp.status).toBe(429);
    expect(resp.headers.get('set-cookie')).toContain('__Host-anc-session=');
  });

  test('per-IP fallback breach returns 429 with the session cookie', async () => {
    const env = makeEnv({ WEB_AUDIT_LIMITER_IP: { limit: async () => ({ success: false }) } });
    const resp = await runAudit(auditRequest('https://example.com/'), env, makeCtx());
    expect(resp.status).toBe(429);
    expect(resp.headers.get('set-cookie')).toContain('__Host-anc-session=');
  });

  test('malformed body returns 400', async () => {
    const env = makeEnv();
    const req = new Request('https://anc.dev/api/audit-web', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: 'not json',
    });
    const resp = await runAudit(req, env, makeCtx());
    expect(resp.status).toBe(400);
  });
});

describe('handleWebAudit fresh-path bot defense', () => {
  test('missing turnstile_token returns 400 turnstile_failed', async () => {
    const env = makeEnv();
    const resp = await runAudit(
      auditRequest('https://example.com/', undefined, { turnstile_token: undefined }),
      env,
      makeCtx(),
    );
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: string }).error).toBe('turnstile_failed');
  });

  test('a rejected token returns 400 turnstile_failed', async () => {
    const env = makeEnv();
    const resp = await handleWebAudit(auditRequest('https://example.com/'), env, makeCtx(), {
      turnstileFetch: (async (_i: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ success: false }), { status: 200 })) as typeof fetch,
    });
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: string }).error).toBe('turnstile_failed');
  });

  test('absent TURNSTILE_SECRET fails fast with 500', async () => {
    const env = makeEnv({ TURNSTILE_SECRET: undefined });
    const resp = await runAudit(auditRequest('https://example.com/'), env, makeCtx());
    expect(resp.status).toBe(500);
    expect(((await resp.json()) as { error: string }).error).toBe('service_misconfigured');
  });

  test('absent SESSION_HMAC_SECRET fails fast with 500', async () => {
    const env = makeEnv({ SESSION_HMAC_SECRET: undefined });
    const resp = await runAudit(auditRequest('https://example.com/'), env, makeCtx());
    expect(resp.status).toBe(500);
    expect(((await resp.json()) as { error: string }).error).toBe('service_misconfigured');
  });

  test('session limiter is keyed <sid>:<sha256(target)>; IP fallback consulted on pass', async () => {
    const sessionKeys: string[] = [];
    const ipKeys: string[] = [];
    const env = makeEnv({
      WEB_AUDIT_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          sessionKeys.push(key);
          return { success: true };
        },
      },
      WEB_AUDIT_LIMITER_IP: {
        limit: async ({ key }: { key: string }) => {
          ipKeys.push(key);
          return { success: true };
        },
      },
    });
    const resp = await runAudit(auditRequest('https://example.com/'), env, makeCtx(), { probeFetch: stubProbeFetch() });
    expect(resp.status).toBe(200);
    const expectedTargetHash = await sha256Hex('https://example.com/');
    expect(sessionKeys).toHaveLength(1);
    expect(sessionKeys[0].endsWith(`:${expectedTargetHash}`)).toBe(true);
    expect(sessionKeys[0].split(':')[0].length).toBeGreaterThan(0);
    expect(ipKeys).toEqual(['203.0.113.9']);
  });

  test('a fresh audit mints a session cookie on the streaming 200', async () => {
    const env = makeEnv();
    const resp = await runAudit(auditRequest('https://example.com/'), env, makeCtx(), { probeFetch: stubProbeFetch() });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('set-cookie')).toContain('__Host-anc-session=');
  });

  test('the hourly budget rejects the 31st fresh audit with a 30/hr message', async () => {
    const kvStore = new Map<string, string>();
    const kv = {
      async get(key: string) {
        return kvStore.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kvStore.set(key, value);
      },
    } as unknown as KVNamespace;
    const env = makeEnv({ SCORE_KV: kv });
    // Pre-fill the current hour bucket at the ceiling.
    const bucket = Math.floor(Date.now() / 3_600_000);
    kvStore.set(`web_audit:203.0.113.9:${bucket}`, '30');
    const resp = await runAudit(auditRequest('https://example.com/'), env, makeCtx());
    expect(resp.status).toBe(429);
    expect(((await resp.json()) as { message: string }).message).toContain('30 per hour');
  });
});

describe('handleWebAudit streaming', () => {
  test('enabled + under limit + cache miss streams check events then a terminal complete', async () => {
    const { bucket, store } = makeR2();
    const env = makeEnv({ SCORE_CACHE: bucket });
    const ctx = makeCtx();
    const resp = await runAudit(auditRequest('https://example.com/'), env, ctx, { probeFetch: stubProbeFetch() });
    expect(resp.status).toBe(200);
    const events = await readNdjson(resp);
    const checks = events.filter((e) => e.type === 'check');
    expect(checks.length).toBe(54);
    const terminal = events.at(-1) as Record<string, unknown>;
    expect(terminal.type).toBe('complete');
    expect(terminal.share_url).toBe('/web/example.com');
    // the ctx.waitUntil-wrapped R2 write lands
    await Promise.all((ctx as unknown as { _promises: Promise<unknown>[] })._promises);
    expect(store.get(await keyFor('https://example.com/', SPEC_VERSION))).toBeDefined();
  });

  test('cache hit returns the cached scorecard without re-running the engine', async () => {
    const url = 'https://example.com/';
    const key = await keyFor(url, SPEC_VERSION);
    const cached = {
      spec_version: SPEC_VERSION,
      target_url: url,
      scorecard: { schema_version: '0.2', target_url: url, score_pct: 77, results: [] },
      scored_at: new Date().toISOString(),
    };
    const { bucket } = makeR2({ [key]: cached });
    const env = makeEnv({ SCORE_CACHE: bucket });
    const resp = await handleWebAudit(auditRequest(url), env, makeCtx(), {
      probeFetch: (() => {
        throw new Error('engine should not run on a cache hit');
      }) as unknown as typeof fetch,
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      cached: boolean;
      share_url: string;
      scorecard: { score_pct: number };
    };
    expect(body.cached).toBe(true);
    expect(body.scorecard.score_pct).toBe(77);
    expect(body.share_url).toBe('/web/example.com');
  });
});

describe('staleness gate + aggregate invalidation', () => {
  const aggregateKey = `audits/web/leaderboard/${SPEC_VERSION}.json`;
  const frontpageKey = `audits/web/leaderboard-frontpage/${SPEC_VERSION}.json`;

  async function stalePrefill(url: string, pct = 55) {
    const key = await keyFor(url, SPEC_VERSION);
    return {
      [key]: {
        spec_version: SPEC_VERSION,
        target_url: url,
        scorecard: { schema_version: '0.2', target_url: url, score_pct: pct, results: [] },
        scored_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
    };
  }

  test('a fresh audit of a seeded domain rebuilds both aggregates', async () => {
    const { bucket, store } = makeR2();
    const env = makeEnv({ SCORE_CACHE: bucket });
    const ctx = makeCtx();
    const resp = await runAudit(auditRequest('https://seeded.dev/'), env, ctx, { probeFetch: stubProbeFetch() });
    expect(resp.status).toBe(200);
    await readNdjson(resp);
    await Promise.all((ctx as unknown as { _promises: Promise<unknown>[] })._promises);
    expect(store.has(aggregateKey)).toBe(true);
    expect(store.has(frontpageKey)).toBe(true);
    const board = JSON.parse(store.get(aggregateKey) as string) as { entries: Array<{ domain: string }> };
    expect(board.entries.map((e) => e.domain)).toEqual(['seeded.dev']);
  });

  test('a fresh audit of a non-seeded domain writes per-domain R2 only', async () => {
    const { bucket, store } = makeR2();
    const env = makeEnv({ SCORE_CACHE: bucket });
    const ctx = makeCtx();
    await readNdjson(await runAudit(auditRequest('https://example.com/'), env, ctx, { probeFetch: stubProbeFetch() }));
    await Promise.all((ctx as unknown as { _promises: Promise<unknown>[] })._promises);
    expect(store.has(await keyFor('https://example.com/', SPEC_VERSION))).toBe(true);
    expect(store.has(aggregateKey)).toBe(false);
    expect(store.has(frontpageKey)).toBe(false);
  });

  test('a hit younger than the threshold serves cached without the engine', async () => {
    const url = 'https://example.com/';
    const key = await keyFor(url, SPEC_VERSION);
    const prefill = await stalePrefill(url);
    (prefill[key] as { scored_at: string }).scored_at = new Date().toISOString();
    const env = makeEnv({ SCORE_CACHE: makeR2(prefill).bucket });
    const resp = await handleWebAudit(auditRequest(url), env, makeCtx(), {
      probeFetch: (() => {
        throw new Error('engine must not run on a fresh hit');
      }) as unknown as typeof fetch,
    });
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { cached: boolean }).cached).toBe(true);
  });

  test('a hit older than the threshold re-runs the engine through the gates', async () => {
    const url = 'https://example.com/';
    const { bucket, store } = makeR2(await stalePrefill(url));
    const env = makeEnv({ SCORE_CACHE: bucket });
    const ctx = makeCtx();
    const resp = await runAudit(auditRequest(url), env, ctx, { probeFetch: stubProbeFetch() });
    expect(resp.status).toBe(200);
    const events = await readNdjson(resp);
    expect(events.at(-1)?.type).toBe('complete');
    await Promise.all((ctx as unknown as { _promises: Promise<unknown>[] })._promises);
    const updated = JSON.parse(store.get(await keyFor(url, SPEC_VERSION)) as string) as { scored_at: string };
    expect(Date.now() - Date.parse(updated.scored_at)).toBeLessThan(60_000);
  });

  test('kill switch off + stale hit still serves the cached entry as data', async () => {
    const url = 'https://example.com/';
    const env = makeEnv({ WEB_AUDIT_ENABLED: undefined, SCORE_CACHE: makeR2(await stalePrefill(url)).bucket });
    const resp = await runAudit(auditRequest(url, {}), env, makeCtx());
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { cached: boolean; scorecard: { score_pct: number } };
    expect(body.cached).toBe(true);
    expect(body.scorecard.score_pct).toBe(55);
  });

  test('a stale hit behind a breached limiter returns 429, not cached (gates still apply)', async () => {
    const url = 'https://example.com/';
    const env = makeEnv({
      SCORE_CACHE: makeR2(await stalePrefill(url)).bucket,
      WEB_AUDIT_LIMITER: { limit: async () => ({ success: false }) },
    });
    const resp = await runAudit(auditRequest(url), env, makeCtx());
    expect(resp.status).toBe(429);
  });
});

describe('parseWebResultPath', () => {
  test('extracts a bare domain', () => {
    expect(parseWebResultPath('/web/example.com')).toEqual({ domain: 'example.com', isMarkdown: false });
  });
  test('extracts a domain with the .md twin suffix', () => {
    expect(parseWebResultPath('/web/example.com.md')).toEqual({ domain: 'example.com', isMarkdown: true });
  });
  test('rejects path traversal and uppercase', () => {
    expect(parseWebResultPath('/web/../etc')).toBeNull();
    expect(parseWebResultPath('/web/Example.com')).toBeNull();
    expect(parseWebResultPath('/web/a/b')).toBeNull();
  });
  test('does not resolve the reserved /web/scoring segment as a domain', () => {
    expect(parseWebResultPath('/web/scoring')).toBeNull();
    expect(parseWebResultPath('/web/scoring.md')).toBeNull();
  });
});

describe('parseWebScoringPath / isWebScoringPath', () => {
  test('matches the bare page, a domain, and the .md twins', () => {
    expect(parseWebScoringPath('/web/scoring')).toEqual({ domain: null, isMarkdown: false });
    expect(parseWebScoringPath('/web/scoring.md')).toEqual({ domain: null, isMarkdown: true });
    expect(parseWebScoringPath('/web/scoring/example.com')).toEqual({ domain: 'example.com', isMarkdown: false });
    expect(parseWebScoringPath('/web/scoring/example.com.md')).toEqual({ domain: 'example.com', isMarkdown: true });
  });
  test('rejects invalid slugs and extra segments', () => {
    expect(parseWebScoringPath('/web/scoring/EXAMPLE..com')).toBeNull();
    expect(parseWebScoringPath('/web/scoring/a/b')).toBeNull();
    expect(parseWebScoringPath('/web/example.com')).toBeNull();
  });
  test('isWebScoringPath captures the reserved prefix', () => {
    expect(isWebScoringPath('/web/scoring')).toBe(true);
    expect(isWebScoringPath('/web/scoring/example.com')).toBe(true);
    expect(isWebScoringPath('/web/scoring/a/b')).toBe(true);
    expect(isWebScoringPath('/web/example.com')).toBe(false);
  });
});

describe('handleWebScoringPage', () => {
  test('renders 200 HTML with the sitekey meta, script tag, and noscript block', async () => {
    const env = makeEnv({ TURNSTILE_SITEKEY: '1x00000000000000000000AA' });
    const resp = await handleWebScoringPage(new Request('https://anc.dev/web/scoring/example.com'), env);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    expect(resp.headers.get('cache-control')).toBe('no-store');
    expect(resp.headers.get('x-robots-tag')).toBe('noindex');
    expect(resp.headers.get('vary')).toBe('Accept, User-Agent');
    expect(resp.headers.get('cache-tag')).toBeNull();
    const html = await resp.text();
    expect(html).toContain('name="turnstile-sitekey" content="1x00000000000000000000AA"');
    expect(html).toContain('src="/js/web-audit-scoring.js"');
    expect(html).toContain('<noscript>');
    expect(html).toContain('data-web-audit-results');
  });

  test('sitekey substitution is empty on an unprovisioned env', async () => {
    const env = makeEnv({ TURNSTILE_SITEKEY: undefined });
    const resp = await handleWebScoringPage(new Request('https://anc.dev/web/scoring/example.com'), env);
    const html = await resp.text();
    expect(html).toContain('name="turnstile-sitekey" content=""');
  });

  test('an invalid slug 404s', async () => {
    const env = makeEnv();
    const resp = await handleWebScoringPage(new Request('https://anc.dev/web/scoring/EXAMPLE..com'), env);
    expect(resp.status).toBe(404);
  });

  test('the bare /web/scoring path renders the pointer page', async () => {
    const env = makeEnv();
    const resp = await handleWebScoringPage(new Request('https://anc.dev/web/scoring'), env);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain('/web-audit');
  });

  test('POST is 405', async () => {
    const env = makeEnv();
    const resp = await handleWebScoringPage(
      new Request('https://anc.dev/web/scoring/example.com', { method: 'POST' }),
      env,
    );
    expect(resp.status).toBe(405);
  });

  test('markdown negotiation returns the pointer text with no-store + noindex', async () => {
    const env = makeEnv();
    const resp = await handleWebScoringPage(
      new Request('https://anc.dev/web/scoring/example.com', { headers: { Accept: 'text/markdown' } }),
      env,
    );
    expect(resp.headers.get('content-type')).toContain('text/markdown');
    expect(resp.headers.get('cache-control')).toBe('no-store');
    expect(resp.headers.get('x-robots-tag')).toBe('noindex');
    expect(resp.headers.get('vary')).toBe('Accept, User-Agent');
    expect(resp.headers.get('cache-tag')).toBeNull();
    const md = await resp.text();
    expect(md).toContain('/web/example.com.md');
    expect(md).toContain('audit_website');
  });
});

describe('handleWebResultPage', () => {
  function resultEnv(prefill: Record<string, unknown> = {}) {
    return makeEnv({ SCORE_CACHE: makeR2(prefill).bucket });
  }

  async function cachedFor(url: string, pct = 82) {
    const key = await keyFor(url, SPEC_VERSION);
    return {
      [key]: {
        spec_version: SPEC_VERSION,
        target_url: url,
        scorecard: {
          schema_version: '0.2',
          spec_version: SPEC_VERSION,
          target_url: url,
          tool: { name: new URL(url).host, url },
          score_pct: pct,
          score: { relative: pct, global: pct },
          coverage_summary: {
            must: { total: 1, verified: 1 },
            should: { total: 2, verified: 1 },
            may: { total: 0, verified: 0 },
          },
          results: [{ id: 'llms-txt', label: 'llms.txt', group: 'P2', status: 'pass', evidence: null }],
          summary: { pass: 1, broken: 0, absent: 0, n_a: 0, skip: 0, error: 0 },
        },
      },
    };
  }

  test('renders 200 HTML through the shared renderer for a cached domain', async () => {
    const env = resultEnv(await cachedFor('https://example.com/'));
    const resp = await handleWebResultPage(new Request('https://anc.dev/web/example.com'), env);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    expect(resp.headers.get('x-robots-tag')).toBe('noindex');
    expect(resp.headers.get('vary')).toBe('Accept, User-Agent');
    expect(resp.headers.get('cache-tag')).toBe('web:example.com');
    expect(resp.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    const html = await resp.text();
    expect(html).toContain('82%');
  });

  test('serves the markdown twin for the .md suffix', async () => {
    const env = resultEnv(await cachedFor('https://example.com/'));
    const resp = await handleWebResultPage(new Request('https://anc.dev/web/example.com.md'), env);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/markdown');
    expect(resp.headers.get('vary')).toBeNull();
    expect(resp.headers.get('cache-tag')).toBe('web:example.com');
    const md = await resp.text();
    expect(md).toContain('82%');
  });

  test('honors Accept: text/markdown on the suffix-less path', async () => {
    const env = resultEnv(await cachedFor('https://example.com/'));
    const resp = await handleWebResultPage(
      new Request('https://anc.dev/web/example.com', { headers: { Accept: 'text/markdown' } }),
      env,
    );
    expect(resp.headers.get('content-type')).toContain('text/markdown');
  });

  test('404s a domain with no cached audit', async () => {
    const env = resultEnv();
    const resp = await handleWebResultPage(new Request('https://anc.dev/web/never-audited.dev'), env);
    expect(resp.status).toBe(404);
    expect(resp.headers.get('cache-control')).toBe('no-store');
    expect(resp.headers.get('cache-tag')).toBeNull();
    expect(await resp.text()).toContain('not audited');
  });

  test('405s a non-GET method', async () => {
    const env = resultEnv();
    const resp = await handleWebResultPage(new Request('https://anc.dev/web/example.com', { method: 'POST' }), env);
    expect(resp.status).toBe(405);
  });

  // An old-shape stored scorecard: one combined `mcp-api` category with
  // rows tagged `mcp-api`, the exact reduced shape the bug produces.
  async function oldShapeCachedFor(url: string) {
    const key = await keyFor(url, SPEC_VERSION);
    return {
      [key]: {
        spec_version: SPEC_VERSION,
        target_url: url,
        scorecard: {
          schema_version: '0.2',
          spec_version: SPEC_VERSION,
          target_url: url,
          tool: { name: new URL(url).host, url },
          score_pct: 60,
          score: { relative: 60, global: 48 },
          summary: { pass: 2, broken: 0, absent: 2, n_a: 0, skip: 0, error: 0 },
          categories: [{ id: 'mcp-api', name: 'MCP & API', passed: 2, counted: 4 }],
          results: [
            {
              id: 'openapi',
              label: 'OpenAPI',
              category: 'mcp-api',
              keyword: 'must',
              status: 'absent',
              evidence: 'openapi.json -> 404',
            },
            {
              id: 'mcp-initialize',
              label: 'MCP initialize',
              category: 'mcp-api',
              keyword: 'must',
              status: 'pass',
              evidence: 'ok',
            },
            {
              id: 'mcp-tools-list',
              label: 'tools/list',
              category: 'mcp-api',
              keyword: 'should',
              status: 'pass',
              evidence: 'ok',
            },
            {
              id: 'llms-txt',
              label: 'llms.txt',
              category: 'mcp-api',
              keyword: 'should',
              status: 'absent',
              evidence: 'llms.txt -> 404',
            },
          ],
        },
      },
    };
  }

  test('an old-shape stored scorecard renders separate API and MCP category cards, not the combined bucket', async () => {
    const env = resultEnv(await oldShapeCachedFor('https://example.com/'));
    const resp = await handleWebResultPage(new Request('https://anc.dev/web/example.com'), env);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain('<h3 class="audit-group__title">API</h3>');
    expect(html).toContain('<h3 class="audit-group__title">MCP</h3>');
    expect(html).not.toContain('MCP &amp; API');
  });

  test('the .md twin emits separate ## API and ## MCP headings', async () => {
    const env = resultEnv(await oldShapeCachedFor('https://example.com/'));
    const resp = await handleWebResultPage(new Request('https://anc.dev/web/example.com.md'), env);
    expect(resp.status).toBe(200);
    const md = await resp.text();
    expect(md).toContain('## API (0/1)');
    expect(md).toContain('## MCP (2/2)');
    expect(md).toContain('## Content for agents (0/1)');
    expect(md).not.toContain('## MCP & API');
  });

  test('remediation still renders per non-passing check after normalization (HTML + .md)', async () => {
    const env = resultEnv(await oldShapeCachedFor('https://example.com/'));
    const html = await (await handleWebResultPage(new Request('https://anc.dev/web/example.com'), env)).text();
    expect(html).toContain('class="web-check__fix"');
    expect(html).toContain('https://anc.dev/web-audit/skill/openapi');
    const md = await (await handleWebResultPage(new Request('https://anc.dev/web/example.com.md'), env)).text();
    expect(md).toContain('- Fix:');
    expect(md).toContain('https://anc.dev/web-audit/skill/openapi');
  });

  test('a registry-load failure falls back to the stored category shape and still renders 200', async () => {
    const env = makeEnv({
      SCORE_CACHE: makeR2(await oldShapeCachedFor('https://example.com/')).bucket,
      ASSETS: makeAssets({ failRegistry: true }),
    });
    const resp = await handleWebResultPage(new Request('https://anc.dev/web/example.com'), env);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain('MCP &amp; API');
  });
});

describe('site_type declaration (U7)', () => {
  function typedRequest(url: string, siteType: unknown): Request {
    return new Request('https://anc.dev/api/audit-web', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify({ url, site_type: siteType, turnstile_token: 'x' }),
    });
  }

  test('an invalid site_type is rejected with 400 before any probe', async () => {
    const env = makeEnv();
    const resp = await runAudit(typedRequest('https://example.com/', 'commerce'), env, makeCtx(), {
      probeFetch: (() => {
        throw new Error('probe should never run');
      }) as unknown as typeof fetch,
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe('invalid_site_type');
  });

  test('a declared content type gates api-only checks to n_a and lands in the scorecard + cache payload', async () => {
    const { bucket, store } = makeR2();
    const env = makeEnv({ SCORE_CACHE: bucket });
    const ctx = makeCtx();
    const resp = await runAudit(typedRequest('https://example.com/', 'content'), env, ctx, {
      probeFetch: stubProbeFetch(),
    });
    expect(resp.status).toBe(200);
    const events = await readNdjson(resp);
    const terminal = events.at(-1) as {
      scorecard: { site_type: string | null; results: Array<{ id: string; status: string }> };
    };
    expect(terminal.scorecard.site_type).toBe('content');
    expect(terminal.scorecard.results.find((r) => r.id === 'openapi')?.status).toBe('n_a');
    await Promise.all((ctx as unknown as { _promises: Promise<unknown>[] })._promises);
    const cachedRaw = store.get(await keyFor('https://example.com/', SPEC_VERSION));
    expect(cachedRaw).toBeDefined();
    const cached = JSON.parse(cachedRaw as string) as { scorecard: { site_type: string | null } };
    expect(cached.scorecard.site_type).toBe('content');
  });

  test('no site_type runs everything: openapi is scored when the probe detects an API surface', async () => {
    const env = makeEnv();
    const resp = await runAudit(auditRequest('https://example.com/'), env, makeCtx(), {
      probeFetch: stubProbeFetch(),
    });
    const events = await readNdjson(resp);
    const terminal = events.at(-1) as {
      scorecard: { site_type: string | null; results: Array<{ id: string; status: string }> };
    };
    expect(terminal.scorecard.site_type).toBeNull();
    // stubProbeFetch answers /openapi.json with 200, so api-surface holds
    // and the check is scored (not n_a).
    expect(terminal.scorecard.results.find((r) => r.id === 'openapi')?.status).not.toBe('n_a');
  });

  test('typed and untyped runs share one domain-keyed cache entry (last-writer-wins, no keyFor split)', async () => {
    const untypedKey = await keyFor('https://example.com/', SPEC_VERSION);
    const { bucket, store } = makeR2();
    const env = makeEnv({ SCORE_CACHE: bucket });
    const ctx = makeCtx();
    const resp = await runAudit(typedRequest('https://example.com/', 'content'), env, ctx, {
      probeFetch: stubProbeFetch(),
    });
    await readNdjson(resp);
    await Promise.all((ctx as unknown as { _promises: Promise<unknown>[] })._promises);
    expect(store.size).toBe(1);
    expect(store.has(untypedKey)).toBe(true);
  });
});

describe('cache-first gate ordering', () => {
  test('a cache hit is served without a source IP and consumes no fresh-audit budget', async () => {
    const url = 'https://example.com/';
    const key = await keyFor(url, SPEC_VERSION);
    const cached = {
      spec_version: SPEC_VERSION,
      target_url: url,
      scorecard: { schema_version: '0.2', target_url: url, score_pct: 70, results: [] },
      scored_at: new Date().toISOString(),
    };
    const { bucket } = makeR2({ [key]: cached });
    let budgetReads = 0;
    const kv = {
      async get() {
        budgetReads += 1;
        return null;
      },
      async put() {},
    } as unknown as KVNamespace;
    const env = makeEnv({
      SCORE_CACHE: bucket,
      SCORE_KV: kv,
      WEB_AUDIT_LIMITER: {
        limit: async () => {
          throw new Error('limiter must not run on a cache hit');
        },
      },
    });
    // No cf-connecting-ip header: a cached read is data, not a fresh audit.
    const resp = await handleWebAudit(auditRequest(url, {}), env, makeCtx());
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { cached: boolean; scorecard: { score_pct: number } };
    expect(body.cached).toBe(true);
    expect(body.scorecard.score_pct).toBe(70);
    expect(budgetReads).toBe(0);
  });
});

// The tri-state resolution + serve-cached/patch/re-audit choice shared by
// the web POST route and the audit_website MCP tool. Rows mirror the
// plan's authoritative write-semantics truth table.
describe('decidePublicListingWrite', () => {
  const TARGET = 'https://example.com/';
  const FRESH = new Date().toISOString();
  const STALE = new Date(Date.now() - 10 * 60_000).toISOString();

  function entry(scoredAt: string, stored?: boolean): CachedWebAudit {
    const scorecard: Record<string, unknown> = {
      schema_version: '0.2',
      target_url: TARGET,
      score_pct: 50,
      results: [],
    };
    if (stored !== undefined) scorecard.public_listing = stored;
    return { spec_version: SPEC_VERSION, target_url: TARGET, scorecard, scored_at: scoredAt };
  }

  test('first-ever miss: omit and false audit to false; true audits to true', () => {
    expect(decidePublicListingWrite({ explicit: undefined, cached: null })).toEqual({
      path: 'audit',
      value: false,
      flagChanges: false,
    });
    expect(decidePublicListingWrite({ explicit: false, cached: null })).toEqual({
      path: 'audit',
      value: false,
      flagChanges: false,
    });
    expect(decidePublicListingWrite({ explicit: true, cached: null })).toEqual({
      path: 'audit',
      value: true,
      flagChanges: true,
    });
  });

  test('fresh hit: omit serves cached for stored true, false, and absent', () => {
    for (const stored of [true, false, undefined] as const) {
      const cached = entry(FRESH, stored);
      expect(decidePublicListingWrite({ explicit: undefined, cached })).toEqual({
        path: 'serve-cached',
        flagChanges: false,
      });
    }
  });

  test('fresh hit: an explicit value matching a concrete stored value serves cached', () => {
    expect(decidePublicListingWrite({ explicit: true, cached: entry(FRESH, true) })).toEqual({
      path: 'serve-cached',
      flagChanges: false,
    });
    expect(decidePublicListingWrite({ explicit: false, cached: entry(FRESH, false) })).toEqual({
      path: 'serve-cached',
      flagChanges: false,
    });
  });

  test('fresh hit: a differing explicit value patches (stored F/absent -> T)', () => {
    for (const stored of [false, undefined] as const) {
      const cached = entry(FRESH, stored);
      const d = decidePublicListingWrite({ explicit: true, cached });
      expect(d.path).toBe('patch');
      if (d.path === 'patch') {
        expect(d.value).toBe(true);
        expect(d.flagChanges).toBe(true);
        expect(d.cached).toBe(cached);
      }
    }
  });

  test('fresh hit: a differing explicit value patches (stored T/absent -> F)', () => {
    for (const stored of [true, undefined] as const) {
      const cached = entry(FRESH, stored);
      const d = decidePublicListingWrite({ explicit: false, cached });
      expect(d.path).toBe('patch');
      if (d.path === 'patch') {
        expect(d.value).toBe(false);
        expect(d.cached).toBe(cached);
      }
    }
  });

  test('stale hit: omit carries the prior stored value (never erases)', () => {
    expect(decidePublicListingWrite({ explicit: undefined, cached: entry(STALE, true) })).toEqual({
      path: 'audit',
      value: true,
      flagChanges: false,
    });
    expect(decidePublicListingWrite({ explicit: undefined, cached: entry(STALE, false) })).toEqual({
      path: 'audit',
      value: false,
      flagChanges: false,
    });
  });

  test('stale hit with no stored flag: omit assumes false', () => {
    expect(decidePublicListingWrite({ explicit: undefined, cached: entry(STALE, undefined) })).toEqual({
      path: 'audit',
      value: false,
      flagChanges: false,
    });
  });

  test('stale hit: an explicit value wins and marks a flip when it differs', () => {
    expect(decidePublicListingWrite({ explicit: false, cached: entry(STALE, true) })).toEqual({
      path: 'audit',
      value: false,
      flagChanges: true,
    });
    expect(decidePublicListingWrite({ explicit: true, cached: entry(STALE, false) })).toEqual({
      path: 'audit',
      value: true,
      flagChanges: true,
    });
    expect(decidePublicListingWrite({ explicit: true, cached: entry(STALE, true) })).toEqual({
      path: 'audit',
      value: true,
      flagChanges: false,
    });
  });
});

describe('handleWebAudit public_listing', () => {
  const URL_UNDER_TEST = 'https://example.com/';

  async function prefill(opts: { scoredAt: string; stored?: boolean; pct?: number }) {
    const key = await keyFor(URL_UNDER_TEST, SPEC_VERSION);
    const scorecard: Record<string, unknown> = {
      schema_version: '0.2',
      target_url: URL_UNDER_TEST,
      tool: { name: 'example.com', url: URL_UNDER_TEST },
      score_pct: opts.pct ?? 64,
      results: [],
    };
    if (opts.stored !== undefined) scorecard.public_listing = opts.stored;
    return {
      [key]: {
        spec_version: SPEC_VERSION,
        target_url: URL_UNDER_TEST,
        scorecard,
        scored_at: opts.scoredAt,
      },
    };
  }

  const freshStamp = () => new Date().toISOString();
  const staleStamp = () => new Date(Date.now() - 10 * 60_000).toISOString();
  const throwingProbe = (() => {
    throw new Error('engine must not run on a serve-cached / patch request');
  }) as unknown as typeof fetch;

  test('a non-boolean public_listing is rejected with 400 before any probe', async () => {
    for (const bad of ['false', 1, null] as const) {
      const env = makeEnv();
      const resp = await runAudit(auditRequest(URL_UNDER_TEST, undefined, { public_listing: bad }), env, makeCtx(), {
        probeFetch: throwingProbe,
      });
      expect(resp.status).toBe(400);
      expect(((await resp.json()) as { error: string }).error).toBe('invalid_public_listing');
    }
  });

  test('fresh hit + stored true + omit serves cached with no write and no engine', async () => {
    const prefilled = await prefill({ scoredAt: freshStamp(), stored: true });
    const key = await keyFor(URL_UNDER_TEST, SPEC_VERSION);
    const before = JSON.stringify(prefilled[key]);
    const { bucket, store } = makeR2(prefilled);
    const env = makeEnv({ SCORE_CACHE: bucket });
    const resp = await runAudit(auditRequest(URL_UNDER_TEST, {}), env, makeCtx(), { probeFetch: throwingProbe });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { cached: boolean; scorecard: { public_listing: boolean }; share_url: string };
    expect(body.cached).toBe(true);
    expect(body.scorecard.public_listing).toBe(true);
    expect(body.share_url).toBe('/web/example.com');
    // No write: the stored object is byte-identical.
    expect(store.get(key)).toBe(before);
  });

  test('fresh hit + stored false + explicit true patches to true, preserving scored_at and running gates', async () => {
    const scoredAt = freshStamp();
    const { bucket, store } = makeR2(await prefill({ scoredAt, stored: false }));
    const env = makeEnv({ SCORE_CACHE: bucket });
    const resp = await runAudit(auditRequest(URL_UNDER_TEST, undefined, { public_listing: true }), env, makeCtx(), {
      probeFetch: throwingProbe,
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('application/json');
    const body = (await resp.json()) as { scorecard: { public_listing: boolean }; share_url: string };
    // Patch response shape matches a cache serve: patched scorecard + share_url.
    expect(body.scorecard.public_listing).toBe(true);
    expect(body.share_url).toBe('/web/example.com');
    // The gate stack ran: a session cookie is minted like a fresh audit.
    expect(resp.headers.get('set-cookie')).toContain('__Host-anc-session=');
    // Stored envelope flips to true; scored_at is carried forward, not reset.
    const key = await keyFor(URL_UNDER_TEST, SPEC_VERSION);
    const stored = JSON.parse(store.get(key) as string) as {
      scorecard: { public_listing: boolean };
      scored_at: string;
    };
    expect(stored.scorecard.public_listing).toBe(true);
    expect(stored.scored_at).toBe(scoredAt);
  });

  test('a listing patch purges the web tag once, never a /web path prefix', async () => {
    const scoredAt = freshStamp();
    const { bucket } = makeR2(await prefill({ scoredAt, stored: false }));
    const env = makeEnv({ SCORE_CACHE: bucket });
    const calls: Array<{ tags?: string[]; pathPrefixes?: string[] }> = [];
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
      exports: {
        Cached: {
          async purgeHitMinTags(tags: string[]) {
            calls.push({ tags });
            return { success: true, errors: [] };
          },
        },
      },
    } as unknown as ExecutionContext;
    const resp = await runAudit(auditRequest(URL_UNDER_TEST, undefined, { public_listing: true }), env, ctx, {
      probeFetch: throwingProbe,
    });
    expect(resp.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tags).toEqual(['web']);
    expect(calls[0]?.pathPrefixes).toBeUndefined();
  });

  test('fresh hit + stored true + explicit true serves cached (redundant, no write)', async () => {
    const prefilled = await prefill({ scoredAt: freshStamp(), stored: true });
    const key = await keyFor(URL_UNDER_TEST, SPEC_VERSION);
    const before = JSON.stringify(prefilled[key]);
    const { bucket, store } = makeR2(prefilled);
    const env = makeEnv({ SCORE_CACHE: bucket });
    const resp = await runAudit(auditRequest(URL_UNDER_TEST, undefined, { public_listing: true }), env, makeCtx(), {
      probeFetch: throwingProbe,
    });
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { cached: boolean }).cached).toBe(true);
    expect(store.get(key)).toBe(before);
  });

  test('stale hit + stored true + omit re-audits and preserves true in both stores', async () => {
    const { bucket, store } = makeR2(await prefill({ scoredAt: staleStamp(), stored: true }));
    const env = makeEnv({ SCORE_CACHE: bucket });
    const ctx = makeCtx();
    const resp = await runAudit(auditRequest(URL_UNDER_TEST, {}), env, ctx, { probeFetch: stubProbeFetch() });
    expect(resp.status).toBe(200);
    const events = await readNdjson(resp);
    const terminal = events.at(-1) as { type: string; scorecard: { public_listing: boolean } };
    expect(terminal.type).toBe('complete');
    expect(terminal.scorecard.public_listing).toBe(true);
    await Promise.all((ctx as unknown as { _promises: Promise<unknown>[] })._promises);
    const stored = JSON.parse(store.get(await keyFor(URL_UNDER_TEST, SPEC_VERSION)) as string) as {
      scorecard: { public_listing: boolean };
    };
    expect(stored.scorecard.public_listing).toBe(true);
  });

  test('stale hit + stored true + explicit false re-audits to false', async () => {
    const { bucket, store } = makeR2(await prefill({ scoredAt: staleStamp(), stored: true }));
    const env = makeEnv({ SCORE_CACHE: bucket });
    const ctx = makeCtx();
    const resp = await runAudit(auditRequest(URL_UNDER_TEST, undefined, { public_listing: false }), env, ctx, {
      probeFetch: stubProbeFetch(),
    });
    const events = await readNdjson(resp);
    const terminal = events.at(-1) as { scorecard: { public_listing: boolean } };
    expect(terminal.scorecard.public_listing).toBe(false);
    await Promise.all((ctx as unknown as { _promises: Promise<unknown>[] })._promises);
    const stored = JSON.parse(store.get(await keyFor(URL_UNDER_TEST, SPEC_VERSION)) as string) as {
      scorecard: { public_listing: boolean };
    };
    expect(stored.scorecard.public_listing).toBe(false);
  });

  test('first-ever miss defaults to false on omit and honors an explicit true', async () => {
    // Omit -> false.
    {
      const { bucket, store } = makeR2();
      const env = makeEnv({ SCORE_CACHE: bucket });
      const ctx = makeCtx();
      const resp = await runAudit(auditRequest(URL_UNDER_TEST), env, ctx, { probeFetch: stubProbeFetch() });
      const events = await readNdjson(resp);
      expect((events.at(-1) as { scorecard: { public_listing: boolean } }).scorecard.public_listing).toBe(false);
      await Promise.all((ctx as unknown as { _promises: Promise<unknown>[] })._promises);
      const stored = JSON.parse(store.get(await keyFor(URL_UNDER_TEST, SPEC_VERSION)) as string) as {
        scorecard: { public_listing: boolean };
      };
      expect(stored.scorecard.public_listing).toBe(false);
    }
    // Explicit true -> true.
    {
      const { bucket, store } = makeR2();
      const env = makeEnv({ SCORE_CACHE: bucket });
      const ctx = makeCtx();
      const resp = await runAudit(auditRequest(URL_UNDER_TEST, undefined, { public_listing: true }), env, ctx, {
        probeFetch: stubProbeFetch(),
      });
      const events = await readNdjson(resp);
      expect((events.at(-1) as { scorecard: { public_listing: boolean } }).scorecard.public_listing).toBe(true);
      await Promise.all((ctx as unknown as { _promises: Promise<unknown>[] })._promises);
      const stored = JSON.parse(store.get(await keyFor(URL_UNDER_TEST, SPEC_VERSION)) as string) as {
        scorecard: { public_listing: boolean };
      };
      expect(stored.scorecard.public_listing).toBe(true);
    }
  });

  test('kill switch off blocks an explicit-differing fresh-window request: no patch', async () => {
    const prefilled = await prefill({ scoredAt: freshStamp(), stored: false });
    const key = await keyFor(URL_UNDER_TEST, SPEC_VERSION);
    const before = JSON.stringify(prefilled[key]);
    const { bucket, store } = makeR2(prefilled);
    const env = makeEnv({ WEB_AUDIT_ENABLED: undefined, SCORE_CACHE: bucket });
    const resp = await runAudit(auditRequest(URL_UNDER_TEST, {}, { public_listing: true }), env, makeCtx(), {
      probeFetch: throwingProbe,
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { cached: boolean; scorecard: { public_listing: boolean } };
    expect(body.cached).toBe(true);
    // The stored (unpatched) flag is returned and the object is untouched.
    expect(body.scorecard.public_listing).toBe(false);
    expect(store.get(key)).toBe(before);
  });

  test('a breached limiter blocks the patch with 429 and writes nothing', async () => {
    const prefilled = await prefill({ scoredAt: freshStamp(), stored: false });
    const key = await keyFor(URL_UNDER_TEST, SPEC_VERSION);
    const before = JSON.stringify(prefilled[key]);
    const { bucket, store } = makeR2(prefilled);
    const env = makeEnv({ SCORE_CACHE: bucket, WEB_AUDIT_LIMITER: { limit: async () => ({ success: false }) } });
    const resp = await runAudit(auditRequest(URL_UNDER_TEST, undefined, { public_listing: true }), env, makeCtx(), {
      probeFetch: throwingProbe,
    });
    expect(resp.status).toBe(429);
    expect(store.get(key)).toBe(before);
  });

  test('a failed patch write surfaces an error, not fabricated success', async () => {
    const scoredAt = freshStamp();
    const key = await keyFor(URL_UNDER_TEST, SPEC_VERSION);
    const stored = {
      spec_version: SPEC_VERSION,
      target_url: URL_UNDER_TEST,
      scorecard: {
        schema_version: '0.2',
        target_url: URL_UNDER_TEST,
        score_pct: 64,
        results: [],
        public_listing: false,
      },
      scored_at: scoredAt,
    };
    const bucket = {
      async get(k: string) {
        if (k !== key) return null;
        return {
          async json() {
            return stored;
          },
          async text() {
            return JSON.stringify(stored);
          },
        };
      },
      async put() {
        throw new Error('r2 unavailable');
      },
      async delete() {},
    } as unknown as R2Bucket;
    const env = makeEnv({ SCORE_CACHE: bucket });
    const resp = await runAudit(auditRequest(URL_UNDER_TEST, undefined, { public_listing: true }), env, makeCtx(), {
      probeFetch: throwingProbe,
    });
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { error: string; share_url?: string };
    expect(body.error).toBe('patch_failed');
    // No fabricated share_url that a client would follow as a success.
    expect(body.share_url).toBeUndefined();
  });
});

// The per-domain flip budget caps flag-changing writes so the ownership-free
// public_listing flag can't be flapped to grief the board. A shared env keeps
// one KV across requests so the budget accumulates the way it does in
// production.
describe('handleWebAudit public_listing flip budget', () => {
  const URL_A = 'https://example.com/';
  const URL_B = 'https://other.example/';
  const freshStamp = () => new Date().toISOString();
  const throwingProbe = (() => {
    throw new Error('engine must not run on a flag-only patch');
  }) as unknown as typeof fetch;

  async function prefillEntry(url: string, stored: boolean, scoredAt: string) {
    const scorecard: Record<string, unknown> = {
      schema_version: '0.2',
      target_url: url,
      tool: { name: new URL(url).host, url },
      score_pct: 64,
      results: [],
      public_listing: stored,
    };
    return {
      [await keyFor(url, SPEC_VERSION)]: {
        spec_version: SPEC_VERSION,
        target_url: url,
        scorecard,
        scored_at: scoredAt,
      },
    };
  }

  const flip = (url: string, value: boolean) => auditRequest(url, undefined, { public_listing: value });

  test('flips within budget succeed; the sixth flip on a domain returns 429 flip_rate_limited and writes nothing', async () => {
    const { bucket, store } = makeR2(await prefillEntry(URL_A, false, freshStamp()));
    const env = makeEnv({ SCORE_CACHE: bucket });
    const key = await keyFor(URL_A, SPEC_VERSION);
    // Five alternating flips (T, F, T, F, T) each change the stored flag.
    for (let i = 0; i < 5; i++) {
      const want = i % 2 === 0;
      const resp = await runAudit(flip(URL_A, want), env, makeCtx(), { probeFetch: throwingProbe });
      expect(resp.status).toBe(200);
      expect(((await resp.json()) as { scorecard: { public_listing: boolean } }).scorecard.public_listing).toBe(want);
    }
    const afterFive = store.get(key);
    // The sixth flip (explicit false against the now-stored true) is rejected.
    const resp = await runAudit(flip(URL_A, false), env, makeCtx(), { probeFetch: throwingProbe });
    expect(resp.status).toBe(429);
    expect(((await resp.json()) as { error: string }).error).toBe('flip_rate_limited');
    // Rejected before the write: the stored object is untouched.
    expect(store.get(key)).toBe(afterFive);
  });

  test('the budget is keyed by domain, not IP: a different domain still flips after another is exhausted', async () => {
    const prefill = {
      ...(await prefillEntry(URL_A, false, freshStamp())),
      ...(await prefillEntry(URL_B, false, freshStamp())),
    };
    const { bucket } = makeR2(prefill);
    const env = makeEnv({ SCORE_CACHE: bucket });
    // Exhaust domain A on one IP (five flips, then a blocked sixth).
    for (let i = 0; i < 5; i++) {
      const resp = await runAudit(flip(URL_A, i % 2 === 0), env, makeCtx(), { probeFetch: throwingProbe });
      expect(resp.status).toBe(200);
    }
    expect((await runAudit(flip(URL_A, false), env, makeCtx(), { probeFetch: throwingProbe })).status).toBe(429);
    // Same IP, same window, different domain: the flip still lands.
    const other = await runAudit(flip(URL_B, true), env, makeCtx(), { probeFetch: throwingProbe });
    expect(other.status).toBe(200);
    expect(((await other.json()) as { scorecard: { public_listing: boolean } }).scorecard.public_listing).toBe(true);
  });

  test('a no-op (omit or redundant explicit) spends no flip budget', async () => {
    const { bucket, store } = makeR2(await prefillEntry(URL_A, true, freshStamp()));
    const env = makeEnv({ SCORE_CACHE: bucket });
    const key = await keyFor(URL_A, SPEC_VERSION);
    const before = store.get(key);
    // A run of no-ops: omit and redundant explicit-true both serve cached and
    // return before the flip gate, so none should consume budget.
    for (let i = 0; i < 8; i++) {
      const req = i % 2 === 0 ? auditRequest(URL_A, {}) : flip(URL_A, true);
      expect((await runAudit(req, env, makeCtx(), { probeFetch: throwingProbe })).status).toBe(200);
    }
    expect(store.get(key)).toBe(before);
    // The full budget survives: five real flips (T -> F, T, F, T, F) still pass.
    for (let i = 0; i < 5; i++) {
      expect((await runAudit(flip(URL_A, i % 2 === 1), env, makeCtx(), { probeFetch: throwingProbe })).status).toBe(
        200,
      );
    }
    // The sixth is finally blocked, proving exactly five were available.
    expect((await runAudit(flip(URL_A, true), env, makeCtx(), { probeFetch: throwingProbe })).status).toBe(429);
  });
});
