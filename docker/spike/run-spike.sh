#!/usr/bin/env bash
# run-spike.sh — top-level orchestrator for the Homebrew 6.0 live-
# scoring spike.
#
# Plan: docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md U7
#
# Runs the full spike sequence:
#   1. Build the spike image (calls docker/spike/build.sh).
#   2. R6 probe (U2, gate for arm 2).
#   3. Arm 1 and arm 3 in parallel (independent of probe outcome).
#   4. Arm 2 sequentially after the probe (skipped on probe-fail; the
#      arm 2 wrapper writes arm2-cancelled.json).
#   5. Egress host capture (U5, sample of brew-pinned entries).
#   6. Report generation (U6).
#   7. Optional --dispose step: removes the spike image after the
#      report writes (KD1 firewall enforcement).
#
# Mode: local only. CF Sandbox mode is a follow-up sub-plan per KTD5;
# the --local flag is accepted explicitly for forward compatibility.
#
# Usage:
#   bash docker/spike/run-spike.sh                       # full anc100, no disposal
#   bash docker/spike/run-spike.sh --dispose             # full anc100, dispose image after
#   bash docker/spike/run-spike.sh --limit 10            # first 10 entries
#   bash docker/spike/run-spike.sh --only ripgrep,bat,fd # named entries
#   bash docker/spike/run-spike.sh --skip-build          # reuse existing image
#
# The --limit / --only flags propagate to every arm + capture.

set -uo pipefail

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fi
SPIKE_DIR="$REPO_ROOT/docker/spike"

DISPOSE=0
SKIP_BUILD=0
ENTRY_ARGS=()

# --local is an explicit no-op flag accepted for forward-compatibility
# with the deferred --cf-sandbox follow-up; it serves only to make
# the local-vs-CF-Sandbox choice visible in the orchestrator's CLI
# surface so future calls can opt into a future mode without
# reorganizing the flag namespace.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dispose) DISPOSE=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --local) shift ;;
    --cf-sandbox)
      echo "error: --cf-sandbox is the deferred follow-up per KTD5; v1 ships local-only" >&2
      echo "       see docker/spike/README.md for the CF Sandbox sub-plan status" >&2
      exit 2
      ;;
    --limit|--only) ENTRY_ARGS+=("$1" "$2"); shift 2 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "error: unknown flag: $1" >&2
      echo "       try: $0 --help" >&2
      exit 2
      ;;
  esac
done

start_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "==> Spike orchestrator starting at $start_iso (local mode)" >&2

# Phase 1: build
if [[ $SKIP_BUILD -eq 0 ]]; then
  echo "==> [1/6] Building spike image..." >&2
  bash "$SPIKE_DIR/build.sh"
else
  echo "==> [1/6] Skipping build (--skip-build set)" >&2
fi

GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
SPIKE_TAG="${SPIKE_TAG:-anc-sandbox-spike:${GIT_SHA}}"
export SPIKE_TAG

if ! docker image inspect "$SPIKE_TAG" >/dev/null 2>&1; then
  echo "error: $SPIKE_TAG not present after build step" >&2
  exit 2
fi

# Phase 2: R6 probe (gate for arm 2)
echo "==> [2/6] Running R6 probe..." >&2
probe_rc=0
bash "$SPIKE_DIR/probe.sh" || probe_rc=$?
PROBE_FILE="$REPO_ROOT/docs/research/2026-06-12-brew-v6-anc100/probe-result.json"
if [[ -f "$PROBE_FILE" ]]; then
  probe_outcome=$(jaq -r '.outcome' < "$PROBE_FILE")
  echo "    probe outcome: $probe_outcome (rc=$probe_rc)" >&2
else
  echo "error: probe-result.json missing after probe.sh" >&2
  exit 2
fi

# Phase 3 + 4: arm 1 + arm 3 in parallel (independent of probe);
# arm 2 sequentially after probe (skipped on probe-fail by the arm 2
# wrapper itself).
echo "==> [3/6] Running arm 1 and arm 3 in parallel..." >&2

arm1_log=$(mktemp -t spike-arm1.XXXXXX)
arm3_log=$(mktemp -t spike-arm3.XXXXXX)

bash "$SPIKE_DIR/run-arm1.sh" "${ENTRY_ARGS[@]}" > "$arm1_log" 2>&1 &
arm1_pid=$!
bash "$SPIKE_DIR/run-arm3.sh" "${ENTRY_ARGS[@]}" > "$arm3_log" 2>&1 &
arm3_pid=$!

# Phase 4: arm 2 sequential (or skipped). The arm 2 wrapper handles
# the probe-fail case internally by writing arm2-cancelled.json.
echo "==> [4/6] Running arm 2 (probe gate decides skip vs run)..." >&2
bash "$SPIKE_DIR/run-arm2.sh" "${ENTRY_ARGS[@]}"

# Wait for parallel arms.
arm1_rc=0; wait "$arm1_pid" || arm1_rc=$?
arm3_rc=0; wait "$arm3_pid" || arm3_rc=$?
echo "    arm 1 rc=$arm1_rc (log: $arm1_log)" >&2
echo "    arm 3 rc=$arm3_rc (log: $arm3_log)" >&2

# Surface the tail of each arm's log to the orchestrator stderr so
# the operator sees the per-arm summary without grepping.
echo "==> arm 1 tail:" >&2
tail -n3 "$arm1_log" >&2
echo "==> arm 3 tail:" >&2
tail -n3 "$arm3_log" >&2
trash "$arm1_log" "$arm3_log" 2>/dev/null || rm -f "$arm1_log" "$arm3_log"

# Phase 5: egress host capture
echo "==> [5/6] Running egress host capture..." >&2
bash "$SPIKE_DIR/capture-hosts.sh" || echo "    capture-hosts rc=$? (continuing)" >&2

# Phase 6: report
echo "==> [6/6] Generating report..." >&2
bash "$SPIKE_DIR/report.sh"

end_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "==> Spike done at $end_iso" >&2

# Disposal step (KD1 firewall): remove the spike image after the
# report writes. The label + CI gate is the load-bearing firewall;
# disposal is best-effort cleanup so the local image cannot be
# accidentally referenced by a stale compose or pushed manually.
if [[ $DISPOSE -eq 1 ]]; then
  echo "==> Disposing $SPIKE_TAG..." >&2
  docker image rm "$SPIKE_TAG" || true
  if docker image inspect "$SPIKE_TAG" >/dev/null 2>&1; then
    echo "    warn: $SPIKE_TAG still present after docker image rm" >&2
  else
    echo "    $SPIKE_TAG removed" >&2
  fi
else
  echo "==> NOTE: --dispose not set; spike image $SPIKE_TAG remains. Dispose with:" >&2
  echo "         docker image rm $SPIKE_TAG" >&2
fi

echo "==> Report: $REPO_ROOT/docs/research/2026-06-12-brew-v6-anc100/report.md" >&2
