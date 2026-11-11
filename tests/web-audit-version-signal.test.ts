// The route and body here are a contract the anc CLI reads; the path stays a
// literal so a rename fails this suite instead of following the constant.

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  isRegistryFingerprintPrefix,
  registryFingerprintPrefix,
  resetWebAuditRegistryCacheForTests,
  type WebAuditRegistry,
  withRegistryFingerprint,
} from '../src/worker/audit-web/registry';
import { WEB_SCHEMA_VERSION } from '../src/worker/audit-web/scorecard';
import type { WebAuditVersionSignal } from '../src/worker/audit-web/version-signal';
import worker from '../src/worker/index';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';
import { withLogCapture } from './helpers/log-capture';

const URL_ = 'https://anc.dev/api/web-audit/version';
const REGISTRY = { schema_version: 1, checks: [{ id: 'fixture-check' }] } as unknown as WebAuditRegistry;

type WorkerEnv = Parameters<typeof worker.fetch>[1];

function env(registry: () => Response = () => new Response(JSON.stringify(REGISTRY))): {
  env: WorkerEnv;
  assetPaths: string[];
} {
  const assetPaths: string[] = [];
  return {
    assetPaths,
    env: {
      ASSETS: {
        fetch: async (request: Request): Promise<Response> => {
          const { pathname } = new URL(request.url);
          assetPaths.push(pathname);
          return pathname === '/_internal/web-audit-registry.json' ? registry() : new Response('asset');
        },
      },
    } as unknown as WorkerEnv,
  };
}

function send(init: RequestInit = {}, e: WorkerEnv = env().env): Promise<Response> {
  return worker.fetch(new Request(URL_, init), e, {} as ExecutionContext);
}

beforeEach(() => {
  resetWebAuditRegistryCacheForTests();
});

describe('GET /api/web-audit/version', () => {
  test('serves exactly the three version fields', async () => {
    const res = await send();
    expect(res.status).toBe(200);
    const body = (await res.json()) as WebAuditVersionSignal;
    expect(body).toEqual({
      spec_version: SPEC_VERSION,
      registry_fingerprint: await registryFingerprintPrefix(REGISTRY),
      web_schema_version: WEB_SCHEMA_VERSION,
    });
  });

  test('names the registry by the prefix a stored scorecard records, not the full digest', async () => {
    const { registry_fingerprint } = (await (await send()).json()) as WebAuditVersionSignal;
    const stored = await withRegistryFingerprint({}, REGISTRY);
    expect(registry_fingerprint).toBe(stored.registry_fingerprint);
    expect(isRegistryFingerprintPrefix(registry_fingerprint)).toBe(true);
  });

  test('the body is byte-stable across requests and never negotiates', async () => {
    const { env: e } = env();
    const baseline = await (await send({}, e)).text();
    const variants: Record<string, string>[] = [
      { accept: 'text/markdown' },
      { accept: 'text/html,application/xhtml+xml' },
      { accept: 'application/json' },
      { 'user-agent': 'curl/8.7.1' },
    ];
    for (const headers of variants) {
      const res = await send({ headers }, e);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(await res.text()).toBe(baseline);
    }
  });

  test('a query string changes nothing but the cache class, so it cannot mint a day-long edge object', async () => {
    const { env: e } = env();
    const plain = await send({}, e);
    const queried = await worker.fetch(new Request(`${URL_}?x=1`), e, {} as ExecutionContext);
    expect(await queried.text()).toBe(await plain.text());
    expect(queried.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(queried.headers.get('cloudflare-cdn-cache-control')).toBe('public, max-age=300');
  });

  test('carries the machine-surface headers and the HIT-1d class', async () => {
    const { headers } = await send();
    expect(headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(headers.get('x-robots-tag')).toBe('noindex');
    expect(headers.get('access-control-allow-origin')).toBe('*');
    expect(headers.get('cache-control')).toBe('public, max-age=300, stale-while-revalidate=60');
    expect(headers.get('cloudflare-cdn-cache-control')).toBe('public, max-age=86400');
    for (const absent of ['vary', 'link', 'x-llms-txt', 'content-security-policy', 'cache-tag', 'set-cookie']) {
      expect(`${absent}: ${headers.get(absent)}`).toBe(`${absent}: null`);
    }
  });
});

describe('HEAD /api/web-audit/version', () => {
  test('answers 200 with the GET headers and no body', async () => {
    const { env: e } = env();
    const get = await send({}, e);
    const head = await send({ method: 'HEAD' }, e);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(Object.fromEntries(head.headers)).toEqual(Object.fromEntries(get.headers));
  });
});

describe('/api/web-audit/version outside the contract', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    test(`${method} is 405 naming GET and HEAD, unstored, and reads nothing`, async () => {
      const { env: e, assetPaths } = env();
      const res = await send({ method }, e);
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(assetPaths).toEqual([]);
    });
  }

  test('an unreadable registry is an unstored 503 with a record, and recovers on the next request', async () => {
    let readable = false;
    const { env: e } = env(() =>
      readable ? new Response(JSON.stringify(REGISTRY)) : new Response('nope', { status: 500 }),
    );
    const { result: res, records } = await withLogCapture(() => send({}, e));
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
    expect(res.headers.get('retry-after')).toBe('30');
    const errors = records.filter((r) => r.record.scope === 'web-audit.error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.level).toBe('error');
    expect(errors[0]?.record.surface).toBe('version-signal');

    readable = true;
    expect((await send({}, e)).status).toBe(200);
  });
});
