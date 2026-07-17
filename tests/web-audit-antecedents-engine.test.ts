// Dependency-ordered engine tests: runWebAudit's two-wave evaluation reuses
// wave-1 probes and the single canonical root fetch to resolve antecedents,
// instead of re-fetching. The per-token resolver logic is unit-tested in the
// web-audit-antecedents-<group> files; this asserts the gating end to end.

import { describe, expect, test } from 'bun:test';
import { type AuditEvent, runWebAudit } from '../src/worker/audit-web/engine';
import type { WebAuditRegistry, WebCheck } from '../src/worker/audit-web/registry';

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
    category_order: ['discoverability', 'content-for-agents', 'bot-crawl-policy', 'api', 'mcp', 'agent-discovery-auth'],
    categories: {
      discoverability: 'Discoverability',
      'content-for-agents': 'Content for agents',
      'bot-crawl-policy': 'Bot & crawl policy',
      api: 'API',
      mcp: 'MCP',
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
        category: 'api',
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
});
