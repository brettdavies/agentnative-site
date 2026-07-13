// Shared handler contracts for the four web-audit probe handlers (plan
// U4). Every handler takes a check, the normalized base URL, a per-audit
// context, and returns a uniform outcome. Egress always flows through
// the SSRF guard (src/worker/audit-web/ssrf.ts); no handler calls fetch
// directly.

import type { GuardedFetchOptions } from '../ssrf';

/** Internal probe status. `error`/`timeout` map to `skip`/`error` at the scorecard boundary. */
export type ProbeStatus = 'pass' | 'fail' | 'na';

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
  /** Passed straight to guardedFetch (fetchImpl injection for tests, hop cap). */
  fetchOptions?: Pick<GuardedFetchOptions, 'fetchImpl' | 'maxRedirects'>;
}
