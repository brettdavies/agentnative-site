// One `page.request` record per served page, emitted at the uncached
// gateway. It has to live there for two reasons: the cache-enabled inner
// entrypoint is skipped on a cache HIT, so a record inside it would count
// only misses, and the gateway is the only place the real User-Agent
// exists, because the classification rewrite deletes it for HTML clients
// and replaces it with a marker for markdown clients before the inner
// Worker runs. The record carries the path and never the query string: on
// /web-audit the query is a visitor-typed value.

import { isGetOrHead } from '../accept';
import { classifyClient } from './client-class';
import { emitLog, type LogFields } from './log';
import { deriveUserAgent } from './user-agent';

// The path is client-supplied free text on an unauthenticated route, so it
// is capped for the same flood-amplification reason the emitter caps
// client-supplied names.
const MAX_PATH_LENGTH = 256;

export type ServedFormat = 'html' | 'markdown';

function servedFormat(response: Response): ServedFormat | null {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.startsWith('text/html')) return 'html';
  if (contentType.startsWith('text/markdown')) return 'markdown';
  return null;
}

/**
 * Build the record for a gateway-served request, or null when the request
 * is not a page: a non-GET, an `/api/` path, or a response whose content
 * type is anything but HTML or markdown (assets, JSON, text files).
 */
export function pageRequestFields(original: Request, response: Response, durationMs: number): LogFields | null {
  if (!isGetOrHead(original.method)) return null;
  const { pathname } = new URL(original.url);
  if (pathname.startsWith('/api/')) return null;
  const format = servedFormat(response);
  if (format === null) return null;

  const { clientClass, agentName } = classifyClient(original.headers);
  const browser = clientClass === 'browser' ? deriveUserAgent(original.headers) : null;
  const pathTruncated = pathname.length > MAX_PATH_LENGTH;
  return {
    path: pathTruncated ? pathname.slice(0, MAX_PATH_LENGTH) : pathname,
    path_truncated: pathTruncated ? true : undefined,
    method: original.method,
    status: response.status,
    format,
    cache_status: response.headers.get('cf-cache-status'),
    // Two cache layers report HIT: a Static Assets hit comes back through
    // the Worker with no Age header, and only a Workers Caching hit that
    // skipped the Worker carries Age.
    cache_age_present: response.headers.has('age'),
    client_class: clientClass,
    agent_name: agentName,
    browser_family: browser?.brand,
    browser_version: browser?.brandMajorMinor,
    engine: browser?.engine,
    engine_version: browser?.engineVersion,
    os_family: browser?.osFamily,
    duration_ms: durationMs,
  };
}

/** Never throws: the page record can never fail the response it describes. */
export function recordPageRequest(original: Request, response: Response, durationMs: number): void {
  try {
    const fields = pageRequestFields(original, response, durationMs);
    if (fields !== null) emitLog({ scope: 'page.request' }, fields);
  } catch {
    // Swallowed by design, matching the emitter.
  }
}
