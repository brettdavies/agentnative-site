// Merged-leaderboard inject: the Worker fills the built page's
// {{WEB_BOARD_ROWS}} region from the R2 `leaderboard` aggregate at request
// time, in the HTML pane and in the markdown twin. The CLI board ships baked
// into the asset and must never be touched by the inject.

import { describe, expect, test } from 'bun:test';
import { aggregateKeyFor, type WebAggregateEntry } from '../src/worker/audit-web/cache';
import worker, { type Env } from '../src/worker/index';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

const SCORECARDS_SHELL = `<!doctype html>
<html><head><title>ANC 100</title></head>
<body>
  <div class="scope">
    <div class="seg" role="radiogroup" aria-label="Leaderboard surface" data-surface-board-seg>
      <input type="radio" name="board-surface" id="s-cli" checked="checked"><label for="s-cli">CLI</label>
      <input type="radio" name="board-surface" id="s-web"><label for="s-web">Website</label>
    </div>
    <div class="board" data-s="cli" aria-label="CLI tool agent-readiness scores">
      <a class="lrow good" href="/score/ripgrep"><span class="rank">01</span>ripgrep</a>
    </div>
    <div class="board" data-s="web" aria-label="Website agent-readiness scores">
{{WEB_BOARD_ROWS}}
    </div>
    <div class="board-view" data-s="web">
      <p class="board-rubric">Scored against the emerging agent-web standards.</p>
{{WEB_BOARD_VIEW}}
    </div>
  </div>
</body></html>`;

const SCORECARDS_MD = `# ANC 100

| # | Tool | Tier | Lang | Score | Principles |
|---|------|------|------|-------|------------|
| 1 | [ripgrep](/score/ripgrep) | workhorse | Rust | 92% | 7/7 |

## Web leaderboard

{{WEB_BOARD_ROWS}}
`;

function boardEntry(domain: string, globalScore: number): WebAggregateEntry {
  return {
    domain,
    url: `https://${domain}/`,
    name: domain,
    description: `about ${domain}`,
    score_pct: globalScore + 5,
    score: { relative: globalScore + 5, global: globalScore },
  };
}

