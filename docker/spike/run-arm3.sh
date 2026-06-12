#!/usr/bin/env bash
# run-arm3.sh — arm 3 wrapper for the Homebrew 6.0 live-scoring spike.
#
# Plan: docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md U4
# Brainstorm requirements: R1 arm 3 (reformulate as brew install),
# R15 (arm 3 failure handling: no-result entries recorded as fail,
# run continues).
#
# Reformulates every registry entry as `brew install <pkg>` and runs
# it inside the spike image. For brew-registered entries this is
# identical to arm 1 (and the data should match). For non-brew
# entries (uv / bun / curl / nvidia-smi) the script attempts
# `brew install <binary>` on the assumption that the binary name
# corresponds to a brew formula; entries with no matching formula
# fail at install time and are recorded per R15.
#
# Production-fidelity: arm 3's whole point is to measure the
# resolveBrewFallback translation path's wall-clock. The script reads
# the resolutions cache at
# `docs/research/2026-06-12-brew-v6-anc100/brew-resolutions.json`
# (produced by `docker/spike/prep-resolutions.sh`) which calls the
# production `resolveBrewFallback` via the Bun shim at
# `docker/spike/resolve-brew-fallback.ts`. For each registry entry:
#
#   - resolution.ok == true       → measure the resolved install path
#                                    (cargo-binstall, uv, direct, etc.)
#                                    — same code path arm 1 measures
#                                    for the brew-pinned majority.
#   - resolution.ok == false      → record as R15 fail per the
#                                    brainstorm's contract (no-result
#                                    entries do not abort the run).
#   - resolutions file missing    → fall back to literal
#                                    `brew install <pkg>` (the
#                                    pre-option-3 behavior) so triage
#                                    runs without prep still work.
#
# Usage:
#   bash docker/spike/run-arm3.sh                       # full anc100
#   bash docker/spike/run-arm3.sh --limit 5             # first 5 entries
#   bash docker/spike/run-arm3.sh --only ripgrep,bat    # named entries
#
# Output: docs/research/2026-06-12-brew-v6-anc100/arm3-results.json

set -uo pipefail

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fi
# shellcheck disable=SC1091
source "$REPO_ROOT/docker/spike/arm-common.sh"

load_arm_env || exit $?

