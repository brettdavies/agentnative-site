// Every surface that mints a link must mint it on the origin it was
// served from, so an agent following the link stays on the deployment it
// is talking to.
//
// A deployment that hands out links to a different deployment is not a
// broken link — it is a silent redirect out of the environment, and both
// surfaces still look correct in isolation. It surfaced as one audit row
// whose fix-skill link pointed at the production host in an MCP result
// and at the staging host on the staging page.
//
// A grep for stray host literals would not have caught it: the offending
// module had a tidy `const SITE_URL = 'https://anc.dev'` at the top. Only
// serving a surface on a deliberately non-canonical origin and looking at
// what comes back does.
//
// Two rules for tests in this file:
//
//   1. Serve on NON_CANONICAL_ORIGIN, never the canonical host. The
//      shared mcpRpc helper defaults to `https://anc.dev`, which is
//      exactly why the pre-existing suite stayed green over a broken
//      path — a test that only exercises the canonical origin proves
//      nothing here.
//   2. Assert against the WHOLE serialized response, not one field, so a
//      URL nobody thought to check still trips the guard.

import { beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { buildSitemap } from '../src/build/10-sitemap.mjs';
import { normalizeWebAuditRegistry, normalizeWebRemediation } from '../src/build/13-web-audit-registry.mjs';
import { buildLlmsIndex } from '../src/build/llms.mjs';
import { emitShell } from '../src/build/shell.mjs';
import { absolutifyMarkdownLinks, canonicalBaseUrl, composeTwin, resolveBaseUrl } from '../src/build/util.mjs';
import { toolsFor } from '../src/client/webmcp-lib';
import { CANONICAL_SITE_URL } from '../src/shared/site-url';
import { keyFor as webKeyFor } from '../src/worker/audit-web/cache';
import { resetWebAuditRegistryCacheForTests } from '../src/worker/audit-web/registry';
import {
  handleWebAudit,
  handleWebResultPage,
  handleWebScoringPage,
  type WebAuditRouteEnv,
} from '../src/worker/audit-web/route';
import { resetWebRemediationCacheForTests } from '../src/worker/mcp/tools/web-remediation';
import { keyFor as scoreKeyFor } from '../src/worker/score/cache';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import { _resetShellTemplateCache, handleLiveScorePage } from '../src/worker/score/summary-render';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';
import {
  getJsonToolContent,
  type JsonRpcBody,
  mcpInitialize,
  mcpRpc,
  resetMcpTestState,
  STAGING_TEST_ORIGIN,
} from './helpers/mcp-rpc';

const NON_CANONICAL_ORIGIN = STAGING_TEST_ORIGIN;
const REPO_ROOT = new URL('..', import.meta.url).pathname;
const WEB_AUDIT_DATA = join(REPO_ROOT, 'src', 'data', 'web-audit');

/**
 * The core assertion. `serialized` is the entire response — body plus
 * anything else the surface emits — so a URL this file never names by
 * hand still fails the test.
 *
 * The positive half matters as much as the negative: a surface that
 * emitted no URLs at all would pass a bare "no anc.dev" check.
 */
function expectServedOnOwnOrigin(serialized: string, origin: string = NON_CANONICAL_ORIGIN): void {
  expect(serialized).not.toContain(`https://${new URL(CANONICAL_SITE_URL).host}`);
  expect(serialized).toContain(origin);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MCP_FIXTURE_CATALOG = {
  generated_at: '2026-08-28T00:00:00.000Z',
  spec_version: SPEC_VERSION,
  registry: [
    {
      slug: 'ripgrep',
      name: 'ripgrep',
      binary: 'rg',
      install: 'brew install ripgrep',
      version: '14.1.1',
      anc_version: ANC_VERSION,
      scorecard_url: '/score/ripgrep',
      score_pct: 85,
      repo: 'BurntSushi/ripgrep',
    },
  ],
  principles: [],
  spec_sections: [],
};

const LIVE_SCORECARD = {
  schema_version: '0.5',
  spec_version: SPEC_VERSION,
  tool: { name: 'cowsay', binary: 'cowsay', version: '3.8.4' },
  target: { kind: 'command', command: 'cowsay' },
  badge: { score_pct: 41, eligible: false },
  audience: 'agent-optimized',
  audit_profile: null,
  results: [
    { status: 'fail', label: 'exits non-zero on bad flag', group: 'P4', evidence: 'got exit 0' },
    { status: 'pass', label: 'streams stdout', group: 'P1', evidence: 'OK' },
  ],
};

// Canonical link stays site-relative here so the whole-response assertion
// reads the surface's own links. The real shell bakes an absolute
// canonical on the canonical host at build time; that half is asserted in
// the build section below.
const SHELL_TEMPLATE =
  '<!doctype html><title>{{TITLE}}</title><meta name="description" content="{{DESCRIPTION}}">' +
  '<link rel="canonical" href="{{CANONICAL_PATH}}"><main>{{BODY}}</main>';

let webAuditProjections: { registry: string; remediation: string } | null = null;
async function projections(): Promise<{ registry: string; remediation: string }> {
  if (!webAuditProjections) {
    const registry = normalizeWebAuditRegistry(
      yaml.load(await readFile(join(WEB_AUDIT_DATA, 'registry.yaml'), 'utf8')) as object,
    );
    const checks = registry.checks as Array<{ id: string }>;
    const remediation = normalizeWebRemediation(
      yaml.load(await readFile(join(WEB_AUDIT_DATA, 'remediation.yaml'), 'utf8')) as object,
      checks.map((c) => c.id),
    );
    webAuditProjections = { registry: JSON.stringify(registry), remediation: JSON.stringify(remediation) };
  }
  return webAuditProjections;
}

function alwaysPassLimiter() {
  return { limit: async () => ({ success: true }) };
}

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

function makeR2(prefill: Record<string, unknown> = {}): R2Bucket {
  const store = new Map<string, string>();
  for (const [k, v] of Object.entries(prefill)) store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  return {
    async get(key: string) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return {
        async json() {
          return JSON.parse(raw);
        },
        async text() {
          return raw;
        },
      };
    },
    async put(key: string, value: unknown) {
      store.set(key, typeof value === 'string' ? value : String(value));
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { objects: [], truncated: false as const };
    },
  } as unknown as R2Bucket;
}

async function makeAssets(): Promise<Fetcher> {
  const { registry, remediation } = await projections();
  const registryIndex = {
    by_slug: Object.fromEntries(MCP_FIXTURE_CATALOG.registry.map((e) => [e.slug, { ...e }])),
    by_owner_repo: {},
  };
  return {
    async fetch(input: RequestInfo | URL) {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(raw).pathname;
      const json = (body: string) =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/_internal/mcp-catalog.json') return json(JSON.stringify(MCP_FIXTURE_CATALOG));
      if (path === '/registry-index.json') return json(JSON.stringify(registryIndex));
      if (path === '/discovery-hints-index.json') return json(JSON.stringify({ by_owner_repo: {} }));
      if (path === '/_internal/web-audit-registry.json') return json(registry);
      if (path === '/_internal/web-remediation.json') return json(remediation);
      if (path === '/_internal/web-seed.json') return json('[]');
      if (path === '/_internal/score-live-shell.html') {
        return new Response(SHELL_TEMPLATE, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('not found', { status: 404 });
    },
  } as unknown as Fetcher;
}

/**
 * A cached web scorecard. Rows are restricted to check ids whose static
 * remediation carries no citation of the canonical host — a few entries in
 * remediation.yaml link anc.dev as a worked example, and those citations
 * are catalog data, not a link this deployment minted.
 */
async function cachedWebAudit(targetUrl: string, pct = 74): Promise<Record<string, unknown>> {
  const key = await webKeyFor(targetUrl, SPEC_VERSION);
  return {
    [key]: {
      spec_version: SPEC_VERSION,
      target_url: targetUrl,
      public_listing: true,
      scored_at: new Date().toISOString(),
      scorecard: {
        schema_version: '0.2',
        spec_version: SPEC_VERSION,
        target_url: targetUrl,
        tool: { name: new URL(targetUrl).host, url: targetUrl },
        score_pct: pct,
        score: { relative: pct, global: pct },
        coverage_summary: {
          must: { total: 1, verified: 1 },
          should: { total: 1, verified: 0 },
          may: { total: 0, verified: 0 },
        },
        categories: [{ id: 'discoverability', name: 'Discoverability', passed: 1, counted: 2 }],
        results: [
          { id: 'llms-txt', label: 'llms.txt', category: 'discoverability', status: 'pass', evidence: null },
          {
            id: 'openapi',
            label: 'OpenAPI description',
            category: 'discoverability',
            status: 'absent',
            evidence: 'no /openapi.json',
          },
        ],
        summary: { pass: 1, broken: 0, absent: 1, n_a: 0, skip: 0, error: 0 },
      },
    },
  };
}

beforeEach(() => {
  resetMcpTestState();
  resetWebAuditRegistryCacheForTests();
  resetWebRemediationCacheForTests();
  _resetShellTemplateCache();
  _resetRegistryIndexCache();
});

// ---------------------------------------------------------------------------
// Surface 1 — MCP tool results (the reported bug)
// ---------------------------------------------------------------------------

describe('MCP surface links back to the origin it was called on', () => {
  async function mcpEnv() {
    return { ASSETS: await makeAssets(), SCORE_CACHE: makeR2() } as unknown as Parameters<typeof mcpRpc>[0];
  }

  async function callTool(
    env: Awaited<ReturnType<typeof mcpEnv>>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ raw: string; body: JsonRpcBody }> {
    const { raw, body } = await mcpRpc(
      env,
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
      {},
      { origin: NON_CANONICAL_ORIGIN },
    );
    return { raw, body };
  }

  test('initialize instructions name the serving origin, not the canonical host', async () => {
    const env = await mcpEnv();
    const body = await mcpInitialize(env, { origin: NON_CANONICAL_ORIGIN });
    expectServedOnOwnOrigin(JSON.stringify(body));
  });

  test('get_scorecard registry hit returns a scorecard_url on the serving origin', async () => {
    const env = await mcpEnv();
    const { raw, body } = await callTool(env, 'get_scorecard', { slug: 'ripgrep' });
    expect((getJsonToolContent(body) as { found?: boolean }).found).toBe(true);
    expectServedOnOwnOrigin(raw);
  });

  test('get_scorecard live-cache hit returns a scorecard_url on the serving origin', async () => {
    const env = {
      ASSETS: await makeAssets(),
      SCORE_CACHE: makeR2({
        [scoreKeyFor('cowsay', SPEC_VERSION)]: {
          spec_version: SPEC_VERSION,
          anc_version: ANC_VERSION,
          tool_version: '3.8.4',
          scorecard: LIVE_SCORECARD,
        },
      }),
    } as unknown as Parameters<typeof mcpRpc>[0];
    const { raw, body } = await callTool(env, 'get_scorecard', { install: 'brew install cowsay' });
    expect((getJsonToolContent(body) as { source?: string }).source).toBe('live-cache');
    expectServedOnOwnOrigin(raw);
  });

  test('get_website_audit share_url and per-row fix-skill links use the serving origin', async () => {
    const target = 'https://example.com/';
    const env = {
      ASSETS: await makeAssets(),
      SCORE_CACHE: makeR2(await cachedWebAudit(target)),
    } as unknown as Parameters<typeof mcpRpc>[0];
    const { raw, body } = await callTool(env, 'get_website_audit', { url: 'example.com' });
    expect((getJsonToolContent(body) as { found?: boolean }).found).toBe(true);
    // The fix-skill link is the exact field the live staging run got wrong.
    expect(raw).toContain(`${NON_CANONICAL_ORIGIN}/web-audit/skill/openapi`);
    expectServedOnOwnOrigin(raw);
  });

  test('list_website_audits share_urls use the serving origin', async () => {
    const env = {
      ASSETS: await makeAssets(),
      SCORE_CACHE: makeR2({
        [`audits/web/leaderboard/${SPEC_VERSION}.json`]: {
          spec_version: SPEC_VERSION,
          generated_at: '2026-08-28T00:00:00.000Z',
          entries: [
            {
              domain: 'example.com',
              url: 'https://example.com/',
              name: 'example.com',
              description: 'fixture',
              score_pct: 74,
              score: { relative: 74, global: 74 },
            },
          ],
        },
      }),
    } as unknown as Parameters<typeof mcpRpc>[0];
    const { raw } = await callTool(env, 'list_website_audits', {});
    expectServedOnOwnOrigin(raw);
  });

  test('get_web_remediation skill_url uses the serving origin', async () => {
    const env = await mcpEnv();
    const { raw, body } = await callTool(env, 'get_web_remediation', { check_id: 'llms-txt' });
    expect((getJsonToolContent(body) as { found?: boolean }).found).toBe(true);
    expectServedOnOwnOrigin(raw);
  });
});

// ---------------------------------------------------------------------------
// Surface 2 — rendered HTML pages and their markdown twins
// ---------------------------------------------------------------------------

describe('web result pages link back to the origin they were served from', () => {
  async function webEnv(prefill: Record<string, unknown> = {}): Promise<WebAuditRouteEnv> {
    return {
      ASSETS: await makeAssets(),
      SCORE_CACHE: makeR2(prefill),
    } as unknown as WebAuditRouteEnv;
  }

  test('/web/<domain> HTML', async () => {
    const env = await webEnv(await cachedWebAudit('https://example.com/'));
    const res = await handleWebResultPage(new Request(`${NON_CANONICAL_ORIGIN}/web/example.com`), env);
    expect(res.status).toBe(200);
    expectServedOnOwnOrigin(await res.text());
  });

  test('/web/<domain>.md markdown twin', async () => {
    const env = await webEnv(await cachedWebAudit('https://example.com/'));
    const res = await handleWebResultPage(new Request(`${NON_CANONICAL_ORIGIN}/web/example.com.md`), env);
    expect(res.status).toBe(200);
    expectServedOnOwnOrigin(await res.text());
  });

  test('/web/<unknown>.md not-found twin', async () => {
    const env = await webEnv();
    const res = await handleWebResultPage(new Request(`${NON_CANONICAL_ORIGIN}/web/never-audited.test.md`), env);
    expect(res.status).toBe(404);
    expectServedOnOwnOrigin(await res.text());
  });

  test('/web/scoring/<domain>.md in-progress twin', async () => {
    const env = await webEnv();
    const res = await handleWebScoringPage(new Request(`${NON_CANONICAL_ORIGIN}/web/scoring.md`), env);
    expect(res.status).toBe(200);
    expectServedOnOwnOrigin(await res.text());
  });
});

describe('live-score pages link back to the origin they were served from', () => {
  async function liveEnv(prefill: Record<string, unknown> = {}) {
    return { ASSETS: await makeAssets(), SCORE_CACHE: makeR2(prefill) } as unknown as Parameters<
      typeof handleLiveScorePage
    >[1];
  }

  const cached = {
    [scoreKeyFor('cowsay', SPEC_VERSION)]: {
      spec_version: SPEC_VERSION,
      anc_version: ANC_VERSION,
      tool_version: '3.8.4',
      scorecard: LIVE_SCORECARD,
    },
  };

  test('/score/live/<binary>.md markdown twin', async () => {
    const env = await liveEnv(cached);
    const res = await handleLiveScorePage(new Request(`${NON_CANONICAL_ORIGIN}/score/live/cowsay.md`), env);
    expect(res.status).toBe(200);
    expectServedOnOwnOrigin(await res.text());
  });

  test('/score/live/<unknown>.md not-found twin', async () => {
    const env = await liveEnv();
    const res = await handleLiveScorePage(new Request(`${NON_CANONICAL_ORIGIN}/score/live/nosuchtool.md`), env);
    expect(res.status).toBe(404);
    expectServedOnOwnOrigin(await res.text());
  });
});

// ---------------------------------------------------------------------------
// Surface 3 — JSON API responses
// ---------------------------------------------------------------------------

describe('JSON API responses carry no foreign host', () => {
  test('/api/web-audit cache hit', async () => {
    const target = 'https://example.com/';
    const env = {
      ASSETS: await makeAssets(),
      SCORE_CACHE: makeR2(await cachedWebAudit(target)),
      SCORE_KV: makeKv(),
      WEB_AUDIT_ENABLED: 'true',
      TURNSTILE_SECRET: 'test-turnstile-secret',
      SESSION_HMAC_SECRET: 'test-session-secret',
      WEB_AUDIT_LIMITER: alwaysPassLimiter(),
      WEB_AUDIT_LIMITER_IP: alwaysPassLimiter(),
    } as unknown as WebAuditRouteEnv;
    const res = await handleWebAudit(
      new Request(`${NON_CANONICAL_ORIGIN}/api/web-audit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
        body: JSON.stringify({ url: 'example.com' }),
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    const raw = await res.text();
    expect(res.status).toBe(200);
    // share_url is site-relative, so nothing in this body may name a host.
    expect(raw).not.toContain(`https://${new URL(CANONICAL_SITE_URL).host}`);
    expect(raw).toContain('"share_url":"/web/example.com"');
  });
});

// ---------------------------------------------------------------------------
// Surface 4 — WebMCP tools in the browser client
// ---------------------------------------------------------------------------

describe('WebMCP tools resolve the page origin', () => {
  test('orientation tools answer with the origin the page is on', async () => {
    const tools = toolsFor('/p3', { origin: NON_CANONICAL_ORIGIN });
    expect(tools.length).toBeGreaterThan(0);
    const answers = await Promise.all(tools.map((t) => t.execute({})));
    expectServedOnOwnOrigin(answers.join('\n'));
  });

  test('with no page origin available, tools fall back to the canonical host', async () => {
    const tools = toolsFor('/p3', {});
    const answers = await Promise.all(tools.map((t) => t.execute({})));
    expect(answers.join('\n')).toContain(CANONICAL_SITE_URL);
  });
});

// ---------------------------------------------------------------------------
// Surface 5 — build output, where the two classes pull apart
// ---------------------------------------------------------------------------

describe('build output separates canonical identity from navigation', () => {
  const STAGING_BASE = 'https://staging.example';

  test('navigational emitters follow PUBLIC_BASE_URL', () => {
    const previous = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = STAGING_BASE;
    try {
      expect(resolveBaseUrl()).toBe(STAGING_BASE);
      expect(absolutifyMarkdownLinks('See [P1](/p1).')).toContain(`${STAGING_BASE}/p1`);
      const llms = buildLlmsIndex({
        introTitle: 'anc',
        summary: 'summary',
        principles: [{ n: 1, slug: 'non-interactive-by-default', title: 'P1' }],
        programmaticAccess: [{ label: 'MCP', path: '/mcp' }],
      });
      expect(llms).toContain(`${STAGING_BASE}/p1.md`);
      expect(llms).not.toContain(CANONICAL_SITE_URL);
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previous;
    }
  });

  test('canonical emitters ignore PUBLIC_BASE_URL', () => {
    const previous = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = STAGING_BASE;
    try {
      expect(canonicalBaseUrl()).toBe(CANONICAL_SITE_URL);

      // Every production caller omits baseUrl; passing it undefined is
      // that call shape, and lets emitShell resolve its own base.
      const html = emitShell({
        title: 'P3',
        description: 'desc',
        canonicalPath: '/p3',
        bodyHtml: '<p>body</p>',
        themeInitJs: '',
        baseUrl: undefined,
      });
      expect(html).toContain(`<link rel="canonical" href="${CANONICAL_SITE_URL}/p3" />`);
      expect(html).toContain(`content="${CANONICAL_SITE_URL}/p3"`);
      expect(html).not.toContain(STAGING_BASE);

      const sitemap = buildSitemap({ principleNumbers: [1], lastmod: '2026-08-28' });
      expect(sitemap).toContain(`<loc>${CANONICAL_SITE_URL}/p1</loc>`);
      expect(sitemap).not.toContain(STAGING_BASE);

      // One twin, both rules: canonical frontmatter, navigational body.
      const twin = composeTwin({ title: 'P3', description: 'desc', canonicalPath: '/p3' }, 'See [P1](/p1).\n');
      expect(twin).toContain(`url: ${CANONICAL_SITE_URL}/p3`);
      expect(twin).toContain(`](${STAGING_BASE}/p1)`);
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// Second net — a static scan for new raw host literals
// ---------------------------------------------------------------------------
//
// Strictly weaker than everything above: this would not have caught the
// original bug, because the offending module declared a tidy
// `const SITE_URL = 'https://anc.dev'` and used it correctly by its own
// lights. It earns its place by making the next one a compile-time-ish
// decision instead of a silent copy-paste.
//
// Every allowlist entry names a file and a reason. Adding one is the
// point: it forces the author to argue why this occurrence is not a link
// to the wrong deployment.

describe('the canonical host has exactly one definition in code', () => {
  const ALLOWED: Record<string, string> = {
    'src/shared/site-url.ts': 'the definition itself',
    'src/worker/spec-version.gen.ts': 'generated by src/build/00-spec-version-gen.mjs from the constant',
    'src/worker/mcp/tools/web-audit.ts':
      'an example input VALUE in a tool-argument description (the domain to audit), not a link to this site',
  };

  async function sourceFiles(dir: string, acc: string[] = []): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await sourceFiles(full, acc);
      else if (/\.(ts|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) acc.push(full);
    }
    return acc;
  }

  test('no module outside the allowlist writes the canonical host as a literal', async () => {
    const roots = ['worker', 'client', 'build', 'shared'].map((d) => join(REPO_ROOT, 'src', d));
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of await sourceFiles(root)) {
        const rel = file.slice(REPO_ROOT.length);
        if (rel in ALLOWED) continue;
        const lines = (await readFile(file, 'utf8')).split('\n');
        lines.forEach((line, i) => {
          if (!line.includes(CANONICAL_SITE_URL)) return;
          // Comments describe; they do not link.
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
