// End-to-end engine coverage for the four markdown-to-agents MAY checks and
// their shared markdown-twin gate. Drives runWebAudit with an injected
// fetchImpl that emulates three site shapes: one that serves the twin to
// every client class (all pass), one that ships no markdown at all
// (antecedent-unmet), and one that ships markdown but never UA-sniffs, honors
// text/plain, or emits Vary (applicable but absent -> no penalty).

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

const MARKDOWN_CHECKS: WebCheck[] = [
  makeCheck({
    id: 'accept-markdown',
    antecedent: 'html-root',
    with: { path: '/', headers: { Accept: 'text/markdown' }, expect: { content_type: 'markdown|text/plain' } },
  }),
  makeCheck({ id: 'llms-txt', with: { path: '/llms.txt', retain_body: true, expect: { status: [200] } } }),
  makeCheck({
    id: 'markdown-cli-ua',
    tier: 'optional',
    keyword: 'may',
    antecedent: 'markdown-twin',
    with: {
      path: '/',
      headers: { 'User-Agent': 'curl/8.7.1', Accept: '*/*' },
      expect: { content_type: 'markdown|text/plain' },
    },
  }),
  makeCheck({
    id: 'markdown-agent-ua',
    tier: 'optional',
    keyword: 'may',
    antecedent: 'markdown-twin',
    with: {
      path: '/',
      headers: { 'User-Agent': 'ChatGPT-User/1.0 (+https://openai.com/bot)', Accept: '*/*' },
      expect: { content_type: 'markdown|text/plain' },
    },
  }),
  makeCheck({
    id: 'markdown-accept-plain',
    tier: 'optional',
    keyword: 'may',
    antecedent: 'markdown-twin',
    with: { path: '/', headers: { Accept: 'text/plain' }, expect: { content_type: 'markdown|text/plain' } },
  }),
  makeCheck({
    id: 'markdown-vary',
    tier: 'optional',
    keyword: 'may',
    antecedent: 'markdown-twin',
    with: { path: '/', expect: { header_regex: { name: 'vary', pattern: '(?=.*accept)(?=.*user-agent)' } } },
  }),
];

const NEW_CHECK_IDS = ['markdown-cli-ua', 'markdown-agent-ua', 'markdown-accept-plain', 'markdown-vary'] as const;

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

function scorecardOf(events: AuditEvent[]) {
  const complete = events.find((e) => e.type === 'complete');
  if (!complete || complete.type !== 'complete') throw new Error('no complete event');
  return complete.scorecard;
}

function headerOf(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

const MARKDOWN_BODY = '# Home\n\nThe markdown twin.\n';
const HTML_BODY = '<html><head></head><body><main>hi</main></body></html>';

/** A fetchImpl plus a record of `METHOD url [headers?]` for reuse assertions. */
function siteFetch(rootFor: (accept: string | undefined, ua: string | undefined) => Response): {
  fetchImpl: typeof fetch;
  seen: string[];
} {
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(`${init?.method ?? 'GET'} ${url} ${init?.headers ? 'H' : 'noH'}`);
    const pathname = new URL(url).pathname;
    if (pathname === '/') {
      return rootFor(headerOf(init?.headers, 'accept'), headerOf(init?.headers, 'user-agent'));
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function markdownResponse(): Response {
  return new Response(MARKDOWN_BODY, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } });
}

function htmlResponse(extra: Record<string, string> = {}): Response {
  return new Response(HTML_BODY, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...extra } });
}

const MD_ALTERNATE_LINK = '</index.md>; rel="alternate"; type="text/markdown"';

