// Shared helpers for the probe handlers and the discovery and follow
// phases: base-relative URL resolution, `{mcp_endpoint}`/`{host}`
// substitution, per-check timeout derivation (registry `with.timeout` is
// in seconds), redirect handling for probes of the MCP endpoint, the
// statuses that ask for a retry, and a phase's share of the per-audit
// deadline.

import type { GuardedFetchOptions } from '../ssrf';

/**
 * Statuses whose shape is "not now" rather than "not here": a target
 * asking to be retried is reporting its own load, not answering what the
 * request asked. Each maps to its RFC 9110 reason phrase, which a row's
 * evidence can name.
 */
export const RETRY_SHAPED_STATUSES: ReadonlyMap<number, string> = new Map([
  [408, 'Request Timeout'],
  [429, 'Too Many Requests'],
]);

/** Join a path to the base, or pass an absolute URL through unchanged. */
export function resolveUrl(base: string, pathOrUrl: string): string {
  if (pathOrUrl.length === 0) return '';
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl;
  try {
    return new URL(pathOrUrl, base).toString();
  } catch {
    return '';
  }
}

function originOf(url: string | null): string {
  if (url === null) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Replace the `{mcp_endpoint}` token and the `{mcp_origin}` token (the
 * endpoint's scheme, host, and port); each yields '' when the endpoint is
 * unknown.
 */
export function substituteEndpoint(value: string, mcpEndpoint: string | null): string {
  if (!value.includes('{mcp_endpoint}') && !value.includes('{mcp_origin}')) return value;
  return value.replaceAll('{mcp_endpoint}', mcpEndpoint ?? '').replaceAll('{mcp_origin}', originOf(mcpEndpoint));
}

type RedirectPolicy = Pick<GuardedFetchOptions, 'refuseRedirects' | 'crossOriginRedirects'>;

/**
 * Redirect handling for a request to the MCP endpoint. No probe of it
 * reaches a host nothing confirmed: on a declared host no redirect is
 * taken, and on the audited origin only hops that stay on it are. There,
 * a GET gets the hop it may not take back as its answer, since a redirect
 * is a valid answer to a GET; any other method fails on it.
 */
export function mcpEndpointRedirects(followed: boolean | undefined, method = 'POST'): RedirectPolicy {
  if (followed === true) return { refuseRedirects: true };
  return { crossOriginRedirects: method === 'GET' || method === 'HEAD' ? 'return' : 'refuse' };
}

/**
 * Redirect handling for a probe of `rawPath`: the MCP endpoint's when the
 * path targets it. A document on a declared endpoint's host takes no
 * redirect either, for the same reason; on the audited origin it keeps the
 * default.
 */
export function endpointRedirects(rawPath: string, followed: boolean | undefined, method?: string): RedirectPolicy {
  if (rawPath.includes('{mcp_endpoint}')) return mcpEndpointRedirects(followed, method);
  return rawPath.includes('{mcp_origin}') && followed === true ? { refuseRedirects: true } : {};
}

/** Replace the `{host}` token used by DoH record names. */
export function substituteHost(value: string, host: string): string {
  return value.replaceAll('{host}', host);
}

/** Convert a check's optional `with.timeout` (seconds) to ms, else the default. */
export function timeoutMsFor(checkTimeoutSeconds: number | undefined, defaultTimeoutMs: number): number {
  return typeof checkTimeoutSeconds === 'number' ? Math.round(checkTimeoutSeconds * 1000) : defaultTimeoutMs;
}

/** Remaining nested-fetch budget; 0 means stop and do not issue another request. */
export function remainingDeadlineMs(deadlineAtMs: number, nowMs = Date.now()): number {
  return Math.max(0, deadlineAtMs - nowMs);
}

/** A phase's share of the per-audit deadline, handed out one request timeout at a time. */
export interface PhaseBudget {
  readonly deadlineAt: number;
  /** The next request's timeout: the per-request timeout or what is left, whichever is smaller; null once spent. */
  slice(): number | null;
}

export function phaseBudget(
  capMs: number,
  timeoutMs: number,
  clock: { deadlineAt?: number; now: () => number },
): PhaseBudget {
  const deadlineAt = Math.min(clock.deadlineAt ?? Number.POSITIVE_INFINITY, clock.now() + capMs);
  return {
    deadlineAt,
    slice: () => {
      const slice = Math.min(timeoutMs, remainingDeadlineMs(deadlineAt, clock.now()));
      return slice > 0 ? slice : null;
    },
  };
}

const MARKDOWN_HREF_RE = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function isRecoveryPath(pathname: string): boolean {
  return (
    pathname.endsWith('/sitemap.xml') ||
    pathname.endsWith('/llms.txt') ||
    pathname === '/docs' ||
    pathname.startsWith('/docs/')
  );
}

/**
 * True when markdown contains at least one href that resolves to a
 * same-origin sitemap.xml, llms.txt, or /docs recovery surface.
 */
export function sameOriginRecoveryLink(body: string, base: string): { ok: boolean; why: string } {
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    return { ok: false, why: 'unparseable audit origin' };
  }
  for (const match of body.matchAll(MARKDOWN_HREF_RE)) {
    let url: URL;
    try {
      url = new URL(match[1], base);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    if (isRecoveryPath(url.pathname)) {
      return { ok: true, why: `same-origin recovery ${url.pathname}` };
    }
  }
  return { ok: false, why: 'no same-origin sitemap.xml, llms.txt, or /docs link' };
}