OUT_FILE="$ARM_OUT_DIR/arm3-results.json"
TMP_DIR=$(mktemp -d -t arm3.XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> Arm 3: resolveBrewFallback path per registry entry (R15 contract on no-result)" >&2
echo "    Image:    $SPIKE_TAG" >&2
echo "    Output:   $OUT_FILE" >&2

i=0
while IFS=$'\t' read -r name binary install; do
  i=$((i + 1))
  printf -v idx '%04d' "$i"

  # Skip driver-only entries up front — no brew reformulation
  # possible regardless of what the resolver returns.
  case "$install" in
    "included with "*)
      echo "==> Arm 3 entry $i: $name — SKIP (registered as 'included with ...')" >&2
      # shellcheck disable=SC2016  # $vars in the jaq filter are jaq vars
      jaq -nc \
        --arg arm arm3 \
        --arg entry "$name" \
        --arg install_cmd "$install" \
        --arg skip_reason "registered as 'included with ...' (driver-only, no brew reformulation possible)" \
        '{arm: $arm, entry: $entry, install_cmd: $install_cmd, skipped: true, skip_reason: $skip_reason}' \
        > "$TMP_DIR/$idx-$name.json"
      continue
      ;;
  esac

  # Production-fidelity path: read the cached resolveBrewFallback
  # resolution. If the resolution succeeded, measure the resolved
  # install command. If it returned `install_unsupported`, record as
  # R15 fail. If the cache is missing, fall back to literal
  # `brew install <pkg>` for triage.
  audit_cmd="anc audit --command $binary --output json"
  resolution=$(load_resolution_from_file "$name")

  if [[ -z "$resolution" ]]; then
    # No prep cache available — fall back to the pre-option-3
    # behavior (literal `brew install` in the spike image, after
    # resolving via the override map).
    brew_pkg=$(resolve_brew_formula "$name" "$install")
    if [[ -z "$brew_pkg" ]]; then
      local_skip_reason="no brew formula: no override AND no resolutions cache"
      echo "==> Arm 3 entry $i: $name — SKIP ($local_skip_reason)" >&2
      # shellcheck disable=SC2016  # $vars in the jaq filter are jaq vars
      jaq -nc \
        --arg arm arm3 \
        --arg entry "$name" \
        --arg install_cmd "$install" \
        --arg skip_reason "$local_skip_reason" \
        '{arm: $arm, entry: $entry, install_cmd: $install_cmd, skipped: true, skip_reason: $skip_reason}' \
        > "$TMP_DIR/$idx-$name.json"
      continue
    fi
    echo "==> Arm 3 entry $i: $name — falling back to literal brew install ($brew_pkg)" >&2
    install_cmd="sudo -u runner brew install --quiet $brew_pkg"
  else
    res_ok=$(printf '%s' "$resolution" | jaq -r '.ok')
    if [[ "$res_ok" != "true" ]]; then
      res_err=$(printf '%s' "$resolution" | jaq -r '.error')
      res_details=$(printf '%s' "$resolution" | jaq -r '.details // ""')
      echo "==> Arm 3 entry $i: $name — R15 fail: $res_err ($res_details)" >&2
      # shellcheck disable=SC2016  # $vars in the jaq filter are jaq vars
      jaq -nc \
        --arg arm arm3 \
        --arg entry "$name" \
        --arg install_cmd "(reformulated as brew → $res_err)" \
        --arg error "r15-no-result: $res_err ($res_details)" \
        --arg fallback_error "$res_err" \
        --arg fallback_details "$res_details" \
        '{
          arm: $arm,
          entry: $entry,
          install_cmd: $install_cmd,
          install_rc: 1,
          install_elapsed: 0,
          audit_rc: -1,
          audit_elapsed: 0,
          total_elapsed: 0,
          dnf: false,
          error: $error,
          r15_fallback: {error: $fallback_error, details: $fallback_details}
        }' > "$TMP_DIR/$idx-$name.json"
      continue
    fi
    install_cmd=$(printf '%s' "$resolution" | jaq -r '.install_cmd')
    resolved_pm=$(printf '%s' "$resolution" | jaq -r '.pm')
    resolved_binary=$(printf '%s' "$resolution" | jaq -r '.binary')
    echo "==> Arm 3 entry $i: $name — resolved pm=$resolved_pm binary=$resolved_binary" >&2
    audit_cmd="anc audit --command $resolved_binary --output json"
  fi

  measure_entry arm3 "$name" "$install_cmd" "$audit_cmd" > "$TMP_DIR/$idx-$name.json" \
    || echo "    measure_entry failed for $name; recorded in result file (R15 contract)" >&2
done < <(list_entries "$@")

write_arm_array "$TMP_DIR" "$OUT_FILE"

total=$(jaq -r 'length' < "$OUT_FILE")
skipped=$(jaq -r '[.[] | select(.skipped == true)] | length' < "$OUT_FILE")
errors=$(jaq -r '[.[] | select((.error != null) and ((.skipped // false) | not))] | length' < "$OUT_FILE")
ok=$(jaq -r '[.[] | select((.error == null) and ((.skipped // false) | not))] | length' < "$OUT_FILE")

# R15 failure rate metric: install failures counted as a percentage of
# non-skipped entries. The report (U6) will surface this; arm 3 logs
# it inline as a sanity check.
# shellcheck disable=SC2016  # $vars in the jaq filter are jaq vars
fail_pct=$(jaq -r --argjson tot "$total" --argjson skp "$skipped" --argjson err "$errors" '
  ($tot - $skp) as $denom |
  if $denom == 0 then 0 else (($err * 100.0) / $denom | floor) end
' < "$OUT_FILE")

echo "==> Arm 3 done: $total entries ($ok ok, $errors errors, $skipped skipped; R15 failure rate ${fail_pct}%)" >&2
echo "==> Result: $OUT_FILE" >&2
