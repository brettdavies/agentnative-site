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
//   - wraps the whole chain in one AbortController deadline.
//
// DNS-rebinding residual: Workers cannot pre-resolve a hostname and pin
// the connection to the resolved address, so a public hostname that
// re-resolves to a private address mid-audit is not detectable here.
// The compensating controls are the metadata-IP/hostname block (the
// high-value rebinding target) and per-hop revalidation; the
// canonicalization above closes the encoding-bypass gap but not the
// rebinding gap.

import type { ProbeResponse } from './assert';

export type UrlValidation = { ok: true; url: URL } | { ok: false; reason: string };

export type GuardedFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type GuardedFetchOptions = {
  /** Deadline for the whole request chain (redirects included). */
  timeoutMs?: number;
  /** Maximum Location hops before the chain aborts. */
  maxRedirects?: number;
  /**
   * When false, a redirect response is returned as-is (status + Location
   * header) instead of being followed — the canonical-redirect eval rule
   * needs to see the 301, which following would erase.
   */
  followRedirects?: boolean;
  /** Injection point for tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_REDIRECTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
  const hostname = rawHostname.toLowerCase().replace(/\.$/, '');
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
    return { ok: false, reason: `unparseable url: ${raw}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `scheme ${url.protocol} is not http(s)` };
  }
  const reason = blockedHostReason(url.hostname);
  if (reason) return { ok: false, reason: `blocked: ${reason}` };
  return { ok: true, url };
}

/**
 * Fetch through the SSRF guard. Never throws; failures come back as
 * `{ status: null, error }` mirroring the extracted fetch contract so
 * `assertHttp` can evaluate them uniformly.
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

  try {
    let current = validatePublicUrl(rawUrl);
    if (!current.ok) return fail(current.reason.startsWith('blocked') ? current.reason : `blocked: ${current.reason}`);

    for (let hop = 0; hop <= maxRedirects; hop++) {
      let response: Response;
      try {
        response = await fetchImpl(current.url.toString(), {
          method: init.method ?? 'GET',
          headers: init.headers,
          body: init.body,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (err) {
        return fail(errMsg(err));
      }

      const location = response.headers.get('location');
      if (opts.followRedirects !== false && REDIRECT_STATUSES.has(response.status) && location) {
        let next: URL;
        try {
          next = new URL(location, current.url);
        } catch {
          return fail(`blocked: unparseable redirect target ${location}`);
        }
        const validated = validatePublicUrl(next.toString());
        if (!validated.ok) {
          return fail(
            validated.reason.startsWith('blocked')
              ? `${validated.reason} (redirect hop ${hop + 1})`
              : `blocked: ${validated.reason} (redirect hop ${hop + 1})`,
          );
        }
        if (hop === maxRedirects) {
          return fail(`redirect limit exceeded (${maxRedirects} hops)`);
        }
        current = validated;
        continue;
      }

      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      let body = '';
      try {
        body = await response.text();
      } catch (err) {
        return fail(errMsg(err));
      }
      return {
        status: response.status,
        headers,
        body,
        error: null,
        elapsed_ms: Date.now() - started,
      };
    }
    return fail(`redirect limit exceeded (${maxRedirects} hops)`);
  } finally {
    clearTimeout(timer);
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return `TimeoutError: deadline exceeded`;
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}
