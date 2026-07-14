#!/usr/bin/env bash
# capture-hosts.sh — egress host capture for arms 2 and 3 of the
# Homebrew 6.0 live-scoring spike.
#
# Plan: docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md U5
# Brainstorm requirement: R13 (egress host enumeration during arms 2 + 3).
#
# Runs a sample of brew-pinned registry entries through both arm
# shapes with `HOMEBREW_CURL_VERBOSE=1`, parses the resulting stderr
# for curl's `* Connected to <host>:<port>` and `* Host <host>:<port>
# was resolved.` lines, and aggregates the deduplicated host list per
# arm. The captured list feeds the `INSTALL_HOSTS` allow-list during
# any shape-adoption follow-up (origin R13 + R14).
#
# This is a SEPARATE pass from arms 2/3 themselves — capturing per
# entry inside `measure-entry.sh` would have inflated the per-entry
# JSON with full stderr (multi-MB total) for no fidelity gain. The
# same brew bottle hosts are contacted regardless of the specific
# formula, so a small sample is sufficient to enumerate the
# allow-list.
#
# Capture method: HOMEBREW_CURL_VERBOSE. The plan listed a tcpdump
# side-load fallback (requires `--cap-add=NET_ADMIN` on docker run)
# for cases where HOMEBREW_VERBOSE doesn't surface enough — tcpdump
# remains a documented alternative but is NOT wired here; the curl
# verbose output covers ghcr.io (bottles), formulae.brew.sh (metadata
# in v6's JSON API path), and any third-party tap URLs.
#
# Usage:
#   bash docker/spike/capture-hosts.sh                         # default 3-entry sample
#   bash docker/spike/capture-hosts.sh --limit 5               # 5-entry sample
#   bash docker/spike/capture-hosts.sh --only ripgrep,bat,fd   # explicit sample
#
# Output: docs/research/2026-06-12-brew-v6-anc100/egress-hosts.json

set -uo pipefail

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fi
# shellcheck disable=SC1091
source "$REPO_ROOT/docker/spike/arm-common.sh"

load_arm_env || exit $?

# arm-common.sh sources measure-entry.sh, which sets `set -euo pipefail`.
# The -e flag persists into this script and would abort on the first
# grep-no-match in extract_hosts (curl verbose output is empty on a
# cached install, expected). Turn it back off — capture-hosts.sh
# handles per-step failures explicitly via the if/||true pattern.
set +e

