// Shared handler contracts for the four web-audit probe handlers (plan
// U4). Every handler takes a check, the normalized base URL, a per-audit
// context, and returns a uniform outcome. Egress always flows through
// the SSRF guard (src/worker/audit-web/ssrf.ts); no handler calls fetch
// directly.

import type { ProbeResponse } from '../assert';
import type { GuardedFetchOptions } from '../ssrf';

/**
 * Internal probe status (tri-state outcome model, KTD-1): `absent` means
 * the surface is not there (404/410, NXDOMAIN, missing card); `broken`
 * means it is there but invalid (malformed body, wrong content-type, an
 * unexpected status where the surface clearly exists). `error` is an
 * operational failure (network error, timeout) that excludes the check
 * from scoring rather than crediting or penalizing it.
 */
export type ProbeStatus = 'pass' | 'broken' | 'absent' | 'na' | 'error';

/** Handler-specific evidence rows, kept structurally open like the extracted JSON. */
export type EvidenceItem = Record<string, unknown>;

export interface ProbeOutcome {
  status: ProbeStatus;
  evidence: EvidenceItem[];
}

export interface HandlerContext {
  /** Normalized base URL (scheme + host + trailing slash). */
  base: string;
  /** Target hostname, for DoH `{host}` substitution. */
  host: string;
  /** Discovered MCP endpoint absolute URL, or null. */
  mcpEndpoint: string | null;
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
}
