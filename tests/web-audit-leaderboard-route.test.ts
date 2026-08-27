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

type ListedObject = { key: string; customMetadata?: Record<string, string> };

type EnvOpts = {
  listed?: ListedObject[];
  seedDomains?: string[];
};

let hashCounter = 0;

/** Listed per-domain R2 object carrying board fields in custom metadata. */
function listedAudit(
  domain: string,
  globalScore: number,
  relative: number,
  overrides: {
    scored_at?: string;
    key?: string;
    // 'true'/'false' set the metadata flag; 'absent' omits the key so the row
    // exercises the missing-key-reads-as-false path. Defaults to opted-in so a
    // helper named "listed" produces a board-visible row.
    public_listing?: 'true' | 'false' | 'absent';
  } = {},
): ListedObject {
  hashCounter += 1;
  const hash = String(hashCounter).padStart(64, '0');
  const customMetadata: Record<string, string> = {
    domain,
    name: domain,
    score_pct: String(relative),
    relative: String(relative),
    global: String(globalScore),
    scored_at: overrides.scored_at ?? new Date().toISOString(),
  };
  const listing = overrides.public_listing ?? 'true';
  if (listing !== 'absent') customMetadata.public_listing = listing;
  return {
    key: overrides.key ?? `audits/web/${hash}/${SPEC_VERSION}.json`,
    customMetadata,
  };
}

