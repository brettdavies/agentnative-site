#!/usr/bin/env bash
# report.sh — report generator for the Homebrew 6.0 live-scoring spike.
#
# Plan: docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md U6
# Brainstorm requirements: R7 (per-entry comparison + distribution +
# headroom panel), R8 (anc100 vs brew_only caveat), R9 (supply-chain
# freshness gate), R10 (tap-trust record), R11 (Bubblewrap state),
# R13 (egress hosts), R14 (trust-model paragraph), R15 (arm 3 failure
# rate as metric), success-criteria decision matrix.
#
# Reads every artifact the prior units write:
#   probe-result.json     (U2)
#   arm1-results.json     (U4)
#   arm2-results.json or arm2-cancelled.json (U4)
#   arm3-results.json     (U4)
#   egress-hosts.json     (U5, optional)
# and emits a single markdown report at
#   docs/research/2026-06-12-brew-v6-anc100/report.md
#
# The report is consumed by the shape-decision discussion the
# brainstorm gates on. The decision matrix verdict + arm 3
# competitive-band verdict + v5-era closure verdict are computed
# inline against the success-criteria bands committed pre-spike.
#
# Usage: bash docker/spike/report.sh
# (No flags. The orchestrator invokes this after arms + capture finish.)

set -uo pipefail

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fi
OUT_DIR="$REPO_ROOT/docs/research/2026-06-12-brew-v6-anc100"
OUT_FILE="$OUT_DIR/report.md"

PROBE_FILE="$OUT_DIR/probe-result.json"
ARM1_FILE="$OUT_DIR/arm1-results.json"
ARM2_FILE="$OUT_DIR/arm2-results.json"
# ARM2_CANCEL_FILE is read implicitly by generate_probe_section's
# logging path; surfaced here for the orchestrator's awareness.
# shellcheck disable=SC2034
ARM2_CANCEL_FILE="$OUT_DIR/arm2-cancelled.json"
ARM3_FILE="$OUT_DIR/arm3-results.json"
EGRESS_FILE="$OUT_DIR/egress-hosts.json"

for tool in jaq awk; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: required host tool '$tool' not installed" >&2
    exit 2
  fi
done

