// Shared handler contracts for the four web-audit probe handlers (plan
// U4). Every handler takes a check, the normalized base URL, a per-audit
// context, and returns a uniform outcome. Egress always flows through
// the SSRF guard (src/worker/audit-web/ssrf.ts); no handler calls fetch
// directly.

import type { RetainedDocumentKey } from '../../../shared/web-audit-documents';
import type { NaReason } from '../../../shared/web-audit-findings';
import type { ProbeResponse } from '../assert';
import type { RetainedDocument } from '../discovery-documents';
import type { SignInChallenge } from '../mcp-auth';
import type { GuardedFetchOptions } from '../ssrf';

/**
 * Internal probe status: `absent` means the surface is not there
 * (404/410, NXDOMAIN, missing card); `broken` means it is there but
 * invalid (malformed body, wrong content-type, an unexpected status where
 * the surface clearly exists), so an agent that finds it is misled;
 * `noncompliant` means an agent can use it and get the outcome it asked
 * for while a spec detail is violated, which is a smaller harm than
 * either a trap or an absence. `error` is an operational failure (network
 * error, timeout) that excludes the check from scoring rather than
 * crediting or penalizing it.
 */
export type ProbeStatus = 'pass' | 'noncompliant' | 'broken' | 'absent' | 'na' | 'error';

/** Handler-specific evidence rows, kept structurally open like the extracted JSON. */
export type EvidenceItem = Record<string, unknown>;

/**
 * Whether the target serves the modern MCP era, read from the wave-1
 * `server/discover` probe: `present` when it answered with a JSON-RPC
 * result, `unevidenced` when it answered any other way, and `unknown`
 * when it never got an answer (transport failure, rate limit, deadline).
 */
export type McpModernLane = 'present' | 'unevidenced' | 'unknown';

/** Era-lane facts the wave-1 MCP probes establish for the wave-2 rows. */
export interface McpLaneEvidence {
  modern: McpModernLane;
  /** Capability groups the legacy `initialize` result advertised. */
  legacyAdvertised: readonly string[];
  /** Capability groups the modern `server/discover` result advertised. */
  modernAdvertised: readonly string[];
}

/**
 * The MCP endpoint of record requires sign-in: a wire probe drew a 401 and
 * RFC 9728 metadata on the endpoint's own host names that endpoint as its
 * protected resource.
 */
export interface McpAuthRequired {
  endpoint: string;
  /** The 401's WWW-Authenticate value; null when the 401 carried none. */
  challenge: string | null;
  /** The handshake lane whose probe drew the 401, which the token-less refusal row asks on. */
  lane: 'legacy' | 'modern';
  /** Where the metadata naming the endpoint was read. */
  metadataUrl: string;
  metadata: Record<string, unknown>;
}

export interface ProbeOutcome {
  status: ProbeStatus;
  evidence: EvidenceItem[];
  /** Handler-stated reason for an `na` status; the engine passes it through to the result row. */
  na_reason?: NaReason;
  /**
   * The row settled without issuing a request, because an antecedent the
   * audit did observe rules the surface out. It still scores (an absence
   * an agent would hit is an absence), but it carries no observation of
   * the surface itself, so no remediation is attached: a fix prompt
   * derived from an unmade request names work the audit never established
   * was needed.
   */
  unprobed?: true;
  /**
   * When true, the handler exhausted the remaining per-audit budget mid-probe.
   * The engine treats the run as incomplete and the route must not cache it.
   */
  incomplete?: boolean;
}

export interface HandlerContext {
  /** Normalized base URL (scheme + host + trailing slash). */
  base: string;
  /** Target hostname, for DoH `{host}` substitution. */
  host: string;
  /** Discovered MCP endpoint absolute URL, or null. */
  mcpEndpoint: string | null;
  /**
   * The endpoint is on a declared host, pinned when reciprocity admitted
   * it, so no probe of it follows a redirect somewhere nothing confirmed.
   */
  mcpEndpointFollowed?: boolean;
  protocolVersion: string;
  /** Default per-request timeout in ms; a check's `with.timeout` (seconds) overrides. */
  defaultTimeoutMs: number;
  /**
   * The single canonical root fetch (plain GET `/`), threaded through so
   * root-HTML checks reuse it instead of re-fetching. A check with its
   * own headers (content negotiation) still fetches independently.
   */
  root?: ProbeResponse;
  /**
   * Same-origin section directories enumerated from the root llms.txt
   * link index unioned with sitemap paths (deduplicated); the
   * scoped-llms handler probes `<dir>/llms(-full).txt` under these.
   */
  scopedDirs?: string[];
  /** Passed straight to guardedFetch (fetchImpl injection for tests, hop cap). */
  fetchOptions?: Pick<GuardedFetchOptions, 'fetchImpl' | 'maxRedirects'>;
  /**
   * Wave-1 retained response bodies keyed by check id (e.g. `llms-txt`).
   * Handlers that soften on a discoverable twin read this instead of
   * issuing a second fetch of the antecedent source.
   */
  retainedBodies?: ReadonlyMap<string, string>;
  /** Documents discovery read and kept; a `retained-document` check scores one with no request. */
  retainedDocuments?: ReadonlyMap<RetainedDocumentKey, RetainedDocument>;
  /**
   * Session id from wave-1 MCP initialize (`Mcp-Session-Id`), or null when
   * the server is stateless. Wave-2 MCP probes send it when present.
   */
  mcpSessionId?: string | null;
  /**
   * Era-lane evidence from the wave-1 MCP probes. Modern-era rows score
   * only against a lane `server/discover` evidenced, and a row that reads
   * a capability its own lane advertised is judged against that
   * advertisement.
   */
  mcpLanes?: McpLaneEvidence;
  /** Set once the endpoint is known to require sign-in, so a 401 from it reads as that rather than as a defect. */
  mcpAuth?: McpAuthRequired | null;
  /**
   * Set when wave 1 did not settle that the endpoint requires sign-in:
   * whether a 401 a later row drew is backed by the endpoint's RFC 9728
   * metadata, which then reads as sign-in the same way.
   */
  mcpSignIn?: (answer: SignInChallenge) => Promise<boolean>;
}
