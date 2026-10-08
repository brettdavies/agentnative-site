// An audit asks the target for each distinct request once. A row that
// needs an answer another row already received reads that answer instead
// of reaching the target again, so a site is not charged twice for one
// question and a second fetch cannot disagree with the first. A request
// goes out again only when the answer on record cannot serve the caller:
// it holds less of the body than the caller reads, or it arrived later than
// the caller's deadline allows. A caller that skips the body still leaves
// the body in the memo for one that reads it.

import { describe, expect, test } from 'bun:test';
import { loadRegistry, stubFetchFor } from '../scripts/web-audit/conformance-corpus';
import { SCENARIOS } from '../scripts/web-audit/conformance-scenarios';
import { runWebAudit } from '../src/worker/audit-web/engine';
import { ALWAYS_ADMIT_BUDGET } from '../src/worker/audit-web/follow-requests';
import { createRequestMemo, type MemoStats } from '../src/worker/audit-web/request-hop';
import { guardedFetch } from '../src/worker/audit-web/ssrf';
import { stubFetch } from './helpers/stub-fetch';

const URL_A = 'https://example.com/robots.txt';

/** A stub target that records every request it receives. */
function target(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const received: string[] = [];
  const fetchImpl = stubFetch((url, init) => {
    received.push(`${init?.method ?? 'GET'} ${url}`);
    return answer(url, init);
  });
  return { received, fetchImpl };
}

const ABORTED = () => new DOMException('deadline exceeded', 'AbortError');

/** Never answers; rejects as an aborted fetch does, at once when the signal has already fired. */
function hang(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    if (init?.signal?.aborted) reject(ABORTED());
    init?.signal?.addEventListener('abort', () => reject(ABORTED()));
  });
}

/**
 * A response whose status and headers arrive at once and whose body sends
 * one chunk, then stalls until the caller aborts or the reader cancels it.
 * `cancelled` reports whether a reader gave up on the body.
 */
function stallsAfterHeaders(status: number, headers: Record<string, string>) {
  const state = { cancelled: false };
  const answer = (_url: string, init?: RequestInit): Response => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":'));
        init?.signal?.addEventListener('abort', () => controller.error(ABORTED()));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return new Response(body, { status, headers });
  };
  return Object.assign(answer, { state });
}

/** A response whose status and headers arrive at once and whose body arrives whole after `delayMs`. */
function bodyAfter(delayMs: number, text: string) {
  return (_url: string, init?: RequestInit): Response => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await Bun.sleep(delayMs);
        if (init?.signal?.aborted) return controller.error(ABORTED());
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    return new Response(body);
  };
}

