#!/usr/bin/env bash
# Install every tool from registry.yaml during image build, classifying
# successes and failures. Intentionally NEVER aborts the build — tools that
# fail to install just end up with their binary missing from PATH at scoring
# time, and the runner records them as install-failed. This keeps the image
# build idempotent across registry tweaks.
#
# Layout (build-time only — these paths live INSIDE the image):
#   /build/registry.yaml               — copied in by Dockerfile (immutable)
#   /build/install-log.txt             — per-tool result, persisted in image
#   /home/runner/.local/bin            — uv tool install destination (auto)
#   /home/linuxbrew/.linuxbrew/bin     — brew destination
#   /home/runner/.bun/bin              — bun add -g destination
#   /home/runner/.cargo/bin            — cargo binstall destination
#
# Note: /work/registry.yaml is the RUN-TIME path (compose bind-mount). This
# script never touches it. Run-time consumer is score-anc100.sh.

set -uo pipefail

REGISTRY=/build/registry.yaml
LOG=/build/install-log.txt

mkdir -p "$(dirname "$LOG")"
: > "$LOG"

# Exclude tools whose `install` field is not one of our allowed paths.
EXCLUDED_INSTALL_PREFIXES_RE='^(included|curl)'

# Read every (name, binary, install) tuple out of the registry.
mapfile -t entries < <(
  yq -r '.tools[] | [.name, .binary, .install] | @tsv' "$REGISTRY"
)

total=${#entries[@]}
ok=0
skipped=0
failed=0

echo "=== Installing $total registry tools ==="
echo "Logging to $LOG"
echo

for line in "${entries[@]}"; do
  IFS=$'\t' read -r name binary install <<<"$line"

  if [[ -z "$install" ]]; then
    echo "[skip] $name — no install field" | tee -a "$LOG"
    skipped=$((skipped + 1))
    continue
  fi

  if [[ "$install" =~ $EXCLUDED_INSTALL_PREFIXES_RE ]]; then
    echo "[skip] $name — install method not container-compatible: $install" | tee -a "$LOG"
    skipped=$((skipped + 1))
    continue
  fi

  echo "----- $name ($binary) -----"
  echo "$install"

  # Run install in a subshell so any source/PATH side-effects don't bleed.
  if (eval "$install") >>"$LOG" 2>&1; then
    if command -v "$binary" >/dev/null 2>&1; then
      echo "[ok]   $name → $(command -v "$binary")" | tee -a "$LOG"
      ok=$((ok + 1))
    else
      echo "[partial] $name installed but binary '$binary' not in PATH" | tee -a "$LOG"
      failed=$((failed + 1))
    fi
  else
    echo "[fail] $name — install command exited non-zero (see $LOG)" | tee -a "$LOG"
    failed=$((failed + 1))
  fi
  echo
done

echo "==============================="
echo "Install summary: ok=$ok skipped=$skipped failed=$failed total=$total"
echo "==============================="
echo "Install summary: ok=$ok skipped=$skipped failed=$failed total=$total" >> "$LOG"