// A fresh env per test: loadWebSeed caches by env identity, so a shared one
// would carry seed state between cases.
function makeEnv(aggregate: WebAggregateEntry[] | null): Env {
  const store = new Map<string, string>();
  if (aggregate) {
    store.set(
      aggregateKeyFor('leaderboard', SPEC_VERSION),
      JSON.stringify({ spec_version: SPEC_VERSION, generated_at: new Date().toISOString(), entries: aggregate }),
    );
  }
  return {
    ASSETS: {
      async fetch(request: Request | string): Promise<Response> {
        const path = new URL(typeof request === 'string' ? request : request.url).pathname;
        if (path === '/scorecards.md') {
          return new Response(SCORECARDS_MD, {
            status: 200,
            headers: { 'content-type': 'text/markdown; charset=utf-8' },
          });
        }
        if (path === '/_internal/web-seed.json') return new Response('[]', { status: 200 });
        return new Response(SCORECARDS_SHELL, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
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
      // The all view enumerates user-submitted audits. An empty page keeps
      // that path exercised, where a missing list() is swallowed by its own
      // catch and logs on every request instead.
      async list() {
        return { objects: [], truncated: false };
      },
    } as unknown as R2Bucket,
  } as unknown as Env;
}

function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

async function fetchBoard(env: Env, url = 'https://anc.dev/scorecards', headers?: HeadersInit): Promise<string> {
  const resp = await worker.fetch(new Request(url, { headers }), env, ctx());
  expect(resp.status).toBe(200);
  return resp.text();
}

describe('merged leaderboard: the website pane', () => {
  test('injects board rows into the marked region, ranked by relative score', async () => {
    const html = await fetchBoard(makeEnv([boardEntry('next.dev', 60), boardEntry('top.dev', 80)]));
    expect(html).not.toContain('{{WEB_BOARD_ROWS}}');
    expect(html).toContain('href="/web/top.dev"');
    expect(html).toContain('href="/web/next.dev"');
    expect(html.indexOf('top.dev')).toBeLessThan(html.indexOf('next.dev'));
  });

  test('a row states both scores: the meter is relative, the sub-label is global', async () => {
    // boardEntry('top.dev', 80) is global 80, relative 85. The headline is the
    // relative score, so it takes the meter; global rides the sub-label, which
    // is how one row carries both without a second column.
    const html = await fetchBoard(makeEnv([boardEntry('top.dev', 80)]));
    const webPane = html.slice(html.indexOf('data-s="web"'));
    expect(webPane).toContain('class="lrow');
    expect(webPane).toContain('<span class="name-sub">80% global</span>');
    expect(webPane).toContain('<span class="meter__num">85</span>');
  });

  test('an absent aggregate renders the scoring-in-progress state, still HTTP 200', async () => {
    const html = await fetchBoard(makeEnv(null));
    expect(html).not.toContain('{{WEB_BOARD_ROWS}}');
    expect(html).toContain('Scoring in progress');
  });

  test('the CLI board is untouched by the inject', async () => {
    const html = await fetchBoard(makeEnv([boardEntry('top.dev', 80)]));
    const cliPane = html.slice(html.indexOf('data-s="cli"'), html.indexOf('data-s="web"'));
    expect(cliPane).toContain('href="/score/ripgrep"');
    expect(cliPane).not.toContain('top.dev');
  });

  test('the view switch renders against the leaderboard base, not the website board', async () => {
    const html = await fetchBoard(makeEnv([boardEntry('top.dev', 80)]));
    expect(html).not.toContain('{{WEB_BOARD_VIEW}}');
    expect(html).toContain('aria-label="Board view"');
    expect(html).toContain('href="/scorecards?view=curated"');
    // A forked copy of the control would quietly send this board's readers to
    // the other board.
    expect(html).not.toContain('href="/web?view=curated"');
  });

  test('?lane=web opens on the website pane, which is how a website result links back', async () => {
    const html = await fetchBoard(makeEnv([boardEntry('top.dev', 80)]), 'https://anc.dev/scorecards?lane=web');
    expect(html).toContain('id="s-web" checked');
    expect(html).not.toContain('id="s-cli" checked');
    // The whole tag, not just the absence of the old attribute: dropping the
    // bare word out of `checked="checked"` leaves `id="s-cli"="checked"`,
    // which satisfies the negative assertion above while shipping broken
    // markup.
    expect(html).toContain('<input type="radio" name="board-surface" id="s-cli">');
    expect(html).not.toContain('="checked"');
  });

  test('no lane, or the CLI lane, leaves the CLI pane checked', async () => {
    const plain = await fetchBoard(makeEnv([boardEntry('top.dev', 80)]));
    expect(plain).toContain('id="s-cli" checked');
    expect(plain).not.toContain('id="s-web" checked');
    const cli = await fetchBoard(makeEnv([boardEntry('top.dev', 80)]), 'https://anc.dev/scorecards?lane=cli');
    expect(cli).toContain('id="s-cli" checked');
    expect(cli).not.toContain('id="s-web" checked');
  });

  test('the injected rows need no client JS', async () => {
    const html = await fetchBoard(makeEnv([boardEntry('top.dev', 80)]));
    const webPane = html.slice(html.indexOf('data-s="web"'), html.indexOf('</body>'));
    expect(webPane).not.toContain('<script');
  });
});

describe('merged leaderboard: the markdown twin', () => {
  test('fills the web section with the full table and keeps the CLI table', async () => {
    const md = await fetchBoard(makeEnv([boardEntry('top.dev', 80)]), 'https://anc.dev/scorecards.md');
    expect(md).not.toContain('{{WEB_BOARD_ROWS}}');
    // The twin keeps every column the compact HTML row trades away.
    expect(md).toContain('| # | Tool | Tier | Lang | Score | Principles |');
    expect(md).toContain('| # | Site | Global | Relative | Source |');
    expect(md).toContain('| 1 | [top.dev](https://anc.dev/web/top.dev) | 80% | 85% | curated |');
  });

  test('Accept: text/markdown reaches the same filled twin', async () => {
    const md = await fetchBoard(makeEnv([boardEntry('top.dev', 80)]), 'https://anc.dev/scorecards', {
      accept: 'text/markdown',
    });
    expect(md).not.toContain('{{WEB_BOARD_ROWS}}');
    expect(md).toContain('| # | Site | Global | Relative | Source |');
  });

  test('the twin carries no view-switch markup', async () => {
    const md = await fetchBoard(makeEnv([boardEntry('top.dev', 80)]), 'https://anc.dev/scorecards.md');
    expect(md).not.toContain('{{WEB_BOARD_VIEW}}');
    expect(md).not.toContain('tier-filters');
  });

  test('an absent aggregate leaves the twin a sentence, not a bare heading', async () => {
    const md = await fetchBoard(makeEnv(null), 'https://anc.dev/scorecards.md');
    expect(md).not.toContain('{{WEB_BOARD_ROWS}}');
    expect(md).toContain('Scoring in progress');
  });
});

describe('merged leaderboard: the rewritten response', () => {
  test('drops the asset validators, which no longer describe the body', async () => {
    const env = makeEnv(null);
    env.ASSETS = {
      async fetch(): Promise<Response> {
        return new Response(SCORECARDS_SHELL, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            etag: '"asset-etag"',
            'last-modified': 'Wed, 01 Jan 2020 00:00:00 GMT',
          },
        });
      },
    } as unknown as Fetcher;
    const resp = await worker.fetch(new Request('https://anc.dev/scorecards'), env, ctx());
    expect(resp.status).toBe(200);
    expect(resp.headers.get('etag')).toBeNull();
    expect(resp.headers.get('last-modified')).toBeNull();
  });

  test('a missing cache bucket degrades to the empty state rather than erroring', async () => {
    const env = makeEnv(null);
    (env as { SCORE_CACHE?: unknown }).SCORE_CACHE = undefined;
    expect(await fetchBoard(env)).toContain('Scoring in progress');
  });
});
