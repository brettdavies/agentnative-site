// Each scenario's requests.json is what the CLI's port has to send, so the file has
// to hold what the engine sent and generation has to refuse a set no second engine
// could match.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  answerOrders,
  assertHandlersFailed,
  generateCorpus,
  loadRegistry,
  runScenario,
  stubFetchFor,
} from '../scripts/web-audit/conformance-corpus';
import { requestsJson, scheduleIndependentRequests, sortedRequests } from '../scripts/web-audit/conformance-requests';
import { SCENARIOS } from '../scripts/web-audit/conformance-scenarios';
import { SCENARIOS_DIR } from '../src/build/web-audit-contract-paths.mjs';
import { runWebAudit } from '../src/worker/audit-web/engine';
import { ALWAYS_ADMIT_BUDGET } from '../src/worker/audit-web/follow-requests';
import { type HopRequest, requestIdentityKey } from '../src/worker/audit-web/request-hop';

const registry = loadRegistry();

describe("each scenario's requests.json", () => {
  type Recorded = Omit<HopRequest, 'body'> & { body: string | null };

  const recorded = (name: string): HopRequest[] =>
    (JSON.parse(readFileSync(join(SCENARIOS_DIR, name, 'requests.json'), 'utf8')) as Recorded[]).map((request) => ({
      ...request,
      body: request.body ?? undefined,
    }));

  test('run-healthy lists every request its audit sent, sorted by the identity key, each once', async () => {
    const scenario = SCENARIOS['run-healthy'];
    const stub = stubFetchFor(scenario, { unmatched: [] });
    const received: string[] = [];
    const fetchImpl = ((input: string, init?: RequestInit) => {
      received.push(
        requestIdentityKey({
          method: init?.method ?? 'GET',
          url: input,
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: init?.body === undefined || init.body === null ? undefined : String(init.body),
        }),
      );
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
    expect(received.length).toBeGreaterThan(0);
    expect(recorded('run-healthy').map(requestIdentityKey)).toEqual([...new Set(received)].sort());
    expect(new Set(received).size).toBe(received.length);
  });

  test('every scenario records a sorted set of its requests, and at least one request', () => {
    for (const name of Object.keys(SCENARIOS)) {
      const keys = recorded(name).map(requestIdentityKey);
      expect({ name, sorted: keys }).toEqual({ name, sorted: [...new Set(keys)].sort() });
      expect({ name, some: keys.length > 0 }).toEqual({ name, some: true });
    }
  });

  const request = (url: string): HopRequest => ({ method: 'GET', url, headers: {}, body: undefined });

  test('a scenario that sends one request twice fails generation, naming the scenario and the request', () => {
    expect(() => sortedRequests('twice', [request('https://a.test/'), request('https://a.test/')])).toThrow(
      /scenario twice sent one request twice: .*https:\/\/a\.test\//,
    );
  });

  test('a scenario whose scorecard differs at concurrency 1 fails generation, naming the scenario', () => {
    const concurrent = { output: 'a', requests: [request('https://a.test/')] };
    expect(() =>
      scheduleIndependentRequests('moves', 'at concurrency 1', concurrent, { ...concurrent, output: 'b' }),
    ).toThrow('scenario moves: the scorecard at concurrency 1 differs');
  });

  test('a scenario whose request set differs at concurrency 1 fails generation, naming the request', () => {
    const concurrent = { output: 'a', requests: [request('https://a.test/')] };
    const serial = { output: 'a', requests: [request('https://b.test/')] };
    expect(() => scheduleIndependentRequests('moves', 'at concurrency 1', concurrent, serial)).toThrow(
      /scenario moves: the request set at concurrency 1 differs.*only at concurrency 1: .*b\.test.*only at the default: .*a\.test/,
    );
  });

  test('a scenario that moves with its answers in another order fails generation, naming the order', () => {
    const concurrent = { output: 'a', requests: [request('https://a.test/')] };
    const other = { output: 'a', requests: [request('https://a.test/'), request('https://b.test/')] };
    expect(() =>
      scheduleIndependentRequests('moves', 'with later requests answering first', concurrent, other),
    ).toThrow(
      /scenario moves: the request set with later requests answering first differs.*only with later requests answering first: .*b\.test/,
    );
  });

  test('the first answer order reverses any eight requests sent in a row from a multiple of eight', () => {
    const [reversed] = answerOrders(registry);
    const burst = Array.from({ length: 8 }, (_, sentIndex) =>
      reversed.answerDelayMs?.('https://example.com/', sentIndex),
    ) as number[];
    expect(burst).toEqual([...burst].sort((a, b) => b - a));
    expect(new Set(burst).size).toBe(burst.length);
    expect(Math.min(...burst)).toBeGreaterThan(0);
  });

  test('the second answer order holds back the paths source checks read, the root path among them', () => {
    const [, sourcesLast] = answerOrders(registry);
    expect(sourcesLast.answerDelayMs?.('https://example.com/llms.txt', 0)).toBeGreaterThan(0);
    expect(sourcesLast.answerDelayMs?.('https://example.com/sitemap.xml', 0)).toBeGreaterThan(0);
    expect(sourcesLast.answerDelayMs?.('https://example.com/', 0)).toBeGreaterThan(0);
    expect(sourcesLast.answerDelayMs?.('https://example.com/.well-known/security.txt', 0)).toBe(0);
  });

  // Generation stays away from real timeouts, because a stall on a busy host moves
  // every scenario in the crowd. This one needs one: the root answers inside its
  // timeout, and the root's answer plus any other outruns it, so a wait for the root
  // charged to a redirect hop's budget runs out. Each scenario here reads through
  // such a hop. The margin is wide and the retry covers a stall longer than it; a
  // wait that spends the budget fails both tries.
  test(
    'a redirect hop held for a slow root keeps its budget in the scenarios that read through one',
    async () => {
      const slowRoot = {
        perCheckTimeoutMs: 1000,
        answerDelayMs: (_url: string, sentIndex: number) => (sentIndex === 0 ? 800 : 220),
      };
      await Promise.all(
        [
          'alias-redirect-pass',
          'cors-full-pass',
          'mcp-dual-stack',
          'mcp-www-authenticate',
          'run-all-pass',
          'run-healthy',
          'run-root-redirects-to-http-catalog-card',
          'run-root-redirects-to-http-document-redirect',
        ].map(async (name) => {
          const expected = await runScenario(name, SCENARIOS[name], registry);
          const held = await runScenario(name, SCENARIOS[name], registry, slowRoot);
          scheduleIndependentRequests(name, 'with a slow root', expected, held);
        }),
      );
    },
    { timeout: 60_000, retry: 1 },
  );

  // Rejects only if the delay is applied, the stub honors the abort, the timeout
  // reaches the engine and the comparison runs, so losing any of them fails here.
  test('generation fails an order no scenario can hold under, naming it', async () => {
    const alwaysLate = { label: 'with every answer late', perCheckTimeoutMs: 20, answerDelayMs: () => 200 };
    await expect(generateCorpus(registry, [alwaysLate])).rejects.toThrow(/with every answer late/);
  }, 120_000);

  test('a scenario whose failing handler never ran fails generation, naming it', () => {
    const evidence = 'handler error: no handler registered for "corpus-failing-handler"';
    const rows = (row: object) => JSON.stringify({ results: [{ id: 'x', ...row }] });
    expect(() => assertHandlersFailed('moves', { failing_handlers: ['x'] }, rows({ evidence: 'gated' }))).toThrow(
      'scenario moves: the handler of x did not fail',
    );
    expect(() => assertHandlersFailed('moves', { failing_handlers: ['x'] }, rows({ evidence }))).not.toThrow();
    expect(() => assertHandlersFailed('moves', {}, rows({ evidence: 'gated' }))).not.toThrow();
  });

  test('the file form names an absent body null and holds lowercase header names sorted by name', () => {
    const entry = { method: 'POST', url: 'https://a.test/', headers: { B: '2', a: '1' }, body: undefined };
    expect(requestsJson([entry])).toBe(
      `${JSON.stringify([{ method: 'POST', url: 'https://a.test/', headers: { a: '1', b: '2' }, body: null }], null, 2)}\n`,
    );
  });
});
