// www.anc.dev answers every request with a permanent redirect to the same
// path and query on anc.dev, before the gateway or any route runs.

import { describe, expect, test } from 'bun:test';
import worker, { type Env } from '../src/worker/index';

function recordingCtx(seen: Request[]): ExecutionContext {
  return {
    exports: {
      Cached: {
        fetch(request: Request) {
          seen.push(request);
          return new Response('inner', { headers: { 'content-type': 'text/html; charset=utf-8' } });
        },
      },
    },
  } as unknown as ExecutionContext;
}

const env = {
  ASSETS: {
    async fetch(): Promise<Response> {
      return new Response('asset', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  } as unknown as Fetcher,
} as Env;

async function send(url: string, init: RequestInit = {}): Promise<{ response: Response; seen: Request[] }> {
  const seen: Request[] = [];
  const response = await worker.fetch(new Request(url, init), env, recordingCtx(seen));
  return { response, seen };
}

describe('www.anc.dev redirects to anc.dev', () => {
  test('a GET keeps its path and query and gets a 301', async () => {
    const { response, seen } = await send('https://www.anc.dev/score/stripe.com?tab=mcp', {
      headers: { accept: 'text/html' },
    });
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://anc.dev/score/stripe.com?tab=mcp');
    expect(seen).toHaveLength(0);
  });

  test('the bare host redirects to the apex root', async () => {
    const { response } = await send('https://www.anc.dev/');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://anc.dev/');
  });

  test('a HEAD gets a 301', async () => {
    const { response } = await send('https://www.anc.dev/about', { method: 'HEAD' });
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://anc.dev/about');
  });

  test('a POST gets a 308 so the method and body survive the redirect', async () => {
    const { response, seen } = await send('https://www.anc.dev/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://anc.dev/mcp');
    expect(seen).toHaveLength(0);
  });

  test('an http request to www redirects to https on the apex', async () => {
    const { response } = await send('http://www.anc.dev/llms.txt');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://anc.dev/llms.txt');
  });

  test('the apex and the staging host are served, not redirected', async () => {
    for (const url of ['https://anc.dev/about', 'https://agentnative-site-staging.brettdavies.workers.dev/about']) {
      const { response, seen } = await send(url, { headers: { accept: 'text/html' } });
      expect(response.status).toBe(200);
      expect(seen).toHaveLength(1);
    }
  });
});
