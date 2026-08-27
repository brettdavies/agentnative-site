// `mcp` probe handler. Builds the JSON-RPC payload per op (legacy
// initialize / tools-list / resources-list / error with the registry's
// pinned protocol version; modern-era modern-tools-list / server-discover
// header-routed per SEP-2243; the per-era error-code conformance family),
// POSTs through the SSRF guard, parses JSON or SSE via parseJsonRpc, and
// evaluates serverInfo / capabilities / tools / resources / discovery /
// error-code. Returns n_a when no endpoint was discovered, and an
// unprobed `absent` when wave 1 evidenced no modern lane.
// CORS classification lives in the cors-preflight posture handler.

import { parseJsonRpc } from '../assert';
import type { WebCheck } from '../registry';
import { AUDIT_PROBE_MAX_BODY_BYTES, type GuardedFetchOptions, guardedFetch } from '../ssrf';
import { remainingDeadlineMs, timeoutMsFor } from './shared';
import type { EvidenceItem, HandlerContext, McpLaneEvidence, McpModernLane, ProbeOutcome } from './types';

/**
 * Per-op facts every family-dependent behavior in this file derives from.
 * One declaration rather than a set per behavior: an op added to the
 * table without a `family` cannot compile, and an op added anywhere else
 * cannot exist, because `McpOp` is the table's key set. That is what
 * stops a new op from silently joining the era family (and inheriting its
 * softening) by being absent from a membership set someone forgot.
 */
type McpOpSpec = {
  /** Which classification branch judges the answer. Conformance rows ask
   * a question the lane has already proven it serves, so no era
   * softening reaches them; era rows name a method the lane could be
   * missing. */
  family: 'era' | 'conformance';
  /** Which protocol era's wire shape the row probes. */
  era: 'legacy' | 'modern';
  /** Wire method for a modern era probe; the Mcp-Method header and the
   * body both read it, so they cannot disagree (the -32020 condition the
   * suite itself probes for). */
  method?: string;
  /** Capability group the row reads, as named in its own lane's
   * handshake. Refusing a method the handshake advertised contradicts
   * the handshake, so the era softening must not reach such a row. */
  advertises?: string;
  /** The row whose answer decides the modern lane. It is never gated on
   * its own answer, and its refusal is read as the era's absence. */
  discriminates?: true;
  /** The row passes on a refusal code rather than on a result. A lane that
   * refuses under the wrong code still gave the agent the outcome it
   * asked for, so such a row separates a taxonomy defect from a trap the
   * way the conformance family does. */
  expectsRefusal?: true;
};

const MCP_OPS = {
  initialize: { family: 'era', era: 'legacy' },
  'tools-list': { family: 'era', era: 'legacy', advertises: 'tools' },
  'resources-list': { family: 'era', era: 'legacy', advertises: 'resources' },
  error: { family: 'era', era: 'legacy', expectsRefusal: true },
  'malformed-body': { family: 'conformance', era: 'legacy' },
  'batch-reject': { family: 'conformance', era: 'legacy' },
  'unknown-tool': { family: 'conformance', era: 'legacy' },
  'server-discover': { family: 'era', era: 'modern', method: 'server/discover', discriminates: true },
  'modern-tools-list': { family: 'era', era: 'modern', method: 'tools/list', advertises: 'tools' },
  'modern-unknown-method': { family: 'conformance', era: 'modern' },
  'modern-clientcaps': { family: 'conformance', era: 'modern' },
  'modern-header-mismatch': { family: 'conformance', era: 'modern' },
  'modern-version-reject': { family: 'conformance', era: 'modern' },
  'modern-resources-miss': { family: 'conformance', era: 'modern' },
} as const satisfies Record<string, McpOpSpec>;

export type McpOp = keyof typeof MCP_OPS;

type OpsOfFamily<F extends McpOpSpec['family']> = {
  [K in McpOp]: (typeof MCP_OPS)[K]['family'] extends F ? K : never;
}[McpOp];