OUT_FILE="$ARM_OUT_DIR/egress-hosts.json"
TMP_DIR=$(mktemp -d -t capture-hosts.XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

# Default sample: 3 brew-pinned entries. The same hosts get hit for
# every brew install / brew exec, so a tiny sample enumerates the
# allow-list. Override via --limit or --only.
SAMPLE_ARGS=("$@")
if [[ ${#SAMPLE_ARGS[@]} -eq 0 ]]; then
  SAMPLE_ARGS=(--limit 3)
fi

extract_hosts() {
  # Reads stderr from stdin, prints unique host names one per line.
  # Matches curl's verbose lines:
  #   * Host ghcr.io:443 was resolved.
  #   * Connected to ghcr.io (140.82.114.33) port 443
  # The "Host" form survives even when DNS resolves but the
  # connection fails; the "Connected to" form only fires on
  # successful establishment.
  # grep exit 1 on no-match is expected (cached installs emit no
  # curl verbose lines); swallow it to keep the pipeline alive.
  { grep -E '^\* (Host [^[:space:]]+ was resolved|Connected to )' || true; } \
    | sed -E 's/^\* Host ([^[:space:]:]+):[0-9]+ was resolved.*/\1/; s/^\* Connected to ([^[:space:]]+) .*/\1/' \
    | sort -u
}

echo "==> Capturing egress hosts for arm 2 (brew exec) and arm 3 (brew install)" >&2
echo "    Sample:   ${SAMPLE_ARGS[*]}" >&2
echo "    Image:    $SPIKE_TAG" >&2
echo "    Output:   $OUT_FILE" >&2

declare -a arm2_logs=()
declare -a arm3_logs=()
declare -a sample_entries=()

i=0
while IFS=$'\t' read -r name binary install; do
  i=$((i + 1))
  brew_pkg=$(parse_brew_pkg_from_install "$install")
  if [[ -z "$brew_pkg" ]]; then
    echo "    skip $name (not brew-pinned)" >&2
    continue
  fi

  sample_entries+=("$name")

  arm2_log="$TMP_DIR/arm2-$i-$name.stderr"
  arm3_log="$TMP_DIR/arm3-$i-$name.stderr"

  echo "==> Capture $name: arm 2 brew exec ($brew_pkg)" >&2
  docker run --rm --entrypoint /bin/bash \
    -e HOMEBREW_CURL_VERBOSE=1 \
    "$SPIKE_TAG" -c \
    "sudo -u runner env HOMEBREW_CURL_VERBOSE=1 brew exec --formulae=$brew_pkg -- $binary --version" \
    > /dev/null 2> "$arm2_log" || true
  arm2_logs+=("$arm2_log")

  echo "==> Capture $name: arm 3 brew install ($brew_pkg)" >&2
  # No --quiet here: brew install --quiet suppresses curl verbose
  # output too; this pass is for host enumeration, not wall-clock,
  # so the chatter is desired.
  docker run --rm --entrypoint /bin/bash \
    -e HOMEBREW_CURL_VERBOSE=1 \
    "$SPIKE_TAG" -c \
    "sudo -u runner env HOMEBREW_CURL_VERBOSE=1 brew install $brew_pkg" \
    > /dev/null 2> "$arm3_log" || true
  arm3_logs+=("$arm3_log")
done < <(list_entries "${SAMPLE_ARGS[@]}")

if [[ ${#sample_entries[@]} -eq 0 ]]; then
  echo "error: no brew-pinned entries in the sample; nothing to capture" >&2
  exit 2
fi

# Aggregate hosts across all sample logs, dedupe per arm.
arm2_hosts_file="$TMP_DIR/arm2-hosts.txt"
arm3_hosts_file="$TMP_DIR/arm3-hosts.txt"
: > "$arm2_hosts_file"
: > "$arm3_hosts_file"

for log in "${arm2_logs[@]}"; do
  extract_hosts < "$log" >> "$arm2_hosts_file"
done
for log in "${arm3_logs[@]}"; do
  extract_hosts < "$log" >> "$arm3_hosts_file"
done

arm2_hosts_json=$(sort -u "$arm2_hosts_file" | jaq -R -s 'split("\n") | map(select(length > 0))')
arm3_hosts_json=$(sort -u "$arm3_hosts_file" | jaq -R -s 'split("\n") | map(select(length > 0))')

sample_json=$(printf '%s\n' "${sample_entries[@]}" \
  | jaq -R -s 'split("\n") | map(select(length > 0))')

captured_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# shellcheck disable=SC2016  # $vars in the jaq filter are jaq vars
jaq -n \
  --argjson arm2 "$arm2_hosts_json" \
  --argjson arm3 "$arm3_hosts_json" \
  --argjson sample "$sample_json" \
  --arg captured_at "$captured_at" \
  --arg capture_method homebrew_curl_verbose \
  --arg spike_image "$SPIKE_TAG" \
  '{
    capture_method: $capture_method,
    captured_at: $captured_at,
    spike_image: $spike_image,
    sample_entries: $sample,
    arm2: $arm2,
    arm3: $arm3
  }' > "$OUT_FILE"

arm2_count=$(jaq -r '.arm2 | length' < "$OUT_FILE")
arm3_count=$(jaq -r '.arm3 | length' < "$OUT_FILE")

echo "==> Captured $arm2_count distinct hosts for arm 2, $arm3_count distinct hosts for arm 3" >&2
echo "==> Sample entries: ${sample_entries[*]}" >&2
echo "==> Result: $OUT_FILE" >&2
