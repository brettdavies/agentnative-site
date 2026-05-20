// Workers Analytics Engine telemetry helper for /api/score.
//
// One writeDataPoint per request, emitted from handler.ts in the same
// try/finally that emits the `score.tier` console log line. The console
// log is the manual-recovery fallback when AE is down; this helper is
// the queryable surface.
//
// Field schema is contractual — `tests/score-telemetry.test.ts` pins
// every blob/double/index slot so a future reorder breaks loudly
// rather than silently invalidating saved AE SQL queries. AE rejects
// values silently rather than throwing on cardinality limits, so this
// wrapper enforces shape at the boundary and ALSO enforces the
// graceful-degradation discipline (same posture as `kill-switch.ts`):
// any AE write error logs under scope `score.telemetry.write_failed`
// and is swallowed, so an AE outage cannot block a `/api/score`
// response.
//
// Slot map (canonical — DO NOT reorder without updating
// `docs/runbooks/live-scoring-analytics.md` AND the
// `tests/score-telemetry.test.ts` regression pin):
//
//   blob1   input kind     "registry" | "install-command" | "github-url" |
//                          "slug-miss" | "invalid"
//   blob2   pm             "npm" | "cargo-binstall" | "pip" | "uv" | "bun" |
//                          "go" | "brew" | "direct" | "git-clone" | null
//   blob3   error code     null on success, else ScoreError.code
//   blob4   freshness      "live" | "cache-hit" | "registry-hit" | null
//   blob5   resolved step  DiscoveryResult.resolved_step on live;
//                          "registry" on curated hits; null otherwise
//
//   double1 total ms       Worker handler wall clock
//   double2 install ms     sandbox exec install duration; null on
//                          non-live paths (registry hit, cache hit,
//                          pre-install error)
//   double3 anc check ms   sandbox exec anc-check duration; null on
//                          non-live paths
//   double4 status         HTTP status the response carried
//
//   index1  tool name OR slug; null on validation errors. Cardinality
//           target ≤10k; AE samples high-cardinality indexes
//           automatically.

import type { ResolvedStep } from './discover-binary';
import type { ScoreError } from './response-shape';

// The AE binding type ships in @cloudflare/workers-types; declared
// locally as a structural shape so the worker module compiles in
// environments where the binding type isn't loaded and tests can
// pass a hand-rolled stub. The writeDataPoint signature mirrors the
// Cloudflare runtime's contract.
export interface AnalyticsEngineDataset {
  writeDataPoint(event: { blobs?: (string | null)[]; doubles?: (number | null)[]; indexes?: string[] }): void;
}

export type ScoreTelemetryEnv = {
  SCORE_TELEMETRY: AnalyticsEngineDataset;
};

export type PmTag = 'npm' | 'cargo-binstall' | 'pip' | 'uv' | 'bun' | 'go' | 'brew' | 'direct' | 'git-clone';

export type InputKindTag = 'registry' | 'install-command' | 'github-url' | 'slug-miss' | 'invalid';

export type FreshnessTag = 'live' | 'cache-hit' | 'registry-hit';

export type ScoreEventFields = {
  input_kind: InputKindTag | null;
  pm: PmTag | null;
  error_code: ScoreError['code'] | null;
  freshness: FreshnessTag | null;
  resolved_step: ResolvedStep | 'registry' | null;
  total_ms: number;
  install_ms: number | null;
  anc_check_ms: number | null;
  response_status: number;
  // tool name OR slug — whichever the input resolved to. Null when
  // input validation rejected before any name was knowable.
  tool: string | null;
};

export function recordScoreEvent(env: ScoreTelemetryEnv, fields: ScoreEventFields): void {
  try {
    env.SCORE_TELEMETRY.writeDataPoint({
      blobs: [fields.input_kind, fields.pm, fields.error_code, fields.freshness, fields.resolved_step],
      doubles: [fields.total_ms, fields.install_ms, fields.anc_check_ms, fields.response_status],
      indexes: fields.tool ? [fields.tool] : [],
    });
  } catch (err) {
    console.log(
      JSON.stringify({
        scope: 'score.telemetry.write_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