describe('guardedFetch with an audit request memo', () => {
  test('an identical request reads the answer already received, as a copy of its own', async () => {
    const { received, fetchImpl } = target(() => new Response('User-agent: *', { headers: { 'x-a': '1' } }));
    const memo = createRequestMemo();
    const first = await guardedFetch(URL_A, {}, { fetchImpl, memo });
    const second = await guardedFetch(URL_A, {}, { fetchImpl, memo });
    first.headers['x-a'] = 'changed';
    expect(received).toEqual([`GET ${URL_A}`]);
    expect([second.status, second.body, second.headers['x-a']]).toEqual([200, 'User-agent: *', '1']);
  });

  test('the memo counts the hops it sent and answered from the record, and the body bytes it kept', async () => {
    const { fetchImpl } = target(() => new Response('User-agent: *'));
    const memo = createRequestMemo();
    const llms = 'https://example.com/llms.txt';
    await guardedFetch(URL_A, {}, { fetchImpl, memo });
    await guardedFetch(URL_A, {}, { fetchImpl, memo });
    await guardedFetch(llms, {}, { fetchImpl, memo, maxBodyBytes: 0 });
    await guardedFetch(llms, {}, { fetchImpl, memo });
    expect(memo.stats).toEqual({
      sent: 2,
      reused: 2,
      retainedBytes: 26,
      bodiesRetained: 2,
      largestBodyBytes: 13,
      overBodyCap: 0,
      overTotalCap: 0,
      readsOpen: 0,
    });
  });

  test('requests that differ in method, header, or body each reach the target', async () => {
    const { received, fetchImpl } = target(() => new Response('ok'));
    const memo = createRequestMemo();
    await guardedFetch(URL_A, {}, { fetchImpl, memo });
    await guardedFetch(URL_A, { headers: { accept: 'text/markdown' } }, { fetchImpl, memo });
    await guardedFetch(URL_A, { method: 'POST', body: 'a' }, { fetchImpl, memo });
    await guardedFetch(URL_A, { method: 'POST', body: 'b' }, { fetchImpl, memo });
    expect(received.length).toBe(4);
  });

  test('concurrent identical requests share one request', async () => {
    const { received, fetchImpl } = target(() => new Response('ok'));
    const memo = createRequestMemo();
    const answers = await Promise.all([1, 2, 3].map(() => guardedFetch(URL_A, {}, { fetchImpl, memo })));
    expect(received.length).toBe(1);
    expect(answers.map((a) => a.body)).toEqual(['ok', 'ok', 'ok']);
  });

  test('a status-only probe and a body reader share one request in either order', async () => {
    const readerFirst = target(() => new Response('# Guide\n'));
    const memo = createRequestMemo();
    const reader = await guardedFetch(URL_A, {}, { fetchImpl: readerFirst.fetchImpl, memo });
    const statusOnly = await guardedFetch(URL_A, {}, { fetchImpl: readerFirst.fetchImpl, memo, maxBodyBytes: 0 });
    expect([reader.body, statusOnly.status, statusOnly.body, readerFirst.received.length]).toEqual([
      '# Guide\n',
      200,
      '',
      1,
    ]);

    const statusFirst = target(() => new Response('# Guide\n'));
    const other = createRequestMemo();
    await guardedFetch(URL_A, {}, { fetchImpl: statusFirst.fetchImpl, memo: other, maxBodyBytes: 0 });
    const later = await guardedFetch(URL_A, {}, { fetchImpl: statusFirst.fetchImpl, memo: other });
    expect([later.body, statusFirst.received.length]).toEqual(['# Guide\n', 1]);
  });

  test('a retry that serves less than the answer on record does not replace it', async () => {
    let calls = 0;
    const { received, fetchImpl } = target(() =>
      ++calls === 1 ? new Response('0123456789') : Promise.reject(new TypeError('connection reset')),
    );
    const memo = createRequestMemo();
    await guardedFetch(URL_A, {}, { fetchImpl, memo, maxBodyBytes: 4 });
    const failed = await guardedFetch(URL_A, {}, { fetchImpl, memo });
    const capped = await guardedFetch(URL_A, {}, { fetchImpl, memo, maxBodyBytes: 4 });
    expect([failed.error, capped.body, received.length]).toEqual(['TypeError: connection reset', '0123', 2]);
  });

  test('a body cut at a smaller cap than the next caller reads is asked for again', async () => {
    const { received, fetchImpl } = target(() => new Response('0123456789'));
    const memo = createRequestMemo();
    const capped = await guardedFetch(URL_A, {}, { fetchImpl, memo, maxBodyBytes: 4 });
    const full = await guardedFetch(URL_A, {}, { fetchImpl, memo });
    const smaller = await guardedFetch(URL_A, {}, { fetchImpl, memo, maxBodyBytes: 2 });
    expect([capped.body, capped.truncated, full.body, smaller.body, smaller.truncated]).toEqual([
      '0123',
      true,
      '0123456789',
      '01',
      true,
    ]);
    expect(received.length).toBe(2);
  });

  test('a timeout answers only a caller whose deadline is no longer', async () => {
    const { received, fetchImpl } = target(hang);
    const memo = createRequestMemo();
    const timedOut = await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 40 });
    const shorter = await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 20 });
    expect([timedOut.error, shorter.error, received.length]).toEqual([
      'TimeoutError: deadline exceeded',
      'TimeoutError: deadline exceeded',
      1,
    ]);
    await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 60 });
    expect(received.length).toBe(2);
  });

  test('an answer that took longer than the next caller allows is asked for again', async () => {
    const { received, fetchImpl } = target(() => Bun.sleep(60).then(() => new Response('slow')));
    const memo = createRequestMemo();
    await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 1_000 });
    await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 20 });
    expect(received.length).toBe(2);
  });

  test('a redirect one caller followed answers callers that keep it, with or without its body', async () => {
    const card = 'https://example.com/.well-known/mcp.json';
    const canonical = 'https://example.com/mcp/server-card';
    const { received, fetchImpl } = target((url) =>
      url === card ? new Response('Moved', { status: 301, headers: { location: canonical } }) : new Response('{}'),
    );
    const memo = createRequestMemo();
    const followed = await guardedFetch(card, {}, { fetchImpl, memo });
    const kept = await guardedFetch(card, {}, { fetchImpl, memo, followRedirects: false, maxBodyBytes: 0 });
    expect([followed.status, kept.status, kept.headers.location]).toEqual([200, 301, canonical]);
    expect(received).toEqual([`GET ${card}`, `GET ${canonical}`]);
    const withBody = await guardedFetch(card, {}, { fetchImpl, memo, followRedirects: false });
    expect([withBody.body, received.length]).toEqual(['Moved', 2]);
  });

  test('a redirect one caller followed answers a caller that may keep cross-origin redirects', async () => {
    const endpoint = 'https://example.com/mcp';
    const { received, fetchImpl } = target((url) =>
      url === endpoint
        ? new Response('Moved', { status: 308, headers: { location: `${endpoint}/` } })
        : new Response('{"ok":true}'),
    );
    const memo = createRequestMemo();
    await guardedFetch(endpoint, {}, { fetchImpl, memo });
    const returning = await guardedFetch(endpoint, {}, { fetchImpl, memo, crossOriginRedirects: 'return' });
    expect([returning.status, returning.body]).toEqual([200, '{"ok":true}']);
    expect(received).toEqual([`GET ${endpoint}`, `GET ${endpoint}/`]);
  });

  test('a status-only probe answers at the headers while the memo reads a stalling body within its deadline', async () => {
    const { received, fetchImpl } = target(stallsAfterHeaders(200, {}));
    const memo = createRequestMemo();
    const started = Date.now();
    const statusOnly = await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 80, maxBodyBytes: 0 });
    const statusMs = Date.now() - started;
    const reader = await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 80 });
    expect([statusOnly.status, statusOnly.error, statusMs < 40]).toEqual([200, null, true]);
    expect([reader.error, received.length]).toEqual(['TimeoutError: deadline exceeded', 1]);
  });

  test("the memo's body read stops at the status-only caller's deadline when nobody waits on it", async () => {
    const stalling = stallsAfterHeaders(200, {});
    const { fetchImpl } = target(stalling);
    const memo = createRequestMemo();
    await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 40, maxBodyBytes: 0 });
    expect([stalling.state.cancelled, memo.stats.readsOpen]).toEqual([false, 1]);
    await Bun.sleep(80);
    expect([stalling.state.cancelled, memo.stats.readsOpen, memo.stats.retainedBytes]).toEqual([true, 0, 0]);
  });

  test("a body reader that joins the memo's body read late in its budget still reads the body", async () => {
    const { received, fetchImpl } = target(bodyAfter(300, 'BODY'));
    const memo = createRequestMemo();
    const statusOnly = guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 1_000, maxBodyBytes: 0 });
    await Bun.sleep(200);
    const reader = await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 350 });
    await statusOnly;
    expect([reader.body, reader.error, received.length]).toEqual(['BODY', null, 1]);
  });

  test("a body reader with a later deadline pushes the memo's body read back to it", async () => {
    const { received, fetchImpl } = target(bodyAfter(150, 'BODY'));
    const memo = createRequestMemo();
    await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 80, maxBodyBytes: 0 });
    const reader = await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 400 });
    expect([reader.body, reader.error, received.length]).toEqual(['BODY', null, 1]);
  });

  test("a status-only caller does not wait for a concurrent body reader's stalled body", async () => {
    const { received, fetchImpl } = target(stallsAfterHeaders(404, { 'ratelimit-limit': '100' }));
    const memo = createRequestMemo();
    const reader = guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 300, maxBodyBytes: 65_536 });
    await Bun.sleep(10);
    const started = Date.now();
    const statusOnly = await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 300, maxBodyBytes: 0 });
    const statusMs = Date.now() - started;
    expect([statusOnly.status, statusOnly.headers['ratelimit-limit'], statusMs < 100]).toEqual([404, '100', true]);
    expect([(await reader).error, received.length]).toEqual(['TimeoutError: deadline exceeded', 1]);
  });

  test('a body read that fails after the headers still answers a status-only caller', async () => {
    const { received, fetchImpl } = target(stallsAfterHeaders(404, { 'ratelimit-limit': '100' }));
    const memo = createRequestMemo();
    const reader = await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 60, maxBodyBytes: 65_536 });
    const statusOnly = await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 60, maxBodyBytes: 0 });
    const sameReader = await guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 60, maxBodyBytes: 65_536 });
    expect([reader.status, reader.error]).toEqual([null, 'TimeoutError: deadline exceeded']);
    expect([statusOnly.status, statusOnly.error, statusOnly.headers['ratelimit-limit']]).toEqual([404, null, '100']);
    expect([sameReader.error, received.length]).toEqual(['TimeoutError: deadline exceeded', 1]);
  });

  test('a caller waiting on an identical request in flight gives up at its own deadline', async () => {
    const { received, fetchImpl } = target(() => Bun.sleep(300).then(() => new Response('late')));
    const memo = createRequestMemo();
    const started = Date.now();
    const [slow, hurried] = await Promise.all([
      guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 2_000 }),
      Bun.sleep(5).then(() => guardedFetch(URL_A, {}, { fetchImpl, memo, timeoutMs: 50 })),
    ]);
    expect([slow.body, hurried.error, received.length]).toEqual(['late', 'TimeoutError: deadline exceeded', 1]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  test('a connection error answers a later caller whose deadline it arrived within', async () => {
    const { received, fetchImpl } = target(() => Promise.reject(new TypeError('connection reset')));
    const memo = createRequestMemo();
    const first = await guardedFetch(URL_A, {}, { fetchImpl, memo });
    const second = await guardedFetch(URL_A, {}, { fetchImpl, memo });
    expect([first.error, second.error, received.length]).toEqual([
      'TypeError: connection reset',
      'TypeError: connection reset',
      1,
    ]);
  });

  test('a body past the memo cap reaches its reader but is asked for again by the next reader', async () => {
    const big = 'x'.repeat(1024 * 1024 + 1);
    const { received, fetchImpl } = target(() => new Response(big));
    const memo = createRequestMemo();
    const first = await guardedFetch(URL_A, {}, { fetchImpl, memo });
    const statusOnly = await guardedFetch(URL_A, {}, { fetchImpl, memo, maxBodyBytes: 0 });
    expect([first.body.length, statusOnly.status, received.length]).toEqual([big.length, 200, 1]);
    const second = await guardedFetch(URL_A, {}, { fetchImpl, memo });
    expect([second.body.length, received.length]).toEqual([big.length, 2]);
    expect(memo.stats).toMatchObject({ sent: 2, reused: 1, retainedBytes: 0, overBodyCap: 2, overTotalCap: 0 });
  });

  test('the memo stops holding bodies once an audit holds 8 MiB of them', async () => {
    const megabyte = 'y'.repeat(1024 * 1024);
    const { received, fetchImpl } = target(() => new Response(megabyte));
    const memo = createRequestMemo();
    const urls = Array.from({ length: 9 }, (_, i) => `https://example.com/page-${i}`);
    for (const url of urls) await guardedFetch(url, {}, { fetchImpl, memo });
    await guardedFetch(urls[0], {}, { fetchImpl, memo });
    await guardedFetch(urls[8], {}, { fetchImpl, memo });
    expect(received.length).toBe(10);
    expect(memo.stats).toMatchObject({
      sent: 10,
      reused: 1,
      retainedBytes: 8 * megabyte.length,
      bodiesRetained: 8,
      largestBodyBytes: megabyte.length,
      overBodyCap: 0,
      overTotalCap: 2,
    });
  });

  test('a memo-held redirect is still checked by the guard before a caller follows it', async () => {
    const card = 'https://example.com/.well-known/mcp.json';
    const metadataHost = 'https://169.254.169.254/latest/meta-data/';
    const { received, fetchImpl } = target(
      () => new Response(null, { status: 302, headers: { location: metadataHost } }),
    );
    const memo = createRequestMemo();
    const kept = await guardedFetch(card, {}, { fetchImpl, memo, followRedirects: false, maxBodyBytes: 0 });
    const followed = await guardedFetch(card, {}, { fetchImpl, memo });
    expect(kept.status).toBe(302);
    expect(followed.error).toContain('(redirect hop 1)');
    expect(received).toEqual([`GET ${card}`]);
  });

  test('a cross-origin redirect one caller kept is refused for a caller that refuses cross-origin hops', async () => {
    const endpoint = 'https://example.com/mcp';
    const elsewhere = 'https://other.example.net/mcp';
    const { received, fetchImpl } = target(() => new Response(null, { status: 307, headers: { location: elsewhere } }));
    const memo = createRequestMemo();
    const returned = await guardedFetch(endpoint, {}, { fetchImpl, memo, crossOriginRedirects: 'return' });
    const refused = await guardedFetch(endpoint, {}, { fetchImpl, memo, crossOriginRedirects: 'refuse' });
    expect([returned.status, refused.error]).toEqual([307, `redirect refused: 307 to ${elsewhere}`]);
    expect(received).toEqual([`GET ${endpoint}`]);
  });

  test('without a memo every call reaches the target', async () => {
    const { received, fetchImpl } = target(() => new Response('ok'));
    await guardedFetch(URL_A, {}, { fetchImpl });
    await guardedFetch(URL_A, {}, { fetchImpl });
    expect(received.length).toBe(2);
  });
});

