// The asset binding answers a trailing-slash twin (`/p1/`) with a 307 to the
// bare path, and a search engine reads 307 as temporary, so the pair stays
// split. The Worker upgrades exactly that redirect, a pure trailing-slash
// toggle on the same origin, to a permanent one and leaves the binding's own
// Location untouched. Every other redirect, and a Location that leaves the
// origin, keeps the binding's status.

import { beforeEach, describe, expect, test } from 'bun:test';
import worker from '../src/worker/index';
import { _resetIndexCache } from '../src/worker/score/core';

function envRedirecting(status: number, location: string | null) {
  return {
    ASSETS: {
      async fetch(): Promise<Response> {
        return new Response(null, { status, headers: location === null ? {} : { Location: location } });
      },
    } as unknown as Fetcher,
  };
}

async function call(path: string, upstream: { status: number; location: string | null }, init?: RequestInit) {
  const request = new Request(`https://anc.dev${path}`, init);
  return worker.fetch(request, envRedirecting(upstream.status, upstream.location), {} as ExecutionContext);
}

describe('trailing-slash redirects from the asset binding', () => {
  beforeEach(() => {
    _resetIndexCache();
  });

  test('GET and HEAD of a slash twin answer 301 with the binding Location verbatim', async () => {
    for (const method of ['GET', 'HEAD']) {
      const res = await call('/p1/', { status: 307, location: '/p1' }, { method });
      expect({ method, status: res.status, location: res.headers.get('location') }).toEqual({
        method,
        status: 301,
        location: '/p1',
      });
    }
  });

  test('any other method answers 308, so a POST keeps its method and body', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await call('/api/score/', { status: 307, location: '/api/score' }, { method });
      expect({ method, status: res.status, location: res.headers.get('location') }).toEqual({
        method,
        status: 308,
        location: '/api/score',
      });
    }
  });

  test('the query string rides on the binding Location unchanged', async () => {
    const res = await call('/scorecards/?lane=web', { status: 307, location: '/scorecards?lane=web' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/scorecards?lane=web');
  });

  test('an absolute same-origin Location is kept as the binding wrote it', async () => {
    const res = await call('/about/', { status: 307, location: 'https://anc.dev/about' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://anc.dev/about');
  });

  test('the bare-to-slash direction is a trailing-slash toggle too', async () => {
    const res = await call('/docs', { status: 307, location: '/docs/' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/docs/');
  });

  test('a 307 that is not a trailing-slash toggle keeps its status', async () => {
    for (const [path, location] of [
      ['/p1.html', '/p1'],
      ['/index.html', '/'],
      ['/P1/', '/p1'],
      ['/p1/', '/p2'],
      ['/p1/', '/p1/extra'],
      ['/p1/', '/p1/'],
      ['/p1/', '/p1?x=2'],
      ['/p1/?x=1', '/p1'],
      ['/a//', '/b/'],
    ] as const) {
      const res = await call(path, { status: 307, location });
      expect({ path, status: res.status, location: res.headers.get('location') }).toEqual({
        path,
        status: 307,
        location,
      });
    }
  });

  // The upgrade must never make a redirect off the origin permanent, because a
  // browser caches a 301 and would replay it.
  test('a Location that leaves the origin keeps its status', async () => {
    for (const location of [
      'https://evil.example/p1',
      '//evil.example/p1',
      '//evil.example/',
      'https://anc.dev.evil.example/p1',
      'http://anc.dev/p1',
      '\\\\evil.example\\p1',
    ]) {
      const res = await call('/p1/', { status: 307, location });
      expect({ location, status: res.status }).toEqual({ location, status: 307 });
    }
  });

  test('a redirect with no Location, and a status other than 307, pass through', async () => {
    const noLocation = await call('/p1/', { status: 307, location: null });
    expect(noLocation.status).toBe(307);
    for (const status of [301, 302, 308]) {
      const res = await call('/p1/', { status, location: '/p1' });
      expect({ status: res.status, location: res.headers.get('location') }).toEqual({ status, location: '/p1' });
    }
  });

  test('a response that is not a redirect is untouched', async () => {
    const res = await worker.fetch(
      new Request('https://anc.dev/p1/'),
      {
        ASSETS: {
          async fetch() {
            return new Response('ok', { status: 200, headers: { 'content-type': 'text/html' } });
          },
        } as unknown as Fetcher,
      },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
  });
});