function makeEnv(aggregate: WebAggregateEntry[] | null, opts: EnvOpts = {}): WebAuditRouteEnv {
  const store = new Map<string, string>();
  if (aggregate) {
    store.set(
      aggregateKeyFor('leaderboard', SPEC_VERSION),
      JSON.stringify({ spec_version: SPEC_VERSION, generated_at: new Date().toISOString(), entries: aggregate }),
    );
  }
  const seedDomains = opts.seedDomains ?? (aggregate ?? []).map((e) => e.domain);
  const seed = seedDomains.map((domain) => ({
    domain,
    url: `https://${domain}/`,
    name: domain,
    description: `about ${domain}`,
  }));
  return {
    ASSETS: {
      async fetch(input: RequestInfo | URL) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/_internal/score-live-shell.html')) {
          return new Response(SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        if (url.includes('/_internal/web-seed.json')) {
          return new Response(JSON.stringify(seed), { status: 200, headers: { 'content-type': 'application/json' } });
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
      async list() {
        return { objects: opts.listed ?? [], truncated: false };
      },
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

describe('all vs curated views', () => {
  test('GET /web defaults to the all view: curated rows plus a non-seeded cached entry', async () => {
    const env = makeEnv(BOARD, { listed: [listedAudit('user.dev', 40, 55)] });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web'), env)).text();
    expect(html).toContain('href="/web/top.dev"');
    expect(html).toContain('href="/web/mid.dev"');
    expect(html).toContain('href="/web/user.dev"');
  });

  test('GET /web?view=curated hides the non-seeded entry', async () => {
    const env = makeEnv(BOARD, { listed: [listedAudit('user.dev', 40, 55)] });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web?view=curated'), env)).text();
    expect(html).toContain('href="/web/top.dev"');
    expect(html).not.toContain('user.dev');
  });

  test('an unrecognized view value falls back to the all view', async () => {
    const env = makeEnv(BOARD, { listed: [listedAudit('user.dev', 40, 55)] });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web?view=garbage'), env)).text();
    expect(html).toContain('href="/web/user.dev"');
  });

  test('the all view marks the All link active and points Curated at ?view=curated', async () => {
    const env = makeEnv(BOARD, { listed: [listedAudit('user.dev', 40, 55)] });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web'), env)).text();
    expect(html).toMatch(
      /<a[^>]*class="tier-filter tier-filter--active"[^>]*aria-current="page"[^>]*href="\/web"[^>]*>All<\/a>/,
    );
    expect(html).toMatch(/<a[^>]*href="\/web\?view=curated"[^>]*>Curated \(2\)<\/a>/);
  });

  test('the curated view marks the Curated link active and points All at /web', async () => {
    const env = makeEnv(BOARD, { listed: [listedAudit('user.dev', 40, 55)] });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web?view=curated'), env)).text();
    expect(html).toMatch(
      /<a[^>]*class="tier-filter tier-filter--active"[^>]*aria-current="page"[^>]*href="\/web\?view=curated"[^>]*>Curated \(2\)<\/a>/,
    );
    expect(html).toMatch(/<a[^>]*class="tier-filter"[^>]*href="\/web"[^>]*>All<\/a>/);
  });

  test('default board marks Relative active; Global is the opt-in', async () => {
    const env = makeEnv(BOARD, { listed: [] });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web'), env)).text();
    expect(html).toMatch(
      /data-web-sort="relative"[^>]*aria-pressed="true"|class="tier-filter tier-filter--active"[^>]*data-web-sort="relative"/,
    );
    expect(html).toContain('data-web-sort="relative"');
    expect(html).toContain('data-web-sort="global"');
  });

  test('toggle links preserve a present ?sort=global', async () => {
    const env = makeEnv(BOARD, { listed: [listedAudit('user.dev', 40, 55)] });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web?sort=global'), env)).text();
    expect(html).toContain('href="/web?sort=global"');
    expect(html).toContain('href="/web?view=curated&amp;sort=global"');
  });

  test('?sort=relative does not pollute view-toggle hrefs (Relative is the default)', async () => {
    const env = makeEnv(BOARD, { listed: [listedAudit('user.dev', 40, 55)] });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web?sort=relative'), env)).text();
    expect(html).not.toContain('sort=relative');
    expect(html).toContain('href="/web"');
    expect(html).toContain('href="/web?view=curated"');
  });

  test('a user-submitted row carries the marker; curated rows do not', async () => {
    const env = makeEnv(BOARD, { listed: [listedAudit('user.dev', 40, 55)] });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web'), env)).text();
    const userRow = html.slice(html.indexOf('data-domain="user.dev"'), html.indexOf('data-domain="user.dev"') + 600);
    expect(userRow).toContain('<span class="lb-tag">user-submitted</span>');
    const topRow = html.slice(
      html.indexOf('data-domain="top.dev"'),
      html.indexOf('</tr>', html.indexOf('data-domain="top.dev"')),
    );
    expect(topRow).not.toContain('lb-tag');
  });

  test('view-aware meta: all shows the breakdown, curated shows the curated count', async () => {
    const env = makeEnv(BOARD, { listed: [listedAudit('user.dev', 40, 55)] });
    const allHtml = await (await handleWebLeaderboard(new Request('https://anc.dev/web'), env)).text();
    expect(allHtml).toContain('3 sites on the board (2 curated, 1 user-submitted)');
    const curatedHtml = await (await handleWebLeaderboard(new Request('https://anc.dev/web?view=curated'), env)).text();
    expect(curatedHtml).toContain('2 curated sites on the board');
    expect(curatedHtml).not.toContain('user-submitted)');
  });

  test('the methodology footer no longer claims a purely curated board', async () => {
    const env = makeEnv(BOARD, { listed: [] });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web'), env)).text();
    expect(html).not.toContain('The board is curated.');
    expect(html).toContain('ages out');
  });

  test('a non-seeded entry past the display window is absent from the all view', async () => {
    const expired = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
    const env = makeEnv(BOARD, { listed: [listedAudit('expired.dev', 40, 55, { scored_at: expired })] });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web'), env)).text();
    expect(html).not.toContain('expired.dev');
  });

  test('a seeded domain present in the R2 list is not duplicated', async () => {
    const env = makeEnv(BOARD, { listed: [listedAudit('top.dev', 90, 95)] });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web'), env)).text();
    expect(html.match(/data-domain="top\.dev"/g)).toHaveLength(1);
  });

  test('a curated-aggregate domain missing from the seed still renders once', async () => {
    const env = makeEnv(BOARD, { seedDomains: ['top.dev'], listed: [listedAudit('mid.dev', 70, 88)] });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web'), env)).text();
    expect(html.match(/data-domain="mid\.dev"/g)).toHaveLength(1);
  });

  test('cold aggregate and empty list render the empty state in both views', async () => {
    for (const path of ['/web', '/web?view=curated']) {
      const env = makeEnv(null, { listed: [] });
      const html = await (await handleWebLeaderboard(new Request(`https://anc.dev${path}`), env)).text();
      expect(html).toContain('Scoring in progress');
    }
  });

  test('markdown all view carries the Source column and the view switch line', async () => {
    const env = makeEnv(BOARD, { listed: [listedAudit('user.dev', 40, 55)] });
    const md = await (await handleWebLeaderboard(new Request('https://anc.dev/web.md'), env)).text();
    expect(md).toContain('| Source |');
    expect(md).toMatch(/\| \[user\.dev\]\([^)]+\) \| 40% \| 55% \| on-demand \|/);
    expect(md).toMatch(/\| \[top\.dev\]\([^)]+\) \| 90% \| 95% \| curated \|/);
    expect(md).toContain('View: All | [Curated](https://anc.dev/web.md?view=curated)');
  });

  test('markdown curated view lists only curated rows and links back to All', async () => {
    const env = makeEnv(BOARD, { listed: [listedAudit('user.dev', 40, 55)] });
    const md = await (await handleWebLeaderboard(new Request('https://anc.dev/web.md?view=curated'), env)).text();
    expect(md).not.toContain('user.dev');
    expect(md).toContain('View: [All](https://anc.dev/web.md) | Curated');
  });

  test('Accept: text/markdown composes with ?view=curated', async () => {
    const env = makeEnv(BOARD, { listed: [listedAudit('user.dev', 40, 55)] });
    const resp = await handleWebLeaderboard(
      new Request('https://anc.dev/web?view=curated', { headers: { Accept: 'text/markdown' } }),
      env,
    );
    expect(resp.headers.get('content-type')).toContain('text/markdown');
    const md = await resp.text();
    expect(md).not.toContain('user.dev');
  });

  test('the all view is exercised through top-level worker dispatch', async () => {
    const env = makeEnv(BOARD, { listed: [listedAudit('user.dev', 40, 55)] }) as unknown as Env;
    const resp = await worker.fetch(new Request('https://anc.dev/web'), env, {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain('href="/web/user.dev"');
  });
});

describe('public_listing board gate', () => {
  // Reused across HTML/markdown parity so both surfaces read one fixture.
  function mixedListing(): ListedObject[] {
    return [
      listedAudit('optin.dev', 40, 55, { public_listing: 'true' }),
      listedAudit('optout.dev', 41, 56, { public_listing: 'false' }),
      listedAudit('legacy.dev', 42, 57, { public_listing: 'absent' }),
    ];
  }

  test('the all view lists only opted-in user rows; false and absent are hidden', async () => {
    const env = makeEnv(BOARD, { listed: mixedListing() });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web?view=all'), env)).text();
    expect(html).toContain('data-domain="optin.dev"');
    expect(html).not.toContain('optout.dev');
    expect(html).not.toContain('legacy.dev');
  });

  test('the .md all view gates the identical user-row set as the HTML all view', async () => {
    const htmlEnv = makeEnv(BOARD, { listed: mixedListing() });
    const mdEnv = makeEnv(BOARD, { listed: mixedListing() });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web?view=all'), htmlEnv)).text();
    const md = await (await handleWebLeaderboard(new Request('https://anc.dev/web.md?view=all'), mdEnv)).text();
    // Same visibility decision on both surfaces, so the board cannot diverge.
    for (const shown of ['optin.dev']) {
      expect(html).toContain(shown);
      expect(md).toContain(shown);
    }
    for (const hidden of ['optout.dev', 'legacy.dev']) {
      expect(html).not.toContain(hidden);
      expect(md).not.toContain(hidden);
    }
  });

  test('curated rows always show, even when their own R2 object opts out', async () => {
    // top.dev is curated (in the aggregate + seed) and additionally carries a
    // user object flagged false: it must still render, never gated.
    const env = makeEnv(BOARD, { listed: [listedAudit('top.dev', 90, 95, { public_listing: 'false' })] });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web?view=all'), env)).text();
    expect(html).toContain('data-domain="top.dev"');
    expect(html).toContain('data-domain="mid.dev"');
  });

  test('the meta breakdown counts only opted-in user rows', async () => {
    const env = makeEnv(BOARD, { listed: mixedListing() });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web?view=all'), env)).text();
    expect(html).toContain('3 sites on the board (2 curated, 1 user-submitted)');
  });

  test('the curated view is unaffected by the flag gate', async () => {
    const env = makeEnv(BOARD, {
      listed: [
        listedAudit('optin.dev', 40, 55, { public_listing: 'true' }),
        listedAudit('optout.dev', 41, 56, { public_listing: 'false' }),
      ],
    });
    const html = await (await handleWebLeaderboard(new Request('https://anc.dev/web?view=curated'), env)).text();
    expect(html).toContain('data-domain="top.dev"');
    expect(html).toContain('data-domain="mid.dev"');
    expect(html).not.toContain('optin.dev');
    expect(html).not.toContain('optout.dev');
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
