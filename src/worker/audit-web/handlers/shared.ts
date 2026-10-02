// Shared helpers for the probe handlers and the discovery and follow
// phases: base-relative URL resolution, `{mcp_endpoint}`/`{host}`
// substitution, per-check timeout derivation (registry `with.timeout` is
// in seconds), redirect handling for probes of the MCP endpoint, the
// statuses that ask for a retry, a URL that answered only with a redirect
// to http, a phase's share of the per-audit deadline, and the outcome of a
// row that evaluates several targets.

import type { NaReason } from '../../../shared/web-audit-findings';
import { NO_PLAINTEXT_REQUEST } from '../../../shared/web-audit-result-line';
import type { ProbeResponse } from '../assert';
import type { GuardedFetchOptions } from '../ssrf';
import type { EvidenceItem, ProbeOutcome, ProbeStatus } from './types';

const REDIRECTS_TO_HTTP_WHY = `redirects to http; ${NO_PLAINTEXT_REQUEST}`;

/**
 * The URL answered, but only with a redirect to http, whose hop the guard
 * refused: nothing it serves is readable over https.
 */
export function redirectsToHttp(resp: Pick<ProbeResponse, 'status' | 'refused'>): boolean {
  return resp.refused === 'insecure-scheme' && resp.status !== null;
}

/** Why a declared URL was not requested over plaintext: as written, or by its redirect. */
export type PlaintextReason = 'not https' | 'redirects to http';

/** The evidence item for a declared URL anc did not request over plaintext. */
export function plaintextItem(reason: PlaintextReason): EvidenceItem & { why: string[] } {
  return { blocked: reason, ok: false, why: [`${reason}; ${NO_PLAINTEXT_REQUEST}`] };
}

/** The evidence item for a URL that answered only with a redirect to http. */
export function redirectsToHttpItem(url: string, status: number | null): EvidenceItem & { why: string[] } {
  return { url, status, ok: false, why: [REDIRECTS_TO_HTTP_WHY] };
}

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

/** `HTTP <status> <reason>` for a retry-shaped status, else null. */
export function retryShapedAnswer(status: number | null): string | null {
  const reason = status === null ? undefined : RETRY_SHAPED_STATUSES.get(status);
  return reason === undefined ? null : `HTTP ${status} ${reason}`;
}

/**
 * The `why` of a row its own retry-shaped answer settles as `error`, else
 * null. Such an answer reports the target's load at that moment, whichever
 * layer sent it, so neither its body nor its headers describe the surface
 * the row asks about.
 */
export function retryShapedWhy(status: number | null): string | null {
  const answer = retryShapedAnswer(status);
  return answer === null ? null : `the target answered ${answer}; not scored`;
}

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

/** One target of a row that evaluates several (the API anchors), with its own outcome. */
export interface TargetOutcome {
  status: ProbeStatus;
  na_reason?: NaReason;
  evidence: EvidenceItem[];
}

// Worst first: something there and wrong outranks a spec defect, which
// outranks nothing there, which outranks an operational unknown; a row
// passes only when every target it evaluated passed.
const TARGET_STATUS_RANK: readonly ProbeStatus[] = ['broken', 'noncompliant', 'absent', 'error', 'pass'];

/** The worst status among `statuses`, ignoring targets not evaluated; `na` only when none was. */
export function worstTargetStatus(statuses: readonly ProbeStatus[]): ProbeStatus {
  return TARGET_STATUS_RANK.find((status) => statuses.includes(status)) ?? 'na';
}

/**
 * A row's outcome over its targets. Each evidence item carries its
 * target's `target_status` (and `na_reason`), which is where the row's
 * per-host outcomes are read from. A target not evaluated (its host
 * declared but not followed) neither passes nor fails the row; when no
 * target was evaluated the row takes the first target's reason.
 */
export function aggregateTargets(targets: readonly TargetOutcome[]): ProbeOutcome {
  const evidence = targets.flatMap((target) =>
    target.evidence.map((item) => ({
      ...item,
      target_status: target.status,
      ...(target.na_reason !== undefined ? { na_reason: target.na_reason } : {}),
    })),
  );
  const status = worstTargetStatus(targets.map((target) => target.status));
  if (status !== 'na') return { status, evidence };
  const reason = targets[0]?.na_reason;
  return { status, evidence, ...(reason !== undefined ? { na_reason: reason } : {}) };
}