# Helper — pass rate (fraction of entries inside 60s, with the DNF
# flag) as integer percent of non-skipped entries.
arm_pass_rate_pct() {
  local file="$1"
  [[ -f "$file" ]] || { printf '0'; return; }
  # shellcheck disable=SC2016  # $vars in the jaq filter are jaq vars
  jaq -r '
    [.[] | select((.skipped // false) | not)] as $ne |
    ($ne | length) as $n |
    if $n == 0 then 0
    else (([$ne[] | select(.dnf == false and .error == null)] | length) * 100 / $n | floor)
    end
  ' < "$file"
}

# Helper — percentile of a numeric field from a results array.
# Skips DNF / error / skipped entries.
arm_percentile() {
  local file="$1"; local field="$2"; local pct="$3"
  [[ -f "$file" ]] || { printf '0'; return; }
  # shellcheck disable=SC2016  # $vars in the jaq filter are jaq vars
  jaq -r --argjson pct "$pct" --arg field "$field" '
    [.[] | select((.skipped // false) | not) | select(.error == null) | .[$field]] |
    map(select(. != null)) | sort as $sorted |
    if ($sorted | length) == 0 then "n/a"
    else $sorted[(($sorted | length) * ($pct / 100.0) | floor | if . >= ($sorted | length) then ($sorted | length - 1) else . end)] | tostring
    end
  ' < "$file"
}

# Helper — count of entries with a given predicate.
arm_count() {
  local file="$1"; local filter="$2"
  [[ -f "$file" ]] || { printf '0'; return; }
  jaq -r "[.[] | $filter] | length" < "$file"
}

# Header
generate_header() {
  local now brew_version
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [[ -f "$PROBE_FILE" ]]; then
    brew_version=$(jaq -r '.brew_version' < "$PROBE_FILE")
  else
    brew_version="(unknown — no probe artifact)"
  fi

  local spike_image
  if [[ -f "$PROBE_FILE" ]]; then
    spike_image=$(jaq -r '.spike_image' < "$PROBE_FILE")
  else
    spike_image="(unknown — no probe artifact)"
  fi

  cat <<HEADER
# Homebrew 6.0 live-scoring spike — report

| Field | Value |
| --- | --- |
| Spike report generated | $now |
| Brew version | $brew_version |
| Spike image tag | \`$spike_image\` |
| Mode | local (CF Sandbox follow-up deferred per KTD5) |
| Plan | [\`docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md\`](../../plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md) |
| Brainstorm | [\`docs/brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md\`](../../brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md) |

HEADER
}

# R6 probe verdict section
generate_probe_section() {
  cat <<'SEC'
## R6 probe verdict

SEC

  if [[ ! -f "$PROBE_FILE" ]]; then
    echo "*Probe artifact missing.* Re-run \`docker/spike/probe.sh\` before regenerating the report."
    echo
    return
  fi

  local outcome formula attempts elapsed binary_path glue
  outcome=$(jaq -r '.outcome' < "$PROBE_FILE")
  formula=$(jaq -r '.formula' < "$PROBE_FILE")
  attempts=$(jaq -r '.attempts' < "$PROBE_FILE")
  elapsed=$(jaq -r '.elapsed_seconds' < "$PROBE_FILE")
  binary_path=$(jaq -r '.binary_path' < "$PROBE_FILE")
  glue=$(jaq -r '.glue' < "$PROBE_FILE")

  cat <<SEC
| Field | Value |
| --- | --- |
| Outcome | **$outcome** |
| Formula | \`$formula\` |
| Attempts | $attempts |
| Elapsed seconds | $elapsed |
| Binary path | \`$binary_path\` |
| Glue | ${glue:-"_(none — direct invocation)_"} |

SEC

  case "$outcome" in
    succeeded|succeeded-with-shim)
      echo "Arm 2 measurement proceeded. Shape C is on the table per the success-criteria bands below."
      ;;
    failed|*)
      echo "Arm 2 cancelled by R6/KTD3. Shape C is recorded as inviable; downstream decision bands skip the shape C row."
      ;;
  esac
  echo
}

# Per-entry comparison table
generate_comparison_table() {
  cat <<'SEC'
## Per-entry comparison

Total elapsed (install + audit), one row per registry entry. `—` denotes skipped (not applicable to the arm) or
errored.

| Entry | Arm 1 | Arm 2 | Arm 3 | Δ(2−1) | Δ(3−1) |
| --- | --- | --- | --- | --- | --- |
SEC

  if [[ ! -f "$ARM1_FILE" ]]; then
    echo "_(arm 1 results missing; per-entry comparison cannot be rendered.)_"
    echo
    return
  fi

  # shellcheck disable=SC2016  # $vars are jaq vars
  jaq -r --slurpfile arm2 "${ARM2_FILE:-/dev/null}" --slurpfile arm3 "${ARM3_FILE:-/dev/null}" '
    def fmt: . * 1000 | round / 1000 | tostring + "s";
    def cell_total($a; $entry):
      if $a[$entry] == null then "—"
      elif ($a[$entry].skipped // false) then "—"
      elif $a[$entry].error != null then "—"
      else ($a[$entry].total_elapsed | fmt) end;
    def cell_delta($a; $base):
      if $a == null or ($a.skipped // false) or ($a.error != null) then "—"
      elif $base == null or ($base.skipped // false) or ($base.error != null) then "—"
      else (($a.total_elapsed - $base.total_elapsed) | fmt) end;
    ($arm2 | if length > 0 then .[0] else [] end | map({(.entry): .}) | add // {}) as $a2 |
    ($arm3 | if length > 0 then .[0] else [] end | map({(.entry): .}) | add // {}) as $a3 |
    [.[]] | sort_by(.entry) | .[] as $row |
    "| \($row.entry) | \(if ($row.skipped // false) then "—" elif $row.error != null then "—" else ($row.total_elapsed | fmt) end) | \(cell_total($a2; $row.entry)) | \(cell_total($a3; $row.entry)) | \(cell_delta($a2[$row.entry]; $row)) | \(cell_delta($a3[$row.entry]; $row)) |"
  ' < "$ARM1_FILE" 2>/dev/null || echo "| _(comparison table generation failed)_ |  |  |  |  |  |"

  echo
}

# Summary band per arm
generate_summary_band() {
  cat <<'SEC'
## Summary band

Pass rate is the fraction of non-skipped, non-errored entries that completed inside the 60-second DNF threshold.
Median / p75 / p95 / max are over `total_elapsed` for the same set.

| Arm | n | pass rate | median (s) | p75 (s) | p95 (s) | max (s) |
| --- | --- | --- | --- | --- | --- | --- |
SEC

  for arm_label in "Arm 1:$ARM1_FILE" "Arm 2:$ARM2_FILE" "Arm 3:$ARM3_FILE"; do
    local label file
    label="${arm_label%%:*}"
    file="${arm_label#*:}"
    if [[ ! -f "$file" ]]; then
      echo "| $label | _(no data)_ | — | — | — | — | — |"
      continue
    fi
    local n pass med p75 p95 mx
    n=$(arm_count "$file" 'select((.skipped // false) | not) | select(.error == null)')
    pass=$(arm_pass_rate_pct "$file")
    med=$(arm_percentile "$file" total_elapsed 50)
    p75=$(arm_percentile "$file" total_elapsed 75)
    p95=$(arm_percentile "$file" total_elapsed 95)
    mx=$(arm_percentile "$file" total_elapsed 100)
    echo "| $label | $n | ${pass}% | $med | $p75 | $p95 | $mx |"
  done
  echo

  # Per-arm "didn't measure" breakdown so the pass-rate denominator is
  # transparent: how many entries were excluded, why, and whether that
  # exclusion is signal vs noise.
  local prod_bounce=0 r15_fails=0
  if [[ -f "$ARM1_FILE" ]]; then
    prod_bounce=$(arm_count "$ARM1_FILE" 'select(.production_bounce != null)')
  fi
  if [[ -f "$ARM3_FILE" ]]; then
    r15_fails=$(arm_count "$ARM3_FILE" 'select(.r15_fallback != null)')
  fi
  if (( prod_bounce > 0 || r15_fails > 0 )); then
    echo "### Exclusions"
    echo
    if (( prod_bounce > 0 )); then
      cat <<NOTE
- **Arm 1 production-bounce count: $prod_bounce.** Entries where the resolved \`resolveBrewFallback\` returned
  \`install_unsupported\` — production users TODAY get a \`pm=brew_only\` bounce for the same input. Treat as a
  failure-of-the-current-path signal, not as "out of scope": each one is an anc100 entry that the live sandbox
  cannot score TODAY.
NOTE
    fi
    if (( r15_fails > 0 )); then
      cat <<NOTE
- **Arm 3 R15 no-result count: $r15_fails.** \`resolveBrewFallback\` could not translate these entries to a peer PM
  (no GitHub release, no matching pip / npm / crates package). Per the R15 contract these are recorded with
  \`error: r15-no-result\` and excluded from arm 3's wall-clock distribution.
NOTE
    fi
    echo
  fi
}

# Headroom panel — arm 1 distribution histogram
generate_headroom_panel() {
  cat <<'SEC'
## Headroom panel (arm 1)

Distribution of arm 1's `total_elapsed` across non-skipped, non-errored entries, bucketed against the 60-second
budget. The R2 DNF threshold is included as the rightmost bucket.

| Bucket | Count | Bar |
| --- | --- | --- |
SEC

  if [[ ! -f "$ARM1_FILE" ]]; then
    echo "| _(no arm 1 data)_ | — | — |"
    echo
    return
  fi

  for bucket in "0-5s:0:5" "5-10s:5:10" "10-30s:10:30" "30-60s:30:60" "DNF (>60s):60:99999"; do
    local label lo hi
    label="${bucket%%:*}"
    local rest="${bucket#*:}"
    lo="${rest%%:*}"
    hi="${rest#*:}"
    local count
    # shellcheck disable=SC2016  # $vars in the jaq filter are jaq vars
    count=$(jaq -r --argjson lo "$lo" --argjson hi "$hi" '
      [.[] | select((.skipped // false) | not) | select(.error == null) |
       select(.total_elapsed >= $lo and .total_elapsed < $hi)] | length
    ' < "$ARM1_FILE")
    local bar=""
    for ((i=0; i<count && i<40; i++)); do
      bar="${bar}█"
    done
    echo "| $label | $count | $bar |"
  done
  echo
}

# Decision matrix verdict
generate_decision_matrix() {
  cat <<'SEC'
## Decision matrix verdict

Bands committed pre-spike (per the brainstorm's success criteria):

- arm 2 ≥ 80% AND probe verdict in {`succeeded`, `succeeded-with-shim`} → **shape C is viable**
- arm 2 50–80% AND probe verdict ok → **shape A+D candidate** (pending brew_only second-pass)
- arm 2 < 50% OR probe failed → **status quo or shape B** (planning revisits)

SEC

  local probe_outcome=unknown
  if [[ -f "$PROBE_FILE" ]]; then
    probe_outcome=$(jaq -r '.outcome' < "$PROBE_FILE")
  fi

  local arm2_pass=0
  if [[ -f "$ARM2_FILE" ]]; then
    arm2_pass=$(arm_pass_rate_pct "$ARM2_FILE")
  fi

  local verdict
  case "$probe_outcome" in
    succeeded|succeeded-with-shim)
      if (( arm2_pass >= 80 )); then
        verdict="**shape C is viable** (arm 2 pass rate $arm2_pass%, probe $probe_outcome)"
      elif (( arm2_pass >= 50 )); then
        verdict="**shape A+D candidate** (arm 2 pass rate $arm2_pass%, probe $probe_outcome; pending brew_only second-pass)"
      else
        verdict="**status quo or shape B** (arm 2 pass rate $arm2_pass% < 50%; planning revisits)"
      fi
      ;;
    *)
      verdict="**status quo or shape B** (probe $probe_outcome; planning revisits)"
      ;;
  esac

  echo "**Verdict:** $verdict."
  echo
}

# Arm 3 competitive-band verdict + R15 failure rate
generate_arm3_verdict() {
  cat <<'SEC'
## Arm 3 competitive-band verdict (R15)

Arm 3 is competitive when its pass rate is within 10 percentage points of arm 2's AND its median wall-clock is within
5 seconds of arm 2's median.

SEC

  local a2_pass=0 a3_pass=0 a2_med=0 a3_med=0
  if [[ -f "$ARM2_FILE" ]]; then
    a2_pass=$(arm_pass_rate_pct "$ARM2_FILE")
    a2_med=$(arm_percentile "$ARM2_FILE" total_elapsed 50)
  fi
  if [[ -f "$ARM3_FILE" ]]; then
    a3_pass=$(arm_pass_rate_pct "$ARM3_FILE")
    a3_med=$(arm_percentile "$ARM3_FILE" total_elapsed 50)
  fi

  echo "| Arm | pass rate | median (s) |"
  echo "| --- | --- | --- |"
  echo "| Arm 2 | ${a2_pass}% | ${a2_med} |"
  echo "| Arm 3 | ${a3_pass}% | ${a3_med} |"
  echo

  if [[ "$a2_med" == "n/a" || "$a3_med" == "n/a" ]]; then
    echo "**Verdict:** _insufficient data_ (one or both arms missing median)."
  else
    local pass_delta med_delta
    pass_delta=$(awk -v a="$a2_pass" -v b="$a3_pass" 'BEGIN { d=a-b; if (d<0) d=-d; print d }')
    med_delta=$(awk -v a="$a2_med" -v b="$a3_med" 'BEGIN { d=a-b; if (d<0) d=-d; printf "%.3f", d }')
    if awk -v p="$pass_delta" -v m="$med_delta" 'BEGIN { exit (p <= 10 && m <= 5) ? 0 : 1 }'; then
      echo "**Verdict:** arm 3 is competitive (within ${pass_delta}pp pass rate, ${med_delta}s median)."
    else
      echo "**Verdict:** arm 3 is the wall-clock floor arm 2 must beat (delta: ${pass_delta}pp pass rate, ${med_delta}s median)."
    fi
  fi
  echo

  # R15 failure rate
  cat <<'SEC'
### R15 failure rate

SEC
  if [[ -f "$ARM3_FILE" ]]; then
    local errors total skipped denom
    total=$(jaq -r 'length' < "$ARM3_FILE")
    skipped=$(jaq -r '[.[] | select(.skipped == true)] | length' < "$ARM3_FILE")
    errors=$(jaq -r '[.[] | select(.error != null and (.skipped // false | not))] | length' < "$ARM3_FILE")
    denom=$((total - skipped))
    if (( denom > 0 )); then
      local pct
      pct=$(awk -v e="$errors" -v d="$denom" 'BEGIN { printf "%.1f", (e * 100.0 / d) }')
      echo "$errors / $denom non-skipped entries failed (${pct}%)."
    else
      echo "_(no non-skipped entries to compute R15 rate against)_"
    fi
  else
    echo "_(arm 3 results missing)_"
  fi
  echo
}

# Supply-chain summary
generate_supply_chain() {
  cat <<'SEC'
## Supply-chain summary

### R9 — Freshness gate

The spike image sets `HOMEBREW_NO_AUTO_UPDATE=1` so `brew update` does not silently fire on every install (which
would have made wall-clock measurement non-deterministic). The freshness gate proper (a configurable acceptance
window for bottle release date) is NOT enforced by the spike — that is a production posture decision orthogonal to
the wall-clock data this spike gathers.

### R10 — Tap-trust state

`HOMEBREW_REQUIRE_TAP_TRUST=FALSE` was set at the image level for measurement parity (arm 1 has no equivalent gate,
so trust-on-arm-2/3 would have biased the comparison). Production adoption of any shape re-evaluates this; the v6
canonical pre-trust command is `brew trust <tap>` and trusted entries persist to `~/.homebrew/trust.json` per user.

### R11 — Bubblewrap state

`HOMEBREW_NO_SANDBOX` was intentionally unset for the spike (R11 default — Bubblewrap enforced by brew during build /
postinstall). Per-entry env snapshots in `arm{1,2,3}-results.json` surface any entry where the fallback to
`HOMEBREW_NO_SANDBOX=1` was applied; if the count is non-zero the report should be revisited before shape adoption.

### R13 — Captured egress hosts

SEC

  if [[ -f "$EGRESS_FILE" ]]; then
    local method captured_at
    method=$(jaq -r '.capture_method' < "$EGRESS_FILE")
    captured_at=$(jaq -r '.captured_at' < "$EGRESS_FILE")
    echo "Capture method: \`$method\`. Captured at: $captured_at."
    echo
    echo "**Arm 2 hosts:**"
    # shellcheck disable=SC2016  # backtick literals in sed; not shell expansion
    jaq -r '.arm2[]' < "$EGRESS_FILE" | sed 's/^/- `/; s/$/`/'
    echo
    echo "**Arm 3 hosts:**"
    # shellcheck disable=SC2016  # backtick literals in sed; not shell expansion
    jaq -r '.arm3[]' < "$EGRESS_FILE" | sed 's/^/- `/; s/$/`/'
  else
    echo "_(egress capture artifact missing — re-run \`docker/spike/capture-hosts.sh\`)_"
  fi
  echo

  cat <<'SEC'
### R14 — Trust model comparison

(Manual paragraph — written during report review.)

The arm 1 install path inherits whatever trust the registered PM enforces (cargo-binstall verifies upstream
release SHA via the lockfile; uv applies its own upload-delay gate; bun resolves through the npm registry's
signature chain). Arm 2 and arm 3 add brew's tap-trust model on top — disabled here for measurement parity, but a
production adoption of shape C / A+D / B re-enables the tap-trust ceremony and inherits brew's per-tap
signature-verification convention. The comparison cuts both ways: brew adds an explicit trust seam that the
current registered PMs do not gate on per-formula, AND the brew chain adds an additional verification surface
(bottle signatures, tap signatures) the current path skips. Shape adoption needs to decide which trust model the
live sandbox stands behind.

SEC
}

# v5-era closure verdict
generate_v5_closure() {
  cat <<'SEC'
## v5-era closure verdict

The original "no brew on the live image" decision was driven by Homebrew-on-Linux v4/v5 performance characteristics
(per-formula JSON metadata fetches, sequential bottle downloads, Ruby cold-start cost, glibc baseline chasing).
v6.0.0 (2026-06-11) closed each of those specific gaps (internal JSON API default, parallelized bottle fetching,
install-steps framework eliminating Ruby evaluation for many formulae, Ubuntu 24.04 / glibc 2.39 baseline that
Trixie's 2.41 over-spec).

SEC

  local arm2_pass=0 probe_outcome=unknown
  if [[ -f "$ARM2_FILE" ]]; then
    arm2_pass=$(arm_pass_rate_pct "$ARM2_FILE")
  fi
  if [[ -f "$PROBE_FILE" ]]; then
    probe_outcome=$(jaq -r '.outcome' < "$PROBE_FILE")
  fi

  if [[ "$probe_outcome" =~ ^succeeded ]] && (( arm2_pass >= 50 )); then
    echo "**Closure verdict:** viable — shape C (or A+D) moves forward. The v5-era perf objection is no longer load-bearing."
  else
    echo "**Closure verdict:** status quo persists. The v5 perf objection is moot, but the spike data does not justify a shape change at the wall-clock level. The remaining objections (image budget, Bubblewrap-in-CF-Sandbox interaction) are unaffected by v6 alone."
  fi
  echo
}

# anc100 vs brew_only caveat
generate_brew_only_caveat() {
  cat <<'SEC'
## anc100 vs brew_only caveat

Per R8, this spike's data does NOT answer the `pm=brew_only` tail-coverage question — entries that have no peer PM
(no cargo-binstall, no uv, no GitHub release) are NOT in anc100 and were NOT measured here. The deferred
second-pass spike against the `pm=brew_only` tail is the gate for A+D / B adoption. The current data only tells the
shape-C-vs-status-quo story for the common case.

SEC
}

# Main
{
  generate_header
  generate_probe_section
  generate_comparison_table
  generate_summary_band
  generate_headroom_panel
  generate_decision_matrix
  generate_arm3_verdict
  generate_supply_chain
  generate_v5_closure
  generate_brew_only_caveat
} > "$OUT_FILE"

echo "==> Wrote $OUT_FILE" >&2
