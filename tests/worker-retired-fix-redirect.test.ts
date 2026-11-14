// Search engines still list the retired /web-audit/skill/<id> fix-page path, so
// every id the remediation catalog holds redirects to its /fix/<id> twin, and
// any other id is a 404.

import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import worker from '../src/worker/index';
import { _resetIndexCache } from '../src/worker/score/core';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

function catalogIds(): string[] {
  const doc = yaml.load(readFileSync(join(REPO_ROOT, 'src', 'data', 'web-audit', 'remediation.yaml'), 'utf8'));
  if (typeof doc !== 'object' || doc === null || !('remediation' in doc)) throw new Error('no remediation mapping');
  return Object.keys(doc.remediation as Record<string, unknown>);
}

const IDS = catalogIds();

// The Worker reads the catalog the build projects; every other path is a 404,
// as Static Assets answers a path with no file behind it.
function makeEnv() {
  const catalog = Object.fromEntries(IDS.map((id) => [id, { title: id, goal: 'g', fix: 'f', resources: [] }]));
  return {
    ASSETS: {
      async fetch(request: Request | string): Promise<Response> {
        const path = new URL(typeof request === 'string' ? request : request.url).pathname;
        if (path === '/_internal/web-remediation.json') return Response.json(catalog);
        if (path === '/registry-index.json') return new Response('{"by_slug":{},"by_owner_repo":{}}');
        return new Response('', { status: 404 });
      },
    } as unknown as Fetcher,
  };
}

async function get(path: string, init?: RequestInit) {
  return worker.fetch(new Request(`https://anc.dev${path}`, init), makeEnv(), {} as ExecutionContext);
}

describe('retired /web-audit/skill/<id> paths', () => {
  beforeEach(() => {
    _resetIndexCache();
  });

  test('the catalog holds the retired id as well as the live checks', () => {
    expect(IDS).toContain('well-known-mcp-card');
    expect(IDS.length).toBeGreaterThan(60);
  });

  test('every catalog id 301s to its /fix/ page, and its .md twin to the twin', async () => {
    for (const id of IDS) {
      for (const [suffix, twin] of [
        ['', ''],
        ['.md', '.md'],
      ]) {
        const from = `/web-audit/skill/${id}${suffix}`;
        const res = await get(from);
        expect({ from, status: res.status, location: res.headers.get('location') }).toEqual({
          from,
          status: 301,
          location: `/fix/${id}${twin}`,
        });
        expect(res.headers.get('cache-control')).toBe('public, max-age=300');
      }
    }
  });

  test('the redirect does not follow content negotiation', async () => {
    const res = await get('/web-audit/skill/ai-catalog', { headers: { Accept: 'text/markdown' } });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/fix/ai-catalog');
  });

  test('an id outside the catalog stays a 404, with no Location', async () => {
    for (const from of [
      '/web-audit/skill/not-a-check',
      '/web-audit/skill/not-a-check.md',
      '/web-audit/skill/ai-catalog-2',
      '/web-audit/skill/AI-Catalog',
      '/web-audit/skill/__proto__',
      '/web-audit/skill/constructor',
      '/web-audit/skill/toString.md',
    ]) {
      const res = await get(from);
      expect({ from, status: res.status, location: res.headers.get('location') }).toEqual({
        from,
        status: 404,
        location: null,
      });
    }
  });

  test('a path that is not the exact id shape stays a 404, with no Location', async () => {
    for (const from of [
      '/web-audit/skill',
      '/web-audit/skill/',
      '/web-audit/skill/.md',
      '/web-audit/skill/ai-catalog/',
      '/web-audit/skill/ai-catalog/extra',
      '/web-audit/skill/ai-catalog.md.md',
      '/web-audit/skill/ai-catalog.json',
      '/web-audit/skill/ai-catalog.html',
      '/web-audit/skill/ai-catalog%2F..%2F..',
      '/web-audit/skill/%2F%2Fevil.example',
      '/web-audit/skill//evil.example',
      '/web-audit/skill/..',
    ]) {
      const res = await get(from);
      expect({ from, status: res.status, location: res.headers.get('location') }).toEqual({
        from,
        status: 404,
        location: null,
      });
    }
  });
});
