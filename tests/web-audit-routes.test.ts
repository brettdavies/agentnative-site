// Web-audit route tests (plan U7 + U8): the /api/audit-web streaming
// dispatch gate chain, and the /web/<domain> shareable result page.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import { keyFor } from '../src/worker/audit-web/cache';
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

const SEED_FIXTURE = [{ domain: 'seeded.dev', url: 'https://seeded.dev/', name: 'seeded.dev', description: 'seeded' }];

function makeAssets(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/_internal/web-audit-registry.json')) {
        return new Response(await registryJson(), { status: 200, headers: { 'content-type': 'application/json' } });
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
    expect(checks.length).toBe(36);
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
    const html = await resp.text();
    expect(html).toContain('82%');
  });

  test('serves the markdown twin for the .md suffix', async () => {
    const env = resultEnv(await cachedFor('https://example.com/'));
    const resp = await handleWebResultPage(new Request('https://anc.dev/web/example.com.md'), env);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/markdown');
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
    expect(await resp.text()).toContain('not audited');
  });

  test('405s a non-GET method', async () => {
    const env = resultEnv();
    const resp = await handleWebResultPage(new Request('https://anc.dev/web/example.com', { method: 'POST' }), env);
    expect(resp.status).toBe(405);
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
