// A row that asserts nothing about the body and keeps none reads the status and
// headers, so a 70 MB llms-full.txt costs its headers. The memo keeps reading the
// start of the body for a later row, and a row whose failure is the body itself
// reads through.

import { describe, expect, test } from 'bun:test';
import { type ExpectBlock, expectReadsBody } from '../src/worker/audit-web/assert';
import { type AuditEvent, runWebAudit } from '../src/worker/audit-web/engine';
import { ALWAYS_ADMIT_BUDGET } from '../src/worker/audit-web/follow-requests';
import { runHttp } from '../src/worker/audit-web/handlers/http';
import type { HandlerContext } from '../src/worker/audit-web/handlers/types';
import type { WebAuditRegistry, WebCheck } from '../src/worker/audit-web/registry';
import { closeRequestMemo, createRequestMemo, MEMO_BODY_MAX_BYTES } from '../src/worker/audit-web/request-hop';
import { stubFetch } from './helpers/stub-fetch';

const BASE = 'https://example.com/';
const CHUNK_BYTES = 64 * 1024;

function makeCheck(partial: Partial<WebCheck> & { id: string }): WebCheck {
  return {
    category: 'discoverability',
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

/** A response whose body never ends, noting how much of it was read and whether it was cancelled. */
function endlessBody(headers: Record<string, string> = {}): {
  response: Response;
  read: () => number;
  cancelled: () => boolean;
} {
  let bytes = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    // Yields to timers as a socket does; enqueueing synchronously would starve the abort.
    async pull(controller) {
      await Bun.sleep(0);
      bytes += CHUNK_BYTES;
      controller.enqueue(new Uint8Array(CHUNK_BYTES));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { status: 200, headers }),
    read: () => bytes,
    cancelled: () => cancelled,
  };
}

/** A response that sends its first bytes and then holds the body open, as a stuck SSE stream does. */
function heldOpenBody(init: RequestInit | undefined, headers: Record<string, string>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(': open\n\n'));
      init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  });
  return new Response(body, { status: 200, headers });
}

function context(fetchImpl: typeof fetch, memo = createRequestMemo(), defaultTimeoutMs = 300): HandlerContext {
  return {
    base: BASE,
    host: 'example.com',
    mcpEndpoint: 'https://example.com/mcp',
    protocolVersion: '2025-06-18',
    defaultTimeoutMs,
    fetchOptions: { fetchImpl, memo },
  };
}

describe('a row that needs no body', () => {
  test.each<[string, ExpectBlock, Record<string, string>]>([
    ['status', { status: [200] }, {}],
    ['status_below', { status_below: 500 }, {}],
    ['content_type', { content_type: 'markdown' }, { 'content-type': 'text/markdown' }],
    ['header_present', { header_present: 'vary' }, { vary: 'accept' }],
    ['header_regex', { header_regex: { name: 'vary', pattern: 'accept' } }, { vary: 'accept' }],
  ])('passes on its %s while the body never ends', async (_key, expect_, headers) => {
    const body = endlessBody(headers);
    const fetchImpl = stubFetch(() => body.response);
    const memo = createRequestMemo();
    const outcome = await runHttp(
      makeCheck({ id: 'row', with: { path: '/large', expect: expect_ } }),
      context(fetchImpl, memo),
    );
    closeRequestMemo(memo);
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0]).not.toHaveProperty('truncated');
  });

  test('the memo reads the first MiB in the background and no further', async () => {
    const body = endlessBody();
    const fetchImpl = stubFetch(() => body.response);
    const memo = createRequestMemo();
    await runHttp(
      makeCheck({ id: 'llms-full-txt', with: { path: '/llms-full.txt', expect: { status: [200] } } }),
      context(fetchImpl, memo, 2_000),
    );
    const until = Date.now() + 1_000;
    while (!body.cancelled() && Date.now() < until) await Bun.sleep(5);
    closeRequestMemo(memo);
    expect(body.cancelled()).toBe(true);
    // A stream pulls a chunk or two ahead of what its reader has taken.
    expect(body.read()).toBeLessThanOrEqual(MEMO_BODY_MAX_BYTES + 3 * CHUNK_BYTES);
  });

  test('a later row that needs the body reads it from the same request', async () => {
    let requests = 0;
    const fetchImpl = stubFetch((url) => {
      if (new URL(url).pathname !== '/robots.txt') return new Response('', { status: 404 });
      requests += 1;
      return new Response('User-agent: *\n', { status: 200 });
    });
    const registry: WebAuditRegistry = {
      version: 1,
      mcp_discovery: {
        ai_catalog: '/.well-known/ai-catalog.json',
        card_suffix: '/server-card',
        well_known: [],
        common_paths: [],
        protocol_version: '2025-06-18',
      },
      category_order: ['discoverability'],
      categories: { discoverability: 'Discoverability' },
      checks: [
        makeCheck({ id: 'robots', with: { path: '/robots.txt', expect: { status: [200] } } }),
        makeCheck({
          id: 'robots-ai-rules',
          antecedent: 'robots-present',
          with: { path: '/robots.txt', expect: { status: [200], body_regex: 'User-agent' } },
        }),
      ],
    };
    const events: AuditEvent[] = [];
    for await (const event of runWebAudit({
      url: BASE,
      registry,
      fetchOptions: { fetchImpl },
      domainBudget: ALWAYS_ADMIT_BUDGET,
    })) {
      events.push(event);
    }
    expect(requests).toBe(1);
    const rule = events.find((e) => e.type === 'result' && e.result.id === 'robots-ai-rules');
    expect(rule).toMatchObject({ result: { status: 'pass' } });
  });
});

