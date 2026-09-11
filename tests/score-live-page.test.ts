// The legacy `/score/live/<binary>` path is an adapter over the unified
// result renderer: it serves the same page `/score/<binary>` serves, with
// the new canonical, until the path retires. These tests pin the adapter's
// dispatch, its twin, the curated redirect, and the 404 shapes.

import { beforeEach, describe, expect, test } from 'bun:test';
import { scorePath } from '../src/shared/audit-routes';
import { handleLegacyLiveScorePath, type ResultEnv } from '../src/worker/audit/result';
import { keyFor } from '../src/worker/score/cache';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import { _resetShellTemplateCache } from '../src/worker/shell-template';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';

const SHELL_TEMPLATE = `<!doctype html><html><head><title>{{TITLE}}</title><link rel="canonical" href="https://anc.dev{{CANONICAL_PATH}}" />
{{ALTERNATES}}
</head><body>{{BODY}}</body></html>`;

const SAMPLE_SCORECARD = {
  spec_version: SPEC_VERSION,
  tool: { name: 'cowsay', binary: 'cowsay', version: '3.8.4' },
  target: { kind: 'command', command: 'cowsay' },
  badge: { score_pct: 92, eligible: true, embed_markdown: '![badge](/badge/cowsay.svg)' },
  results: [
    { id: 'P3.1', group: 'P3', status: 'pass', label: 'Exit codes', evidence: 'ok' },
    { id: 'P4.1', group: 'P4', status: 'fail', label: 'JSON', evidence: 'no <b>--json</b> & more' },
  ],
};
const REGISTRY_INDEX = {
  by_slug: {
    ripgrep: {
      name: 'ripgrep',
      binary: 'rg',
      install: 'brew install ripgrep',
      anc_version: ANC_VERSION,
      scorecard_url: '/score/ripgrep',
    },
  },
  by_owner_repo: {},
};

function makeEnv(content: Record<string, unknown> = {}, opts: { failRegistry?: boolean } = {}): ResultEnv {
  const store = new Map(Object.entries(content).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    ASSETS: {
      async fetch(req: Request | string) {
        const path = new URL(typeof req === 'string' ? req : req.url).pathname;
        if (path === '/_internal/score-live-shell.html') return new Response(SHELL_TEMPLATE, { status: 200 });
        if (path === '/registry-index.json') {
          return opts.failRegistry
            ? new Response('down', { status: 500 })
            : new Response(JSON.stringify(REGISTRY_INDEX), { status: 200 });
        }
        if (path === '/_internal/web-seed.json') return new Response('[]', { status: 200 });
        return new Response('not found', { status: 404 });
      },
    } as Fetcher,
    SCORE_CACHE: {
      async get(key: string) {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return { json: async () => JSON.parse(raw), text: async () => raw };
      },
      async put() {},
      async delete() {},
      async list() {
        return { objects: [], truncated: false };
      },
    } as unknown as R2Bucket,
  };
}

const CACHED = {
  [keyFor('cowsay', SPEC_VERSION)]: {
    spec_version: SPEC_VERSION,
    anc_version: ANC_VERSION,
    tool_version: '3.8.4',
    scorecard: SAMPLE_SCORECARD,
  },
};

function get(path: string, init: RequestInit = {}): Request {
  return new Request(`https://anc.dev${path}`, init);
}

beforeEach(() => {
  _resetShellTemplateCache();
  _resetRegistryIndexCache();
});

describe('/score/live/<binary> adapter', () => {
  test('renders the unified page with the /score/<binary> canonical and both head alternates', async () => {
    const res = await handleLegacyLiveScorePath(get('/score/live/cowsay'), makeEnv(CACHED));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain(`<link rel="canonical" href="https://anc.dev${scorePath('cowsay')}"`);
    expect(html).toContain('href="/score/cowsay/md"');
    expect(html).toContain('href="/score/cowsay/json"');
    expect(html).toContain('stpill--fail');
    expect(html).toContain('data-reaudit');
  });

  test('escapes evidence and tool fields on the page', async () => {
    const html = await (await handleLegacyLiveScorePath(get('/score/live/cowsay'), makeEnv(CACHED))).text();
    expect(html).toContain('no &lt;b&gt;--json&lt;/b&gt; &amp; more');
    expect(html).not.toContain('<b>--json</b>');
  });

  test('the .md suffix serves the twin and HEAD answers like GET', async () => {
    const md = await handleLegacyLiveScorePath(get('/score/live/cowsay.md'), makeEnv(CACHED));
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(await md.text()).toContain('# cowsay');
    const head = await handleLegacyLiveScorePath(get('/score/live/cowsay', { method: 'HEAD' }), makeEnv(CACHED));
    expect(head.status).toBe(200);
  });

  test('a curated binary or slug redirects to its /score/<slug> page, twin included', async () => {
    for (const [path, target] of [
      ['/score/live/rg', '/score/ripgrep'],
      ['/score/live/rg.md', '/score/ripgrep/md'],
    ]) {
      const res = await handleLegacyLiveScorePath(get(path), makeEnv(CACHED));
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(target);
    }
  });

  test('the .html form redirects to the bare /score/<binary>', async () => {
    const res = await handleLegacyLiveScorePath(get('/score/live/cowsay.html'), makeEnv(CACHED));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/score/cowsay');
  });

  test('a missing record is the 404 pointer in HTML and markdown, with no raw input as markup', async () => {
    const html = await handleLegacyLiveScorePath(get('/score/live/nosuchtool'), makeEnv());
    expect(html.status).toBe(404);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(await html.text()).toContain('/audit?lane=cli&amp;target=nosuchtool');
    const md = await handleLegacyLiveScorePath(get('/score/live/nosuchtool.md'), makeEnv());
    expect(md.status).toBe(404);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    const hostile = await handleLegacyLiveScorePath(get('/score/live/%3Cscript%3E'), makeEnv());
    expect(hostile.status).toBe(404);
    expect(await hostile.text()).not.toContain('<script>');
  });

  test('a non-GET method is 405 and a shell outage is a plain 500', async () => {
    const post = await handleLegacyLiveScorePath(get('/score/live/cowsay', { method: 'POST' }), makeEnv(CACHED));
    expect(post.status).toBe(405);
    const env = makeEnv(CACHED);
    env.ASSETS = {
      async fetch(req: Request | string) {
        const path = new URL(typeof req === 'string' ? req : req.url).pathname;
        if (path === '/registry-index.json') return new Response(JSON.stringify(REGISTRY_INDEX), { status: 200 });
        return new Response('gone', { status: 404 });
      },
    } as Fetcher;
    const res = await handleLegacyLiveScorePath(get('/score/live/cowsay'), env);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });
});
