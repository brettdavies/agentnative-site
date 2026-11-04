// Each scenario's requests.json is what the CLI's port has to send, so the file has
// to hold what the engine sent and generation has to refuse a set no second engine
// could match.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRegistry, stubFetchFor } from '../scripts/web-audit/conformance-corpus';
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
    expect(() => scheduleIndependentRequests('moves', concurrent, { ...concurrent, output: 'b' })).toThrow(
      'scenario moves: the scorecard at concurrency 1 differs',
    );
  });

  test('a scenario whose request set differs at concurrency 1 fails generation, naming the request', () => {
    const concurrent = { output: 'a', requests: [request('https://a.test/')] };
    const serial = { output: 'a', requests: [request('https://b.test/')] };
    expect(() => scheduleIndependentRequests('moves', concurrent, serial)).toThrow(
      /scenario moves: the request set at concurrency 1 differs.*only at concurrency 1: .*b\.test.*only at the default: .*a\.test/,
    );
  });

  test('the file form names an absent body null and holds lowercase header names sorted by name', () => {
    const entry = { method: 'POST', url: 'https://a.test/', headers: { B: '2', a: '1' }, body: undefined };
    expect(requestsJson([entry])).toBe(
      `${JSON.stringify([{ method: 'POST', url: 'https://a.test/', headers: { a: '1', b: '2' }, body: null }], null, 2)}\n`,
    );
  });
});
