// A check starts when what it reads has settled, not when the slowest source
// has: one stalled source holds one slot and the checks that read it, and every
// other check runs on. Under that schedule the cap, the gate and registry order
// in the scorecard all hold as they would in any order.

import { describe, expect, test } from 'bun:test';
import { loadRegistry, stubFetchFor } from '../scripts/web-audit/conformance-corpus';
import { SCENARIOS } from '../scripts/web-audit/conformance-scenarios';
import { type AuditEvent, runWebAudit } from '../src/worker/audit-web/engine';
import { ALWAYS_ADMIT_BUDGET } from '../src/worker/audit-web/follow-requests';
import type { WebAuditRegistry, WebCheck } from '../src/worker/audit-web/registry';
import { stubFetch } from './helpers/stub-fetch';

const BASE = 'https://example.com/';
const HTML = { 'content-type': 'text/html' };
// How long a held answer waits for the request it is watching for before giving
// up, so an engine that never sends that request fails the assertion and does
// not hang the test.
const GIVE_UP_MS = 400;

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

function pathRow(id: string, path: string, partial: Partial<WebCheck> = {}): WebCheck {
  return makeCheck({ id, with: { path, expect: { status: [200] } }, ...partial });
}

function registryOf(checks: WebCheck[]): WebAuditRegistry {
  return {
    version: 1,
    mcp_discovery: {
      ai_catalog: '/.well-known/ai-catalog.json',
      card_suffix: '/server-card',
      well_known: ['/.well-known/mcp.json'],
      common_paths: [],
      protocol_version: '2025-06-18',
    },
    category_order: ['discoverability'],
    categories: { discoverability: 'Discoverability' },
    checks,
  };
}

function audit(checks: WebCheck[], fetchImpl: typeof fetch, concurrency?: number): AsyncGenerator<AuditEvent> {
  return runWebAudit({
    url: BASE,
    registry: registryOf(checks),
    concurrency,
    fetchOptions: { fetchImpl },
    domainBudget: ALWAYS_ADMIT_BUDGET,
  });
}

async function collect(gen: AsyncGenerator<AuditEvent>): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

