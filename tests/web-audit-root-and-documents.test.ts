// The root fetch and discovery's first document reads run side by side, and
// what the root turns out to be decides how long the reads keep: a root that
// fails at the network level cuts them to the degraded budget, and one that
// redirects to http ends the run. A stalling host costs no more than it would
// with the reads waiting their turn.

import { describe, expect, test } from 'bun:test';
import { type AuditEvent, DEGRADED_PER_CHECK_TIMEOUT_MS, runWebAudit } from '../src/worker/audit-web/engine';
import { ALWAYS_ADMIT_BUDGET } from '../src/worker/audit-web/follow-requests';
import type { WebAuditRegistry } from '../src/worker/audit-web/registry';
import { guardedFetch } from '../src/worker/audit-web/ssrf';
import { stubFetch } from './helpers/stub-fetch';

const BASE = 'https://example.com/';
const DOCUMENT = '/.well-known/mcp.json';
// How long a held answer waits for the request it is watching for before giving
// up, so an engine that never sends that request fails the assertion and does
// not hang the test.
const GIVE_UP_MS = 400;

function registry(commonPaths: string[] = []): WebAuditRegistry {
  return {
    version: 1,
    mcp_discovery: {
      ai_catalog: '/.well-known/ai-catalog.json',
      card_suffix: '/server-card',
      well_known: [DOCUMENT],
      common_paths: commonPaths,
      protocol_version: '2025-06-18',
    },
    category_order: ['discoverability'],
    categories: { discoverability: 'Discoverability' },
    checks: [],
  };
}

