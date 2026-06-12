#!/usr/bin/env bash
# measure-entry.sh — common per-entry measurement harness for the
# Homebrew 6.0 live-scoring spike.
#
# Plan: docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md U3
# Brainstorm requirements: R2 (combined install + score wall-clock,
# no 60s enforcement, DNF grouping in analysis), R5 (env state recorded
# per arm), KTD4 (per-entry disposable containers), KTD7 (sudo -u runner
# seam for brew commands).
#
# Sourceable library exposing one function:
#
#   measure_entry <arm> <entry_name> <install_cmd> <audit_cmd> [TIMEOUT_S]
#
# Spawns a fresh ephemeral container from the spike image, runs the
# install command, runs the audit command, captures sub-second wall-
# clocks via $EPOCHREALTIME at both phases, snapshots brew supply-
# chain state, and prints one JSON line per entry to stdout. Arm
# wrappers (U4 run-arm{1,2,3}.sh) consume this via:
#
#   source docker/spike/measure-entry.sh
#   measure_entry arm2 ripgrep \
#     "sudo -u runner brew exec --formulae=ripgrep -- rg --version" \
#     "sudo -u runner brew exec --formulae=ripgrep -- anc audit --command rg --output json"
#
# Output JSON schema (one line, compact):
#
#   {
#     "arm":             "arm1" | "arm2" | "arm3",
#     "entry":           string,
#     "install_cmd":     string,
#     "audit_cmd":       string,
#     "install_rc":      int,
#     "install_elapsed": float (sub-second),
#     "audit_rc":        int,
#     "audit_elapsed":   float (sub-second),
#     "total_elapsed":   float (= install_elapsed + audit_elapsed),
#     "dnf":             bool (true when total_elapsed > 60s),
#     "brew_version":    string,
#     "audit_result":    object | null,
#     "env_snapshot":    string (HOMEBREW_*/UV_*/PIP_* env vars, sorted),
#     "trust_state":     object | null (brew trust --json v1),
#     "install_stderr_tail": string (last 5 lines on install failure; empty on success),
#     "audit_stderr_tail":   string (last 5 lines on audit-error exit >1; empty otherwise),
#     "error":           string | null (set when install failed or audit emitted no JSON)
#   }
#
# Exit-code convention (inherited from probe.sh and applied here):
#   install_rc == 0 → install succeeded.
#   install_rc != 0 → install failed; error field set, audit phase skipped.
#   audit_rc == 0 or 1 → scorecard valid (1 = "checks failed", normal).
#   audit_rc > 1 → real audit error; error field set.
#
# Per KTD4, every measure_entry call spawns a fresh container. The
# brew bottle cache from a prior entry's container does NOT persist —
# arm 2 measures cold installs per entry, which is the correct shape
# for live-scoring DO comparison (the DO also runs one-shot per
# request).

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
SPIKE_TAG="${SPIKE_TAG:-anc-sandbox-spike:${GIT_SHA}}"

# Default per-entry container timeout. Plan R2 sets no enforced 60s
# install + score limit — long runs complete and analysis groups
# anything over 60s as DNF. But unbounded waits on a hung install
# would block the whole spike; a 10-minute per-entry ceiling catches
# pathological hangs without affecting any realistic install time.
MEASURE_ENTRY_TIMEOUT_S="${MEASURE_ENTRY_TIMEOUT_S:-600}"

# DNF threshold from R2.
MEASURE_DNF_THRESHOLD_S="${MEASURE_DNF_THRESHOLD_S:-60}"