describe('markdown-to-agents rewards: a site that serves the twin to every client', () => {
  // Serves markdown to CLI/AI User-Agents that state no preference, honors
  // Accept text/plain, and its canonical root carries the markdown alternate
  // Link plus Vary: Accept, User-Agent.
  function twinRoot(accept: string | undefined, ua: string | undefined): Response {
    const wantsMarkdown = accept !== undefined && (/markdown/i.test(accept) || accept.includes('text/plain'));
    const wildcardOrAbsent = accept === undefined || accept.includes('*/*');
    const cliOrAgent = ua !== undefined && /curl|wget|chatgpt-user|claude-user|perplexity-user/i.test(ua);
    if (wantsMarkdown || (cliOrAgent && wildcardOrAbsent)) return markdownResponse();
    return htmlResponse({ link: MD_ALTERNATE_LINK, vary: 'Accept, User-Agent' });
  }

  test('all four markdown checks pass', async () => {
    const { fetchImpl } = siteFetch(twinRoot);
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(MARKDOWN_CHECKS), fetchOptions: { fetchImpl } }),
    );
    const rows = resultsOf(events);
    for (const id of NEW_CHECK_IDS) {
      expect(rows.find((r) => r.id === id)?.status).toBe('pass');
    }
  });

  test('the four passes are counted as verified MAY coverage', async () => {
    const { fetchImpl } = siteFetch(twinRoot);
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(MARKDOWN_CHECKS), fetchOptions: { fetchImpl } }),
    );
    const sc = scorecardOf(events);
    expect(sc.coverage_summary.may.total).toBe(4);
    expect(sc.coverage_summary.may.verified).toBe(4);
  });

  test('markdown-vary reuses the canonical root fetch instead of issuing a second plain GET /', async () => {
    const { fetchImpl, seen } = siteFetch(twinRoot);
    await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(MARKDOWN_CHECKS), fetchOptions: { fetchImpl } }),
    );
    // Exactly one header-less GET / : the canonical root fetch. markdown-vary
    // carries no headers, so it reuses that response and adds no fetch.
    expect(seen.filter((s) => s === 'GET https://example.com/ noH').length).toBe(1);
  });
});

describe('markdown-to-agents rewards: a site that ships no markdown at all', () => {
  // HTML root with no markdown alternate Link, no llms.txt, and HTML for
  // every content-negotiated request.
  function noMarkdownRoot(): Response {
    return htmlResponse();
  }

  test('the four checks are n_a with na_reason antecedent-unmet', async () => {
    const { fetchImpl } = siteFetch(noMarkdownRoot);
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(MARKDOWN_CHECKS), fetchOptions: { fetchImpl } }),
    );
    const rows = resultsOf(events);
    for (const id of NEW_CHECK_IDS) {
      const row = rows.find((r) => r.id === id);
      expect(row?.status).toBe('n_a');
      expect(row?.na_reason).toBe('antecedent-unmet');
    }
  });

  test('gated-out MAY checks are excluded from the coverage totals (and the relative denominator)', async () => {
    const { fetchImpl } = siteFetch(noMarkdownRoot);
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(MARKDOWN_CHECKS), fetchOptions: { fetchImpl } }),
    );
    const sc = scorecardOf(events);
    expect(sc.coverage_summary.may.total).toBe(0);
  });
});

describe('markdown-to-agents rewards: a markdown site that never adopts the affordances', () => {
  // The root advertises the markdown alternate Link (so markdown-twin holds)
  // but the site never UA-sniffs, never honors text/plain, and omits Vary:
  // every content probe comes back HTML, and the root carries no Vary.
  function shipsMdButUnimplemented(): Response {
    return htmlResponse({ link: MD_ALTERNATE_LINK });
  }

  test('the four checks are n_a with na_reason optional-absent (applicable, unimplemented, no penalty)', async () => {
    const { fetchImpl } = siteFetch(shipsMdButUnimplemented);
    const events = await collect(
      runWebAudit({ url: 'https://example.com/', registry: registryOf(MARKDOWN_CHECKS), fetchOptions: { fetchImpl } }),
    );
    const rows = resultsOf(events);
    for (const id of NEW_CHECK_IDS) {
      const row = rows.find((r) => r.id === id);
      expect(row?.status).toBe('n_a');
      expect(row?.na_reason).toBe('optional-absent');
    }
  });
});