/** Method, URL, headers and body of one outgoing request: what the target sees. */
function requestOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const headers: string[] = [];
  new Headers(init?.headers).forEach((value, name) => {
    headers.push(`${name}: ${value}`);
  });
  const body = init?.body === undefined || init.body === null ? '' : String(init.body);
  return JSON.stringify([(init?.method ?? 'GET').toUpperCase(), url, headers.sort(), body]);
}

describe('an audit sends each distinct request once', () => {
  const registry = loadRegistry();

  test('no conformance scenario sends a request it already sent', async () => {
    const repeated: Record<string, string[]> = {};
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      const stub = stubFetchFor(scenario, { unmatched: [] });
      const sent = new Map<string, number>();
      const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = requestOf(input, init);
        sent.set(request, (sent.get(request) ?? 0) + 1);
        return stub(input, init);
      }) as typeof fetch;
      for await (const _event of runWebAudit({
        url: scenario.target,
        registry,
        siteType: scenario.site_type,
        specVersion: scenario.spec_version,
        followDeclarations: scenario.follow_declarations ?? true,
        domainBudget: ALWAYS_ADMIT_BUDGET,
        fetchOptions: { fetchImpl },
        now: () => 0,
      })) {
        // drain the audit
      }
      const again = [...sent].filter(([, count]) => count > 1).map(([request, count]) => `x${count} ${request}`);
      if (again.length > 0) repeated[name] = again;
    }
    expect(repeated).toEqual({});
  });

  test("an audit's complete event reports every request it sent and the body bytes its memo kept", async () => {
    const scenario = SCENARIOS['run-healthy'];
    const stub = stubFetchFor(scenario, { unmatched: [] });
    let received = 0;
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      received += 1;
      return stub(input, init);
    }) as typeof fetch;
    let memo: MemoStats | undefined;
    for await (const event of runWebAudit({
      url: scenario.target,
      registry,
      siteType: scenario.site_type,
      specVersion: scenario.spec_version,
      followDeclarations: scenario.follow_declarations ?? true,
      domainBudget: ALWAYS_ADMIT_BUDGET,
      fetchOptions: { fetchImpl },
      now: () => 0,
    })) {
      if (event.type === 'complete') memo = event.memo;
    }
    expect(memo?.sent).toBe(received);
    expect(memo?.reused).toBeGreaterThan(0);
    expect(memo?.bodiesRetained).toBeGreaterThan(0);
    expect(memo?.retainedBytes).toBeGreaterThanOrEqual(memo?.largestBodyBytes ?? 0);
    expect(memo?.largestBodyBytes).toBeGreaterThan(0);
  });
});
