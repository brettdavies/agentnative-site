// Engine coverage for U2 agent-recovery checks: 404 family, content-without-JS
// floor + llms.txt softening, and agent-UA reachability.

import { describe, expect, test } from 'bun:test';
import { type AuditEvent, runWebAudit } from '../src/worker/audit-web/engine';
import type { WebAuditRegistry, WebCheck } from '../src/worker/audit-web/registry';

function makeCheck(partial: Partial<WebCheck> & { id: string }): WebCheck {
  return {
    category: 'discoverability',
    tier: 'recommended',
    keyword: 'should',
    principle: 'P8',
    site_types: ['all'],
    antecedent: 'http-root',
    weight: 1,
    title: partial.id,
    hint: 'h',
    handler: 'http',
    with: {},
    ...partial,
  };
}

const RECOVERY_CHECKS: WebCheck[] = [
  makeCheck({
    id: 'llms-txt',
    category: 'content-for-agents',
    principle: 'P2',
    antecedent: 'none',
    with: { path: '/llms.txt', retain_body: true, expect: { status: [200] } },
  }),
  makeCheck({
    id: 'agent-friendly-404',
    with: { path: '/anc-web-audit-no-such-page', expect: { status: [404, 410] } },
  }),
  makeCheck({
    id: 'agent-friendly-404-md',
    with: {
      path: '/anc-web-audit-no-such-page',
      headers: { Accept: 'text/markdown' },
      expect: {
        status: [404, 410],
        content_type: 'markdown|text/plain',
        body_regex: '\\]\\([^)]*(sitemap\\.xml|llms\\.txt|/docs)',
      },
    },
  }),
  makeCheck({
    id: 'content-without-js',
    category: 'content-for-agents',
    principle: 'P2',
    antecedent: 'html-root',
    handler: 'content-without-js',
    with: {},
  }),
  makeCheck({
    id: 'agent-ua-reachable',
    category: 'bot-crawl-policy',
    principle: 'P7',
    with: {
      path: '/',
      headers: { 'User-Agent': 'ChatGPT-User/1.0 (+https://openai.com/bot)', Accept: '*/*' },
      expect: {
        status_below: 300,
        body_not_regex: 'just a moment|attention required|cf-challenge|enable javascript and cookies|captcha',
      },
    },
  }),
];

