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
# Production-fidelity note: the brainstorm describes arm 3 as
# explicitly invoking `resolveBrewFallback` from
# `src/worker/score/resolve-spec.ts` to measure the translation
# layer's wall-clock. This script does NOT do that — invoking
# resolveBrewFallback requires either a Bun harness importing the
# worker code or a `wrangler dev` server, plus a bootstrapped
# `DiscoveryHintsIndex`. Both are deferred per plan U4 "Deferred to
# implementation." The current measurement is `brew install <pkg>`
# directly, which IS what resolveBrewFallback would call if it
# decided to keep the brew path; for entries where the fallback
# would have redirected to cargo-binstall / uv / etc., this script's
# measurement is the WORSE case (since brew install in v6 ought to
# work for any bottled formula). Wiring up the fallback for a
# fidelity re-run is a follow-up.
#
# R15 implementation: an install failure surfaces from measure_entry
# as `install_rc != 0` with the stderr tail surfaced. The record is
# still written and the loop continues — exactly the contract R15
# specifies.
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

echo "==> Arm 3: brew install <pkg> per registry entry (no resolveBrewFallback wiring)" >&2
echo "    Image:    $SPIKE_TAG" >&2
echo "    Output:   $OUT_FILE" >&2

i=0
while IFS=$'\t' read -r name binary install; do
  i=$((i + 1))
  printf -v idx '%04d' "$i"

  # Resolve the brew package name to install. For brew-registered
  # entries the registry already names the pkg; for other entries
  # the binary name is the best heuristic short of resolveBrewFallback.
  brew_pkg=$(parse_brew_pkg_from_install "$install")
  if [[ -z "$brew_pkg" ]]; then
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
      *)
        brew_pkg="$binary"
        ;;
    esac
  fi

  echo "==> Arm 3 entry $i: $name (brew pkg: $brew_pkg, binary: $binary)" >&2

  install_cmd="sudo -u runner brew install --quiet $brew_pkg"
  audit_cmd="anc audit --command $binary --output json"

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
