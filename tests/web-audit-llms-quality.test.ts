// Engine coverage for the llms.txt quality trio: format, links, when-to-use.

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
    antecedent: 'root-llms-txt',
    weight: 1,
    title: partial.id,
    hint: 'h',
    handler: 'llms-txt-quality',
    with: {},
    ...partial,
  };
}

const CHECKS: WebCheck[] = [
  makeCheck({
    id: 'llms-txt',
    antecedent: 'none',
    handler: 'http',
    with: { path: '/llms.txt', retain_body: true, expect: { status: [200] } },
  }),
  makeCheck({ id: 'llms-txt-format', with: { op: 'format' } }),
  makeCheck({ id: 'llms-txt-links', with: { op: 'links', max_candidates: 8 } }),
  makeCheck({ id: 'llms-txt-when-to-use', with: { op: 'when-to-use' } }),
];

function registryOf(checks: WebCheck[]): WebAuditRegistry {
  return {
    version: 1,
    mcp_discovery: { well_known: ['/.well-known/mcp.json'], common_paths: ['/mcp'], protocol_version: '2025-06-18' },
    category_order: ['content-for-agents'],
    categories: { 'content-for-agents': 'Content for agents' },
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

const FORMATTED = `# Site

> A summary of what this does.

## Programmatic access

Use the MCP when you need to search the catalog.

- [Guide](https://example.com/guide.md)
`;

function siteFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as typeof fetch;
}

describe('llms.txt quality trio', () => {
  test('presence passes and format fails as two distinct rows', async () => {
    const fetchImpl = siteFetch((url) => {
      if (url.endsWith('/llms.txt')) return new Response('# Only a heading\n', { status: 200 });
      return new Response('html', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
    );
    const rows = resultsOf(events);
    expect(rows.find((r) => r.id === 'llms-txt')?.status).toBe('pass');
    expect(rows.find((r) => r.id === 'llms-txt-format')?.status).toBe('absent');
  });

  test('format passes and a broken link misses llms-txt-links', async () => {
    const fetchImpl = siteFetch((url) => {
      if (url.endsWith('/llms.txt')) return new Response(FORMATTED, { status: 200 });
      if (url.endsWith('/guide.md')) return new Response('gone', { status: 404 });
      return new Response('html', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
    );
    const rows = resultsOf(events);
    expect(rows.find((r) => r.id === 'llms-txt-format')?.status).toBe('pass');
    expect(rows.find((r) => r.id === 'llms-txt-links')?.status).toBe('absent');
    expect(rows.find((r) => r.id === 'llms-txt-links')?.evidence).toContain('404');
  });

  test('when-to-use heading present vs absent', async () => {
    const withHeading = siteFetch((url) => {
      if (url.endsWith('/llms.txt')) return new Response(FORMATTED, { status: 200 });
      if (url.endsWith('/guide.md')) return new Response('# Guide\n\nBody.\n', { status: 200 });
      return new Response('html', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const withoutHeading = siteFetch((url) => {
      if (url.endsWith('/llms.txt')) {
        return new Response('# Site\n\n> Summary\n\n- [Guide](https://example.com/guide.md)\n', { status: 200 });
      }
      if (url.endsWith('/guide.md')) return new Response('# Guide\n\nBody.\n', { status: 200 });
      return new Response('html', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const present = resultsOf(
      await collect(
        runWebAudit({
          url: 'https://example.com/',
          registry: registryOf(CHECKS),
          fetchOptions: { fetchImpl: withHeading },
        }),
      ),
    );
    const absent = resultsOf(
      await collect(
        runWebAudit({
          url: 'https://example.com/',
          registry: registryOf(CHECKS),
          fetchOptions: { fetchImpl: withoutHeading },
        }),
      ),
    );
    expect(present.find((r) => r.id === 'llms-txt-when-to-use')?.status).toBe('pass');
    expect(absent.find((r) => r.id === 'llms-txt-when-to-use')?.status).toBe('absent');
  });

  test('all three quality rows are n_a when root llms.txt is absent', async () => {
    const fetchImpl = siteFetch((url) => {
      if (url.endsWith('/llms.txt')) return new Response('nope', { status: 404 });
      return new Response('html', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(CHECKS), fetchOptions: { fetchImpl } }),
    );
    const rows = resultsOf(events);
    for (const id of ['llms-txt-format', 'llms-txt-links', 'llms-txt-when-to-use'] as const) {
      const row = rows.find((r) => r.id === id);
      expect(row?.status).toBe('n_a');
      expect(row?.na_reason).toBe('antecedent-unmet');
    }
  });
});
