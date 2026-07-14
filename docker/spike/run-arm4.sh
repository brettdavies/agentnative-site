#!/usr/bin/env bash
# run-arm4.sh — arm 4 wrapper for the Homebrew 6.0 live-scoring spike.
#
# Plan: docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md
# (added post-U4 to complete the three-existing-paths comparison).
#
# Arm 4 measures `sudo -u runner brew install --quiet <pkg>` directly
# in the v6 spike image — the response a brew-equipped live-scoring
# image would give to the user's `brew install <pkg>` input WITHOUT
# routing through `resolveBrewFallback` or `brew exec`. This is the
# pre-v6 alternative that was never deployed because v5's
# Homebrew-on-Linux performance characteristics broke the 60s budget;
# v6's perf work (internal JSON API default, parallel bottle fetching,
# install-steps framework) reopens the question.
#
# Four-arm framing:
#   - Arm 1: `resolveBrewFallback` translation (today's production).
#   - Arm 2: `brew exec --formulae=<pkg> -- <binary>` (NEW v6 path).
#   - Arm 3: `resolveBrewFallback` reformulation (same as arm 1 for
#            brew-pinned entries; the R15 contract surfaces non-brew
#            entries that don't translate).
#   - Arm 4: literal `brew install <pkg>` in v6 image (this arm).
#
# Arm 4 only runs entries the registry pins as `brew install <pkg>`
# (the 86-entry majority) plus the verified non-brew overrides in
# `brew-overrides.yaml`. Entries with no brew formula are skipped
# with a specific reason.
#
# Usage:
#   bash docker/spike/run-arm4.sh                       # full registry (skips non-brew)
#   bash docker/spike/run-arm4.sh --brew-only           # explicit brew-only filter
#   bash docker/spike/run-arm4.sh --only ripgrep,bat    # named entries
#   bash docker/spike/run-arm4.sh --limit 10            # first 10 entries
#
# Output: docs/research/2026-06-12-brew-v6-anc100/arm4-results.json

set -uo pipefail

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fi
# shellcheck disable=SC1091
source "$REPO_ROOT/docker/spike/arm-common.sh"

load_arm_env || exit $?

OUT_FILE="$ARM_OUT_DIR/arm4-results.json"
TMP_DIR=$(mktemp -d -t arm4.XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> Arm 4: literal brew install in v6 image (response to 'brew install <pkg>' input)" >&2
echo "    Image:    $SPIKE_TAG" >&2
echo "    Output:   $OUT_FILE" >&2

i=0
while IFS=$'\t' read -r name binary install; do
  i=$((i + 1))
  printf -v idx '%04d' "$i"

  # Skip driver-only entries up front.
  case "$install" in
    "included with "*)
      echo "==> Arm 4 entry $i: $name — SKIP (registered as 'included with ...')" >&2
      # shellcheck disable=SC2016  # $vars in the jaq filter are jaq vars
      jaq -nc \
        --arg arm arm4 \
        --arg entry "$name" \
        --arg install_cmd "$install" \
        --arg skip_reason "registered as 'included with ...' (driver-only, no brew install path)" \
        '{arm: $arm, entry: $entry, install_cmd: $install_cmd, skipped: true, skip_reason: $skip_reason}' \
        > "$TMP_DIR/$idx-$name.json"
      continue
      ;;
  esac

  # Use the resolver (registry parse + override map) to get the brew
  # formula name. Non-brew entries without a verified override skip
  # with a specific reason rather than guessing.
  brew_pkg=$(resolve_brew_formula "$name" "$install")
  if [[ -z "$brew_pkg" ]]; then
    local_skip_reason="no brew formula: registry pin is not 'brew install <pkg>' and no verified override in brew-overrides.yaml"
    echo "==> Arm 4 entry $i: $name — SKIP ($local_skip_reason)" >&2
    # shellcheck disable=SC2016  # $vars in the jaq filter are jaq vars
    jaq -nc \
      --arg arm arm4 \
      --arg entry "$name" \
      --arg install_cmd "$install" \
      --arg skip_reason "$local_skip_reason" \
      '{arm: $arm, entry: $entry, install_cmd: $install_cmd, skipped: true, skip_reason: $skip_reason}' \
      > "$TMP_DIR/$idx-$name.json"
    continue
  fi

  echo "==> Arm 4 entry $i: $name (brew pkg: $brew_pkg, binary: $binary)" >&2

  install_cmd="sudo -u runner brew install --quiet $brew_pkg"
  audit_cmd="anc audit --command $binary --output json"

  measure_entry arm4 "$name" "$install_cmd" "$audit_cmd" > "$TMP_DIR/$idx-$name.json" \
    || echo "    measure_entry failed for $name; recorded in result file" >&2
done < <(list_entries "$@")

write_arm_array "$TMP_DIR" "$OUT_FILE"

total=$(jaq -r 'length' < "$OUT_FILE")
skipped=$(jaq -r '[.[] | select(.skipped == true)] | length' < "$OUT_FILE")
errors=$(jaq -r '[.[] | select((.error != null) and ((.skipped // false) | not))] | length' < "$OUT_FILE")
ok=$(jaq -r '[.[] | select((.error == null) and ((.skipped // false) | not))] | length' < "$OUT_FILE")

echo "==> Arm 4 done: $total entries ($ok ok, $errors errors, $skipped skipped)" >&2
echo "==> Result: $OUT_FILE" >&2
