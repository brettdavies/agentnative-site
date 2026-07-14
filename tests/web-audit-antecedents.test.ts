// Antecedent resolution + dependency-ordered engine tests (plan-003 U3).
//
// The resolver half exercises every antecedent token against a synthetic
// context (site-type cases use ctx.siteType directly; the entry-point
// wiring lands with the route/MCP plumbing). The engine half asserts the
// two-wave evaluation reuses wave-1 probes and the root fetch instead of
// re-fetching.

import { describe, expect, test } from 'bun:test';
import {
  type AntecedentContext,
  resolveAntecedent,
  siteTypeApplies,
  WAVE1_CHECK_IDS,
} from '../src/worker/audit-web/antecedents';
import type { ProbeResponse } from '../src/worker/audit-web/assert';
import { type AuditEvent, runWebAudit } from '../src/worker/audit-web/engine';
import type { ProbeOutcome } from '../src/worker/audit-web/handlers/types';
import type { WebAuditRegistry, WebCheck } from '../src/worker/audit-web/registry';

function htmlRoot(body = '<html><head></head><body><main>hi</main></body></html>'): ProbeResponse {
  return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body, error: null };
}

function outcome(status: ProbeOutcome['status'], evidence: ProbeOutcome['evidence'] = []): ProbeOutcome {
  return { status, evidence };
}

function ctx(overrides: Partial<AntecedentContext> = {}): AntecedentContext {
  return {
    siteType: null,
    mcpEndpoint: null,
    discoveryEvidence: [],
    root: htmlRoot(),
    sources: new Map(),
    ...overrides,
  };
}

