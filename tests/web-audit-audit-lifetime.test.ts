// An audit owns everything it starts: once the engine's generator finishes,
// whether the audit completed or its consumer stopped early, no request it
// sent is still waiting on the target and no response body it opened is
// still being read. Anything left running would hold the audit's kept
// bodies in an isolate other requests share until its own deadline passed.

import { describe, expect, test } from 'bun:test';
import { loadRegistry, stubFetchFor } from '../scripts/web-audit/conformance-corpus';
import { SCENARIOS } from '../scripts/web-audit/conformance-scenarios';
import { type AuditEvent, runWebAudit } from '../src/worker/audit-web/engine';
import { ALWAYS_ADMIT_BUDGET } from '../src/worker/audit-web/follow-requests';

const registry = loadRegistry();
const scenario = SCENARIOS['run-healthy'];

function abortedError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

/** The response with its body replaced by one that sends its first bytes, then stalls until it is cancelled. */
function stallingBody(response: Response, cancelled: { value: boolean }): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const first = new Uint8Array(await response.arrayBuffer()).subarray(0, 8);
      controller.enqueue(first.byteLength > 0 ? first : new TextEncoder().encode(' '));
    },
    cancel() {
      cancelled.value = true;
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

function audit(fetchImpl: typeof fetch): AsyncGenerator<AuditEvent> {
  return runWebAudit({
    url: scenario.target,
    registry,
    siteType: scenario.site_type,
    specVersion: scenario.spec_version,
    followDeclarations: scenario.follow_declarations ?? true,
    domainBudget: ALWAYS_ADMIT_BUDGET,
    fetchOptions: { fetchImpl },
    now: () => 0,
  });
}

describe('an audit releases what it holds when it ends', () => {
  test('an audit has stopped every body read by the time its consumer sees complete', async () => {
    const stub = stubFetchFor(scenario, { unmatched: [] });
    const preflightBody = { value: false };
    let preflights = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await stub(input, init);
      if ((init?.method ?? 'GET').toUpperCase() !== 'OPTIONS') return response;
      preflights += 1;
      return stallingBody(response, preflightBody);
    }) as typeof fetch;
    const events = audit(fetchImpl);
    let next = await events.next();
    while (!next.done && next.value.type !== 'complete') next = await events.next();
    await Bun.sleep(20);
    expect([next.done, preflights, preflightBody.value]).toEqual([false, 1, true]);
  });

  test('an audit whose consumer stops early aborts every request it left waiting on the target', async () => {
    const stub = stubFetchFor(scenario, { unmatched: [] });
    let hold = false;
    const waiting = new Set<AbortSignal>();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!hold || !signal) return stub(input, init);
      waiting.add(signal);
      return new Promise<Response>((resolve, reject) => {
        const answer = setTimeout(() => {
          waiting.delete(signal);
          resolve(stub(input, init));
        }, 150);
        const onAbort = (): void => {
          clearTimeout(answer);
          reject(abortedError());
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }) as typeof fetch;
    let leftWaiting = 0;
    for await (const event of audit(fetchImpl)) {
      if (event.type !== 'result') continue;
      if (waiting.size > 0) {
        leftWaiting = waiting.size;
        break;
      }
      hold = true;
    }
    await Bun.sleep(20);
    expect(leftWaiting).toBeGreaterThan(0);
    expect([...waiting].filter((signal) => !signal.aborted)).toEqual([]);
  });
});