type ConformanceOp = OpsOfFamily<'conformance'>;

const ALL_OPS = Object.keys(MCP_OPS) as McpOp[];

// `as const` is what makes ConformanceOp derivable, and it also narrows
// each row to only the keys it declares; reading an optional key off an
// arbitrary op needs the widened view.
function specOf(op: McpOp): McpOpSpec {
  return MCP_OPS[op];
}

function opsWhere(predicate: (spec: McpOpSpec) => boolean): readonly McpOp[] {
  return ALL_OPS.filter((op) => predicate(specOf(op)));
}

type McpWith = {
  op: McpOp;
  assert?: 'capabilities';
  method?: string;
  expect_code?: number;
  timeout?: number;
};

// The modern era is a handler concern, not registry config: the
// registry's mcp_discovery.protocol_version stays the legacy pin and
// keeps legacy discovery byte-stable.
const MODERN_PROTOCOL_VERSION = '2026-07-28';

const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

// Codes that signal the probed era lane is not offered (-32601 method
// not found, -32022 UnsupportedProtocolVersion). Any other well-formed
// error envelope keeps the broken-surface penalty, apart from the
// rate-limit code below.
//
// These read as unavailability only on an op that names a method the
// lane could be missing. The conformance family names none: an
// unparseable body and a JSON array carry no method at all, and an
// unknown tool NAME rides a `tools/call` the lane has already proven it
// serves. A conformance row answered with an unavailability code is
// therefore as wrong as any other mismatched code, and an endpoint that
// answers -32601 to everything must not outscore a server that answers
// honestly and imperfectly.
const LANE_UNAVAILABLE_CODES = new Set([-32601, -32022]);

// A rate-limit refusal measures the auditor's own request volume, not
// the probed surface, so it is an operational condition (status
// `error`, excluded from scoring) rather than a penalty on a target
// defending itself.
const RATE_LIMITED_CODE = -32099;

// `server/discover` is the only modern-only method on the wire, so its
// answer is the sole sound era signal: every other modern row sends a
// request a 2025-era server is free to answer without serving the modern
// revision at all (a lenient one serves the legacy tools/list behind it,
// a strict one refuses the version claim), which makes its answer
// evidence about leniency rather than about the era. These rows are
// therefore settled from the lane rather than probed on their own answer.
export const MODERN_LANE_DEPENDENT_OPS = opsWhere((spec) => spec.era === 'modern' && spec.discriminates !== true);

// A stateful 2025-era server refuses a sessionless POST with -32000
// before it ever reaches the code these rows probe, which scores its
// statefulness instead of its error codes. One conditional re-ask with
// the session legacy initialize issued puts the row back on its own
// question; a stateless target never issues a session and so stays a
// single request.
export const LEGACY_CONFORMANCE_OPS = opsWhere((spec) => spec.family === 'conformance' && spec.era === 'legacy');

/** Every row judged by the conformance branch, in registry order. */
export const CONFORMANCE_OPS = opsWhere((spec) => spec.family === 'conformance');

/** Every row judged by the era branch, in registry order. */
export const ERA_OPS = opsWhere((spec) => spec.family === 'era');

const SESSION_REQUIRED_CODE = -32000;

// A refusal delivered as an HTTP status with no JSON-RPC envelope: the
// request was rejected, not mishandled. 404 is deliberately outside the
// set so a dead endpoint earns nothing on any row that consults it.
const TYPED_REFUSAL_STATUSES: readonly number[] = [400, 415];

// Statuses whose shape is "not now" rather than "not here": a target
// asking to be retried is reporting load, not a protocol era.
const RETRY_SHAPED_STATUSES: readonly number[] = [408, 429];

const CLIENT_INFO = { name: 'agent-web-audit', version: '1.0' };

export function legacyProbeHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
}

export const LEGACY_TOOLS_LIST_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

