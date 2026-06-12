#!/usr/bin/env bash
# run-arm1.sh — arm 1 wrapper for the Homebrew 6.0 live-scoring spike.
#
# Plan: docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md U4
# Brainstorm requirement: R1 arm 1 ("current production install path").
#
# Iterates every registry.yaml entry, builds the install command from
# the entry's `install:` field, wraps brew commands in `sudo -u runner`
# per KTD7, and dispatches to measure_entry from docker/spike/
# measure-entry.sh. Output is one JSON object per entry written
# incrementally as the run progresses, then combined into a single
# JSON array at the end.
#
# Production-fidelity note: the brainstorm describes arm 1 as the
# "current production install path." For the 86 brew-pinned registry
# entries the live sandbox runs them through `resolveBrewFallback` in
# `src/worker/score/resolve-spec.ts`, NOT direct brew install (the
# live image carries no brew). The spike image DOES carry brew, so
# running the literal registry command here measures brew install
# inside the spike — useful as a baseline against arm 2 and arm 3,
# but not identical to what production sees today. Wiring
# resolveBrewFallback into arm 1 is deferred to a follow-up
# enhancement (see plan U4 "Deferred to implementation": Bun-script
# vs wrangler-dev integration). The current data still tells the
# story arms 2/3 need to be compared against.
#
# Usage:
#   bash docker/spike/run-arm1.sh                       # full anc100
#   bash docker/spike/run-arm1.sh --limit 5             # first 5 entries
#   bash docker/spike/run-arm1.sh --only curl,git       # named entries
#
# Output: docs/research/2026-06-12-brew-v6-anc100/arm1-results.json

set -uo pipefail

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fi
# shellcheck disable=SC1091
source "$REPO_ROOT/docker/spike/arm-common.sh"

load_arm_env || exit $?

OUT_FILE="$ARM_OUT_DIR/arm1-results.json"
TMP_DIR=$(mktemp -d -t arm1.XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> Arm 1: current production install path (literal registry command, spike image)" >&2
echo "    Registry: $ARM_REGISTRY_FILE" >&2
echo "    Image:    $SPIKE_TAG" >&2
echo "    Output:   $OUT_FILE" >&2

i=0
while IFS=$'\t' read -r name binary install; do
  i=$((i + 1))
  printf -v idx '%04d' "$i"

  echo "==> Arm 1 entry $i: $name ($binary)" >&2

  # Build install command from the registry `install:` field. The
  # field is already a fully-formed shell command; for brew entries we
  # wrap in `sudo -u runner` (brew refuses root). For non-brew entries
  # the command runs as root.
  case "$install" in
    "brew install "*)
      install_cmd="sudo -u runner $install"
      ;;
    "included with "*)
      # nvidia-smi-style entries are not installable in the spike
      # image (driver-only). Record as skipped.
      # shellcheck disable=SC2016  # $vars in the jaq filter are jaq vars
      jaq -nc \
        --arg arm arm1 \
        --arg entry "$name" \
        --arg install_cmd "$install" \
        --arg skip_reason "registered as 'included with ...' (driver-only, not installable in the spike image)" \
        '{arm: $arm, entry: $entry, install_cmd: $install_cmd, skipped: true, skip_reason: $skip_reason}' \
        > "$TMP_DIR/$idx-$name.json"
      continue
      ;;
    *)
      install_cmd="$install"
      ;;
  esac

  audit_cmd="anc audit --command $binary --output json"

  measure_entry arm1 "$name" "$install_cmd" "$audit_cmd" > "$TMP_DIR/$idx-$name.json" \
    || echo "    measure_entry failed for $name; recorded in result file" >&2
done < <(list_entries "$@")

write_arm_array "$TMP_DIR" "$OUT_FILE"

# Summary line
total=$(jaq -r 'length' < "$OUT_FILE")
skipped=$(jaq -r '[.[] | select(.skipped == true)] | length' < "$OUT_FILE")
errors=$(jaq -r '[.[] | select(.error != null and .skipped != true)] | length' < "$OUT_FILE")
ok=$(jaq -r '[.[] | select(.error == null and .skipped != true)] | length' < "$OUT_FILE")

echo "==> Arm 1 done: $total entries ($ok ok, $errors errors, $skipped skipped)" >&2
echo "==> Result: $OUT_FILE" >&2
