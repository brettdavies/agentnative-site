// Pure assertion + JSON-RPC parse layer for the web-audit engine (plan
// U2). Byte-faithful TypeScript port of the extracted `assert_http` /
// `parse_jsonrpc` contracts: same key ordering, same short-circuit
// semantics, same regex flags (content_type/header_regex case-
// insensitive; body_regex case-insensitive AND multiline so `^`/`$`
// anchor per line). No I/O in this module.

/** Uniform probe-response shape every handler and the SSRF guard produce. */
export type ProbeResponse = {
  /** HTTP status, or null when the request itself failed. */
  status: number | null;
  /** Response headers with lowercased names. */
  headers: Record<string, string>;
  body: string;
  /** Non-null when the request failed before producing a status. */
  error: string | null;
  /** Wall-clock milliseconds the request took (informational). */
  elapsed_ms?: number;
};

export type ExpectBlock = {
  status?: number[];
  content_type?: string;
  header_present?: string;
  header_regex?: { name: string; pattern: string };
  body_regex?: string;
};

export type AssertOutcome = { ok: boolean; reasons: string[] };

/**
 * Evaluate an `expect` block against a fetched response. All present
 * keys AND together; the first failing key short-circuits with the
 * reasons accumulated so far.
 */
export function assertHttp(expect: ExpectBlock, resp: ProbeResponse): AssertOutcome {
  const reasons: string[] = [];
  if (resp.error) {
    return { ok: false, reasons: [`request failed: ${resp.error}`] };
  }
  const status = resp.status;
  const headers = resp.headers ?? {};
  const body = resp.body ?? '';

  if (expect.status !== undefined) {
    const ok = status !== null && expect.status.includes(status);
    reasons.push(`status ${status} ${ok ? 'in' : 'not in'} [${expect.status.join(', ')}]`);
    if (!ok) return { ok: false, reasons };
  }
  if (expect.content_type !== undefined) {
    const ct = headers['content-type'] ?? '';
    const ok = new RegExp(expect.content_type, 'i').test(ct);
    reasons.push(`content-type ${JSON.stringify(ct)} ${ok ? '~' : '!~'} /${expect.content_type}/`);
    if (!ok) return { ok: false, reasons };
  }
  if (expect.header_present !== undefined) {
    const name = expect.header_present.toLowerCase();
    const ok = name in headers;
    reasons.push(`header ${name} ${ok ? 'present' : 'absent'}`);
    if (!ok) return { ok: false, reasons };
  }
  if (expect.header_regex !== undefined) {
    const spec = expect.header_regex;
    const val = headers[spec.name.toLowerCase()] ?? '';
    const ok = new RegExp(spec.pattern, 'i').test(val);
    reasons.push(`header ${spec.name} ${ok ? 'matches' : 'no match'} /${spec.pattern}/`);
    if (!ok) return { ok: false, reasons };
  }
  if (expect.body_regex !== undefined) {
    const ok = new RegExp(expect.body_regex, 'im').test(body);
    reasons.push(`body ${ok ? 'matches' : 'no match'} /${expect.body_regex}/`);
    if (!ok) return { ok: false, reasons };
  }
  return { ok: true, reasons };
}

// ---------------------------------------------------------------------------
// canonical-plus-redirect-aliases eval rule (plan-003 U5, R8)
// ---------------------------------------------------------------------------

export type AliasVerdict = 'pass' | 'broken' | 'n_a';

/**
 * Classify a non-followed alias probe against the canonical URL. An
 * absent alias is n_a (no penalty); a 301/308 whose Location resolves to
 * the canonical passes regardless of what the canonical returns; a 2xx
 * serving content inline is broken (ambiguous duplicate, worse than
 * absent). Only permanent redirects credit — a 302/303/307 signals no
 * canonical intent, so it is broken (Open Questions resolution).
 */
export function classifyAliasProbe(
  resp: ProbeResponse,
  aliasUrl: string,
  canonicalUrl: string,
): { verdict: AliasVerdict; note: string } {
  if (resp.error !== null) return { verdict: 'n_a', note: `request failed: ${resp.error}` };
  const status = resp.status ?? 0;
  if (status === 301 || status === 308) {
    const location = resp.headers.location;
    if (!location) return { verdict: 'broken', note: `${status} without a Location header` };
    let target: string;
    try {
      target = new URL(location, aliasUrl).toString();
    } catch {
      return { verdict: 'broken', note: `${status} to unparseable target ${location}` };
    }
    const canonical = new URL(canonicalUrl);
    const resolved = new URL(target);
    if (resolved.origin === canonical.origin && resolved.pathname === canonical.pathname) {
      return { verdict: 'pass', note: `${status} -> ${canonical.pathname}` };
    }
    return { verdict: 'broken', note: `${status} away from the canonical (${resolved.pathname})` };
  }
  if (status === 302 || status === 303 || status === 307) {
    return { verdict: 'broken', note: `${status} non-permanent redirect (301/308 expected)` };
  }
  if (status >= 200 && status < 300) {
    return { verdict: 'broken', note: `${status} serves content inline (ambiguous duplicate)` };
  }
  return { verdict: 'n_a', note: `${status} alias not published` };
}

/**
 * Extract a JSON-RPC object from a JSON or text/event-stream response.
 * SSE bodies (by content-type or by leading `event:`/`data:` shape)
 * yield the first `data:` line that parses; plain bodies parse whole.
 * Returns null for anything that is not a JSON object.
 */
export function parseJsonRpc(resp: ProbeResponse): Record<string, unknown> | null {
  const body = resp.body ?? '';
  const ct = resp.headers?.['content-type'] ?? '';
  if (ct.includes('event-stream') || /^\s*(event:|data:)/.test(body)) {
    for (const line of body.split('\n')) {
      if (line.startsWith('data:')) {
        const parsed = tryParseObject(line.slice(5).trim());
        if (parsed !== null) return parsed;
      }
    }
    return null;
  }
  return tryParseObject(body);
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
