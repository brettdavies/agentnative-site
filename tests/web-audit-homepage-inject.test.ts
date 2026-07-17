// Homepage web-board inject tests: the Worker fills the static shell's
// {{WEB_BOARD_ROWS}} region from the R2 leaderboard-frontpage aggregate
// at request time, keeping the homepage zero-JS while the web pane stays
// live. The CLI pane is static and must never be touched by the inject.

import { describe, expect, test } from 'bun:test';
import { aggregateKeyFor, type WebAggregateEntry } from '../src/worker/audit-web/cache';
import worker, { type Env } from '../src/worker/index';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

const HOMEPAGE_SHELL = `<!doctype html>
<html><head><meta name="turnstile-sitekey" content="{{TURNSTILE_SITEKEY}}"></head>
<body>
  <div class="board" data-s="cli" aria-label="Top CLI tools">
    <a class="lrow good" href="/score/ripgrep"><span class="rank">01</span>ripgrep</a>
  </div>
  <div class="board" data-s="web" aria-label="Top websites">
{{WEB_BOARD_ROWS}}
  </div>
</body></html>`;

function frontpageEntry(domain: string, globalScore: number): WebAggregateEntry {
  return {
    domain,
    url: `https://${domain}/`,
    name: domain,
    description: `about ${domain}`,
    score_pct: globalScore + 5,
    score: { relative: globalScore + 5, global: globalScore },
  };
}

function makeEnv(aggregate: WebAggregateEntry[] | null): Env {
  const store = new Map<string, string>();
  if (aggregate) {
    store.set(
      aggregateKeyFor('leaderboard-frontpage', SPEC_VERSION),
      JSON.stringify({ spec_version: SPEC_VERSION, generated_at: new Date().toISOString(), entries: aggregate }),
    );
  }
  return {
    ASSETS: {
      async fetch() {
        return new Response(HOMEPAGE_SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
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
    TURNSTILE_SITEKEY: 'sitekey-test',
  } as unknown as Env;
}

function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

async function fetchHomepage(env: Env): Promise<string> {
  const resp = await worker.fetch(new Request('https://anc.dev/'), env, ctx());
  expect(resp.status).toBe(200);
  return resp.text();
}

describe('homepage web-board inject', () => {
  test('injects frontpage rows into the marked region when the aggregate is present', async () => {
    const html = await fetchHomepage(makeEnv([frontpageEntry('top.dev', 80), frontpageEntry('next.dev', 60)]));
    expect(html).not.toContain('{{WEB_BOARD_ROWS}}');
    expect(html).toContain('href="/web/top.dev"');
    expect(html).toContain('href="/web/next.dev"');
    expect(html.indexOf('top.dev')).toBeLessThan(html.indexOf('next.dev'));
    const webPane = html.slice(html.indexOf('data-s="web"'));
    expect(webPane).toContain('class="lrow');
  });

  test('renders the scoring-in-progress state when the aggregate is absent, still HTTP 200', async () => {
    const html = await fetchHomepage(makeEnv(null));
    expect(html).not.toContain('{{WEB_BOARD_ROWS}}');
    expect(html).toContain('Scoring in progress');
  });

  test('an empty aggregate renders the same scoring-in-progress state', async () => {
    const html = await fetchHomepage(makeEnv([]));
    expect(html).toContain('Scoring in progress');
  });

  test('the CLI board region is untouched by the inject', async () => {
    const html = await fetchHomepage(makeEnv([frontpageEntry('top.dev', 80)]));
    expect(html).toContain('href="/score/ripgrep"');
    const cliPane = html.slice(html.indexOf('data-s="cli"'), html.indexOf('data-s="web"'));
    expect(cliPane).toContain('ripgrep');
    expect(cliPane).not.toContain('top.dev');
  });

  test('the injected board requires no client JS (no script tags in the injected markup)', async () => {
    const html = await fetchHomepage(makeEnv([frontpageEntry('top.dev', 80)]));
    const webPane = html.slice(html.indexOf('data-s="web"'), html.indexOf('</body>'));
    expect(webPane).not.toContain('<script');
  });

  test('the sitekey substitution still runs alongside the board inject', async () => {
    const html = await fetchHomepage(makeEnv([frontpageEntry('top.dev', 80)]));
    expect(html).toContain('content="sitekey-test"');
    expect(html).not.toContain('{{TURNSTILE_SITEKEY}}');
  });

  test('a minimal env without SCORE_CACHE degrades to the empty state, not an error', async () => {
    const env = makeEnv(null);
    (env as { SCORE_CACHE?: unknown }).SCORE_CACHE = undefined;
    const html = await fetchHomepage(env);
    expect(html).toContain('Scoring in progress');
  });
});

describe('built homepage carries the placeholder', () => {
  test('06-homepage emits the {{WEB_BOARD_ROWS}} marker in the web pane', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/build/06-homepage.mjs', import.meta.url), 'utf8');
    expect(source).toContain('{{WEB_BOARD_ROWS}}');
    expect(source).not.toContain('buildWebBoardRows');
  });
});

// U3: the homepage web-check spec index shows six rows matching the six
// registry categories, with API (C4) and MCP (C5) distinct. These rows are
// categories, not single-tier checks, so they carry no tier chip.
describe('homepage web-check rows (six categories, no group tier)', () => {
  test('renders six rows with unique, sequential ids C1-C6', async () => {
    const { buildWebCheckRows } = await import('../src/build/06-homepage.mjs');
    const rows = buildWebCheckRows();
    const ids = [...rows.matchAll(/<span class="spec__id">(C\d+)<\/span>/g)].map((m) => m[1]);
    expect(ids).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
  });

  test('the API row and MCP row are distinct, with no tier chip on any category row', async () => {
    const { buildWebCheckRows } = await import('../src/build/06-homepage.mjs');
    const rows = buildWebCheckRows();
    // C4 = API, C5 = MCP, as untiered category rows (id -> title -> desc).
    expect(rows).toMatch(
      /spec__row spec__row--untiered"><span class="spec__id">C4<\/span>[\s\S]*?spec__title[^>]*>API</,
    );
    expect(rows).toMatch(
      /spec__row spec__row--untiered"><span class="spec__id">C5<\/span>[\s\S]*?spec__title[^>]*>MCP</,
    );
    // No RFC-2119 tier vocabulary at the category level.
    expect(rows).not.toContain('class="tier"');
    expect(rows).not.toMatch(/spec__row tier-(must|should|may)/);
    expect(rows).not.toContain('MCP &amp; API');
  });
});
