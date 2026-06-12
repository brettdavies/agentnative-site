#!/usr/bin/env bash
# probe.sh — R6 single-formula compatibility probe for the Homebrew 6.0
# live-scoring spike.
#
# Plan: docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md U2
# Brainstorm requirement: R6 — strict pre-condition that anc audit can
# see a brew-exec'd binary; probe-failure cancels arm 2 by design.
#
# Runs ONE anc100 entry through `brew exec --formulae=<formula> --
# anc audit --command <binary> --output json` against the spike image,
# then falls back to a `brew --prefix` shim if the direct path doesn't
# produce a valid scorecard. Records one of three outcomes:
#
#   succeeded            — direct invocation produced a valid scorecard.
#                          arm 2 measurement command is the direct form.
#   succeeded-with-shim  — direct invocation failed; shim (brew install
#                          + brew --prefix path resolution) produced a
#                          valid scorecard. arm 2 wraps every entry in
#                          the same shim.
#   failed               — neither path produced a valid scorecard within
#                          the orchestrator's time-box. arm 2 is
#                          cancelled and shape C is recorded as inviable.
#
# Time-box: the 4-hour wall-clock limit specified by R6 is enforced at
# the orchestrator level via `timeout 14400 probe.sh ...`; this script
# itself runs to completion or returns when both attempts conclude.
#
# Usage:
#   bash docker/spike/probe.sh                   # ripgrep / rg
#   bash docker/spike/probe.sh ripgrep rg        # explicit
#   bash docker/spike/probe.sh <formula> <bin>   # other formulae
#
# Default formula is ripgrep because the brainstorm cites it as widely-
# bottled, well-known, and a strict-subset test case (rg is the binary
# name, distinct from the formula name `ripgrep` — so the test
# exercises the name-resolution shape U3's harness handles for the full
# anc100 list).
#
# Output: docs/research/2026-06-12-brew-v6-anc100/probe-result.json

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

FORMULA="${1:-ripgrep}"
# Binary name defaults to formula name; for known formula/binary
# mismatches the default is overridden below. Explicit second arg
# wins over the lookup.
case "$FORMULA" in
  ripgrep) DEFAULT_BIN=rg ;;
  the_silver_searcher) DEFAULT_BIN=ag ;;
  *) DEFAULT_BIN="$FORMULA" ;;
esac
BINARY="${2:-$DEFAULT_BIN}"

OUT_DIR="$REPO_ROOT/docs/research/2026-06-12-brew-v6-anc100"
OUT_FILE="$OUT_DIR/probe-result.json"

GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
SPIKE_TAG="${SPIKE_TAG:-anc-sandbox-spike:${GIT_SHA}}"

if ! docker image inspect "$SPIKE_TAG" >/dev/null 2>&1; then
  echo "error: $SPIKE_TAG not present locally — run docker/spike/build.sh first" >&2
  exit 1
fi

if ! command -v jaq >/dev/null 2>&1; then
  echo "error: jaq not installed on the host (used to build probe-result.json safely)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

start_epoch=$(date -u +%s)
start_iso=$(date -u -d "@$start_epoch" +%Y-%m-%dT%H:%M:%SZ)

# brew --version inside the spike image. The brew install banner prints
# update warnings on stderr that change between bottle releases; head
# isolates the canonical version line.
brew_version=$(docker run --rm --entrypoint /bin/bash "$SPIKE_TAG" \
  -c 'sudo -u runner brew --version | head -n1' 2>/dev/null || echo unknown)

# Attempt 1: anc audit invoked INSIDE the brew exec context. brew exec
# prepends the formula's bin dir to PATH and runs the inner command;
# anc audit's `--command <name>` then resolves via PATH so the
# brew-exec'd binary is what gets scored. If anc audit produces a
# scorecard whose `.target` shape is intact, the direct invocation
# is sufficient and no shim is required.
#
# stdout vs stderr separation: brew exec writes install progress
# (`==> Installing ...`, bottle downloads, etc.) to stderr; anc audit
# writes its JSON scorecard to stdout. Capturing them in separate
# files lets the validation step parse JSON from a clean stdout
# stream while still preserving brew's chatter for the failure-case
# excerpt.
# Exit-code semantics: anc audit returns exit 1 for "checks failed"
# (normal — scorecard is valid, score below the bar) and exit >1 for
# real errors. The probe treats VALID JSON ON STDOUT as the success
# signal regardless of exit code; the per-arm measurement layer (U3)
# applies the same convention so a failing scorecard doesn't get
# misrecorded as an install error.
#
# `brew exec --quiet` is INTENTIONALLY NOT used: the `-q` flag
# suppresses the inner wrapped command's stdout too, which kills the
# anc audit JSON we need. Install chatter goes to stderr by default,
# so the stdout/stderr split below already gives a clean JSON stream.
attempt1_stdout=$(mktemp -t probe-a1-stdout.XXXXXX)
attempt1_stderr=$(mktemp -t probe-a1-stderr.XXXXXX)

