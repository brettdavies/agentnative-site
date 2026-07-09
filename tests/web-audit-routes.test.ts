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
  isWebAuditPath,
  parseWebResultPath,
  type WebAuditRouteEnv,
} from '../src/worker/audit-web/route';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

let registryJsonPromise: Promise<string> | null = null;
async function registryJson(): Promise<string> {
  if (!registryJsonPromise) {
    registryJsonPromise = (async () => {
      const raw = await readFile(join(REPO_ROOT, 'src', 'data', 'web-audit', 'registry.yaml'), 'utf8');
      return JSON.stringify(normalizeWebAuditRegistry(yaml.load(raw)));
    })();
  }
  return registryJsonPromise;
}

function makeAssets(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/_internal/web-audit-registry.json')) {
        return new Response(await registryJson(), { status: 200, headers: { 'content-type': 'application/json' } });
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

function makeEnv(overrides: Partial<WebAuditRouteEnv> = {}): WebAuditRouteEnv {
  return {
    ASSETS: makeAssets(),
    SCORE_CACHE: makeR2().bucket,
    SCORE_KV: makeKv(),
    WEB_AUDIT_ENABLED: 'true',
    WEB_AUDIT_LIMITER: alwaysPassLimiter(),
    ...overrides,
  };
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

function auditRequest(url: string, headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.9' }): Request {
  return new Request('https://anc.dev/api/audit-web', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ url }),
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
  test('kill switch off returns 503 Retry-After', async () => {
    const env = makeEnv({ WEB_AUDIT_ENABLED: undefined });
    const resp = await handleWebAudit(auditRequest('https://example.com/'), env, makeCtx());
    expect(resp.status).toBe(503);
    expect(resp.headers.get('retry-after')).toBe('3600');
  });

  test('non-POST returns 405', async () => {
    const env = makeEnv();
    const resp = await handleWebAudit(new Request('https://anc.dev/api/audit-web', { method: 'GET' }), env, makeCtx());
    expect(resp.status).toBe(405);
  });

  test('private-URL input is rejected by the SSRF pre-flight before any probe', async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const resp = await handleWebAudit(auditRequest('http://169.254.169.254/'), env, ctx, {
      probeFetch: (() => {
        throw new Error('probe should never run');
      }) as unknown as typeof fetch,
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain('blocked');
  });

  test('missing cf-connecting-ip is gated (no anon fallback)', async () => {
    const env = makeEnv();
    const resp = await handleWebAudit(auditRequest('https://example.com/', {}), env, makeCtx());
    expect(resp.status).toBe(429);
  });

  test('limiter breach returns a gated error envelope', async () => {
    const env = makeEnv({ WEB_AUDIT_LIMITER: { limit: async () => ({ success: false }) } });
    const resp = await handleWebAudit(auditRequest('https://example.com/'), env, makeCtx());
    expect(resp.status).toBe(429);
  });

  test('malformed body returns 400', async () => {
    const env = makeEnv();
    const req = new Request('https://anc.dev/api/audit-web', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: 'not json',
    });
    const resp = await handleWebAudit(req, env, makeCtx());
    expect(resp.status).toBe(400);
  });
});

describe('handleWebAudit streaming', () => {
  test('enabled + under limit + cache miss streams check events then a terminal complete', async () => {
    const { bucket, store } = makeR2();
    const env = makeEnv({ SCORE_CACHE: bucket });
    const ctx = makeCtx();
    const resp = await handleWebAudit(auditRequest('https://example.com/'), env, ctx, { probeFetch: stubProbeFetch() });
    expect(resp.status).toBe(200);
    const events = await readNdjson(resp);
    const checks = events.filter((e) => e.type === 'check');
    expect(checks.length).toBe(34);
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
      scorecard: { schema_version: '0.1', target_url: url, badge: { score_pct: 77 }, results: [] },
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
      scorecard: { badge: { score_pct: number } };
    };
    expect(body.cached).toBe(true);
    expect(body.scorecard.badge.score_pct).toBe(77);
    expect(body.share_url).toBe('/web/example.com');
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
          schema_version: '0.1',
          spec_version: SPEC_VERSION,
          target_url: url,
          tool: { name: new URL(url).host, url },
          badge: { score_pct: pct, eligible: false },
          coverage_summary: {
            must: { total: 1, verified: 1 },
            should: { total: 2, verified: 1 },
            may: { total: 0, verified: 0 },
          },
          results: [{ id: 'llms-txt', label: 'llms.txt', group: 'P2', status: 'pass', evidence: null }],
          summary: { pass: 1, fail: 0, n_a: 0, skip: 0, error: 0 },
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
