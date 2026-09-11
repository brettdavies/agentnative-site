// GET /score/<target>, /md, and /json: one route serves curated, live CLI,
// branch-scoped, and website results in three representations from one
// envelope. These tests drive the route against stubbed bindings and pin
// the dispatch order, the canonicalization, the lane-aware 404, the
// representation headers, and the spine every page shares.

import { beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import { buildWebEnvelope } from '../src/shared/audit-envelope';
import { scoreJsonPath, scoreMarkdownPath, scorePath } from '../src/shared/audit-routes';
import {
  _resetResultCaches,
  handleLegacyLiveScorePath,
  handleLegacyWebResultPath,
  handleResultRoute,
  type ResultEnv,
} from '../src/worker/audit/result';
import { keyFor as webKeyFor } from '../src/worker/audit-web/cache';
import { keyFor as cliKeyFor } from '../src/worker/score/cache';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import { _resetShellTemplateCache } from '../src/worker/shell-template';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';
import { captureLogs } from './helpers/log-capture';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const ORIGIN = 'https://anc.dev';

let registryJsonPromise: Promise<string> | null = null;
async function webRegistryJson(): Promise<string> {
  if (!registryJsonPromise) {
    registryJsonPromise = (async () => {
      const raw = await readFile(join(REPO_ROOT, 'src', 'data', 'web-audit', 'registry.yaml'), 'utf8');
      return JSON.stringify(normalizeWebAuditRegistry(yaml.load(raw) as object));
    })();
  }
  return registryJsonPromise;
}

const SHELL_TEMPLATE = `<!doctype html><html><head><title>{{TITLE}}</title><meta name="description" content="{{DESCRIPTION}}" /><link rel="canonical" href="https://anc.dev{{CANONICAL_PATH}}" />
    {{ALTERNATES}}
</head><body><main>{{BODY}}</main><footer><a href="{{MARKDOWN_TWIN_PATH}}">This page as markdown</a></footer></body></html>`;

const REGISTRY_INDEX = {
  by_slug: {
    ripgrep: {
      name: 'ripgrep',
      binary: 'rg',
      install: 'brew install ripgrep',
      repo: 'BurntSushi/ripgrep',
      version: '15.1.0',
      anc_version: ANC_VERSION,
      scorecard_url: '/score/ripgrep',
      score_pct: 92,
    },
    bare: { name: 'bare', binary: 'bare', install: 'brew install bare' },
  },
  by_owner_repo: {},
};

const CURATED_SCORECARD = {
  spec_version: SPEC_VERSION,
  tool: { name: 'ripgrep', binary: 'rg', version: '15.1.0' },
  badge: { score_pct: 92, eligible: true, embed_markdown: '![badge](/badge/ripgrep.svg)' },
  results: [],
};
const CURATED_HTML = `<!doctype html><html><head><title>ripgrep</title>
    <link rel="alternate" type="text/markdown" href="/score/ripgrep/md" title="This page as markdown" />
    <link rel="alternate" type="application/json" href="/score/ripgrep/json" title="This result as JSON" />
</head><body><article class="scorecard-page">curated ripgrep page</article></body></html>`;
const CURATED_MD = '# ripgrep\n\ncurated twin\n';
const CURATED_JSON = JSON.stringify({
  kind: 'cli',
  tier: 'registry',
  target: 'ripgrep',
  scorecard_url: 'https://anc.dev/score/ripgrep',
  markdown_url: 'https://anc.dev/score/ripgrep/md',
  json_url: 'https://anc.dev/score/ripgrep/json',
  freshness: { cached: true, scored_at: null, refresh_after: null },
  spec_version: SPEC_VERSION,
  scorecard: CURATED_SCORECARD,
  score_pct: 92,
  anc_version: ANC_VERSION,
  tool_version: '15.1.0',
});

const CLI_RECORD = {
  spec_version: SPEC_VERSION,
  anc_version: ANC_VERSION,
  tool_version: '0.5.0',
  scored_at: '2026-09-10T20:00:00.000Z',
  scorecard: {
    spec_version: SPEC_VERSION,
    tool: { name: 'ouch', binary: 'ouch', version: '0.5.0' },
    badge: { score_pct: 71, eligible: true, embed_markdown: '![badge](/badge/ouch.svg)' },
    results: [
      { id: 'P1.1', group: 'P1', status: 'pass', label: 'Has --help', evidence: 'ok' },
      { id: 'P2.1', group: 'P2', status: 'fail', label: 'JSON output', evidence: 'no --json flag' },
    ],
  },
};
const BRANCH_RECORD = {
  ...CLI_RECORD,
  source_sha: 'abcdef1234567890abcdef1234567890abcdef12',
  scorecard: { ...CLI_RECORD.scorecard, tool: { name: 'r', binary: 'r', version: '0.0.0' } },
};
const WEB_RECORD = {
  spec_version: SPEC_VERSION,
  target_url: 'https://anc.dev/',
  scored_at: '2026-09-10T20:00:00.000Z',
  scorecard: {
    target_url: 'https://anc.dev/',
    score_pct: 64,
    score: { relative: 82, global: 64 },
    results: [
      { id: 'llms-txt', status: 'pass', label: 'llms.txt', result: 'served', evidence: '200' },
      { id: 'openapi', status: 'absent', label: 'OpenAPI', result: 'missing', evidence: '404' },
    ],
  },
};

type Overrides = Partial<{
  cache: Record<string, unknown>;
  kvSeed: Record<string, string>;
  assets: Record<string, string>;
  failRegistry: boolean;
  aggregate: unknown;
  sitekey: string;
  seed: unknown[];
  now: number;
}>;

type TestEnv = ResultEnv & { _r2Gets: string[]; _assetGets: string[]; _aggregateReads: number };

async function makeEnv(overrides: Overrides = {}): Promise<TestEnv> {
  const cacheStore = new Map<string, string>();
  for (const [k, v] of Object.entries(overrides.cache ?? {})) cacheStore.set(k, JSON.stringify(v));
  const kvStore = new Map(Object.entries(overrides.kvSeed ?? {}));
  const r2Gets: string[] = [];
  const assetGets: string[] = [];
  const registryJson = await webRegistryJson();
  const aggregateKey = `audits/web/leaderboard/${SPEC_VERSION}.json`;
  const env = {
    _r2Gets: r2Gets,
    _assetGets: assetGets,
    _aggregateReads: 0,
    ASSETS: {
      async fetch(req: Request | string): Promise<Response> {
        const path = new URL(typeof req === 'string' ? req : req.url).pathname;
        const manual = typeof req !== 'string' && req.redirect === 'manual';
        assetGets.push(path);
        const assets: Record<string, string> = {
          '/_internal/score-live-shell.html': SHELL_TEMPLATE,
          '/_internal/web-audit-registry.json': registryJson,
          '/_internal/web-seed.json': JSON.stringify(
            overrides.seed ?? [
              { domain: 'seeded.dev', url: 'https://seeded.dev/', name: 'Seeded', description: 'seeded' },
            ],
          ),
          '/_internal/web-remediation.json': '{}',
          '/discovery-hints-index.json': JSON.stringify({ by_owner_repo: {} }),
          '/score/ripgrep.html': CURATED_HTML,
          '/score/ripgrep.md': CURATED_MD,
          '/score/ripgrep.json': CURATED_JSON,
          ...(overrides.assets ?? {}),
        };
        if (path === '/registry-index.json') {
          if (overrides.failRegistry) return new Response('down', { status: 500 });
          return new Response(JSON.stringify(REGISTRY_INDEX), { status: 200 });
        }
        // Mirrors `html_handling: auto-trailing-slash`: `/x` serves `x.html`
        // and `/x.html` answers a 307 to `/x`, which fetch follows.
        if (path.endsWith('.html') && assets[path] !== undefined) {
          const location = path.slice(0, -'.html'.length);
          if (manual) return new Response(null, { status: 307, headers: { location } });
          return env.ASSETS.fetch(`https://assets.internal${location}`);
        }
        const body = assets[path] ?? assets[`${path}.html`];
        if (body === undefined) return new Response('<html>not found page</html>', { status: 404 });
        return new Response(body, { status: 200 });
      },
    } as Fetcher,
    SCORE_CACHE: {
      async get(key: string) {
        r2Gets.push(key);
        if (key === aggregateKey) {
          env._aggregateReads += 1;
          if (overrides.aggregate === undefined) return null;
          const raw = JSON.stringify(overrides.aggregate);
          return { json: async () => JSON.parse(raw), text: async () => raw };
        }
        const raw = cacheStore.get(key);
        if (raw === undefined) return null;
        return { json: async () => JSON.parse(raw), text: async () => raw };
      },
      async put() {},
      async delete() {},
      async list() {
        return { objects: [], truncated: false };
      },
    } as unknown as R2Bucket,
    SCORE_KV: {
      async get(key: string) {
        return kvStore.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kvStore.set(key, value);
      },
      async delete(key: string) {
        kvStore.delete(key);
      },
    } as unknown as KVNamespace,
    TURNSTILE_SITEKEY: overrides.sitekey ?? '1x00000000000000000000AA',
  } as TestEnv;
  return env;
}

async function seededEnv(overrides: Overrides = {}): Promise<TestEnv> {
  return makeEnv({
    cache: {
      [cliKeyFor('ouch', SPEC_VERSION)]: CLI_RECORD,
      [cliKeyFor('o/r@feature', SPEC_VERSION)]: BRANCH_RECORD,
      [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: WEB_RECORD,
    },
    ...overrides,
  });
}

function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(`${ORIGIN}${path}`, { method, headers });
}

async function route(path: string, env: TestEnv, headers: Record<string, string> = {}, method = 'GET') {
  return handleResultRoute(get(path, headers, method), env, { now: () => Date.parse('2026-09-10T20:00:30.000Z') });
}

async function routeAt(path: string, env: TestEnv, nowIso: string) {
  return handleResultRoute(get(path), env, { now: () => Date.parse(nowIso) });
}

function headLinks(html: string): string[] {
  return [...html.matchAll(/<link rel="alternate" type="([^"]+)" href="([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
}

beforeEach(() => {
  _resetRegistryIndexCache();
  _resetShellTemplateCache();
  _resetResultCaches();
});

describe('curated slugs (registry first)', () => {
  test('/score/ripgrep, /md, and /json serve from the asset; /score/rg/json 301s to /score/ripgrep/json', async () => {
    const env = await seededEnv();
    const html = await route('/score/ripgrep', env);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(await html.text()).toContain('curated ripgrep page');
    const md = await route('/score/ripgrep/md', env);
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(md.headers.get('vary')).toBeNull();
    expect(await md.text()).toContain('curated twin');
    const json = await route('/score/ripgrep/json', env);
    expect(json.status).toBe(200);
    expect(json.headers.get('content-type')).toContain('application/json');
    const body = (await json.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'cli', tier: 'registry', target: 'ripgrep', score_pct: 92 });
    expect(body.scorecard_url).toBe(`${ORIGIN}${scorePath('ripgrep')}`);
    expect(body.json_url).toBe(`${ORIGIN}${scoreJsonPath('ripgrep')}`);
    expect(env._r2Gets).toEqual([]);
    for (const [path, target] of [
      ['/score/rg/json', '/score/ripgrep/json'],
      ['/score/rg/md', '/score/ripgrep/md'],
      ['/score/rg', '/score/ripgrep'],
    ]) {
      const res = await route(path, env);
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(target);
    }
  });

  test('the curated HTML fetch asks the binding for the extensionless page, so no html_handling redirect hop is taken', async () => {
    const env = await seededEnv();
    const res = await route('/score/ripgrep', env);
    expect(res.status).toBe(200);
    expect(env._assetGets.filter((p) => p.startsWith('/score/'))).toEqual(['/score/ripgrep']);
  });

  test('a curated slug whose asset fetch returns the 404 page is not treated as a hit', async () => {
    const env = await seededEnv({ assets: { '/score/ripgrep.html': undefined as unknown as string } });
    const res = await route('/score/ripgrep', env);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('not found page');
  });

  test('a registry entry without a committed scorecard is not a curated hit and a metadata-only slug resolves like a live target', async () => {
    const env = await seededEnv();
    const res = await route('/score/bare', env);
    expect(res.status).toBe(404);
    expect(env._assetGets.some((p) => p.startsWith('/score/bare'))).toBe(false);
  });

  test('when the registry index cannot be loaded a CLI-shaped target answers 503 with Retry-After in all three representations', async () => {
    const env = await seededEnv({ failRegistry: true });
    for (const path of ['/score/ouch', '/score/ouch/md', '/score/ouch/json']) {
      const res = await route(path, env);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('30');
    }
    const web = await route('/score/anc.dev', env);
    expect(web.status).toBe(200);
  });
});

describe('live and branch records', () => {
  test('/score/ouch with an R2 record renders HTML, the twin, and JSON whose scorecard equals the record', async () => {
    const env = await seededEnv();
    const html = await route('/score/ouch', env);
    expect(html.status).toBe(200);
    expect(html.headers.get('x-robots-tag')).toBe('noindex');
    const page = await html.text();
    expect(page).toContain('ouch');
    expect(page).toContain('class="crumb"');
    expect(page).toContain('data-reaudit');
    const md = await route('/score/ouch/md', env);
    expect(md.status).toBe(200);
    expect(await md.text()).toContain('# ouch');
    const json = await route('/score/ouch/json', env);
    expect(json.status).toBe(200);
    const body = (await json.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'cli', tier: 'cache', target: 'ouch' });
    expect(body.scorecard).toEqual(CLI_RECORD.scorecard);
    expect(body.markdown_url).toBe(`${ORIGIN}${scoreMarkdownPath('ouch')}`);
    expect(Object.keys(body).sort()).toEqual(
      [
        'anc_version',
        'auditor_url',
        'freshness',
        'json_url',
        'kind',
        'markdown_url',
        'score_pct',
        'scorecard',
        'scorecard_url',
        'site_spec_version',
        'spec_version',
        'target',
        'tier',
        'tool_version',
      ].sort(),
    );
  });

  test('/score/o/r@feature renders HTML, the twin, and JSON, all noindex; /score/o/r with no record is the 404 pointer', async () => {
    const env = await seededEnv();
    for (const path of ['/score/o/r@feature', '/score/o/r@feature/md', '/score/o/r@feature/json']) {
      const res = await route(path, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
    }
    const json = (await (await route('/score/o/r@feature/json', env)).json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      kind: 'cli',
      tier: 'cache',
      target: 'o/r@feature',
      source_sha: BRANCH_RECORD.source_sha,
    });
    const missing = await route('/score/o/r', env);
    expect(missing.status).toBe(404);
    const body = await missing.text();
    expect(body).toContain('/audit?lane=cli&amp;target=o/r');
  });

  test("a branch page's meta line names the short source_sha and carries the enabled Re-audit control", async () => {
    const env = await seededEnv();
    const page = await (await route('/score/o/r@feature', env)).text();
    expect(page).toContain('abcdef1');
    expect(page).toMatch(
      /<button[^>]*data-reaudit[^>]*data-target="o\/r@feature"[^>]*data-lane="cli"[^>]*data-refresh="1"/,
    );
    expect(page).not.toMatch(/data-reaudit[^>]*aria-disabled/);
    expect(page).toContain('Re-audit runs a fresh audit.');
  });
});

describe('website records', () => {
  test('/score/anc.dev/json equals the website envelope for the same record; an unseeded host is noindex and a seeded one is not', async () => {
    const env = await seededEnv();
    const res = await route('/score/anc.dev/json', env);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    const seededRecord = await seededEnv({
      cache: {
        [await webKeyFor('https://seeded.dev/', SPEC_VERSION)]: { ...WEB_RECORD, target_url: 'https://seeded.dev/' },
      },
    });
    expect((await route('/score/seeded.dev', seededRecord)).headers.get('x-robots-tag')).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    const expected = buildWebEnvelope({ tier: 'cache', target: 'anc.dev', record: WEB_RECORD, origin: ORIGIN });
    expect(body.scorecard).toEqual(expected.scorecard);
    expect(body.freshness).toEqual(expected.freshness);
    expect(body).toMatchObject({ kind: 'web', tier: 'cache', target: 'anc.dev', score_pct: 64 });
  });

  test('/score/anc.dev.html and /score/anc.dev/ canonicalize to /score/anc.dev without reaching the assets binding', async () => {
    const env = await seededEnv();
    for (const path of ['/score/anc.dev.html', '/score/anc.dev/', '/score/anc.dev/md/']) {
      const res = await route(path, env);
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(path.includes('/md') ? '/score/anc.dev/md' : '/score/anc.dev');
    }
    expect(env._assetGets).toEqual([]);
  });

  test('a website result page carries the Re-audit control with refresh_after and the sitekey meta; a curated page carries none', async () => {
    const env = await seededEnv();
    const page = await (await route('/score/anc.dev', env)).text();
    expect(page).toMatch(
      /<button[^>]*class="btn btn--ghost reaudit"[^>]*data-reaudit[^>]*data-target="anc.dev"[^>]*data-lane="web"[^>]*data-refresh-after="2026-09-10T20:01:00.000Z"[^>]*aria-disabled="true"/,
    );
    expect(page).toMatch(/data-reaudit-countdown aria-hidden="true">\s*in 30 s</);
    expect(page).not.toMatch(/data-reaudit[^>]*\sdisabled/);
    expect(page).toContain('<meta name="turnstile-sitekey" content="1x00000000000000000000AA"');
    expect(page).toContain('/js/reaudit.js');
    expect(page).toContain('site score');
    expect(page).toContain('data-web-audit-context');
    expect(page).toMatch(/class="pscore__row[^"]*"[^>]*>\s*<span class="spec__id">C1<\/span>/);
    const curated = await (await route('/score/ripgrep', env)).text();
    expect(curated).not.toContain('data-reaudit');
    expect(curated).not.toContain('turnstile-sitekey');
  });

  test('a live CLI page carries the enabled control with data-refresh and states the scored version', async () => {
    const env = await seededEnv();
    const page = await (await route('/score/ouch', env)).text();
    expect(page).toMatch(/<button[^>]*data-reaudit[^>]*data-target="ouch"[^>]*data-lane="cli"[^>]*data-refresh="1"/);
    expect(page).not.toMatch(/data-reaudit[^>]*aria-disabled/);
    expect(page).toContain('Scored v0.5.0 on 2026-09-10');
    expect(page).toContain('Re-audit runs a fresh audit.');
  });

  test('/score/anc.dev?v=123 renders the same body as the bare URL with no-store and no Cache-Tag', async () => {
    const env = await seededEnv();
    const bare = await (await route('/score/anc.dev', env)).text();
    const versioned = await route('/score/anc.dev?v=123', env);
    expect(versioned.status).toBe(200);
    expect(await versioned.text()).toBe(bare);
    expect(versioned.headers.get('cache-control')).toBe('no-store');
    expect(versioned.headers.get('cache-tag')).toBeNull();
  });
});

describe('404 bodies', () => {
  test('never-audited targets answer the lane-appropriate 404 in all three representations; /json carries only code, message, audit_url, suggestions', async () => {
    const env = await seededEnv();
    const cliHtml = await route('/score/nosuchtool', env);
    expect(cliHtml.status).toBe(404);
    const cliBody = await cliHtml.text();
    expect(cliBody).toContain('No audit exists for <code>nosuchtool</code> yet.');
    expect(cliBody).toContain('href="/audit?lane=cli&amp;target=nosuchtool"');
    expect(cliBody).not.toContain('<form');
    expect(cliBody).not.toContain('turnstile-sitekey');
    expect(cliBody).not.toContain('/js/reaudit.js');
    const cliMd = await route('/score/nosuchtool/md', env);
    expect(cliMd.status).toBe(404);
    expect(await cliMd.text()).toContain('No audit exists for `nosuchtool` yet.');
    const webJson = await route('/score/nosuch.example/json', env);
    expect(webJson.status).toBe(404);
    const body = (await webJson.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['audit_url', 'error', 'suggestions']);
    expect(body.error).toEqual({ code: 'not_found', message: expect.any(String) });
    expect(body.audit_url).toBe(`${ORIGIN}/audit?lane=web&target=nosuch.example`);
    expect(webJson.headers.get('cache-control')).toBe('no-store');
  });

  test('/score/ripgrpe lists ripgrep under Did you mean in HTML, the twin, and suggestions', async () => {
    const env = await seededEnv();
    const html = await (await route('/score/ripgrpe', env)).text();
    expect(html).toContain('Did you mean?');
    expect(html).toContain(`href="${scorePath('ripgrep')}"`);
    const md = await (await route('/score/ripgrpe/md', env)).text();
    expect(md).toContain('Did you mean?');
    expect(md).toContain(`(${ORIGIN}${scorePath('ripgrep')})`);
    const json = (await (await route('/score/ripgrpe/json', env)).json()) as {
      suggestions: Array<{ target: string; scorecard_url: string }>;
    };
    expect(json.suggestions).toEqual([{ target: 'ripgrep', scorecard_url: `${ORIGIN}${scorePath('ripgrep')}` }]);
  });

  test('a host-shaped 404 suggests seeded and listed hosts, reads the aggregate once per minute, and degrades to seed-only with one log line when the aggregate is null', async () => {
    const listed = await seededEnv({
      aggregate: {
        spec_version: SPEC_VERSION,
        generated_at: '2026-09-10T00:00:00.000Z',
        entries: [
          {
            domain: 'listed.dev',
            url: 'https://listed.dev/',
            name: 'Listed',
            description: '',
            score_pct: 50,
            score: { relative: 50, global: 50 },
          },
        ],
      },
    });
    const first = (await (await route('/score/listed.dv/json', listed)).json()) as {
      suggestions: Array<{ target: string }>;
    };
    expect(first.suggestions.map((s) => s.target)).toEqual(['listed.dev']);
    await route('/score/seeded.de/json', listed);
    expect(listed._aggregateReads).toBe(1);

    _resetResultCaches();
    const seen = captureLogs();
    let bare: TestEnv;
    try {
      bare = await seededEnv();
      const res = await route('/score/seeded.de/json', bare);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { suggestions: Array<{ target: string }> };
      expect(body.suggestions.map((s) => s.target)).toEqual(['seeded.dev']);
      await route('/score/seeded.de/json', bare);
    } finally {
      seen.restore();
    }
    expect(seen.records.filter((r) => r.record.scope === 'audit.result')).toHaveLength(1);
  });

  test('a target containing a reserved name or a reserved representation is not treated as a result', async () => {
    const env = await seededEnv();
    for (const path of ['/score/api', '/score/scoring/json', '/score/anc.dev/html', '/score/o/r@md/json']) {
      const res = await route(path, env);
      expect(res.status).toBe(404);
    }
    expect(env._r2Gets).toEqual([]);
  });

  test('/score/defuddle.md is looked up as the host defuddle.md, never as a twin of /score/defuddle', async () => {
    const env = await seededEnv({ cache: { [await webKeyFor('https://defuddle.md/', SPEC_VERSION)]: WEB_RECORD } });
    const res = await route('/score/defuddle.md', env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(env._r2Gets).toContain(await webKeyFor('https://defuddle.md/', SPEC_VERSION));
  });
});

describe('representations and headers', () => {
  test('Accept: application/json on the bare path returns the envelope with Vary; text/markdown the twin; /json is pinned with no Vary', async () => {
    const env = await seededEnv();
    const json = await route('/score/ripgrep', env, { accept: 'application/json' });
    expect(json.headers.get('content-type')).toContain('application/json');
    expect(json.headers.get('vary')).toBe('Accept, User-Agent');
    expect(((await json.json()) as { tier: string }).tier).toBe('registry');
    const md = await route('/score/ripgrep', env, { accept: 'text/markdown' });
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(md.headers.get('vary')).toBe('Accept, User-Agent');
    const pinned = await route('/score/ripgrep/json', env, { accept: 'text/html' });
    expect(pinned.headers.get('content-type')).toContain('application/json');
    expect(pinned.headers.get('vary')).toBeNull();
    expect(pinned.headers.get('access-control-allow-origin')).toBe('*');
    const live = await route('/score/ouch', env, { accept: 'application/json' });
    expect(live.headers.get('content-type')).toContain('application/json');
    expect(((await live.json()) as { target: string }).target).toBe('ouch');
  });

  test('a /json request carrying a session cookie receives no Set-Cookie and no Vary', async () => {
    const env = await seededEnv();
    const res = await route('/score/anc.dev/json', env, { cookie: '__Host-anc-session=abc' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('vary')).toBeNull();
  });

  test('while the in-flight flag exists, /json answers 202 no-store with in_progress and started_at and performs no R2 read', async () => {
    const started = '2026-09-10T20:00:00.000Z';
    const env = await seededEnv({
      kvSeed: {
        'inflight:web:anc.dev': JSON.stringify({ started_at: started }),
        'inflight:cli:ouch': JSON.stringify({ started_at: started }),
      },
    });
    for (const path of ['/score/anc.dev/json', '/score/ouch/json']) {
      const res = await route(path, env);
      expect(res.status).toBe(202);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect((await res.json()) as Record<string, unknown>).toEqual({ in_progress: true, started_at: started });
    }
    expect(env._r2Gets).toEqual([]);
  });

  test('the head of every result page carries both alternates equal to the route builders and the twin names both URLs and the Accept values', async () => {
    const env = await seededEnv();
    for (const target of ['ripgrep', 'ouch', 'anc.dev', 'o/r@feature']) {
      const html = await (await route(scorePath(target), env)).text();
      expect(headLinks(html)).toEqual([
        `text/markdown ${scoreMarkdownPath(target)}`,
        `application/json ${scoreJsonPath(target)}`,
      ]);
      expect(html).not.toContain('{{ALTERNATES}}');
      if (target === 'ripgrep') continue;
      const md = await (await route(scoreMarkdownPath(target), env)).text();
      expect(md).toContain(`${ORIGIN}${scoreMarkdownPath(target)}`);
      expect(md).toContain(`${ORIGIN}${scoreJsonPath(target)}`);
      expect(md).toContain('Accept: application/json');
      expect(md).toContain('Accept: text/markdown');
    }
  });

  test('a non-GET method is 405 with Allow', async () => {
    const env = await seededEnv();
    const res = await route('/score/ouch', env, {}, 'POST');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('legacy paths served through the unified renderer', () => {
  test('/score/live/ouch renders the /score/ouch page with the canonical /score/ouch and the same body; a curated binary 301s to its slug', async () => {
    const env = await seededEnv();
    const legacy = await handleLegacyLiveScorePath(get('/score/live/ouch'), env);
    expect(legacy.status).toBe(200);
    const legacyBody = await legacy.text();
    const unified = await (await route('/score/ouch', env)).text();
    expect(legacyBody).toBe(unified);
    expect(legacyBody).toContain('<link rel="canonical" href="https://anc.dev/score/ouch"');
    const twin = await handleLegacyLiveScorePath(get('/score/live/ouch.md'), env);
    expect(twin.headers.get('content-type')).toContain('text/markdown');
    const alias = await handleLegacyLiveScorePath(get('/score/live/rg.md'), env);
    expect(alias.status).toBe(301);
    expect(alias.headers.get('location')).toBe('/score/ripgrep/md');
  });

  test('/web/anc.dev and its twin render the website result; an unknown domain is the 404 pointer', async () => {
    const env = await seededEnv();
    const page = await handleLegacyWebResultPath(get('/web/anc.dev'), env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('site score');
    const twin = await handleLegacyWebResultPath(get('/web/anc.dev.md'), env);
    expect(twin.headers.get('content-type')).toContain('text/markdown');
    const missing = await handleLegacyWebResultPath(get('/web/nosuch.example'), env);
    expect(missing.status).toBe(404);
  });
});

describe('review pins', () => {
  test('the registry-outage 503 goes through the header policy: JSON carries CORS and no-store', async () => {
    const env = await seededEnv({ failRegistry: true });
    const res = await route('/score/ouch/json', env);
    expect(res.status).toBe(503);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('retry-after')).toBe('30');
  });

  test('a legacy .html form for a reserved or unroutable target is a 404, never a throw', async () => {
    const env = await seededEnv();
    for (const path of ['/web/scoring.html', '/web/api.html']) {
      const res = await handleLegacyWebResultPath(get(path), env);
      expect(res.status).toBe(404);
    }
    for (const path of ['/score/live/api.html', '/score/live/foo%2Fjson.html', '/score/live/scoring.html']) {
      const res = await handleLegacyLiveScorePath(get(path), env);
      expect(res.status).toBe(404);
    }
  });

  test('a 404 for a rejected target honors Accept on the bare path', async () => {
    const env = await seededEnv();
    for (const path of ['/score/api', '/score/anc.dev/html']) {
      const res = await route(path, env, { accept: 'application/json' });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    }
    const md = await route('/score/api', env, { accept: 'text/markdown' });
    expect(md.headers.get('content-type')).toContain('text/markdown');
  });

  test('the footer twin on a result page and on its 404 is the /md segment, and a legacy 404 keeps its .md twin', async () => {
    const env = await seededEnv();
    const page = await (await route('/score/ouch', env)).text();
    expect(page).toContain(`<a href="${scoreMarkdownPath('ouch')}">This page as markdown</a>`);
    const missing = await (await route('/score/nosuchtool', env)).text();
    expect(missing).toContain('<a href="/score/nosuchtool/md">This page as markdown</a>');
    const legacy = await (await handleLegacyWebResultPath(get('/web/nosuch.example'), env)).text();
    expect(legacy).toContain('<a href="/web/nosuch.example.md">This page as markdown</a>');
  });

  test('a non-canonical target form redirects to its canonical page', async () => {
    const env = await seededEnv();
    const res = await route('/score/ANC.dev', env);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/score/anc.dev');
    expect(env._r2Gets).toEqual([]);
  });

  test('a website control past refresh_after renders enabled with no countdown', async () => {
    const env = await seededEnv();
    const page = await (await routeAt('/score/anc.dev', env, '2026-09-10T20:05:00.000Z')).text();
    expect(page).toMatch(
      /<button[^>]*data-reaudit[^>]*data-refresh-after="2026-09-10T20:01:00.000Z"[^>]*>Re-audit<\/button>/,
    );
    expect(page).not.toMatch(/data-reaudit[^>]*aria-disabled/);
    expect(page).not.toContain('data-reaudit-countdown');
    expect(page).toContain('data-reaudit-status');
  });

  test('a shell outage on the 404 path is a plain 500', async () => {
    const env = await seededEnv({ assets: { '/_internal/score-live-shell.html': undefined as unknown as string } });
    const res = await route('/score/nosuchtool', env);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  test('a degraded host-candidate list is memoized only briefly; a healthy one for the full minute', async () => {
    const bare = await seededEnv();
    await routeAt('/score/seeded.de/json', bare, '2026-09-10T20:00:00.000Z');
    await routeAt('/score/seeded.de/json', bare, '2026-09-10T20:00:05.000Z');
    expect(bare._aggregateReads).toBe(1);
    await routeAt('/score/seeded.de/json', bare, '2026-09-10T20:00:20.000Z');
    expect(bare._aggregateReads).toBe(2);
    _resetResultCaches();
    const listed = await seededEnv({
      aggregate: {
        spec_version: SPEC_VERSION,
        generated_at: '2026-09-10T00:00:00.000Z',
        entries: [
          {
            domain: 'listed.dev',
            url: 'https://listed.dev/',
            name: 'Listed',
            description: '',
            score_pct: 50,
            score: { relative: 50, global: 50 },
          },
        ],
      },
    });
    await routeAt('/score/listed.dv/json', listed, '2026-09-10T20:00:00.000Z');
    await routeAt('/score/listed.dv/json', listed, '2026-09-10T20:00:40.000Z');
    expect(listed._aggregateReads).toBe(1);
  });

  test('a hostile target is escaped everywhere the 404 page repeats it', async () => {
    const env = await seededEnv();
    let res = await route('/score/x%22%3E%3Cimg%20src=x%20onerror=1%3E', env);
    if (res.status === 301) {
      const location = res.headers.get('location') ?? '';
      expect(location).not.toContain('<');
      res = await route(location, env);
    }
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror=1>');
    expect(html).toContain('&lt;img');
  });
});