measure_entry() {
  local arm="$1"
  local entry="$2"
  local install_cmd="$3"
  local audit_cmd="$4"
  local timeout_s="${5:-$MEASURE_ENTRY_TIMEOUT_S}"

  if ! docker image inspect "$SPIKE_TAG" >/dev/null 2>&1; then
    echo "error: $SPIKE_TAG not present locally — run docker/spike/build.sh first" >&2
    return 2
  fi

  local out_dir
  out_dir=$(mktemp -d -t measure-entry.XXXXXX)
  # shellcheck disable=SC2064  # expand $out_dir now, not at trap time
  trap "rm -rf '$out_dir'" RETURN

  # Container script. Runs as root (the /sandbox entrypoint is bypassed
  # via --entrypoint /bin/bash); brew commands wrap in sudo -u runner
  # per KTD7. The script writes timing + state into bind-mounted /out
  # so the host can read them without parsing stdout.
  #
  # Note on `set -uo pipefail` inside the container script (not `-e`):
  # an install failure must NOT abort the script — the harness needs
  # to record the failure as a data point, not bail. The audit phase
  # is conditioned on install_rc == 0 so we never measure an audit
  # against a missing binary.
  # Wrap docker run in a host-side `timeout` so a hung install can't
  # block the spike indefinitely. The plan's R2 leaves the 60s budget
  # to analysis (DNF grouping); this timeout is a separate ceiling to
  # catch pathological hangs.
  # shellcheck disable=SC2016  # $vars in the -c heredoc are container-side, not host shell
  timeout --foreground "$timeout_s" \
  docker run --rm \
    --entrypoint /bin/bash \
    --network host \
    -v "$out_dir":/out \
    -e "INSTALL_CMD=$install_cmd" \
    -e "AUDIT_CMD=$audit_cmd" \
    --stop-timeout 10 \
    "$SPIKE_TAG" -c '
      set -uo pipefail
      umask 022

      brew_version=$(sudo -u runner brew --version 2>/dev/null | head -n1 || echo unknown)

      install_start=$EPOCHREALTIME
      bash -c "$INSTALL_CMD" > /out/install.stdout 2> /out/install.stderr
      install_rc=$?
      install_end=$EPOCHREALTIME
      install_elapsed=$(awk -v s="$install_start" -v e="$install_end" "BEGIN { printf \"%.3f\", e - s }")

      audit_rc=-1
      audit_elapsed=0
      if [ "$install_rc" -eq 0 ]; then
        audit_start=$EPOCHREALTIME
        bash -c "$AUDIT_CMD" > /out/audit.stdout 2> /out/audit.stderr
        audit_rc=$?
        audit_end=$EPOCHREALTIME
        audit_elapsed=$(awk -v s="$audit_start" -v e="$audit_end" "BEGIN { printf \"%.3f\", e - s }")
      else
        : > /out/audit.stdout
        : > /out/audit.stderr
      fi

      printf "INSTALL_RC=%s\nINSTALL_ELAPSED=%s\nAUDIT_RC=%s\nAUDIT_ELAPSED=%s\nBREW_VERSION=%s\n" \
        "$install_rc" "$install_elapsed" "$audit_rc" "$audit_elapsed" "$brew_version" \
        > /out/meta.kv

      env | grep -E "^(HOMEBREW|UV|PIP)_" | sort > /out/env.txt || true
      sudo -u runner brew trust --json v1 > /out/trust.json 2>/dev/null || printf "{}" > /out/trust.json
    ' > /dev/null 2>&1 || true

  # Container may have exited or failed entirely. Defensive defaults if
  # meta.kv is missing (e.g., docker daemon crashed). The error field
  # surfaces this on the result.
  local install_rc=255
  local install_elapsed=0
  local audit_rc=-1
  local audit_elapsed=0
  local brew_version=unknown
  local container_failed=0

  if [[ -f "$out_dir/meta.kv" ]]; then
    # shellcheck disable=SC1091
    while IFS='=' read -r key val; do
      case "$key" in
        INSTALL_RC) install_rc="$val" ;;
        INSTALL_ELAPSED) install_elapsed="$val" ;;
        AUDIT_RC) audit_rc="$val" ;;
        AUDIT_ELAPSED) audit_elapsed="$val" ;;
        BREW_VERSION) brew_version="$val" ;;
      esac
    done < "$out_dir/meta.kv"
  else
    container_failed=1
  fi

  local total_elapsed
  total_elapsed=$(awk -v i="$install_elapsed" -v a="$audit_elapsed" \
    'BEGIN { printf "%.3f", i + a }')

  local dnf=false
  if awk -v t="$total_elapsed" -v thr="$MEASURE_DNF_THRESHOLD_S" \
      'BEGIN { exit (t > thr) ? 0 : 1 }'; then
    dnf=true
  fi

  # audit_result: parse audit stdout as JSON if it has a .target
  # field (probe.sh's success criterion). The error field below is
  # gated on this — anc audit returning exit 1 OR 2 with valid JSON
  # is still a SUCCESSFUL measurement (the scorecard just reflects
  # failing checks). Error is only set when we have no usable JSON.
  local audit_result_file="$out_dir/audit.stdout"
  local has_audit_json=false
  if [[ -s "$audit_result_file" ]] && jaq -e '.target' < "$audit_result_file" >/dev/null 2>&1; then
    has_audit_json=true
  fi

  local error=null
  if [[ $container_failed -eq 1 ]]; then
    error='"container-failed: meta.kv missing — docker run aborted"'
  elif [[ "$install_rc" -ne 0 ]]; then
    local stderr_tail
    stderr_tail=$(tail -n5 "$out_dir/install.stderr" 2>/dev/null || true)
    # shellcheck disable=SC2016  # $s is a jaq var, not a shell var
    error=$(jaq -nR --arg s "install-failed: rc=$install_rc tail=$stderr_tail" '$s')
  elif ! $has_audit_json; then
    local stderr_tail
    stderr_tail=$(tail -n5 "$out_dir/audit.stderr" 2>/dev/null || true)
    # shellcheck disable=SC2016  # $s is a jaq var, not a shell var
    error=$(jaq -nR --arg s "audit-no-json: rc=$audit_rc tail=$stderr_tail" '$s')
  fi

  local install_stderr_tail audit_stderr_tail
  if [[ "$install_rc" -ne 0 ]]; then
    install_stderr_tail=$(tail -n5 "$out_dir/install.stderr" 2>/dev/null || true)
  else
    install_stderr_tail=""
  fi
  if ! $has_audit_json && [[ "$install_rc" -eq 0 ]]; then
    audit_stderr_tail=$(tail -n5 "$out_dir/audit.stderr" 2>/dev/null || true)
  else
    audit_stderr_tail=""
  fi

  local env_snapshot trust_state_arg
  env_snapshot=$(cat "$out_dir/env.txt" 2>/dev/null || true)
  if [[ -s "$out_dir/trust.json" ]]; then
    trust_state_arg=$(cat "$out_dir/trust.json")
  else
    trust_state_arg="{}"
  fi

  # Assemble the result JSON. --argjson for already-JSON values; --arg
  # for strings (jaq escapes them). audit_result reads the stdout file
  # via --slurpfile when valid; null otherwise.
  local audit_result_arg
  if $has_audit_json; then
    audit_result_arg=$(cat "$audit_result_file")
  else
    audit_result_arg="null"
  fi

  # shellcheck disable=SC2016  # $vars inside the jaq filter are jaq vars
  jaq -nc \
    --arg arm "$arm" \
    --arg entry "$entry" \
    --arg install_cmd "$install_cmd" \
    --arg audit_cmd "$audit_cmd" \
    --argjson install_rc "$install_rc" \
    --argjson install_elapsed "$install_elapsed" \
    --argjson audit_rc "$audit_rc" \
    --argjson audit_elapsed "$audit_elapsed" \
    --argjson total_elapsed "$total_elapsed" \
    --argjson dnf "$dnf" \
    --arg brew_version "$brew_version" \
    --argjson audit_result "$audit_result_arg" \
    --arg env_snapshot "$env_snapshot" \
    --argjson trust_state "$trust_state_arg" \
    --arg install_stderr_tail "$install_stderr_tail" \
    --arg audit_stderr_tail "$audit_stderr_tail" \
    --argjson error "$error" \
    '{
      arm: $arm,
      entry: $entry,
      install_cmd: $install_cmd,
      audit_cmd: $audit_cmd,
      install_rc: $install_rc,
      install_elapsed: $install_elapsed,
      audit_rc: $audit_rc,
      audit_elapsed: $audit_elapsed,
      total_elapsed: $total_elapsed,
      dnf: $dnf,
      brew_version: $brew_version,
      audit_result: $audit_result,
      env_snapshot: $env_snapshot,
      trust_state: $trust_state,
      install_stderr_tail: $install_stderr_tail,
      audit_stderr_tail: $audit_stderr_tail,
      error: $error
    }'
}

# If this file is executed directly (not sourced), expose the function
# as a CLI: measure-entry.sh <arm> <entry> <install_cmd> <audit_cmd>.
# Lets a one-off ad-hoc measurement skip the source-into-arm-wrapper
# dance. Sourcing remains the canonical path for U4's arm wrappers.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [[ $# -lt 4 ]]; then
    echo "usage: $0 <arm> <entry_name> <install_cmd> <audit_cmd>" >&2
    exit 2
  fi
  measure_entry "$@"
fi