/** Legacy initialize request body; discovery's legacy pass and the initialize check send the same bytes. */
export function legacyInitializeBody(protocolVersion: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
  });
}

/** Modern request headers (SEP-2243): header-routed, sessionless, no initialize. */
export function modernProbeHeaders(method: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
    'Mcp-Method': method,
  };
}

function modernMeta(protocolVersion: string): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

/** Modern request body; clientCapabilities is mandatory on every modern request (omitting it draws -32602). */
export function modernProbeBody(method: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method,
    params: { _meta: modernMeta(MODERN_PROTOCOL_VERSION) },
  });
}

// A protocol revision that predates the modern lane, so every conforming
// 2026-07-28 server must refuse it with -32022 + data.supported.
const UNSUPPORTED_VERSION_CLAIM = '2025-03-26';
const UNKNOWN_TOOL_NAME = 'not_a_real_tool';
const UNKNOWN_METHOD = 'nonexistent/method';
const RESOURCE_MISS_URI = 'resource://agent-web-audit/nonexistent';

type ConformanceProbe = {
  headers: () => Record<string, string>;
  body: () => string;
  /** JSON-RPC error codes that satisfy the row. */
  accept: readonly number[];
  /** Bare HTTP statuses that satisfy the row when no envelope came back (typed refusal arm). */
  httpAccept?: readonly number[];
  /** The accepted envelope must carry error.data.supported (version reject). */
  requireSupported?: boolean;
};

// Per-era conformance probes: one request each, era-shaped headers, raw
// body override where the probe is the body itself (malformed / batch).
// Codes -32603 (an internal error cannot be forced from outside) and
// -32099 (triggering rate limits against third-party servers is abusive)
// are deliberately not probed.
const CONFORMANCE_PROBES: Record<ConformanceOp, ConformanceProbe> = {
  'malformed-body': {
    headers: legacyProbeHeaders,
    body: () => 'not-json{{',
    accept: [-32700],
    httpAccept: TYPED_REFUSAL_STATUSES,
  },
  'batch-reject': {
    // A valid all-legacy batch is served on the pinned SDK line; the
    // reliably rejected shape is a batch carrying a modern-envelope element.
    headers: legacyProbeHeaders,
    body: () => `[${modernProbeBody('tools/list')}]`,
    accept: [-32600],
  },
  'unknown-tool': {
    headers: legacyProbeHeaders,
    body: () =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: UNKNOWN_TOOL_NAME, arguments: {} },
      }),
    accept: [-32602],
  },
  'modern-unknown-method': {
    headers: () => modernProbeHeaders(UNKNOWN_METHOD),
    body: () => modernProbeBody(UNKNOWN_METHOD),
    accept: [-32601],
  },
  'modern-clientcaps': {
    headers: () => modernProbeHeaders('tools/list'),
    body: () => {
      const { 'io.modelcontextprotocol/clientCapabilities': _dropped, ...meta } = modernMeta(MODERN_PROTOCOL_VERSION);
      return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } });
    },
    accept: [-32602, -32600],
  },
  'modern-header-mismatch': {
    headers: () => modernProbeHeaders('resources/list'),
    body: () => modernProbeBody('tools/list'),
    accept: [-32020],
  },
  'modern-version-reject': {
    headers: () => ({ ...modernProbeHeaders('tools/list'), 'MCP-Protocol-Version': UNSUPPORTED_VERSION_CLAIM }),
    body: () =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: modernMeta(UNSUPPORTED_VERSION_CLAIM) },
      }),
    accept: [-32022],
    requireSupported: true,
  },
  'modern-resources-miss': {
    headers: () => ({ ...modernProbeHeaders('resources/read'), 'Mcp-Name': RESOURCE_MISS_URI }),
    body: () =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: RESOURCE_MISS_URI, _meta: modernMeta(MODERN_PROTOCOL_VERSION) },
      }),
    // -32602 is the miss code at the SDK encode seam; -32002 is
    // receive-tolerated legacy compat from non-SDK servers.
    accept: [-32602, -32002],
  },
};

