// SSRF egress guard for the web-audit engine (plan U3, KTD-7). Every
// probe fetch flows through guardedFetch; handlers never call fetch
// directly. The guard:
//
//   - allows only http/https schemes,
//   - canonicalizes the host to a normalized IP BEFORE range-checking
//     (decimal / octal / hex / short dotted IPv4 literal forms,
//     IPv4-mapped IPv6, bracketed IPv6),
//   - blocks private RFC1918, loopback, link-local, unique-local, CGNAT,
//     unspecified, and cloud-metadata destinations plus the well-known
//     metadata hostnames (localhost, *.internal),
//   - follows redirects manually with a hop cap, re-validating each
//     Location target through the same canonicalization + range check,
//   - can keep the hops on the request's own origin, so a probe's method
//     and body never reach a host its caller did not name,
//   - sends no plaintext request: an http request URL is never sent, and
//     a redirect to http is not taken but answered as the redirect itself,
//   - wraps the whole chain in one AbortController deadline,
//   - sends each request once per audit when the caller passes the audit's
//     request memo (request-hop.ts): an identical request reads the answer
//     already received.
//
// DNS-rebinding residual: Workers cannot pre-resolve a hostname and pin
// the connection to the resolved address, so a public hostname that
// re-resolves to a private address mid-audit is not detectable here.
// The compensating controls are the metadata-IP/hostname block (the
// high-value rebinding target) and per-hop revalidation; the
// canonicalization above closes the encoding-bypass gap but not the
// rebinding gap.

import { AUDIT_USER_AGENT } from '../../shared/user-agents';
import type { ProbeResponse } from './assert';
import { answerOf, bodyOf, failureOf, type HopContext, isRedirect, type RequestMemo, takeHop } from './request-hop';

export { REDIRECT_STATUSES } from './request-hop';

/**
 * A refusal names what was refused: the URL itself, when it does not parse
 * or its scheme is not http(s), or the host it names.
 */
export type UrlValidation = { ok: true; url: URL } | { ok: false; reason: string; refused: 'url' | 'host' };

export type GuardedFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type GuardedFetchOptions = {
  /** Deadline for the whole request chain (redirects included). */
  timeoutMs?: number;
  /**
   * Cap on response body bytes. `0` skips the body (status/headers only).
   * Unset keeps the historical full `response.text()` read.
   */
  maxBodyBytes?: number;
  /** Maximum Location hops before the chain aborts. */
  maxRedirects?: number;
  /**
   * When false, a redirect response is returned as-is (status + Location
   * header) instead of being followed — the canonical-redirect eval rule
   * needs to see the 301, which following would erase.
   */
  followRedirects?: boolean;
  /**
   * When true, a redirect answer is a failure naming its target and no hop
   * is taken: a URL pinned by proof of control must not hand the auditor to
   * a location nothing confirmed.
   */
  refuseRedirects?: boolean;
  /**
   * When set, only redirect hops that keep the scheme, host, and port are
   * taken, and the method and body are never re-sent to another origin.
   * `'return'` hands a redirect to another origin back as-is (status +
   * Location); `'refuse'` makes it a failure naming its target.
   */
  crossOriginRedirects?: 'return' | 'refuse';
  /** Injection point for tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
  /** The audit's request memo: an identical request reads the answer already received. */
  memo?: RequestMemo;
};

/** The fetch options an audit hands every probe: the caller's transport plus the audit's request memo. */
export type AuditFetchOptions = Pick<GuardedFetchOptions, 'fetchImpl' | 'maxRedirects' | 'memo'>;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_REDIRECTS = 4;

// AUDIT_USER_AGENT is sent on every probe that does not set its own
// User-Agent. A request with no UA at all is the strongest bot-block signal
// for CDN WAFs (Akamai tarpits or 401s them wholesale), and the audit
// should identify itself honestly rather than impersonate a browser: sites
// remain free to make an informed decision about the auditor, and the
// UA-sensitive checks (markdown-cli-ua, markdown-agent-ua) still control
// their own header.

/** Case-insensitive presence check for a caller-supplied header. */
function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) return false;
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === wanted);
}
// Cloudflare answers on the origin's behalf with these when the origin
// never spoke: 52x for connection and timeout failures, 530 when the host
// does not resolve. A Worker's fetch returns them rather than throwing, and
// they carry the auditor's edge, not the target.
export function isEdgeErrorStatus(status: number | null): boolean {
  return status !== null && (status === 530 || (status >= 520 && status <= 527));
}

// Blocked IPv4 ranges as [base, prefixBits]. The metadata IP
// 169.254.169.254 sits inside 169.254.0.0/16.
const BLOCKED_IPV4_RANGES: Array<[number, number]> = [
  [ipv4('0.0.0.0'), 8],
  [ipv4('10.0.0.0'), 8],
  [ipv4('100.64.0.0'), 10],
  [ipv4('127.0.0.0'), 8],
  [ipv4('169.254.0.0'), 16],
  [ipv4('172.16.0.0'), 12],
  [ipv4('192.168.0.0'), 16],
];