echo "==> Probe attempt 1: brew exec --formulae=$FORMULA -- anc audit --command $BINARY" >&2
docker run --rm --entrypoint /bin/bash "$SPIKE_TAG" -c \
  "sudo -u runner brew exec --formulae=$FORMULA -- anc audit --command $BINARY --output json" \
  > "$attempt1_stdout" 2> "$attempt1_stderr" || true

outcome=""
binary_path=""
glue=""
attempts=1
audit_excerpt=""

if jaq -e '.target' < "$attempt1_stdout" >/dev/null 2>&1; then
  outcome=succeeded
  binary_path="brew exec --formulae=$FORMULA -- $BINARY"
  audit_excerpt=$(jaq -c '{target: .target, badge: {score_pct: .badge.score_pct}}' < "$attempt1_stdout")
fi

if [[ -z "$outcome" ]]; then
  # Attempt 2: shim — install the formula, resolve its bin dir via
  # `brew --prefix`, then point anc audit at the absolute binary path.
  # This pattern is what U3's measure-entry.sh adopts for arm 2 if the
  # probe records `succeeded-with-shim`.
  attempt2_stdout=$(mktemp -t probe-a2-stdout.XXXXXX)
  attempt2_stderr=$(mktemp -t probe-a2-stderr.XXXXXX)
  attempts=2

  echo "==> Probe attempt 2: shim (brew install --quiet $FORMULA + brew --prefix + anc audit --command \$prefix/bin/$BINARY)" >&2
  docker run --rm --entrypoint /bin/bash "$SPIKE_TAG" -c "
    sudo -u runner brew install --quiet $FORMULA >&2
    shim_prefix=\$(sudo -u runner brew --prefix $FORMULA)
    sudo -u runner anc audit --command \"\$shim_prefix/bin/$BINARY\" --output json
  " > "$attempt2_stdout" 2> "$attempt2_stderr" || true

  if jaq -e '.target' < "$attempt2_stdout" >/dev/null 2>&1; then
    outcome=succeeded-with-shim
    binary_path="\$(brew --prefix $FORMULA)/bin/$BINARY"
    glue="brew install --quiet $FORMULA && shim=\$(brew --prefix $FORMULA) && anc audit --command \$shim/bin/$BINARY"
    audit_excerpt=$(jaq -c '{target: .target, badge: {score_pct: .badge.score_pct}}' < "$attempt2_stdout")
  else
    outcome=failed
    binary_path=""
    glue=""
    # Failure excerpt: stderr (brew chatter, error messages) for each
    # attempt, capped at 20 lines per attempt. Stdout is omitted from
    # the excerpt because both attempts intentionally put JSON on
    # stdout — if it isn't JSON, the stderr is what diagnoses why.
    audit_excerpt=$(printf 'attempt1 stderr:\n%s\n---\nattempt2 stderr:\n%s\n' \
      "$(head -n20 "$attempt1_stderr" 2>/dev/null || true)" \
      "$(head -n20 "$attempt2_stderr" 2>/dev/null || true)")
  fi
  rm -f "$attempt2_stdout" "$attempt2_stderr"
fi

rm -f "$attempt1_stdout" "$attempt1_stderr"

end_epoch=$(date -u +%s)
end_iso=$(date -u -d "@$end_epoch" +%Y-%m-%dT%H:%M:%SZ)
elapsed=$((end_epoch - start_epoch))

# Assemble the result JSON. `--arg` keeps every string-typed field
# escaped correctly; `--argjson` keeps integers as numbers. The schema
# matches the plan U2 description.
# shellcheck disable=SC2016  # $vars inside the jaq filter are jaq vars, not shell vars.
jaq -n \
  --arg outcome "$outcome" \
  --arg formula "$FORMULA" \
  --arg binary "$BINARY" \
  --arg binary_path "$binary_path" \
  --arg glue "$glue" \
  --arg brew_version "$brew_version" \
  --arg started "$start_iso" \
  --arg ended "$end_iso" \
  --arg spike_image "$SPIKE_TAG" \
  --arg audit_excerpt "$audit_excerpt" \
  --argjson attempts "$attempts" \
  --argjson elapsed "$elapsed" \
  '{
    outcome: $outcome,
    formula: $formula,
    binary: $binary,
    binary_path: $binary_path,
    glue: $glue,
    attempts: $attempts,
    elapsed_seconds: $elapsed,
    brew_version: $brew_version,
    probe_started_at: $started,
    probe_ended_at: $ended,
    spike_image: $spike_image,
    audit_excerpt: $audit_excerpt
  }' > "$OUT_FILE"

echo "==> Probe outcome: $outcome (elapsed: ${elapsed}s, attempts: $attempts)" >&2
echo "==> Result: $OUT_FILE" >&2

case "$outcome" in
  succeeded|succeeded-with-shim) exit 0 ;;
  failed) exit 1 ;;
esac