describe('resolveAntecedent', () => {
  test('none always applies', () => {
    expect(resolveAntecedent('none', ctx())).toBe('apply');
  });

  test('http-root applies on any HTTP answer and errors on a network failure', () => {
    expect(resolveAntecedent('http-root', ctx())).toBe('apply');
    expect(resolveAntecedent('http-root', ctx({ root: null }))).toBe('error');
  });

  test('html-root requires a text/html content-type', () => {
    expect(resolveAntecedent('html-root', ctx())).toBe('apply');
    const jsonRoot: ProbeResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{}',
      error: null,
    };
    expect(resolveAntecedent('html-root', ctx({ root: jsonRoot }))).toBe('n_a');
    expect(resolveAntecedent('html-root', ctx({ root: null }))).toBe('error');
  });

  test('mcp-present follows discovery', () => {
    expect(resolveAntecedent('mcp-present', ctx({ mcpEndpoint: 'https://x.dev/mcp' }))).toBe('apply');
    expect(resolveAntecedent('mcp-present', ctx())).toBe('n_a');
  });

  test('mcp-auth holds on a 401/WWW-Authenticate initialize or a card auth declaration', () => {
    const base = { mcpEndpoint: 'https://x.dev/mcp' };
    const with401 = ctx({
      ...base,
      sources: new Map([['mcp-initialize', outcome('broken', [{ url: 'https://x.dev/mcp', status: 401 }])]]),
    });
    expect(resolveAntecedent('mcp-auth', with401)).toBe('apply');
    const withHeader = ctx({
      ...base,
      sources: new Map([
        ['mcp-initialize', outcome('broken', [{ url: 'https://x.dev/mcp', status: 400, www_authenticate: 'Bearer' }])],
      ]),
    });
    expect(resolveAntecedent('mcp-auth', withHeader)).toBe('apply');
    const withCard = ctx({ ...base, discoveryEvidence: [{ source: '/.well-known/mcp.json', authentication: true }] });
    expect(resolveAntecedent('mcp-auth', withCard)).toBe('apply');
    expect(resolveAntecedent('mcp-auth', ctx(base))).toBe('n_a');
    expect(resolveAntecedent('mcp-auth', ctx())).toBe('n_a');
  });

  test('api-surface holds via each union signal independently and fails when none hold', () => {
    expect(resolveAntecedent('api-surface', ctx({ siteType: 'api' }))).toBe('apply');
    expect(
      resolveAntecedent('api-surface', ctx({ root: htmlRoot('<link rel="service-desc" href="/openapi.json">') })),
    ).toBe('apply');
    const linkHeaderRoot: ProbeResponse = {
      status: 200,
      headers: { 'content-type': 'text/html', link: '</openapi.json>; rel="service-desc"' },
      body: '<html></html>',
      error: null,
    };
    expect(resolveAntecedent('api-surface', ctx({ root: linkHeaderRoot }))).toBe('apply');
    const openapi200 = ctx({
      sources: new Map([['openapi', outcome('broken', [{ url: 'https://x.dev/openapi.json', status: 200 }])]]),
    });
    expect(resolveAntecedent('api-surface', openapi200)).toBe('apply');
    const llmsApiLink = ctx({
      sources: new Map([
        [
          'llms-txt',
          outcome('pass', [{ url: 'https://x.dev/llms.txt', status: 200, body: '- [API](/api/reference)' }]),
        ],
      ]),
    });
    expect(resolveAntecedent('api-surface', llmsApiLink)).toBe('apply');
    expect(resolveAntecedent('api-surface', ctx())).toBe('n_a');
  });

  test('schemas-ref holds on a passing openapi or a schema reference in the root', () => {
    const openapiPass = ctx({ sources: new Map([['openapi', outcome('pass')]]) });
    expect(resolveAntecedent('schemas-ref', openapiPass)).toBe('apply');
    expect(resolveAntecedent('schemas-ref', ctx({ root: htmlRoot('see /schema.json for shapes') }))).toBe('apply');
    expect(resolveAntecedent('schemas-ref', ctx())).toBe('n_a');
  });

  test('docs-site holds for a declared content type or a present root llms.txt', () => {
    expect(resolveAntecedent('docs-site', ctx({ siteType: 'content' }))).toBe('apply');
    const llmsPass = ctx({ sources: new Map([['llms-txt', outcome('pass')]]) });
    expect(resolveAntecedent('docs-site', llmsPass)).toBe('apply');
    expect(resolveAntecedent('docs-site', ctx({ siteType: 'api' }))).toBe('n_a');
  });

  test('root-llms-txt / root-llms-full-txt reuse the wave-1 probe results', () => {
    const sources = new Map([
      ['llms-txt', outcome('pass')],
      ['llms-full-txt', outcome('absent')],
    ]);
    expect(resolveAntecedent('root-llms-txt', ctx({ sources }))).toBe('apply');
    expect(resolveAntecedent('root-llms-full-txt', ctx({ sources }))).toBe('n_a');
  });

  test('robots-present reuses the robots result, not a second fetch', () => {
    expect(resolveAntecedent('robots-present', ctx({ sources: new Map([['robots', outcome('pass')]]) }))).toBe('apply');
    expect(resolveAntecedent('robots-present', ctx({ sources: new Map([['robots', outcome('absent')]]) }))).toBe('n_a');
    expect(resolveAntecedent('robots-present', ctx())).toBe('n_a');
  });

  test('auth-present holds on oauth discovery metadata or any observed 401', () => {
    expect(resolveAntecedent('auth-present', ctx({ sources: new Map([['oauth-discovery', outcome('pass')]]) }))).toBe(
      'apply',
    );
    const root401: ProbeResponse = { status: 401, headers: {}, body: '', error: null };
    expect(resolveAntecedent('auth-present', ctx({ root: root401 }))).toBe('apply');
    const openapi401 = ctx({
      sources: new Map([['openapi', outcome('broken', [{ url: 'https://x.dev/openapi.json', status: 401 }])]]),
    });
    expect(resolveAntecedent('auth-present', openapi401)).toBe('apply');
    expect(resolveAntecedent('auth-present', ctx())).toBe('n_a');
  });
});