function ipv4(dotted: string): number {
  const parts = dotted.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Parse an IPv4 literal in any inet_aton-accepted form (decimal, octal,
 * hex components; 1-4 dotted parts). Returns the 32-bit value or null
 * when the host is not an IPv4 literal.
 */
export function parseIpv4Literal(host: string): number | null {
  if (host.length === 0) return null;
  const parts = host.split('.');
  if (parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (part.length === 0) return null;
    let value: number;
    if (/^0x[0-9a-f]+$/i.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]*$/.test(part)) value = Number.parseInt(part, 8);
    else if (/^[1-9][0-9]*$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isFinite(value) || value < 0) return null;
    values.push(value);
  }
  const last = values[values.length - 1];
  const lastWidthBytes = 4 - (values.length - 1);
  if (last >= 2 ** (8 * lastWidthBytes)) return null;
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] > 255) return null;
  }
  let out = last;
  for (let i = 0; i < values.length - 1; i++) {
    out += values[i] * 2 ** (8 * (3 - i));
  }
  return out >>> 0;
}

/**
 * Parse a (bracket-stripped) IPv6 literal to 16 bytes, or null when the
 * host is not IPv6. Handles `::` compression and a trailing IPv4 tail.
 */
export function parseIpv6Literal(host: string): Uint8Array | null {
  if (!host.includes(':')) return null;
  const zoneless = host.split('%')[0];
  const halves = zoneless.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment === '') return [];
    const groups: number[] = [];
    for (const g of segment.split(':')) {
      if (g.includes('.')) {
        const v4 = parseIpv4Literal(g);
        if (v4 === null) return null;
        groups.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
        groups.push(Number.parseInt(g, 16));
      }
    }
    return groups;
  };

  const head = parseGroups(halves[0]);
  if (head === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const tail = parseGroups(halves[1]);
    if (tail === null) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[2 * i] = (groups[i] >> 8) & 0xff;
    bytes[2 * i + 1] = groups[i] & 0xff;
  }
  return bytes;
}

function blockedIpv4Reason(value: number): string | null {
  for (const [base, bits] of BLOCKED_IPV4_RANGES) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === base) {
      return `ipv4 ${formatIpv4(value)} is in blocked range ${formatIpv4(base)}/${bits}`;
    }
  }
  return null;
}

function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

function blockedIpv6Reason(bytes: Uint8Array): string | null {
  const allZero = bytes.every((b) => b === 0);
  if (allZero) return 'ipv6 unspecified address (::)';
  const isLoopback = bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1;
  if (isLoopback) return 'ipv6 loopback (::1)';
  if ((bytes[0] & 0xfe) === 0xfc) return 'ipv6 unique-local (fc00::/7)';
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'ipv6 link-local (fe80::/10)';
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms
  // range-check the embedded IPv4 address.
  const first10Zero = bytes.slice(0, 10).every((b) => b === 0);
  if (first10Zero && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0))) {
    const v4 = ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
    const reason = blockedIpv4Reason(v4);
    if (reason) return `ipv4-in-ipv6: ${reason}`;
  }
  return null;
}

/** Returns a block reason for the hostname, or null when it may be fetched. */
export function blockedHostReason(rawHostname: string): string | null {
  // WHATWG URL keeps trailing dots as written: `localhost..` is localhost.
  const hostname = rawHostname.toLowerCase().replace(/\.+$/, '');
  if (hostname.length === 0) return 'empty hostname';
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return 'localhost is not a public host';
  if (hostname === 'metadata.google.internal' || hostname.endsWith('.internal')) {
    return 'internal metadata hostnames are blocked';
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const v6 = parseIpv6Literal(hostname.slice(1, -1));
    if (v6 === null) return 'unparseable ipv6 literal';
    return blockedIpv6Reason(v6);
  }
  const v6 = hostname.includes(':') ? parseIpv6Literal(hostname) : null;
  if (v6) return blockedIpv6Reason(v6);
  const v4 = parseIpv4Literal(hostname);
  if (v4 !== null) return blockedIpv4Reason(v4);
  return null;
}

/**
 * Validate a caller-supplied URL for probing: parseable, http/https,
 * and a host that canonicalizes to a public destination.
 */
export function validatePublicUrl(raw: string): UrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `unparseable url: ${raw}`, refused: 'url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `scheme ${url.protocol} is not http(s)`, refused: 'url' };
  }
  const reason = blockedHostReason(url.hostname);
  if (reason) return { ok: false, reason: `blocked: ${reason}`, refused: 'host' };
  return { ok: true, url };
}

export function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The answer for a URL that is never requested because it is not https. */
export function notHttps(): ProbeResponse {
  return { status: null, headers: {}, body: '', error: 'not requested: not https', refused: 'insecure-scheme' };
}

