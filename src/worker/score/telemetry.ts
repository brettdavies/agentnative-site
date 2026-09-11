// The CLI lane's terminal telemetry: the `score.tier` log line and the
// Workers Analytics Engine row, one of each per request. The legacy
// handler emits them from its try/finally; the unified endpoint emits
// them once the terminal line is known, from the relay consumer for a
// stream. The console log is the manual-recovery fallback when AE is
// down; the AE row is the queryable surface.
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
//   double3 anc audit ms   sandbox exec anc-audit duration; null on
//                          non-live paths
//   double4 status         HTTP status the response carried
//
//   index1  tool name OR slug; null on validation errors. Cardinality
//           target ≤10k; AE samples high-cardinality indexes
//           automatically.

import { emitLog } from '../telemetry/log';
import type { ResolvedStep } from './discover-binary';
import type { ScoreError } from './response-shape';

// ---------------------------------------------------------------------------
// The per-request tier accumulator.
//
// `tier` records the resolution branch that produced the response:
//   - `curated`     : registry-fast-path hit
//   - `cache_pre`   : the pre-discovery R2 cache hit (binary derivable from input)
//   - `cache_post`  : the post-discovery R2 cache hit (binary discovered, then re-checked)
//   - `live`        : DO dispatched and returned success
//   - `error_<code>`: terminal error (validation, gate denial, no-resolve, etc.)
//
// The cache attempt and hit flags let operators query "what percentage of
// cache hits came from pre vs post discovery?" through the observability
// binding. Operational signal only; never part of the response body.
// ---------------------------------------------------------------------------

export type ScoreTierTelemetry = {
  tier: string;
  cache_pre_attempted: boolean;
  cache_pre_hit: boolean;
  cache_post_attempted: boolean;
  cache_post_hit: boolean;
  binary: string | null;
  input_kind: string | null;
  pm: PmTag | null;
  freshness: FreshnessTag | null;
  resolved_step: ResolvedStep | 'registry' | null;
  install_ms: number | null;
  anc_audit_ms: number | null;
};

export function newScoreTierTelemetry(): ScoreTierTelemetry {
  return {
    tier: 'unset',
    cache_pre_attempted: false,
    cache_pre_hit: false,
    cache_post_attempted: false,
    cache_post_hit: false,
    binary: null,
    input_kind: null,
    pm: null,
    freshness: null,
    resolved_step: null,
    install_ms: null,
    anc_audit_ms: null,
  };
}

/** The `score.tier` log line. */
export function emitScoreTier(t: ScoreTierTelemetry): void {
  emitLog(
    { scope: 'score.tier' },
    {
      tier: t.tier,
      cache_pre_attempted: t.cache_pre_attempted,
      cache_pre_hit: t.cache_pre_hit,
      cache_post_attempted: t.cache_post_attempted,
      cache_post_hit: t.cache_post_hit,
      binary: t.binary,
      input_kind: t.input_kind,
    },
  );
}

// The accumulator onto the AE writeDataPoint payload. Pure, so the
// telemetry-regression test can pin every slot's derivation. blob1 maps
// ValidatedInput.kind ('slug' | 'install-command' | 'github-url' |
// 'unknown') onto the AE input-kind union: 'slug' becomes 'registry'
// because validate.ts only emits 'slug' for inputs that matched the
// by_slug index. Error codes are derived by stripping the `error_` prefix
// the tier string carries; non-error tiers return null in blob3.
export function buildScoreEventFields(t: ScoreTierTelemetry, totalMs: number, status: number): ScoreEventFields {
  const errorCode = t.tier.startsWith('error_') ? (t.tier.slice('error_'.length) as ScoreError['code']) : null;
  return {
    input_kind: mapInputKind(t.input_kind),
    pm: t.pm,
    error_code: errorCode,
    freshness: t.freshness,
    resolved_step: t.resolved_step,
    total_ms: totalMs,
    install_ms: t.install_ms,
    anc_audit_ms: t.anc_audit_ms,
    response_status: status,
    tool: t.binary,
  };
}

export function mapInputKind(kind: string | null): InputKindTag | null {
  switch (kind) {
    case 'slug':
      return 'registry';
    case 'install-command':
      return 'install-command';
    case 'github-url':
      return 'github-url';
    case 'unknown':
      return 'invalid';
    default:
      return null;
  }
}

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
  anc_audit_ms: number | null;
  response_status: number;
  // tool name OR slug — whichever the input resolved to. Null when
  // input validation rejected before any name was knowable.
  tool: string | null;
};

export function recordScoreEvent(env: ScoreTelemetryEnv, fields: ScoreEventFields): void {
  try {
    env.SCORE_TELEMETRY.writeDataPoint({
      blobs: [fields.input_kind, fields.pm, fields.error_code, fields.freshness, fields.resolved_step],
      doubles: [fields.total_ms, fields.install_ms, fields.anc_audit_ms, fields.response_status],
      indexes: fields.tool ? [fields.tool] : [],
    });
  } catch (err) {
    emitLog({ scope: 'score.telemetry.write_failed' }, { error: err instanceof Error ? err.message : String(err) });
  }
}
