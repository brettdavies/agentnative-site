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
# Production-fidelity: for the 86 brew-pinned registry entries the
# live sandbox does NOT run `brew install <pkg>` directly — it runs
# the input through `resolveBrewFallback` in
# `src/worker/score/resolve-spec.ts`, which fetches formula metadata,
# parses the GitHub homepage, and asks `discoverBinary` to find an
# alternative PM. Arm 1 reads the resolutions cache at
# `docs/research/2026-06-12-brew-v6-anc100/brew-resolutions.json`
# (produced by `docker/spike/prep-resolutions.sh`) and dispatches:
#
#   - resolution.ok == true       → measure the resolved install path
#                                    (cargo-binstall, uv, direct, etc.)
#                                    — this is what users get TODAY.
#   - resolution.ok == false      → record as `would-bounce-in-prod`
#                                    with the production error code
#                                    (`install_unsupported pm=brew_only`).
#                                    Users get bounced TODAY; no
#                                    measurement to make.
#   - resolutions file missing    → fall back to literal `brew install`
#                                    in the spike image (the original
#                                    pre-option-3 behavior). Lets the
#                                    spike run without the prep step
#                                    when needed for triage.
#
# Non-brew registry entries (uv tool install, bun add -g, etc.) bypass
# the resolution lookup and run their literal install command — the
# live sandbox treats those identically (no resolveBrewFallback needed).
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

  audit_cmd="anc audit --command $binary --output json"

  case "$install" in
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
    "brew install "*)
      # Brew-pinned: prefer the cached resolveBrewFallback resolution
      # so arm 1 measures the actual production install path. Fall
      # back to literal `brew install` only when the resolutions
      # cache is missing.
      resolution=$(load_resolution_from_file "$name")
      if [[ -z "$resolution" ]]; then
        echo "    no resolutions cache; falling back to literal brew install in spike image" >&2
        install_cmd="sudo -u runner $install"
      else
        res_ok=$(printf '%s' "$resolution" | jaq -r '.ok')
        if [[ "$res_ok" == "true" ]]; then
          install_cmd=$(printf '%s' "$resolution" | jaq -r '.install_cmd')
          resolved_pm=$(printf '%s' "$resolution" | jaq -r '.pm')
          resolved_binary=$(printf '%s' "$resolution" | jaq -r '.binary')
          echo "    resolved via resolveBrewFallback → pm=$resolved_pm binary=$resolved_binary" >&2
          audit_cmd="anc audit --command $resolved_binary --output json"
        else
          res_err=$(printf '%s' "$resolution" | jaq -r '.error')
          res_details=$(printf '%s' "$resolution" | jaq -r '.details // ""')
          echo "    would-bounce-in-prod: $res_err ($res_details)" >&2
          # shellcheck disable=SC2016  # $vars in the jaq filter are jaq vars
          jaq -nc \
            --arg arm arm1 \
            --arg entry "$name" \
            --arg install_cmd "$install" \
            --arg bounce_error "$res_err" \
            --arg bounce_details "$res_details" \
            --arg skip_reason "would-bounce-in-production: $res_err ($res_details)" \
            '{
              arm: $arm,
              entry: $entry,
              install_cmd: $install_cmd,
              skipped: true,
              skip_reason: $skip_reason,
              production_bounce: {error: $bounce_error, details: $bounce_details}
            }' > "$TMP_DIR/$idx-$name.json"
          continue
        fi
      fi
      ;;
    *)
      install_cmd="$install"
      ;;
  esac

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