describe('siteTypeApplies', () => {
  test('all applies everywhere; no declared type runs everything', () => {
    expect(siteTypeApplies(['all'], ctx({ siteType: 'content' }))).toBe(true);
    expect(siteTypeApplies(['api'], ctx({ siteType: null }))).toBe(true);
  });

  test('a declared content type gates api-only checks off', () => {
    expect(siteTypeApplies(['api'], ctx({ siteType: 'content' }))).toBe(false);
    expect(siteTypeApplies(['content'], ctx({ siteType: 'content' }))).toBe(true);
  });

  test('mcp entries auto-apply when an endpoint is discovered, regardless of declared type', () => {
    expect(siteTypeApplies(['mcp'], ctx({ siteType: 'content', mcpEndpoint: 'https://x.dev/mcp' }))).toBe(true);
    expect(siteTypeApplies(['api', 'mcp'], ctx({ siteType: 'content' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Engine wave ordering + probe reuse
// ---------------------------------------------------------------------------

function makeCheck(partial: Partial<WebCheck> & { id: string }): WebCheck {
  return {
    category: 'content-for-agents',
    tier: 'recommended',
    keyword: 'should',
    principle: 'P2',
    site_types: ['all'],
    antecedent: 'none',
    weight: 1,
    title: partial.id,
    hint: 'h',
    handler: 'http',
    with: {},
    ...partial,
  };
}

function registryOf(checks: WebCheck[]): WebAuditRegistry {
  return {
    version: 1,
    mcp_discovery: { well_known: ['/.well-known/mcp.json'], common_paths: ['/mcp'], protocol_version: '2025-06-18' },
    category_order: ['discoverability', 'content-for-agents', 'bot-crawl-policy', 'mcp-api', 'agent-discovery-auth'],
    categories: {
      discoverability: 'Discoverability',
      'content-for-agents': 'Content for agents',
      'bot-crawl-policy': 'Bot & crawl policy',
      'mcp-api': 'MCP & API',
      'agent-discovery-auth': 'Agent discovery & auth',
    },
    checks,
  };
}

async function collect(gen: AsyncGenerator<AuditEvent>): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function resultsOf(events: AuditEvent[]) {
  return events.flatMap((e) => (e.type === 'result' ? [e.result] : []));
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

describe('runWebAudit two-wave evaluation', () => {
  const CHECKS: WebCheck[] = [
    makeCheck({
      id: 'robots',
      category: 'discoverability',
      principle: 'P7',
      with: { path: '/robots.txt', expect: { status: [200] } },
    }),
    makeCheck({
      id: 'robots-ai-rules',
      category: 'bot-crawl-policy',
      principle: 'P7',
      antecedent: 'robots-present',
      with: { path: '/robots.txt', expect: { status: [200], body_regex: 'User-agent' } },
    }),
    makeCheck({ id: 'llms-txt', with: { path: '/llms.txt', retain_body: true, expect: { status: [200] } } }),
    makeCheck({
      id: 'llms-full-txt',
      tier: 'optional',
      keyword: 'may',
      site_types: ['content'],
      antecedent: 'docs-site',
      with: { path: '/llms-full.txt', expect: { status: [200] } },
    }),
    makeCheck({
      id: 'root-meta-description',
      antecedent: 'html-root',
      principle: 'P3',
      with: { path: '/', expect: { body_regex: '<meta[^>]+name=["\']description["\']' } },
    }),
    makeCheck({
      id: 'noscript-fallback',
      antecedent: 'html-root',
      principle: 'P1',
      with: { path: '/', expect: { body_regex: '<noscript' } },
    }),
    makeCheck({
      id: 'link-headers',
      category: 'discoverability',
      antecedent: 'http-root',
      principle: 'P3',
      with: { path: '/', expect: { header_regex: { name: 'link', pattern: 'rel="?service-desc"?' } } },
    }),
    makeCheck({
      id: 'oauth-protected-resource',
      category: 'agent-discovery-auth',
      tier: 'optional',
      keyword: 'may',
      site_types: ['mcp'],
      antecedent: 'mcp-auth',
      principle: 'P1',
      with: { path: '/.well-known/oauth-protected-resource', expect: { status: [200] } },
    }),
    makeCheck({
      id: 'sitemap',
      category: 'discoverability',
      tier: 'optional',
      keyword: 'may',
      principle: 'P7',
      with: { path: '/sitemap.xml', retain_body: true, expect: { status: [200] } },
    }),
  ];

  function siteFetch(overrides: Record<string, Response | (() => Response)> = {}) {
    const seen: string[] = [];
    const fetchImpl = stubFetch((url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      const override = overrides[new URL(url).pathname];
      if (override) return typeof override === 'function' ? override() : override.clone();
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /', { status: 200 });
      if (new URL(url).pathname === '/') {
        return new Response(
          '<html><head><meta name="description" content="x"></head><body><noscript>x</noscript></body></html>',
          {
            status: 200,
            headers: { 'content-type': 'text/html' },
          },
        );
      }
      return new Response('not found', { status: 404 });
    });
    return { fetchImpl, seen };
  }

  test('a dependent check sees its antecedent resolved from the wave-1 result, not a second fetch', async () => {
    const { fetchImpl, seen } = siteFetch();
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
    );
    const rows = resultsOf(events);
    expect(rows.find((r) => r.id === 'robots')?.status).toBe('pass');
    expect(rows.find((r) => r.id === 'robots-ai-rules')?.status).toBe('pass');
    // robots.txt is fetched once by the robots probe and once by the
    // applied robots-ai-rules body assertion; the gate itself adds none.
    expect(seen.filter((s) => s.endsWith('/robots.txt')).length).toBe(2);
  });

  test('robots-ai-rules is n_a (antecedent-unmet) without a robots.txt and probes nothing', async () => {
    const { fetchImpl, seen } = siteFetch({ '/robots.txt': new Response('nope', { status: 404 }) });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
    );
    const rows = resultsOf(events);
    const gated = rows.find((r) => r.id === 'robots-ai-rules');
    expect(gated?.status).toBe('n_a');
    expect(gated?.na_reason).toBe('antecedent-unmet');
    expect(seen.filter((s) => s.endsWith('/robots.txt')).length).toBe(1);
  });

  test('the root-HTML checks and link-headers reuse the single canonical root fetch', async () => {
    const { fetchImpl, seen } = siteFetch();
    await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
    );
    // Exactly one plain GET / : the canonical root fetch. (Discovery
    // never fetches /; content-negotiating checks carry their own headers.)
    expect(seen.filter((s) => s === 'GET https://example.com/').length).toBe(1);
  });

  test('an applicable MAY that is absent is n_a with na_reason optional-absent', async () => {
    const { fetchImpl } = siteFetch({
      '/llms.txt': new Response('# Site', { status: 200 }),
      '/llms-full.txt': new Response('no', { status: 404 }),
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
    );
    const row = resultsOf(events).find((r) => r.id === 'llms-full-txt');
    expect(row?.status).toBe('n_a');
    expect(row?.na_reason).toBe('optional-absent');
  });

  test('llms-full-txt is n_a (antecedent-unmet) on a non-docs site', async () => {
    const { fetchImpl } = siteFetch();
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
    );
    const row = resultsOf(events).find((r) => r.id === 'llms-full-txt');
    expect(row?.status).toBe('n_a');
    expect(row?.na_reason).toBe('antecedent-unmet');
  });

  test('oauth-protected-resource is n_a with no MCP endpoint', async () => {
    const { fetchImpl } = siteFetch();
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
    );
    const row = resultsOf(events).find((r) => r.id === 'oauth-protected-resource');
    expect(row?.status).toBe('n_a');
    expect(row?.na_reason).toBe('antecedent-unmet');
  });

  test('a declared content site gates api-only checks to n_a at the type filter', async () => {
    const registry = registryOf([
      ...CHECKS,
      makeCheck({
        id: 'openapi',
        category: 'mcp-api',
        tier: 'required',
        keyword: 'must',
        site_types: ['api'],
        antecedent: 'api-surface',
        with: { path_any: ['/openapi.json'], expect: { status: [200] } },
      }),
    ]);
    const { fetchImpl } = siteFetch({
      '/openapi.json': new Response('{"openapi":"3.1.0"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry, siteType: 'content', fetchOptions: { fetchImpl } }),
    );
    const row = resultsOf(events).find((r) => r.id === 'openapi');
    expect(row?.status).toBe('n_a');
    expect(row?.na_reason).toBe('antecedent-unmet');
  });

  test('every wave-1 source check id exists in the shipped registry ordering contract', () => {
    for (const id of [
      'robots',
      'llms-txt',
      'llms-full-txt',
      'openapi',
      'oauth-discovery',
      'mcp-initialize',
      'sitemap',
    ]) {
      expect(WAVE1_CHECK_IDS.has(id)).toBe(true);
    }
  });
});
