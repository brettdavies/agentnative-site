#!/usr/bin/env bash
# prep-resolutions.sh — pre-compute resolveBrewFallback resolutions
# for every anc100 registry entry so arms 1 and 3 can measure the
# actual production install path rather than approximating it with
# `brew install`.
#
# Plan: docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md U4
# (option 3 follow-up).
#
# For each registry entry:
#   1. Determine the brew pkg name to attempt (registry's brew install
#      pkg, override map, or — for arm 3 fallback — the registry name).
#   2. Invoke `bun docker/spike/resolve-brew-fallback.ts <pkg>` which
#      calls the production `resolveBrewFallback` (with the production
#      `discovery-hints-index.json` bootstrapped from dist/).
#   3. Accumulate the per-entry result into
#      `docs/research/2026-06-12-brew-v6-anc100/brew-resolutions.json`.
#
# The result file is the single source of truth for arms 1 and 3.
# Arm 1: brew-pinned entries with `ok: true` use the resolved install
# command; entries that resolve `ok: false` (install_unsupported
# pm=brew_only) match what production users see today as a bounce.
# Arm 3: all entries, including non-brew, attempt reformulation.
# `ok: false` is the R15 failure case.
#
# Caching: re-running this script reuses the existing
# brew-resolutions.json unless `--regenerate` is passed. Network calls
# to formulae.brew.sh + GitHub Releases + ecosystem registries (pip /
# crates / npm / etc.) make each resolution slow; caching is the
# difference between a 30-second re-run and a 5-minute re-run.
#
# Usage:
#   bash docker/spike/prep-resolutions.sh             # honor cache
#   bash docker/spike/prep-resolutions.sh --regenerate
#   bash docker/spike/prep-resolutions.sh --limit 5
#   bash docker/spike/prep-resolutions.sh --only ripgrep,bat,fd

set -uo pipefail

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fi
# shellcheck disable=SC1091
source "$REPO_ROOT/docker/spike/arm-common.sh"
# arm-common via measure-entry sets `-e`; unset for this script.
set +e

# prep-resolutions does NOT need the spike image — only host-side
# bun + jaq + yq. Skip load_arm_env's docker image check and do the
# minimal toolchain validation inline.
for tool in bun yq jaq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: required host tool '$tool' not installed" >&2
    exit 2
  fi
done
mkdir -p "$ARM_OUT_DIR"

REGENERATE=0
FILTER_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --regenerate) REGENERATE=1; shift ;;
    --limit|--only) FILTER_ARGS+=("$1" "$2"); shift 2 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "error: unknown flag: $1" >&2; exit 2 ;;
  esac
done

OUT_FILE="$ARM_OUT_DIR/brew-resolutions.json"
BUN_SCRIPT="$ARM_SPIKE_DIR/resolve-brew-fallback.ts"
HINTS_FILE="$REPO_ROOT/dist/discovery-hints-index.json"

if [[ ! -f "$BUN_SCRIPT" ]]; then
  echo "error: $BUN_SCRIPT missing" >&2
  exit 2
fi
if [[ ! -f "$HINTS_FILE" ]]; then
  echo "error: discovery-hints-index.json missing at $HINTS_FILE — run 'bun run build' first" >&2
  exit 2
fi

# Cache short-circuit: when the file exists and no filter was passed,
# reuse it. The presence of --only / --limit forces a fresh run so the
# caller can iterate against a subset without re-resolving the whole
# registry.
if [[ -f "$OUT_FILE" && $REGENERATE -eq 0 && ${#FILTER_ARGS[@]} -eq 0 ]]; then
  echo "==> Reusing cached resolutions at $OUT_FILE (--regenerate to refresh)" >&2
  exit 0
fi

TMP_DIR=$(mktemp -d -t prep-resolutions.XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> Prepping resolveBrewFallback resolutions for arm 1 + arm 3" >&2
echo "    Bun script: $BUN_SCRIPT" >&2
echo "    Hints:      $HINTS_FILE" >&2
echo "    Output:     $OUT_FILE" >&2

i=0
# binary field is read but unused — kept in the read for tuple shape
# consistency with the arm wrappers.
# shellcheck disable=SC2034
while IFS=$'\t' read -r name binary install; do
  i=$((i + 1))
  printf -v idx '%04d' "$i"

  # Determine which brew pkg name to attempt. Priority:
  #   1. Registry's `brew install <pkg>` form (the 86-entry majority).
  #   2. brew-overrides.yaml mapping (for verified non-brew entries).
  #   3. The registry's name (last-resort for arm 3 reformulation —
  #      these are mostly expected to bounce, which IS the R15 signal).
  attempted=$(resolve_brew_formula "$name" "$install")
  source="resolver"
  if [[ -z "$attempted" ]]; then
    attempted="$name"
    source="registry-name-fallback"
  fi

  echo "==> [$i] $name → attempting brew pkg '$attempted' ($source)" >&2

  result_log=$(mktemp -t resolve-result.XXXXXX)
  bun "$BUN_SCRIPT" "$attempted" > "$result_log" 2>&1
  rc=$?

  if [[ $rc -ne 0 ]] || ! jaq -e . < "$result_log" >/dev/null 2>&1; then
    err_tail=$(head -n3 "$result_log" 2>/dev/null | tr '\n' ' ' | head -c 200)
    # shellcheck disable=SC2016  # $vars in jaq filter are jaq vars
    jaq -nc \
      --arg entry "$name" \
      --arg attempted "$attempted" \
      --arg source "$source" \
      --arg err "$err_tail" \
      '{
        entry: $entry,
        attempted_brew_pkg: $attempted,
        attempt_source: $source,
        resolution: {ok: false, error: "bun-runner-error", details: $err}
      }' > "$TMP_DIR/$idx-$name.json"
  else
    # shellcheck disable=SC2016  # $vars in jaq filter are jaq vars
    jaq -c \
      --arg entry "$name" \
      --arg attempted "$attempted" \
      --arg source "$source" \
      '{
        entry: $entry,
        attempted_brew_pkg: $attempted,
        attempt_source: $source,
        resolution: .
      }' < "$result_log" > "$TMP_DIR/$idx-$name.json"
  fi
  rm -f "$result_log"
done < <(list_entries "${FILTER_ARGS[@]}")

write_arm_array "$TMP_DIR" "$OUT_FILE"

# Summary
total=$(jaq -r 'length' < "$OUT_FILE")
ok=$(jaq -r '[.[] | select(.resolution.ok == true)] | length' < "$OUT_FILE")
err=$(jaq -r '[.[] | select(.resolution.ok == false)] | length' < "$OUT_FILE")
echo "==> Prep done: $total entries ($ok resolved, $err install_unsupported / no-result)" >&2
echo "==> Result: $OUT_FILE" >&2
