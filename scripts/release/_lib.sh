#!/usr/bin/env bash
# Shared bash utilities for the release-(pre|post)flight orchestrators and the
# extracted mcp-smoke.sh suite. Source via:
#
#   . "$(dirname "$0")/_lib.sh"
#
# Provides:
#   - Color helpers (C_RED, C_GRN, C_YLW, C_RST, C_BLD) — empty when stdout is
#     not a TTY, so output is clean in CI logs.
#   - Gate counters (PASS_COUNT, FAIL_COUNT, SKIP_COUNT) and emitters
#     (gate_pass, gate_fail, gate_skip).
#   - Section header helper.
#   - Dependency checks (require_bin, have_bin).
#   - Final summary printer (print_summary).
#
# Idempotent: safe to source multiple times. Re-sourcing is a no-op so the
# `readonly` declarations on color constants don't fail.

if [[ -n "${_RELEASE_LIB_SOURCED:-}" ]]; then
    return 0
fi
_RELEASE_LIB_SOURCED=1

# Color helpers --------------------------------------------------------------

if [[ -t 1 ]]; then
    C_RED=$'\033[31m'
    C_GRN=$'\033[32m'
    C_YLW=$'\033[33m'
    C_RST=$'\033[0m'
    C_BLD=$'\033[1m'
else
    C_RED='' C_GRN='' C_YLW='' C_RST='' C_BLD=''
fi
readonly C_RED C_GRN C_YLW C_RST C_BLD

# Gate counters and emitters -------------------------------------------------

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

gate_pass() { printf "  %s✓%s %s\n" "$C_GRN" "$C_RST" "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
gate_fail() { printf "  %s✗%s %s\n    %s\n" "$C_RED" "$C_RST" "$1" "${2:-}"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
gate_skip() { printf "  %s⊝%s %s — %s\n" "$C_YLW" "$C_RST" "$1" "${2:-not yet ready}"; SKIP_COUNT=$((SKIP_COUNT + 1)); }
header()    { printf "\n%s== %s ==%s\n" "$C_BLD" "$1" "$C_RST"; }

# Final summary line. Callers that suppress (e.g., mcp-smoke.sh with
# --result-file) skip this and emit a single-line counter dump instead.
print_summary() {
    printf "\n%sSummary:%s  %s%d passed%s  %s%d failed%s  %s%d skipped%s\n" \
        "$C_BLD" "$C_RST" "$C_GRN" "$PASS_COUNT" "$C_RST" \
        "$C_RED" "$FAIL_COUNT" "$C_RST" "$C_YLW" "$SKIP_COUNT" "$C_RST"
}

# Dependency checks ----------------------------------------------------------

require_bin() {
    command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 2; }
}

have_bin() {
    command -v "$1" >/dev/null 2>&1
}

# Sub-script delegation ------------------------------------------------------

# Runs a sub-script with --result-file pointing at a tmp file and aggregates
# its PASS/FAIL/SKIP counters into the parent's. The sub-script must accept
# --result-file PATH and write three space-separated integers to PATH at exit.
#
# Usage:
#   delegate_to_subscript <script> <args...>
#
# Exit codes from the sub-script are not propagated; the parent decides
# pass/fail based on its own aggregated counters after every gate runs.
delegate_to_subscript() {
    local script="$1"; shift
    local result_file
    result_file=$(mktemp)
    "$script" "$@" --result-file "$result_file" || true
    if [[ -s "$result_file" ]]; then
        local p f s
        read -r p f s < "$result_file"
        PASS_COUNT=$((PASS_COUNT + p))
        FAIL_COUNT=$((FAIL_COUNT + f))
        SKIP_COUNT=$((SKIP_COUNT + s))
    fi
    rm -f "$result_file"
}
