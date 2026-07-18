// Dynamic /web board tests: rendered at request time from the R2
// leaderboard aggregate, with a scoring-in-progress empty state on a cold
// aggregate, and dispatched in the Worker ahead of the static assets so
// no committed board can serve.

import { describe, expect, test } from 'bun:test';
import { aggregateKeyFor, type WebAggregateEntry } from '../src/worker/audit-web/cache';
import { handleWebLeaderboard, isWebLeaderboardPath, type WebAuditRouteEnv } from '../src/worker/audit-web/route';
import worker, { type Env } from '../src/worker/index';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

const SHELL =
  '<!doctype html><title>{{TITLE}}</title><meta name="description" content="{{DESCRIPTION}}"><link rel="canonical" href="{{CANONICAL_PATH}}"><main>{{BODY}}</main>';

function entry(domain: string, globalScore: number, relative: number): WebAggregateEntry {
  return {
    domain,
    url: `https://${domain}/`,
    name: domain,
    description: `about ${domain}`,
    score_pct: relative,
    score: { relative, global: globalScore },
  };
}

function makeEnv(aggregate: WebAggregateEntry[] | null): WebAuditRouteEnv {
  const store = new Map<string, string>();
  if (aggregate) {
    store.set(
      aggregateKeyFor('leaderboard', SPEC_VERSION),
      JSON.stringify({ spec_version: SPEC_VERSION, generated_at: new Date().toISOString(), entries: aggregate }),
    );
  }
  return {
    ASSETS: {
      async fetch(input: RequestInfo | URL) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/_internal/score-live-shell.html')) {
          return new Response(SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        return new Response('static asset fallthrough', { status: 200, headers: { 'content-type': 'text/html' } });
      },
    } as unknown as Fetcher,
    SCORE_CACHE: {
      async get(key: string) {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return {
          async json() {
            return JSON.parse(raw);
          },
        };
      },
      async put() {},
      async delete() {},
    } as unknown as R2Bucket,
  } as WebAuditRouteEnv;
}

const BOARD = [entry('top.dev', 90, 95), entry('mid.dev', 70, 88)];

describe('isWebLeaderboardPath', () => {
  test('matches /web and /web.md only', () => {
    expect(isWebLeaderboardPath('/web')).toBe(true);
    expect(isWebLeaderboardPath('/web.md')).toBe(true);
    expect(isWebLeaderboardPath('/web/example.com')).toBe(false);
    expect(isWebLeaderboardPath('/web-audit')).toBe(false);
  });
});

describe('handleWebLeaderboard', () => {
  test('renders a board row per aggregate entry with sort attributes for the client toggle', async () => {
    const resp = await handleWebLeaderboard(new Request('https://anc.dev/web'), makeEnv(BOARD));
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    const html = await resp.text();
    expect(html).toContain('data-global="90" data-relative="95"');
    expect(html).toContain('data-global="70" data-relative="88"');
    expect(html).toContain('href="/web/top.dev"');
    expect(html).toContain('data-web-sort="global"');
    expect(html).toContain('data-web-sort="relative"');
    expect(html).toContain('src="/js/web-leaderboard.js"');
    expect(html.indexOf('top.dev')).toBeLessThan(html.indexOf('mid.dev'));
  });

  test('renders the markdown twin for /web.md with origin-absolute links', async () => {
    const resp = await handleWebLeaderboard(new Request('https://anc.dev/web.md'), makeEnv(BOARD));
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/markdown');
    const md = await resp.text();
    expect(md).toContain('| 1 | [top.dev](https://anc.dev/web/top.dev) | 90% | 95% |');
    expect(md).toContain('| 2 | [mid.dev](https://anc.dev/web/mid.dev) | 70% | 88% |');
  });

  test('honors Accept: text/markdown on the suffix-less path', async () => {
    const resp = await handleWebLeaderboard(
      new Request('https://anc.dev/web', { headers: { Accept: 'text/markdown' } }),
      makeEnv(BOARD),
    );
    expect(resp.headers.get('content-type')).toContain('text/markdown');
  });

  test('an absent aggregate renders the empty state at HTTP 200 (no server error)', async () => {
    const resp = await handleWebLeaderboard(new Request('https://anc.dev/web'), makeEnv(null));
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain('Scoring in progress');
    expect(html).not.toContain('<tbody>');
  });

  test('an empty aggregate renders the same empty state in the twin', async () => {
    const resp = await handleWebLeaderboard(new Request('https://anc.dev/web.md'), makeEnv([]));
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain('Scoring in progress');
  });

  test('POST is 405', async () => {
    const resp = await handleWebLeaderboard(new Request('https://anc.dev/web', { method: 'POST' }), makeEnv(BOARD));
    expect(resp.status).toBe(405);
  });
});

describe('worker dispatch', () => {
  test('/web is served dynamically and no longer falls through to the static asset', async () => {
    const env = makeEnv(null) as unknown as Env;
    const resp = await worker.fetch(new Request('https://anc.dev/web'), env, {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain('Scoring in progress');
    expect(html).not.toContain('static asset fallthrough');
  });

  test('/web carries the site header policy (Link twin + llms pointer) and stays indexable', async () => {
    const env = makeEnv(BOARD) as unknown as Env;
    const resp = await worker.fetch(new Request('https://anc.dev/web'), env, {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext);
    expect(resp.headers.get('link')).toContain('</web.md>; rel="alternate"');
    expect(resp.headers.get('x-llms-txt')).toBe('/llms.txt');
    expect(resp.headers.get('x-robots-tag')).toBeNull();
  });

  test('/web.html and /web/ canonicalize to /web with a 301', async () => {
    const env = makeEnv(BOARD) as unknown as Env;
    for (const path of ['/web.html', '/web/']) {
      const resp = await worker.fetch(new Request(`https://anc.dev${path}`), env, {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext);
      expect(resp.status).toBe(301);
      expect(resp.headers.get('location')).toBe('/web');
    }
  });
});
