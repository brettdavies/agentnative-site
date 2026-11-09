// Each scenario's request set: what the engine sent, in the order and the shape
// `requests.json` commits. The CLI's port reproduces this set, so the two
// generation failures here are contract failures. A request sent twice breaks
// the memo's promise to a target, and a set that moves with the schedule, or with
// the order its answers arrive in, is one no second engine, running its work on
// its own threads, could match.

import { type HopRequest, normalizedHeaders, requestIdentityKey } from '../../src/worker/audit-web/request-hop';

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

/** The bytes of `requests.json`: `body` is null for a request with none, and `headers` holds lowercase names sorted by name. */
export function requestsJson(requests: readonly HopRequest[]): string {
  const entries = requests.map(({ method, url, headers, body }) => ({
    method,
    url,
    headers: Object.fromEntries(normalizedHeaders(headers)),
    body: body ?? null,
  }));
  return `${JSON.stringify(entries, null, 2)}\n`;
}

/**
 * The concurrent run's requests in identity-key order. Throws naming the scenario
 * when either run sent one request twice, or when its scorecard or request set
 * under `schedule` differs from the default run.
 */
export function scheduleIndependentRequests(
  name: string,
  schedule: string,
  concurrent: ScheduledRun,
  other: ScheduledRun,
): HopRequest[] {
  const requests = sortedRequests(name, concurrent.requests);
  const otherRequests = sortedRequests(name, other.requests);
  if (other.output !== concurrent.output) {
    throw new Error(`scenario ${name}: the scorecard ${schedule} differs from the default run`);
  }
  const concurrentKeys = new Set(requests.map(requestIdentityKey));
  const otherKeys = new Set(otherRequests.map(requestIdentityKey));
  const onlyOther = [...otherKeys].filter((key) => !concurrentKeys.has(key));
  const onlyConcurrent = [...concurrentKeys].filter((key) => !otherKeys.has(key));
  if (onlyOther.length > 0 || onlyConcurrent.length > 0) {
    throw new Error(
      `scenario ${name}: the request set ${schedule} differs from the default run; ` +
        `only ${schedule}: ${onlyOther.join(', ') || '(none)'}; only at the default: ${onlyConcurrent.join(', ') || '(none)'}`,
    );
  }
  return requests;
}
