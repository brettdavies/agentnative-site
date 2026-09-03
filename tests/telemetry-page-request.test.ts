// Gateway page-record tests. The record is emitted in default.fetch after
// the Cached dispatch resolves, from the original request (the gateway
// deletes or rewrites the User-Agent before the inner Worker runs) and the
// returned response, so a cache HIT that never runs Cached still leaves a
// record. Static assets and /api/ paths leave none.

import { afterEach, describe, expect, test } from 'bun:test';
import worker, { type Env } from '../src/worker/index';
import type { LogRecord } from '../src/worker/telemetry/log';
import { recordPageRequest } from '../src/worker/telemetry/page-request';
import { captureLogs, type LogCapture } from './helpers/log-capture';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.60 Safari/537.36';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const REQUESTS_UA = 'python-requests/2.31.0';
const GPTBOT_UA =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';

type Canned = { status?: number; contentType?: string; cacheStatus?: string };

function cachedCtx(canned: Canned = {}, seen: Request[] = []): ExecutionContext {
  return {
    exports: {
      Cached: {
        fetch(request: Request) {
          seen.push(request);
          const headers = new Headers({ 'content-type': canned.contentType ?? 'text/html; charset=utf-8' });
          if (canned.cacheStatus) headers.set('cf-cache-status', canned.cacheStatus);
          return new Response('inner', { status: canned.status ?? 200, headers });
        },
      },
    },
  } as unknown as ExecutionContext;
}

function assetsEnv(contentType: string): Env {
  return {
    ASSETS: {
      async fetch(): Promise<Response> {
        return new Response('asset', { headers: { 'content-type': contentType } });
      },
    } as unknown as Fetcher,
  };
}

function request(
  url: string,
  opts: { ua?: string; accept?: string; method?: string; extra?: Record<string, string> } = {},
) {
  const headers = new Headers({ host: new URL(url).host, ...(opts.extra ?? {}) });
  if (opts.ua !== undefined) headers.set('user-agent', opts.ua);
  if (opts.accept !== undefined) headers.set('accept', opts.accept);
  return new Request(url, { method: opts.method ?? 'GET', headers });
}

function pageRecords(logs: LogCapture): LogRecord[] {
  return logs.records.map((r) => r.record).filter((r) => r.scope === 'page.request');
}

let logs: LogCapture;

afterEach(() => {
  logs.restore();
});