function conformanceFor(op: McpOp): ConformanceProbe | undefined {
  return specOf(op).family === 'conformance' ? CONFORMANCE_PROBES[op as ConformanceOp] : undefined;
}

function buildBody(op: McpOp, method: string, protocolVersion: string): string {
  if (op === 'initialize') {
    return legacyInitializeBody(protocolVersion);
  }
  if (op === 'tools-list') {
    return LEGACY_TOOLS_LIST_BODY;
  }
  if (op === 'resources-list') {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} });
  }
  const modernMethod = specOf(op).method;
  if (modernMethod !== undefined) {
    return modernProbeBody(modernMethod);
  }
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} });
}

export function mcpSessionIdFrom(outcome: ProbeOutcome | undefined): string | null {
  const raw = outcome?.evidence[0]?.session_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Capability groups a handshake evidence row advertised. */
export function advertisedCapabilities(items: EvidenceItem[]): readonly string[] {
  const caps = items[0]?.capabilities;
  return Array.isArray(caps) ? caps.filter((group): group is string => typeof group === 'string') : [];
}

/** A `capabilities` evidence row advertising the resources group. */
export function advertisesResources(items: EvidenceItem[]): boolean {
  return advertisedCapabilities(items).includes('resources');
}

/**
 * Modern-lane presence from the wave-1 `server/discover` outcome. Only a
 * server serving the modern revision can answer `server/discover` with a
 * JSON-RPC result, and `supported_versions` is written on that result
 * path alone, so its presence is the era signal. A probe that never got
 * an answer leaves the lane `unknown`, where the modern rows fall back to
 * probing rather than take a verdict on no evidence.
 */
export function mcpModernLaneFrom(outcome: ProbeOutcome | undefined): McpModernLane {
  if (outcome === undefined || outcome.status === 'error' || outcome.status === 'na') return 'unknown';
  return outcome.evidence.some((item) => 'supported_versions' in item) ? 'present' : 'unevidenced';
}

function jsonRpcErrorCode(rpc: Record<string, unknown> | null): number | null {
  const code = (rpc?.error as { code?: number } | undefined)?.code;
  return typeof code === 'number' ? code : null;
}

const INITIALIZED_BODY = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

/** Best-effort session handshake after initialize; failures do not fail the audit. */
export async function notifyMcpInitialized(
  endpoint: string,
  sessionId: string,
  opts: {
    timeoutMs: number;
    fetchOptions?: Pick<GuardedFetchOptions, 'fetchImpl' | 'maxRedirects'>;
  },
): Promise<void> {
  await guardedFetch(
    endpoint,
    {
      method: 'POST',
      headers: { ...legacyProbeHeaders(), 'Mcp-Session-Id': sessionId },
      body: INITIALIZED_BODY,
    },
    { ...opts.fetchOptions, timeoutMs: opts.timeoutMs },
  );
}

/**
 * Whether the row reads a capability its own lane advertised one request
 * earlier. Refusing a method named in your own handshake contradicts
 * that handshake, so the misconfiguration stays visible on the scorecard
 * instead of reading as an era you do not serve. The advertisement is
 * read from the lane the row probes, so a single-era server is never
 * charged against the other lane's capabilities.
 */
function refusesOwnAdvertisement(op: McpOp, lanes: McpLaneEvidence | undefined): boolean {
  const group = specOf(op).advertises;
  if (group === undefined || lanes === undefined) return false;
  const advertised = specOf(op).era === 'modern' ? lanes.modernAdvertised : lanes.legacyAdvertised;
  return advertised.includes(group);
}

/**
 * A lane's own era probe answered with an unavailability code is
 * reporting an era it does not serve, not a broken surface, unless the
 * lane advertised the very capability it is refusing.
 */
function eraLaneUnavailable(op: McpOp, code: number | null, ctx: HandlerContext): boolean {
  if (code === null || !LANE_UNAVAILABLE_CODES.has(code)) return false;
  return !refusesOwnAdvertisement(op, ctx.mcpLanes);
}

/**
 * Whether a status is compatible with reading an answer as an era signal
 * at all. A 5xx and a retry-shaped status both describe the target's
 * condition rather than its protocol surface, so an answer delivered at
 * one cannot settle which eras the server serves.
 */
function eraReadableStatus(status: number | null): boolean {
  return status === null || (status < 500 && !RETRY_SHAPED_STATUSES.includes(status));
}

/**
 * Whether a `server/discover` answer reports the modern lane's absence.
 * An error envelope is judged on its code, so an internal error stays
 * broken however it is delivered; only an envelope-free answer is judged
 * on its status, so a malformed result and a 5xx both keep the
 * broken-surface penalty a server that tried and failed has earned.
 *
 * -32601 and -32022 name the absence unambiguously and are read at any
 * status. -32000 is JSON-RPC's reserved generic server error, whose
 * session-required meaning is one reading among many, so it counts only
 * where that reading is coherent: a server error or a rate limit
 * carrying it is reporting load, not an era.
 */
function modernLaneRefused(status: number | null, code: number | null): boolean {
  if (code === SESSION_REQUIRED_CODE) return eraReadableStatus(status);
  if (code !== null) return LANE_UNAVAILABLE_CODES.has(code);
  return status !== null && TYPED_REFUSAL_STATUSES.includes(status);
}

export async function runMcp(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const endpoint = ctx.mcpEndpoint;
  if (!endpoint) {
    return { status: 'na', evidence: [{ why: ['no MCP endpoint discovered'] }] };
  }
  const w = check.with as McpWith;
  // The lane is not there, and an agent reaching for it finds nothing, so
  // the row occupies its slot at zero credit like any other absence. It is
  // marked unprobed because no request was sent: the remediation for a
  // specific conformance behavior on a lane the server does not serve
  // would name a defect the audit never observed. The `server/discover`
  // row carries the actionable advice for this shape.
  if (MODERN_LANE_DEPENDENT_OPS.includes(w.op) && ctx.mcpLanes?.modern === 'unevidenced') {
    return {
      status: 'absent',
      unprobed: true,
      evidence: [{ url: endpoint, why: ['no modern lane: server/discover returned no result'] }],
    };
  }
  const conformance = conformanceFor(w.op);
  const modernMethod = specOf(w.op).method;
  // Modern probes stay sessionless (no Mcp-Session-Id) and carry no
  // Mcp-Name: neither op is a tools/call or resources/read. Conformance
  // probes open fully table-shaped, and only the legacy three re-ask with
  // a session, when the target's own answer demands one.
  const headers: Record<string, string> = conformance
    ? conformance.headers()
    : modernMethod !== undefined
      ? modernProbeHeaders(modernMethod)
      : legacyProbeHeaders();
  if (!conformance && modernMethod === undefined && w.op !== 'initialize' && ctx.mcpSessionId) {
    headers['Mcp-Session-Id'] = ctx.mcpSessionId;
  }
  const body = conformance ? conformance.body() : buildBody(w.op, w.method ?? '', ctx.protocolVersion);
  // Every MCP probe reads at most a small JSON-RPC envelope, so the
  // shared audit cap bounds what a hostile endpoint can make the auditor
  // buffer.
  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);
  const fetchOpts = { ...ctx.fetchOptions, timeoutMs, maxBodyBytes: AUDIT_PROBE_MAX_BODY_BYTES };
  // The re-ask below is a second hop on one row's budget; the row's
  // deadline is what bounds it, so the retry gets the remainder rather
  // than a second full timeout the engine only checks between checks.
  const deadlineAt = Date.now() + timeoutMs;

  let resp = await guardedFetch(endpoint, { method: 'POST', headers, body }, fetchOpts);
  let rpc = parseJsonRpc(resp);
  if (LEGACY_CONFORMANCE_OPS.includes(w.op) && ctx.mcpSessionId && jsonRpcErrorCode(rpc) === SESSION_REQUIRED_CODE) {
    const slice = remainingDeadlineMs(deadlineAt);
    if (slice > 0) {
      resp = await guardedFetch(
        endpoint,
        { method: 'POST', headers: { ...headers, 'Mcp-Session-Id': ctx.mcpSessionId }, body },
        { ...fetchOpts, timeoutMs: slice },
      );
      rpc = parseJsonRpc(resp);
    }
  }
  const ev: EvidenceItem = { url: endpoint, status: resp.status, error: resp.error };
  const wwwAuthenticate = resp.headers['www-authenticate'];
  if (wwwAuthenticate !== undefined) ev.www_authenticate = wwwAuthenticate;

  if (resp.error) {
    ev.why = ['request failed'];
    return { status: 'error', evidence: [ev] };
  }

  const code = jsonRpcErrorCode(rpc);
  if (code === RATE_LIMITED_CODE) {
    ev.error_code = RATE_LIMITED_CODE;
    ev.why = ['rate limited by the target'];
    return { status: 'error', evidence: [ev] };
  }

  // Settled ahead of the arms below because a legacy server declines this
  // method both with an envelope and without one, and the arms that would
  // otherwise catch those two answers read them as a broken surface.
  if (specOf(w.op).discriminates === true && modernLaneRefused(resp.status, code)) {
    const reason = code !== null ? `code ${code}` : `HTTP ${resp.status}`;
    if (code !== null) ev.error_code = code;
    ev.why = [`no modern lane: server/discover refused with ${reason}`];
    return { status: 'absent', evidence: [ev] };
  }

  // A typed refusal is the status code plus the absence of a JSON-RPC
  // error envelope, not a parse failure: a 400/415 carrying a
  // framework's own JSON explanation body is still an envelope-free
  // refusal in the statuses the row allows. 404 stays out of every arm
  // so a dead endpoint earns nothing.
  const typedHttpRefusal =
    conformance !== undefined && resp.status !== null && (conformance.httpAccept ?? []).includes(resp.status);

  // The endpoint exists (discovery found it), so a response that carries
  // no parseable JSON-RPC is a broken surface, not an absent one.
  if (rpc === null) {
    if (typedHttpRefusal) {
      ev.why = ['typed HTTP refusal with no JSON-RPC envelope'];
      return { status: 'pass', evidence: [ev] };
    }
    ev.why = ['no parseable JSON-RPC response'];
    return { status: 'broken', evidence: [ev] };
  }

  // Conformance classification: the expected refusal code passes. These
  // rows ask a question the lane has already proven it serves, so no era
  // softening reaches them, and the two ways of failing separate on
  // whether the answer is usable. An envelope-shaped refusal carrying the
  // wrong code still tells the agent the call failed and lets it move on,
  // so it is a taxonomy defect rather than a trap; a result where a
  // refusal was required, or an envelope with no numeric code, leaves the
  // agent believing something that is not true.
  if (conformance) {
    const err = rpc.error as { data?: { supported?: unknown } } | undefined;
    ev.error_code = code;
    if (code === null) {
      if (typedHttpRefusal) {
        ev.why = ['typed HTTP refusal with no JSON-RPC envelope'];
        return { status: 'pass', evidence: [ev] };
      }
      // Two distinguishable defects reach here, and the Issue line on the
      // owner's remediation prompt is this string.
      ev.why = [
        rpc.error !== undefined
          ? 'the JSON-RPC error envelope carries no numeric error.code'
          : 'expected a JSON-RPC error envelope, got a result',
      ];
      return { status: 'broken', evidence: [ev] };
    }
    if (conformance.accept.includes(code)) {
      if (conformance.requireSupported) {
        if (!Array.isArray(err?.data?.supported)) {
          // The refusal itself is correct and well-formed; the client
          // simply cannot read what to renegotiate to.
          ev.why = ['error.data.supported missing from the version-reject envelope'];
          return { status: 'noncompliant', evidence: [ev] };
        }
        ev.supported_versions = err.data.supported;
      }
      return { status: 'pass', evidence: [ev] };
    }
    ev.why = [`expected error code ${conformance.accept.join(' or ')}, got ${code}`];
    return { status: 'noncompliant', evidence: [ev] };
  }

  // Era-lane classification for the ops that ask a lane about itself
  // (initialize, tools-list, resources-list, the unknown-method probe,
  // modern-tools-list, server-discover). Each names a method the lane
  // could be missing, so an unavailability-coded refusal answers the
  // probe truthfully and reads absent. The unknown-method probe reaches
  // here too: its expected code passes, and a post-sunset lane answering
  // -32022 lands absent alongside its lane-mates instead of alone in
  // broken.
  if (rpc.error !== undefined) {
    ev.error_code = code;
    const expected = w.expect_code ?? -32601;
    if (specOf(w.op).expectsRefusal === true) {
      if (code === expected) return { status: 'pass', evidence: [ev] };
      if (eraLaneUnavailable(w.op, code, ctx)) return { status: 'absent', evidence: [ev] };
      ev.why = [`expected error code ${expected}, got ${code}`];
      return { status: 'noncompliant', evidence: [ev] };
    }
    // Every remaining era row asked the lane for a result. An error where
    // a result belongs is a lane that does not serve what it was asked
    // for, so only the unavailability reading softens it.
    return { status: eraLaneUnavailable(w.op, code, ctx) ? 'absent' : 'broken', evidence: [ev] };
  }

  const result = (rpc.result ?? {}) as Record<string, unknown>;
  let ok: boolean;
  if (w.op === 'initialize') {
    const serverInfo = result.serverInfo as { name?: string } | undefined;
    const capabilities = (result.capabilities ?? null) as Record<string, unknown> | null;
    ev.serverInfo = serverInfo ?? null;
    ev.protocolVersion = result.protocolVersion ?? null;
    ev.capabilities = capabilities ? Object.keys(capabilities) : [];
    ev.session_id = resp.headers['mcp-session-id'] ?? null;
    ok = w.assert === 'capabilities' ? !!capabilities && Object.keys(capabilities).length > 0 : !!serverInfo?.name;
  } else if (w.op === 'tools-list' || w.op === 'modern-tools-list') {
    const tools = result.tools as Array<{ name?: string; inputSchema?: unknown }> | undefined;
    ev.tools = Array.isArray(tools) ? tools.map((t) => t.name ?? null) : null;
    ev.with_input_schema = Array.isArray(tools) ? tools.filter((t) => t.inputSchema).length : 0;
    ok = Array.isArray(tools);
  } else if (w.op === 'server-discover') {
    const supported = result.supportedVersions;
    const meta = result._meta as Record<string, unknown> | undefined;
    const serverInfo = meta?.[SERVER_INFO_META_KEY] as { name?: string } | undefined;
    const capabilities = (result.capabilities ?? null) as Record<string, unknown> | null;
    ev.supported_versions = Array.isArray(supported) ? supported : null;
    ev.serverInfo = serverInfo ?? null;
    // The modern lane's capability advertisement; the mcp-resources
    // antecedent reads it alongside the legacy initialize evidence.
    ev.capabilities = capabilities ? Object.keys(capabilities) : [];
    ok = Array.isArray(supported) && !!serverInfo?.name;
  } else if (w.op === 'resources-list') {
    const resources = result.resources as Array<{ uri?: string; name?: string }> | undefined;
    ev.resources = Array.isArray(resources) ? resources.map((r) => r.uri ?? r.name ?? null) : null;
    ok = Array.isArray(resources) && resources.length > 0;
  } else {
    ev.error_code = code;
    ok = code === (w.expect_code ?? -32601);
  }
  return { status: ok ? 'pass' : 'broken', evidence: [ev] };
}