/**
 * Fetch through the SSRF guard. Never throws; failures come back as
 * `{ status: null, error }` mirroring the extracted fetch contract so
 * `assertHttp` can evaluate them uniformly. A redirect to http comes back
 * as the redirect that named it, with `error` and `refused` set, so a
 * caller can tell a target that answered from one that never did.
 */
export async function guardedFetch(
  rawUrl: string,
  init: GuardedFetchInit = {},
  opts: GuardedFetchOptions = {},
): Promise<ProbeResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const fail = (error: string): ProbeResponse => ({
    status: null,
    headers: {},
    body: '',
    error,
    elapsed_ms: Date.now() - started,
  });

  const requestHeaders: Record<string, string> =
    init.headers !== undefined && hasHeader(init.headers, 'user-agent')
      ? init.headers
      : { ...init.headers, 'user-agent': AUDIT_USER_AGENT };

  try {
    let current = validatePublicUrl(rawUrl);
    if (!current.ok) return fail(current.reason.startsWith('blocked') ? current.reason : `blocked: ${current.reason}`);
    if (current.url.protocol !== 'https:') return { ...notHttps(), elapsed_ms: Date.now() - started };
    const origin = current.url.origin;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const request = {
        url: current.url.toString(),
        method: init.method ?? 'GET',
        headers: requestHeaders,
        body: init.body,
      };
      const hopContext: HopContext = {
        deadlineAt: started + timeoutMs,
        signal: controller.signal,
        bodyCap: opts.maxBodyBytes,
        keepsRedirect: opts.followRedirects === false || opts.crossOriginRedirects === 'return',
        memo: opts.memo,
      };
      const send = async (ctx: HopContext) => {
        const sentAt = Date.now();
        let response: Response;
        try {
          response = await fetchImpl(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (err) {
          return failureOf(err, sentAt, ctx);
        }
        return answerOf(response, sentAt, ctx);
      };
      const answer = await takeHop(request, hopContext, send);
      if (answer.kind === 'failure') return fail(answer.error.message);

      const redirect = isRedirect(answer) ? (answer.headers.location ?? null) : null;
      if (redirect !== null && opts.refuseRedirects === true) {
        return fail(`redirect refused: ${answer.status} to ${redirect}`);
      }
      if (redirect !== null && opts.followRedirects !== false) {
        let next: URL;
        try {
          next = new URL(redirect, current.url);
        } catch {
          return fail(`blocked: unparseable redirect target ${redirect}`);
        }
        const offOrigin = opts.crossOriginRedirects !== undefined && next.origin !== origin;
        if (offOrigin && opts.crossOriginRedirects === 'refuse') {
          return fail(`redirect refused: ${answer.status} to ${redirect}`);
        }
        if (!offOrigin) {
          const validated = validatePublicUrl(next.toString());
          if (!validated.ok) {
            return fail(
              validated.reason.startsWith('blocked')
                ? `${validated.reason} (redirect hop ${hop + 1})`
                : `blocked: ${validated.reason} (redirect hop ${hop + 1})`,
            );
          }
          if (validated.url.protocol !== 'https:') {
            return {
              status: answer.status,
              headers: { ...answer.headers },
              body: '',
              error: `redirect refused: ${answer.status} to ${redirect}: not https`,
              refused: 'insecure-scheme',
              elapsed_ms: Date.now() - started,
            };
          }
          if (hop === maxRedirects) {
            return fail(`redirect limit exceeded (${maxRedirects} hops)`);
          }
          current = validated;
          continue;
        }
      }

      // takeHop answers only with a record that serves this caller's cap,
      // so a body this caller cannot read is a body read that failed.
      const read = bodyOf(answer, opts.maxBodyBytes);
      if (read === null) return fail(answer.bodyError?.message ?? 'body unavailable');
      return {
        status: answer.status,
        headers: { ...answer.headers },
        body: read.body,
        error: null,
        elapsed_ms: Date.now() - started,
        ...(read.truncated ? { truncated: true as const } : {}),
      };
    }
    return fail(`redirect limit exceeded (${maxRedirects} hops)`);
  } finally {
    clearTimeout(timer);
  }
}

/** Status-only probes: never buffer the response body. */
export const STATUS_ONLY_BODY_BYTES = 0;
/** Cap for probes that inspect a short body (JSON errors, twin text). */
export const AUDIT_PROBE_MAX_BODY_BYTES = 64 * 1024;
/** Cap for a discovery document the audit keeps: a server card, the AI catalog, the API catalog. */
export const DOCUMENT_MAX_BODY_BYTES = 256 * 1024;
/** Cap for an RFC 9728 protected-resource metadata document. */
export const METADATA_MAX_BODY_BYTES = 64 * 1024;
/** Cap for an OpenAPI description the API catalog declares. */
export const OPENAPI_MAX_BODY_BYTES = 512 * 1024;
