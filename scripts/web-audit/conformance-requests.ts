// Each scenario's request set: what the engine sent, in the order and the shape
// `requests.json` commits. The CLI's port reproduces this set, so the two
// generation failures here are contract failures. A request sent twice breaks
// the memo's promise to a target, and a set that moves with the schedule is one
// no second engine, running its checks on its own threads, could match.

import { type HopRequest, requestIdentityKey } from '../../src/worker/audit-web/request-hop';

export type ScheduledRun = { output: string; requests: readonly HopRequest[] };

/** `sent` in identity-key order. Throws naming the scenario and the request when one was sent twice. */
export function sortedRequests(name: string, sent: readonly HopRequest[]): HopRequest[] {
  const byKey = new Map<string, HopRequest>();
  for (const request of sent) {
    const key = requestIdentityKey(request);
    if (byKey.has(key)) throw new Error(`scenario ${name} sent one request twice: ${key}`);
    byKey.set(key, request);
  }
  return [...byKey.keys()].sort().map((key) => byKey.get(key) as HopRequest);
}

function byName<T>([a]: [string, T], [b]: [string, T]): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The bytes of `requests.json`: `body` is null for a request with none, and `headers` is sorted by name. */
export function requestsJson(requests: readonly HopRequest[]): string {
  const entries = requests.map(({ method, url, headers, body }) => ({
    method,
    url,
    headers: Object.fromEntries(Object.entries(headers).sort(byName)),
    body: body ?? null,
  }));
  return `${JSON.stringify(entries, null, 2)}\n`;
}

/** Throws naming the scenario when its scorecard or request set at concurrency 1 differs from the default run. */
export function assertScheduleIndependent(name: string, concurrent: ScheduledRun, serial: ScheduledRun): void {
  if (serial.output !== concurrent.output) {
    throw new Error(`scenario ${name}: the scorecard at concurrency 1 differs from the default run`);
  }
  const keys = (run: ScheduledRun): Set<string> => new Set(run.requests.map(requestIdentityKey));
  const concurrentKeys = keys(concurrent);
  const serialKeys = keys(serial);
  const onlySerial = [...serialKeys].filter((key) => !concurrentKeys.has(key));
  const onlyConcurrent = [...concurrentKeys].filter((key) => !serialKeys.has(key));
  if (onlySerial.length > 0 || onlyConcurrent.length > 0) {
    throw new Error(
      `scenario ${name}: the request set at concurrency 1 differs from the default run; ` +
        `only at concurrency 1: ${onlySerial.join(', ') || '(none)'}; only at the default: ${onlyConcurrent.join(', ') || '(none)'}`,
    );
  }
}