/** A promise settled by `open`, or by itself after GIVE_UP_MS. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
    setTimeout(resolve, GIVE_UP_MS);
  });
  return { opened, open };
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

describe('a check starts when what it reads has settled', () => {
  test('a check with nothing to read starts while a source is still reading', async () => {
    const seen = gate();
    let sourceOpen = false;
    let startedWhileOpen = false;
    const fetchImpl = stubFetch(async (url) => {
      const path = pathOf(url);
      if (path === '/llms-full.txt') {
        sourceOpen = true;
        await seen.opened;
        sourceOpen = false;
      }
      if (path === '/security.txt') {
        startedWhileOpen = sourceOpen;
        seen.open();
      }
      return new Response('ok', { status: 200, headers: HTML });
    });
    await collect(
      audit(
        [pathRow('llms-full-txt', '/llms-full.txt', { antecedent: 'docs-site' }), pathRow('security', '/security.txt')],
        fetchImpl,
      ),
    );
    expect(startedWhileOpen).toBe(true);
  });

  test('a dependent check starts once its own source settles, while an unrelated source still reads', async () => {
    const seen = gate();
    let slowOpen = false;
    let startedWhileSlowOpen = false;
    let robotsSettled = false;
    let startedAfterItsSource = false;
    const fetchImpl = stubFetch(async (url) => {
      const path = pathOf(url);
      if (path === '/llms-full.txt') {
        slowOpen = true;
        await seen.opened;
        slowOpen = false;
      }
      if (path === '/robots.txt') {
        await Bun.sleep(5);
        queueMicrotask(() => {
          robotsSettled = true;
        });
      }
      if (path === '/dependent') {
        startedWhileSlowOpen = slowOpen;
        startedAfterItsSource = robotsSettled;
        seen.open();
      }
      return new Response('ok', { status: 200, headers: HTML });
    });
    const events = await collect(
      audit(
        [
          pathRow('llms-full-txt', '/llms-full.txt', { antecedent: 'docs-site' }),
          pathRow('robots', '/robots.txt'),
          pathRow('robots-rule', '/dependent', { antecedent: 'robots-present' }),
        ],
        fetchImpl,
      ),
    );
    expect({ startedWhileSlowOpen, startedAfterItsSource }).toEqual({
      startedWhileSlowOpen: true,
      startedAfterItsSource: true,
    });
    expect(events.some((e) => e.type === 'result' && e.result.id === 'robots-rule' && e.result.status === 'pass')).toBe(
      true,
    );
  });

  test('a check waits for the source its handler reads even when its antecedent reads nothing', async () => {
    const order: string[] = [];
    const twin = '# Twin\n\n'.padEnd(600, 'x');
    const fetchImpl = stubFetch(async (url) => {
      const path = pathOf(url);
      order.push(path);
      if (path === '/') return new Response('<html><body></body></html>', { status: 200, headers: HTML });
      if (path === '/llms.txt') {
        await Bun.sleep(20);
        return new Response('# Site\n\n> S\n\n- [Docs](https://example.com/docs/a.md)\n', { status: 200 });
      }
      if (path === '/docs/a.md') return new Response(twin, { status: 200 });
      return new Response('', { status: 404 });
    });
    const events = await collect(
      audit(
        [
          makeCheck({ id: 'content-without-js', handler: 'content-without-js', antecedent: 'html-root' }),
          makeCheck({
            id: 'llms-txt',
            with: { path: '/llms.txt', retain_body: true, expect: { status: [200] } },
          }),
        ],
        fetchImpl,
      ),
    );
    expect(order).toContain('/docs/a.md');
    expect(
      events.some((e) => e.type === 'result' && e.result.id === 'content-without-js' && e.result.status === 'n_a'),
    ).toBe(true);
  });

  test('a result reaches the consumer while an unrelated source still reads', async () => {
    const release = gate();
    let sourceFinished = false;
    const fetchImpl = stubFetch(async (url) => {
      if (pathOf(url) === '/llms-full.txt') {
        await release.opened;
        sourceFinished = true;
      }
      return new Response('ok', { status: 200, headers: HTML });
    });
    const generator = audit(
      [pathRow('llms-full-txt', '/llms-full.txt', { antecedent: 'docs-site' }), pathRow('security', '/security.txt')],
      fetchImpl,
    );
    let firstResultBeforeSource: boolean | null = null;
    for await (const event of generator) {
      if (event.type === 'result' && firstResultBeforeSource === null) {
        firstResultBeforeSource = !sourceFinished;
        release.open();
      }
    }
    expect(firstResultBeforeSource).toBe(true);
  });

  test('a check its gate rules out takes no slot: it reports while every slot is held', async () => {
    const release = gate();
    let heldOpen = false;
    const fetchImpl = stubFetch(async (url) => {
      const path = pathOf(url);
      if (path === '/held') {
        heldOpen = true;
        await release.opened;
        heldOpen = false;
      }
      if (path === '/robots.txt') return new Response('', { status: 404 });
      return new Response('ok', { status: 200, headers: HTML });
    });
    const generator = audit(
      [
        pathRow('robots', '/robots.txt'),
        pathRow('held', '/held'),
        pathRow('robots-rule', '/robots-rule', { antecedent: 'robots-present' }),
      ],
      fetchImpl,
      1,
    );
    let gatedWhileHeld: boolean | null = null;
    for await (const event of generator) {
      if (event.type === 'result' && event.result.id === 'robots-rule') {
        gatedWhileHeld = heldOpen && event.result.status === 'n_a';
        release.open();
      }
    }
    expect(gatedWhileHeld).toBe(true);
  });
});

describe('the MCP step', () => {
  const card = JSON.stringify({ mcp_endpoint: 'https://example.com/mcp' });
  const mcpRow = (id: string, op: string, antecedent: WebCheck['antecedent']): WebCheck =>
    makeCheck({ id, handler: 'mcp', antecedent, site_types: ['mcp'], with: { op } });

  test('every later MCP request follows the notification, and a check outside MCP does not wait for it', async () => {
    const seen = gate();
    let notifyOpen = false;
    let notified = false;
    let otherStartedWhileNotifying = false;
    let toolsListAfterNotify = false;
    const fetchImpl = stubFetch(async (url, init) => {
      const path = pathOf(url);
      if (path === '/.well-known/mcp.json') {
        return new Response(card, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/robots.txt') {
        await Bun.sleep(10);
        return new Response('ok', { status: 200 });
      }
      if (path === '/robots-rule') {
        otherStartedWhileNotifying = notifyOpen;
        seen.open();
        return new Response('ok', { status: 200 });
      }
      if (path !== '/mcp') return new Response('ok', { status: path === '/' ? 200 : 404, headers: HTML });
      const body = String(init?.body ?? '');
      if (body.includes('notifications/initialized')) {
        notifyOpen = true;
        await seen.opened;
        notifyOpen = false;
        notified = true;
        return new Response('', { status: 202 });
      }
      if (body.includes('"tools/list"')) toolsListAfterNotify = notified;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [], capabilities: {} } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'sid-1' },
      });
    });
    await collect(
      audit(
        [
          mcpRow('mcp-initialize', 'initialize', 'mcp-present'),
          mcpRow('mcp-server-discover', 'server-discover', 'mcp-session'),
          mcpRow('mcp-tools-list', 'tools-list', 'mcp-session'),
          pathRow('robots', '/robots.txt'),
          pathRow('robots-rule', '/robots-rule', { antecedent: 'robots-present' }),
        ],
        fetchImpl,
      ),
    );
    expect({ otherStartedWhileNotifying, toolsListAfterNotify }).toEqual({
      otherStartedWhileNotifying: true,
      toolsListAfterNotify: true,
    });
  });
});

describe('the session notification', () => {
  const scenario = SCENARIOS['mcp-stateful-session'];

  test('no request carrying the session goes out until the notification has settled, across every registry check', async () => {
    const stub = stubFetchFor(scenario, { unmatched: [] });
    let notified = false;
    const carrying: Array<{ url: string; beforeNotified: boolean }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      if (body.includes('notifications/initialized')) {
        // Long enough for a row that did not wait to have sent its request.
        await Bun.sleep(30);
        const answer = await stub(input, init);
        notified = true;
        return answer;
      }
      if (new Headers(init?.headers).has('mcp-session-id')) {
        carrying.push({ url: String(input), beforeNotified: !notified });
      }
      return stub(input, init);
    }) as typeof fetch;
    for await (const _event of runWebAudit({
      url: scenario.target,
      registry: loadRegistry(),
      siteType: scenario.site_type,
      specVersion: scenario.spec_version,
      domainBudget: ALWAYS_ADMIT_BUDGET,
      fetchOptions: { fetchImpl },
    })) {
      // drain the audit
    }
    expect(notified).toBe(true);
    expect(carrying.length).toBeGreaterThan(0);
    expect(carrying.filter((request) => request.beforeNotified)).toEqual([]);
  });

  test('a server with no session is sent no notification, and its rows still run', async () => {
    const sent: string[] = [];
    const card = JSON.stringify({ mcp_endpoint: 'https://example.com/mcp' });
    const fetchImpl = stubFetch(async (url, init) => {
      const path = pathOf(url);
      if (path === '/.well-known/mcp.json') {
        return new Response(card, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path !== '/mcp') return new Response('ok', { status: path === '/' ? 200 : 404, headers: HTML });
      sent.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const events = await collect(
      audit(
        [
          makeCheck({ id: 'mcp-initialize', handler: 'mcp', antecedent: 'mcp-present', with: { op: 'initialize' } }),
          makeCheck({ id: 'mcp-tools-list', handler: 'mcp', antecedent: 'mcp-session', with: { op: 'tools-list' } }),
        ],
        fetchImpl,
      ),
    );
    expect(sent.some((body) => body.includes('notifications/initialized'))).toBe(false);
    expect(sent.some((body) => body.includes('"tools/list"'))).toBe(true);
    expect(events.at(-1)?.type).toBe('complete');
  });
});

describe('which work a free slot goes to', () => {
  const card = JSON.stringify({ mcp_endpoint: 'https://example.com/mcp' });

  test('MCP rows go ahead of later rows that were ready first, as the MCP steps go ahead of both', async () => {
    const order: string[] = [];
    const fetchImpl = stubFetch(async (url, init) => {
      const path = pathOf(url);
      if (path === '/.well-known/mcp.json') {
        return new Response(card, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/mcp') {
        const body = String(init?.body ?? '');
        order.push(body.includes('"tools/list"') ? 'tools/list' : 'handshake');
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.startsWith('/static-')) {
        order.push(path);
        await Bun.sleep(5);
      }
      return new Response('ok', { status: path === '/' ? 200 : 404, headers: HTML });
    });
    await collect(
      audit(
        [
          makeCheck({ id: 'mcp-initialize', handler: 'mcp', antecedent: 'mcp-present', with: { op: 'initialize' } }),
          makeCheck({
            id: 'mcp-server-discover',
            handler: 'mcp',
            antecedent: 'mcp-session',
            with: { op: 'server-discover' },
          }),
          makeCheck({ id: 'mcp-tools-list', handler: 'mcp', antecedent: 'mcp-session', with: { op: 'tools-list' } }),
          ...Array.from({ length: 8 }, (_, i) => pathRow(`static-${i}`, `/static-${i}`)),
        ],
        fetchImpl,
        2,
      ),
    );
    // Both slots are busy with the wire probes while the rows queue, so at most
    // the two that take them as the wire probes end can start first.
    expect(order.indexOf('tools/list')).toBeLessThan(order.indexOf('/static-3'));
  });

  test('a source whose handler throws keeps its error row, and what is gated on it reads not applicable', async () => {
    const fetchImpl = stubFetch(
      async (url) => new Response('ok', { status: pathOf(url) === '/' ? 200 : 404, headers: HTML }),
    );
    const events = await collect(
      audit(
        [
          pathRow('llms-txt', '/llms.txt', { antecedent: 'none' }),
          makeCheck({
            id: 'llms-full-txt',
            antecedent: 'docs-site',
            handler: 'not-a-handler' as WebCheck['handler'],
            with: { path: '/llms-full.txt', expect: { status: [200] } },
          }),
          pathRow('scoped', '/scoped', { antecedent: 'root-llms-full-txt' }),
        ],
        fetchImpl,
      ),
    );
    const rows = new Map(events.flatMap((e) => (e.type === 'result' ? [[e.result.id, e.result]] : [])));
    expect(rows.get('llms-full-txt')).toMatchObject({
      status: 'error',
      evidence: 'handler error: no handler registered for "not-a-handler"',
    });
    expect(rows.get('scoped')?.status).toBe('n_a');
  });

  test('a source outside the declared site type reads not applicable even when its handler throws', async () => {
    const fetchImpl = stubFetch(
      async (url) => new Response('ok', { status: pathOf(url) === '/' ? 200 : 404, headers: HTML }),
    );
    const events = await collect(
      runWebAudit({
        url: BASE,
        registry: registryOf([
          makeCheck({
            id: 'openapi',
            antecedent: 'api-surface',
            site_types: ['api'],
            handler: 'not-a-handler' as WebCheck['handler'],
            with: { path: '/openapi.json', expect: { status: [200] } },
          }),
        ]),
        siteType: 'content',
        fetchOptions: { fetchImpl },
        domainBudget: ALWAYS_ADMIT_BUDGET,
      }),
    );
    const row = events.flatMap((e) => (e.type === 'result' ? [e.result] : []))[0];
    expect(row).toMatchObject({ status: 'n_a', evidence: 'not applicable to the declared site type' });
  });

  test('a source the deadline got to first keeps its skip row', async () => {
    let clock = 1_000_000;
    const fetchImpl = stubFetch(async (url) => {
      if (pathOf(url) === '/') clock += 60_000;
      return new Response('ok', { status: 404, headers: HTML });
    });
    const events = [];
    for await (const event of runWebAudit({
      url: BASE,
      registry: registryOf([
        makeCheck({
          id: 'llms-full-txt',
          antecedent: 'docs-site',
          with: { path: '/llms-full.txt', expect: { status: [200] } },
        }),
      ]),
      now: () => clock,
      fetchOptions: { fetchImpl },
      domainBudget: ALWAYS_ADMIT_BUDGET,
    })) {
      events.push(event);
    }
    const row = events.flatMap((e) => (e.type === 'result' ? [e.result] : []))[0];
    expect(row?.status).toBe('skip');
  });
});

describe('what the schedule leaves unchanged', () => {
  test('the scorecard lists rows in registry order however the probes finish', async () => {
    // Later rows answer first, and a source sits after rows that do not read it.
    const delays: Record<string, number> = { '/first': 30, '/second': 15, '/robots.txt': 8, '/third': 1 };
    const fetchImpl = stubFetch(async (url) => {
      await Bun.sleep(delays[pathOf(url)] ?? 0);
      return new Response('ok', { status: 200, headers: HTML });
    });
    const ids = ['first', 'second', 'robots', 'third'];
    const events = await collect(
      audit(
        [
          pathRow('first', '/first'),
          pathRow('second', '/second'),
          pathRow('robots', '/robots.txt'),
          pathRow('third', '/third', { antecedent: 'robots-present' }),
        ],
        fetchImpl,
      ),
    );
    const complete = events.find((e) => e.type === 'complete');
    if (complete?.type !== 'complete') throw new Error('no scorecard');
    expect(complete.scorecard.results.map((row) => row.id)).toEqual(ids);
    expect(events.flatMap((e) => (e.type === 'result' ? [e.result.id] : []))).not.toEqual(ids);
  });

  test.each([1, 3, 6])('no more than %d checks are in flight at once, sources and dependents together', async (cap) => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = stubFetch(async (url) => {
      const path = pathOf(url);
      if (path === '/' || path.startsWith('/.well-known')) return new Response('ok', { status: 404, headers: HTML });
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(3);
      inFlight -= 1;
      return new Response('ok', { status: 200, headers: HTML });
    });
    const dependents = Array.from({ length: 8 }, (_, i) =>
      pathRow(`rule-${i}`, `/rule-${i}`, { antecedent: 'robots-present' }),
    );
    const independents = Array.from({ length: 8 }, (_, i) => pathRow(`pad-${i}`, `/pad-${i}`));
    await collect(audit([pathRow('robots', '/robots.txt'), ...dependents, ...independents], fetchImpl, cap));
    expect(peak).toBe(cap);
  });
});