describe('page.request at the gateway', () => {
  test('a browser request records family, major.minor, engine, and OS with a null agent name', async () => {
    logs = captureLogs();
    await worker.fetch(
      request('https://anc.dev/about', { ua: CHROME_UA, accept: 'text/html' }),
      assetsEnv('x'),
      cachedCtx(),
    );
    const [record] = pageRecords(logs);
    expect(record).toEqual({
      scope: 'page.request',
      path: '/about',
      method: 'GET',
      status: 200,
      format: 'html',
      cache_status: null,
      client_class: 'browser',
      agent_name: null,
      browser_family: 'Chrome',
      browser_version: '124.0',
      engine: 'Blink',
      engine_version: '124.0',
      os_family: 'Windows',
      ms_bucket: '<50',
    });
  });

  test('an agent request records the canonical agent name and no browser fields', async () => {
    logs = captureLogs();
    await worker.fetch(
      request('https://anc.dev/about', { ua: GPTBOT_UA, accept: 'text/html' }),
      assetsEnv('x'),
      cachedCtx(),
    );
    const [record] = pageRecords(logs);
    expect(record.client_class).toBe('ai-crawler');
    expect(record.agent_name).toBe('GPTBot');
    for (const key of ['browser_family', 'browser_version', 'engine', 'engine_version', 'os_family']) {
      expect(key in record).toBe(false);
    }
  });

  test('the class comes from the original request, not the rewritten one the inner Worker sees', async () => {
    logs = captureLogs();
    const seen: Request[] = [];
    await worker.fetch(request('https://anc.dev/about', { ua: REQUESTS_UA }), assetsEnv('x'), cachedCtx({}, seen));
    expect(seen[0].headers.get('user-agent')).toBe('curl/');
    const [record] = pageRecords(logs);
    expect(record.client_class).toBe('cli-client');
    expect(record.agent_name).toBe('python-requests');
  });

  test('a markdown twin records the served format', async () => {
    logs = captureLogs();
    await worker.fetch(
      request('https://anc.dev/about.md', { ua: SAFARI_UA }),
      assetsEnv('x'),
      cachedCtx({ contentType: 'text/markdown; charset=utf-8' }),
    );
    const [record] = pageRecords(logs);
    expect(record.format).toBe('markdown');
    expect(record.path).toBe('/about.md');
    expect(record.browser_family).toBe('Safari');
    expect(record.browser_version).toBe('17.4');
    expect(record.engine).toBe('WebKit');
    expect(record.os_family).toBe('macOS');
  });

  test('a cache HIT still records, asserted at the gateway where Cached does not run', async () => {
    logs = captureLogs();
    await worker.fetch(
      request('https://anc.dev/', { ua: CHROME_UA, accept: 'text/html' }),
      assetsEnv('x'),
      cachedCtx({ cacheStatus: 'HIT' }),
    );
    const records = pageRecords(logs);
    expect(records).toHaveLength(1);
    expect(records[0].cache_status).toBe('HIT');
    expect(records[0].path).toBe('/');
  });

  test('the path never carries the query string', async () => {
    logs = captureLogs();
    await worker.fetch(
      request('https://anc.dev/web-audit?url=https://secret.example', { ua: CHROME_UA, accept: 'text/html' }),
      assetsEnv('x'),
      cachedCtx(),
    );
    const [record] = pageRecords(logs);
    expect(record.path).toBe('/web-audit');
    expect(JSON.stringify(record)).not.toContain('secret.example');
  });

  test('/api/score and a static asset emit no page.request', async () => {
    logs = captureLogs();
    await worker.fetch(
      request('https://anc.dev/api/score', { ua: CHROME_UA, accept: 'application/json' }),
      assetsEnv('x'),
      cachedCtx({ contentType: 'application/json' }),
    );
    await worker.fetch(
      request('https://anc.dev/js/nav.js', { ua: CHROME_UA }),
      assetsEnv('x'),
      cachedCtx({ contentType: 'text/javascript' }),
    );
    await worker.fetch(
      request('https://anc.dev/og-image.png', { ua: CHROME_UA }),
      assetsEnv('x'),
      cachedCtx({ contentType: 'image/png' }),
    );
    expect(pageRecords(logs)).toHaveLength(0);
  });

  test('a POST to /mcp emits no page.request', async () => {
    logs = captureLogs();
    await worker.fetch(
      request('https://anc.dev/mcp', { ua: REQUESTS_UA, method: 'POST', accept: 'application/json' }),
      assetsEnv('x'),
      cachedCtx({ contentType: 'application/json' }),
    );
    expect(pageRecords(logs)).toHaveLength(0);
  });

  test('a 404 page is recorded with its status', async () => {
    logs = captureLogs();
    await worker.fetch(
      request('https://anc.dev/nope', { ua: CHROME_UA, accept: 'text/html' }),
      assetsEnv('x'),
      cachedCtx({ status: 404 }),
    );
    const [record] = pageRecords(logs);
    expect(record.status).toBe(404);
  });

  test('exactly one record per request through the real inner Worker as well', async () => {
    logs = captureLogs();
    await worker.fetch(
      request('https://anc.dev/about', { ua: CHROME_UA, accept: 'text/html' }),
      assetsEnv('text/html; charset=utf-8'),
      {} as ExecutionContext,
    );
    const records = pageRecords(logs);
    expect(records).toHaveLength(1);
    expect(records[0].path).toBe('/about');
    expect(records[0].client_class).toBe('browser');
  });

  test('a failure while building the record never reaches the caller', () => {
    logs = captureLogs();
    const broken = { url: 'not a url', method: 'GET', headers: new Headers() } as unknown as Request;
    expect(() => recordPageRequest(broken, new Response('x'), 1)).not.toThrow();
    expect(pageRecords(logs)).toHaveLength(0);
  });

  test('an unknown client records only the unknown class and a null agent name', async () => {
    logs = captureLogs();
    await worker.fetch(
      request('https://anc.dev/about', { ua: 'SuperSecretAgent/9.9 (token-that-must-not-leak)', accept: 'text/html' }),
      assetsEnv('x'),
      cachedCtx(),
    );
    const [record] = pageRecords(logs);
    expect(record.client_class).toBe('unknown');
    expect(record.agent_name).toBeNull();
    expect(JSON.stringify(record)).not.toContain('SuperSecret');
  });
});
