#!/usr/bin/env bash
# run-arm2.sh — arm 2 wrapper for the Homebrew 6.0 live-scoring spike.
#
# Plan: docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md U4
# Brainstorm requirements: R1 arm 2 (`brew exec`), R6 (probe gate),
# KTD3 (strict probe gate before any arm 2 measurement).
#
# Reads probe-result.json first. If the outcome is not `succeeded` or
# `succeeded-with-shim`, refuses to run and writes a one-line
# cancellation record to arm2-cancelled.json. Otherwise iterates the
# brew-pinned registry entries, builds `brew exec --formulae=<pkg> --`
# install + audit commands per the probe-recorded shim (if any), and
# dispatches to measure_entry.
#
# Non-brew registry entries are skipped: arm 2's whole point is
# measuring brew exec, and entries pinned to uv / bun / curl / etc.
# have no brew name encoded in the registry to feed brew exec.
# Skipped entries land in arm2-results.json with `skipped: true` and a
# reason, mirroring arm 1's nvidia-smi handling.
#
# Usage:
#   bash docker/spike/run-arm2.sh                       # full anc100
#   bash docker/spike/run-arm2.sh --limit 5             # first 5 entries
#   bash docker/spike/run-arm2.sh --only ripgrep,bat    # named entries
#
# Output:
#   docs/research/2026-06-12-brew-v6-anc100/arm2-results.json   (probe ok)
#   docs/research/2026-06-12-brew-v6-anc100/arm2-cancelled.json (probe failed)

set -uo pipefail

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fi
# shellcheck disable=SC1091
source "$REPO_ROOT/docker/spike/arm-common.sh"

load_arm_env || exit $?

PROBE_FILE="$ARM_OUT_DIR/probe-result.json"
OUT_FILE="$ARM_OUT_DIR/arm2-results.json"
CANCEL_FILE="$ARM_OUT_DIR/arm2-cancelled.json"
TMP_DIR=$(mktemp -d -t arm2.XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ ! -f "$PROBE_FILE" ]]; then
  echo "error: probe-result.json missing at $PROBE_FILE — run docker/spike/probe.sh first" >&2
  exit 2
fi

PROBE_OUTCOME=$(jaq -r '.outcome' < "$PROBE_FILE")
PROBE_FORMULA=$(jaq -r '.formula' < "$PROBE_FILE")
PROBE_GLUE=$(jaq -r '.glue // ""' < "$PROBE_FILE")

case "$PROBE_OUTCOME" in
  succeeded|succeeded-with-shim)
    echo "==> Arm 2 gate: probe $PROBE_OUTCOME (formula: $PROBE_FORMULA) — proceeding" >&2
    ;;
  *)
    echo "==> Arm 2 gate: probe $PROBE_OUTCOME — CANCELLED per R6/KTD3" >&2
    # shellcheck disable=SC2016  # $vars in the jaq filter are jaq vars
    jaq -n \
      --arg outcome "$PROBE_OUTCOME" \
      --arg formula "$PROBE_FORMULA" \
      --arg probe_file "$PROBE_FILE" \
      --arg note "Arm 2 cancelled: probe did not return succeeded or succeeded-with-shim. Shape C is recorded as inviable per the brainstorm's decision matrix. Arm 1 and arm 3 still run." \
      '{
        cancelled: true,
        cancellation_reason: $note,
        probe_outcome: $outcome,
        probe_formula: $formula,
        probe_file: $probe_file
      }' > "$CANCEL_FILE"
    echo "==> Wrote $CANCEL_FILE" >&2
    exit 0
  ;;
esac

# Remove any stale cancellation file from a prior probe-fail run, so
# downstream report.sh has a single source of truth.
rm -f "$CANCEL_FILE"

echo "==> Arm 2: brew exec --formulae=<pkg> -- <binary> per registry entry" >&2
echo "    Image:    $SPIKE_TAG" >&2
echo "    Output:   $OUT_FILE" >&2
if [[ "$PROBE_OUTCOME" == "succeeded-with-shim" ]]; then
  echo "    Shim:     $PROBE_GLUE" >&2
fi

i=0
while IFS=$'\t' read -r name binary install; do
  i=$((i + 1))
  printf -v idx '%04d' "$i"

  # Combined resolver: registry's `brew install <pkg>` wins; otherwise
  # the manual override map in brew-overrides.yaml. Non-brew entries
  # with no override (claude-code, codex, sgpt, cursor, nvidia-smi,
  # ...) get skipped with a specific reason naming which lookup failed.
  brew_pkg=$(resolve_brew_formula "$name" "$install")

  if [[ -z "$brew_pkg" ]]; then
    local_skip_reason="no brew formula: registry pin is not 'brew install <pkg>' and no override in brew-overrides.yaml"
    echo "==> Arm 2 entry $i: $name — SKIP ($local_skip_reason)" >&2
    # shellcheck disable=SC2016  # $vars in jaq filter are jaq vars
    jaq -nc \
      --arg arm arm2 \
      --arg entry "$name" \
      --arg install_cmd "$install" \
      --arg skip_reason "$local_skip_reason" \
      '{arm: $arm, entry: $entry, install_cmd: $install_cmd, skipped: true, skip_reason: $skip_reason}' \
      > "$TMP_DIR/$idx-$name.json"
    continue
  fi

  echo "==> Arm 2 entry $i: $name (brew pkg: $brew_pkg, binary: $binary)" >&2

  if [[ "$PROBE_OUTCOME" == "succeeded-with-shim" ]]; then
    # Shim path from probe-result.json: brew install + anc audit via
    # the resolved prefix. Adapt per-entry.
    install_cmd="sudo -u runner brew install --quiet $brew_pkg"
    audit_cmd="prefix=\$(sudo -u runner brew --prefix $brew_pkg) && sudo -u runner anc audit --command \"\$prefix/bin/$binary\" --output json"
  else
    # Direct path: brew exec runs the install as a side effect of
    # invoking the binary. Force the install via a no-op run of the
    # binary first so install + audit wall-clocks are measured
    # separately (otherwise a single brew-exec invocation lumps them).
    install_cmd="sudo -u runner brew exec --formulae=$brew_pkg -- $binary --version"
    audit_cmd="sudo -u runner brew exec --formulae=$brew_pkg -- anc audit --command $binary --output json"
  fi

  measure_entry arm2 "$name" "$install_cmd" "$audit_cmd" > "$TMP_DIR/$idx-$name.json" \
    || echo "    measure_entry failed for $name; recorded in result file" >&2
done < <(list_entries "$@")

write_arm_array "$TMP_DIR" "$OUT_FILE"

total=$(jaq -r 'length' < "$OUT_FILE")
skipped=$(jaq -r '[.[] | select(.skipped == true)] | length' < "$OUT_FILE")
errors=$(jaq -r '[.[] | select((.error != null) and ((.skipped // false) | not))] | length' < "$OUT_FILE")
ok=$(jaq -r '[.[] | select((.error == null) and ((.skipped // false) | not))] | length' < "$OUT_FILE")

echo "==> Arm 2 done: $total entries ($ok ok, $errors errors, $skipped skipped)" >&2
echo "==> Result: $OUT_FILE" >&2