function hangUntilAborted(init: RequestInit | undefined, onAbort?: () => void): Promise<Response> {
  return new Promise((_, reject) => {
    const aborted = (): void => {
      onAbort?.();
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (init?.signal?.aborted) aborted();
    else init?.signal?.addEventListener('abort', aborted, { once: true });
  });
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

async function collect(gen: AsyncGenerator<AuditEvent>): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('the root fetch and the document reads run side by side', () => {
  test('a document read goes out while the root is unanswered, and the root reads while it is', async () => {
    let rootOpen = false;
    let documentOpen = false;
    let readWhileRootOpen = false;
    let rootWhileDocumentOpen = false;
    let openDocument = (): void => {};
    const documentHeld = new Promise<void>((resolve) => {
      openDocument = resolve;
      setTimeout(resolve, GIVE_UP_MS);
    });
    const fetchImpl = stubFetch(async (url) => {
      const path = pathOf(url);
      if (path === '/') {
        rootOpen = true;
        await Bun.sleep(10);
        rootWhileDocumentOpen = documentOpen;
        rootOpen = false;
        openDocument();
      }
      if (path === DOCUMENT) {
        readWhileRootOpen = rootOpen;
        documentOpen = true;
        await documentHeld;
        documentOpen = false;
      }
      return new Response('ok', { status: path === '/' ? 200 : 404 });
    });
    await collect(
      runWebAudit({
        url: BASE,
        registry: registry(),
        fetchOptions: { fetchImpl },
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    expect({ readWhileRootOpen, rootWhileDocumentOpen }).toEqual({
      readWhileRootOpen: true,
      rootWhileDocumentOpen: true,
    });
  });

  test('a root failing at the network level cuts a read in flight to the degraded budget from its start', async () => {
    let startedAt = 0;
    let cutAfterMs = -1;
    const fetchImpl = stubFetch((url, init) => {
      const path = pathOf(url);
      if (path === '/') return Promise.reject(new TypeError('connection refused'));
      if (path === DOCUMENT) {
        startedAt = Date.now();
        return hangUntilAborted(init, () => {
          cutAfterMs = Date.now() - startedAt;
        });
      }
      return new Response('', { status: 404 });
    });
    await collect(
      runWebAudit({
        url: BASE,
        registry: registry(),
        fetchOptions: { fetchImpl },
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    expect(cutAfterMs).toBeGreaterThanOrEqual(DEGRADED_PER_CHECK_TIMEOUT_MS - 50);
    expect(cutAfterMs).toBeLessThan(DEGRADED_PER_CHECK_TIMEOUT_MS + 1_500);
  }, 8_000);

  test('a target that answers nothing costs its root timeout, not that plus a turn for the reads', async () => {
    const timeoutMs = 400;
    const fetchImpl = stubFetch((_url, init) => hangUntilAborted(init));
    const started = Date.now();
    const events = await collect(
      runWebAudit({
        url: BASE,
        registry: registry(),
        perCheckTimeoutMs: timeoutMs,
        fetchOptions: { fetchImpl },
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    expect(events.at(-1)?.type).toBe('unreachable');
    expect(Date.now() - started).toBeLessThan(timeoutMs * 2 - 100);
  });

  test('a slow root leaves the POSTs the whole discovery budget, counted from when it settled', async () => {
    let clock = 1_000_000;
    let posts = 0;
    const fetchImpl = stubFetch(async (url, init) => {
      const path = pathOf(url);
      if (path === '/') {
        // After the first tick: discovery's budget starts with the reads, beside the root.
        await Bun.sleep(1);
        clock += 13_000;
        return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (init?.method === 'POST') posts += 1;
      return new Response('', { status: 404 });
    });
    await collect(
      runWebAudit({
        url: BASE,
        registry: registry(['/mcp']),
        now: () => clock,
        fetchOptions: { fetchImpl },
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    expect(posts).toBeGreaterThan(0);
  });

  test('a root redirecting to http ends the run on its answer, stopping reads in flight and sending nothing over http', async () => {
    const asked: string[] = [];
    let documentAborted = false;
    const fetchImpl = stubFetch((url, init) => {
      asked.push(url);
      const path = pathOf(url);
      if (path === '/') return new Response('', { status: 301, headers: { location: 'http://example.com/' } });
      if (path === DOCUMENT) {
        return hangUntilAborted(init, () => {
          documentAborted = true;
        });
      }
      return new Response('', { status: 404 });
    });
    const generator = runWebAudit({
      url: BASE,
      registry: registry(),
      fetchOptions: { fetchImpl },
      domainBudget: ALWAYS_ADMIT_BUDGET,
    });
    const first = await generator.next();
    expect(first.value).toMatchObject({ type: 'unreachable' });
    expect(documentAborted).toBe(true);
    expect(asked.filter((url) => url.startsWith('http:'))).toEqual([]);
    await generator.return(undefined);
  });
});

describe('a discovery failure while the root is still out', () => {
  test('it comes out of the generator, not as a rejection nothing handles', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const broken = { ...registry(), mcp_discovery: { ...registry().mcp_discovery, well_known: null } };
    const fetchImpl = stubFetch(async () => {
      await Bun.sleep(30);
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    let thrown: unknown = null;
    try {
      await collect(
        runWebAudit({
          url: BASE,
          registry: broken as unknown as WebAuditRegistry,
          fetchOptions: { fetchImpl },
          domainBudget: ALWAYS_ADMIT_BUDGET,
        }),
      );
    } catch (error) {
      thrown = error;
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(unhandled).toEqual([]);
  });
});

describe('a slow root and a redirected document', () => {
  test('the document keeps its budget, so the endpoint it names is found and the root is asked once', async () => {
    let rootAsked = 0;
    const fetchImpl = stubFetch(async (url, init) => {
      const path = pathOf(url);
      if (path === '/') {
        rootAsked += 1;
        await Bun.sleep(100);
        return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (path === DOCUMENT) return new Response('', { status: 301, headers: { location: '/cards/mcp.json' } });
      if (path === '/cards/mcp.json') {
        await new Promise((resolve, reject) => {
          const answered = setTimeout(resolve, 50);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(answered);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
        return Response.json({ mcp_endpoint: 'https://example.com/rpc' });
      }
      return new Response('', { status: 404 });
    });
    const events = await collect(
      runWebAudit({
        url: BASE,
        registry: registry(),
        perCheckTimeoutMs: 120,
        fetchOptions: { fetchImpl },
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    expect(events.find((event) => event.type === 'discovery')).toMatchObject({ endpoint: 'https://example.com/rpc' });
    expect(rootAsked).toBe(1);
  });
});

describe('a redirect hop held for the root', () => {
  const answers = (secondHop: (init: RequestInit | undefined) => Promise<Response>) =>
    stubFetch((url, init) =>
      pathOf(url) === '/first' ? new Response('', { status: 301, headers: { location: '/second' } }) : secondHop(init),
    );
  const answersAfter =
    (ms: number) =>
    (init: RequestInit | undefined): Promise<Response> =>
      new Promise((resolve, reject) => {
        const answer = setTimeout(() => resolve(new Response('ok', { status: 200 })), ms);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(answer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });

  test('waits without spending its budget, so a slow root leaves the hop the time it would have had', async () => {
    const response = await guardedFetch(
      'https://example.com/first',
      {},
      { timeoutMs: 120, fetchImpl: answers(answersAfter(60)), laterHopsAfter: Bun.sleep(100) },
    );
    expect({ status: response.status, error: response.error }).toEqual({ status: 200, error: null });
  });

  test('a cut that arrives during the wait counts from where the wait ended', async () => {
    const rootFailed = new AbortController();
    const rootSettled = Bun.sleep(150).then(() => rootFailed.abort());
    const started = Date.now();
    const response = await guardedFetch(
      'https://example.com/first',
      {},
      {
        timeoutMs: 5_000,
        cut: { signal: rootFailed.signal, toMs: 80 },
        fetchImpl: answers(hangUntilAborted),
        laterHopsAfter: rootSettled,
      },
    );
    const elapsed = Date.now() - started;
    expect(response.error).toStartWith('TimeoutError');
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1_500);
  });

  test('the first request goes out without waiting', async () => {
    const asked: string[] = [];
    const held = new Promise<void>(() => {});
    const fetchImpl = stubFetch((url) => {
      asked.push(pathOf(url));
      return new Response('ok', { status: 200 });
    });
    const response = await guardedFetch('https://example.com/first', {}, { fetchImpl, laterHopsAfter: held });
    expect(response.status).toBe(200);
    expect(asked).toEqual(['/first']);
  });
});

describe('a request cut', () => {
  const hanging = stubFetch((_url, init) => hangUntilAborted(init));

  async function timeToFailure(
    timeoutMs: number,
    toMs: number,
    cutAfterMs: number | 'before',
  ): Promise<{ ms: number; error: string | null }> {
    const signal = new AbortController();
    if (cutAfterMs === 'before') signal.abort();
    else setTimeout(() => signal.abort(), cutAfterMs);
    const started = Date.now();
    const response = await guardedFetch(
      BASE,
      {},
      { timeoutMs, fetchImpl: hanging, cut: { signal: signal.signal, toMs } },
    );
    return { ms: Date.now() - started, error: response.error };
  }

  test('it shortens a request in flight to the cut budget from its start', async () => {
    const { ms, error } = await timeToFailure(5_000, 80, 10);
    expect(error).toStartWith('TimeoutError');
    expect(ms).toBeGreaterThanOrEqual(70);
    expect(ms).toBeLessThan(1_000);
  });

  test('a request already past the cut budget stops at once', async () => {
    const { ms, error } = await timeToFailure(5_000, 20, 120);
    expect(error).toStartWith('TimeoutError');
    expect(ms).toBeGreaterThanOrEqual(110);
    expect(ms).toBeLessThan(1_000);
  });

  test('a request started after the cut takes the cut budget from the outset', async () => {
    const { ms, error } = await timeToFailure(5_000, 50, 'before');
    expect(error).toStartWith('TimeoutError');
    expect(ms).toBeLessThan(1_000);
  });

  test('it never lengthens a request', async () => {
    const { ms, error } = await timeToFailure(60, 5_000, 10);
    expect(error).toStartWith('TimeoutError');
    expect(ms).toBeLessThan(1_000);
  });
});