describe('a row that reads through', () => {
  test('a row asserting on the body reads it', async () => {
    const fetchImpl = stubFetch(() => new Response('hello agents', { status: 200 }));
    const outcome = await runHttp(
      makeCheck({ id: 'row', with: { path: '/doc', expect: { status: [200], body_regex: 'agents' } } }),
      context(fetchImpl),
    );
    expect(outcome.status).toBe('pass');
  });

  test('a row that keeps the body reads it', async () => {
    const fetchImpl = stubFetch(() => new Response('# Site\n', { status: 200 }));
    const outcome = await runHttp(
      makeCheck({ id: 'llms-txt', with: { path: '/llms.txt', retain_body: true, expect: { status: [200] } } }),
      context(fetchImpl),
    );
    expect(outcome.evidence[0]).toMatchObject({ body: '# Site\n' });
  });

  test('a hang-detection row reads through, so a body held open after a clean status reads as broken', async () => {
    const fetchImpl = stubFetch((_url, init) => heldOpenBody(init, { 'content-type': 'text/event-stream' }));
    const memo = createRequestMemo();
    const outcome = await runHttp(
      makeCheck({
        id: 'mcp-get-fast-fail',
        with: { path: '{mcp_endpoint}', timeout: 0.1, expect: { status_below: 500, sse_when_success: true } },
      }),
      context(fetchImpl, memo),
    );
    closeRequestMemo(memo);
    expect(outcome.status).toBe('broken');
    expect(String(outcome.evidence[0].error)).toStartWith('TimeoutError');
  });
});

describe('expectReadsBody', () => {
  test.each<[keyof ExpectBlock, ExpectBlock, boolean]>([
    ['status', { status: [200] }, false],
    ['status_below', { status_below: 500 }, false],
    ['sse_when_success', { sse_when_success: true }, false],
    ['content_type', { content_type: 'x' }, false],
    ['header_present', { header_present: 'x' }, false],
    ['header_regex', { header_regex: { name: 'x', pattern: 'y' } }, false],
    ['body_regex', { body_regex: 'x' }, true],
    ['body_not_regex', { body_not_regex: 'x' }, true],
    ['same_origin_recovery_link', { same_origin_recovery_link: true }, true],
  ])('%s', (_key, block, reads) => {
    expect(expectReadsBody(block)).toBe(reads);
  });

  test('a key present but undefined reads nothing, and any body key among others reads the body', () => {
    expect(expectReadsBody({ body_regex: undefined, status: [200] })).toBe(false);
    expect(expectReadsBody({ status: [200], body_regex: 'x' })).toBe(true);
    expect(expectReadsBody({})).toBe(false);
  });
});