function registryOf(checks: WebCheck[]): WebAuditRegistry {
  return {
    version: 1,
    mcp_discovery: { well_known: ['/.well-known/mcp.json'], common_paths: ['/mcp'], protocol_version: '2025-06-18' },
    category_order: ['discoverability', 'content-for-agents', 'bot-crawl-policy'],
    categories: {
      discoverability: 'Discoverability',
      'content-for-agents': 'Content for agents',
      'bot-crawl-policy': 'Bot & crawl policy',
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

const RICH_HTML = `<html><head></head><body><h1>Agent-native CLI</h1><p>${'Readable prose. '.repeat(20)}</p></body></html>`;
const THIN_HTML = '<html><head></head><body><div id="app"></div></body></html>';
const LLMS = '# Site\n\n> Summary\n\n- [Guide](https://example.com/guide.md)\n';
const GUIDE = '# Guide\n\nThis is enough content for a digital twin page to count as resolvable.\n';
const MD_404 = '# Not found\n\n- [llms.txt](https://example.com/llms.txt)\n';

function siteFetch(
  handler: (url: string, accept: string | undefined, ua: string | undefined) => Response,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    return handler(url, headers.get('accept') ?? undefined, headers.get('user-agent') ?? undefined);
  }) as typeof fetch;
}

describe('agent-friendly 404 family', () => {
  test('soft-200 SPA shell is broken on the status row', async () => {
    const fetchImpl = siteFetch((url) => {
      if (url.includes('/anc-web-audit-no-such-page')) {
        return new Response(THIN_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response(RICH_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(RECOVERY_CHECKS), fetchOptions: { fetchImpl } }),
    );
    expect(resultsOf(events).find((r) => r.id === 'agent-friendly-404')?.status).toBe('broken');
  });

  test('real 404 with HTML-only body passes status and misses markdown recovery', async () => {
    const fetchImpl = siteFetch((url, accept) => {
      if (url.includes('/anc-web-audit-no-such-page')) {
        const md = accept?.includes('markdown');
        return new Response(md ? '# gone' : '<h1>gone</h1>', {
          status: 404,
          headers: { 'content-type': md ? 'text/markdown' : 'text/html' },
        });
      }
      if (url.endsWith('/llms.txt')) return new Response('nope', { status: 404 });
      return new Response(RICH_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(RECOVERY_CHECKS), fetchOptions: { fetchImpl } }),
    );
    const rows = resultsOf(events);
    expect(rows.find((r) => r.id === 'agent-friendly-404')?.status).toBe('pass');
    expect(rows.find((r) => r.id === 'agent-friendly-404-md')?.status).toBe('absent');
  });

  test('real 404 markdown with one recovery link passes the sibling', async () => {
    const fetchImpl = siteFetch((url, accept) => {
      if (url.includes('/anc-web-audit-no-such-page')) {
        const md = accept?.includes('markdown');
        return new Response(md ? MD_404 : '<h1>gone</h1>', {
          status: 404,
          headers: { 'content-type': md ? 'text/markdown' : 'text/html' },
        });
      }
      if (url.endsWith('/llms.txt')) return new Response('nope', { status: 404 });
      return new Response(RICH_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(RECOVERY_CHECKS), fetchOptions: { fetchImpl } }),
    );
    expect(resultsOf(events).find((r) => r.id === 'agent-friendly-404-md')?.status).toBe('pass');
  });

  test('real 404 markdown with zero links misses the sibling', async () => {
    const fetchImpl = siteFetch((url, accept) => {
      if (url.includes('/anc-web-audit-no-such-page')) {
        const md = accept?.includes('markdown');
        return new Response(md ? '# Not found\n' : '<h1>gone</h1>', {
          status: 404,
          headers: { 'content-type': md ? 'text/markdown' : 'text/html' },
        });
      }
      if (url.endsWith('/llms.txt')) return new Response('nope', { status: 404 });
      return new Response(RICH_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(RECOVERY_CHECKS), fetchOptions: { fetchImpl } }),
    );
    expect(resultsOf(events).find((r) => r.id === 'agent-friendly-404-md')?.status).toBe('absent');
  });
});

describe('content-without-js floor', () => {
  test('thin HTML + llms.txt with dead links still applies (no soften)', async () => {
    const fetchImpl = siteFetch((url) => {
      if (url.endsWith('/llms.txt')) return new Response(LLMS, { status: 200 });
      if (url.endsWith('/guide.md')) return new Response('missing', { status: 404 });
      if (url.includes('/anc-web-audit-no-such-page')) {
        return new Response('# gone\n', { status: 404, headers: { 'content-type': 'text/markdown' } });
      }
      return new Response(THIN_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(RECOVERY_CHECKS), fetchOptions: { fetchImpl } }),
    );
    expect(resultsOf(events).find((r) => r.id === 'content-without-js')?.status).toBe('absent');
  });

  test('thin HTML + llms.txt with a live content link is n_a', async () => {
    const fetchImpl = siteFetch((url) => {
      if (url.endsWith('/llms.txt')) return new Response(LLMS, { status: 200 });
      if (url.endsWith('/guide.md')) return new Response(GUIDE, { status: 200 });
      if (url.includes('/anc-web-audit-no-such-page')) {
        return new Response('# gone\n', { status: 404, headers: { 'content-type': 'text/markdown' } });
      }
      return new Response(THIN_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(RECOVERY_CHECKS), fetchOptions: { fetchImpl } }),
    );
    const row = resultsOf(events).find((r) => r.id === 'content-without-js');
    expect(row?.status).toBe('n_a');
    expect(row?.na_reason).toBeUndefined();
  });
});

describe('agent-ua reachability', () => {
  test('agent UA 403 is a SHOULD miss with the UA in the probe', async () => {
    const fetchImpl = siteFetch((_url, _accept, ua) => {
      if (ua?.includes('ChatGPT-User')) return new Response('blocked', { status: 403 });
      if (_url.includes('/anc-web-audit-no-such-page')) {
        return new Response('# gone\n', { status: 404, headers: { 'content-type': 'text/markdown' } });
      }
      if (_url.endsWith('/llms.txt')) return new Response('nope', { status: 404 });
      return new Response(RICH_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(RECOVERY_CHECKS), fetchOptions: { fetchImpl } }),
    );
    const row = resultsOf(events).find((r) => r.id === 'agent-ua-reachable');
    expect(row?.status).toBe('broken');
    expect(row?.evidence).toContain('403');
  });

  test('agent UA 200 without a challenge interstitial passes', async () => {
    const fetchImpl = siteFetch((url) => {
      if (url.includes('/anc-web-audit-no-such-page')) {
        return new Response('# gone\n', { status: 404, headers: { 'content-type': 'text/markdown' } });
      }
      if (url.endsWith('/llms.txt')) return new Response('nope', { status: 404 });
      return new Response(RICH_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(RECOVERY_CHECKS), fetchOptions: { fetchImpl } }),
    );
    expect(resultsOf(events).find((r) => r.id === 'agent-ua-reachable')?.status).toBe('pass');
  });
});
