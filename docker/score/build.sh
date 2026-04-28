#!/usr/bin/env bash
# Build the anc-scorer image and (optionally) run it.
#
# Steps:
#   1. Build the `anc` binary from the local agentnative-cli dev checkout.
#      We use the dev RC because no further substantive changes to scoring
#      logic are expected before v0.2.0 — only the spec re-vendor (content)
#      and release ceremony.
#   2. Copy the built binary into docker/score/ so the Dockerfile build
#      context can pick it up.
#   3. Build the docker image.
#   4. (Optional, with --run) Run the scorer with bind-mounts to write
#      scorecards back to the host.
#
# Usage (from repo root):
#   bash docker/score/build.sh           # build only
#   bash docker/score/build.sh --run     # build + run

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI_ROOT="${ANC_CLI_ROOT:-$HOME/dev/agentnative-cli}"

cd "$REPO_ROOT"

if [[ ! -d "$CLI_ROOT" ]]; then
  echo "error: agentnative-cli checkout not found at $CLI_ROOT" >&2
  echo "       set ANC_CLI_ROOT to override" >&2
  exit 1
fi

# 1. Build the anc binary from CLI dev (release profile, glibc target).
echo "==> Building anc from $CLI_ROOT (release)..."
( cd "$CLI_ROOT" && cargo build --release )
ANC_BIN="$CLI_ROOT/target/release/anc"
if [[ ! -x "$ANC_BIN" ]]; then
  echo "error: expected $ANC_BIN to exist after cargo build" >&2
  exit 1
fi
echo "    built: $ANC_BIN ($("$ANC_BIN" --version))"

# 2. Stage the binary into the build context.
cp "$ANC_BIN" "$REPO_ROOT/docker/score/anc"
chmod +x "$REPO_ROOT/docker/score/anc"

# 3. Build the image via compose.
echo "==> Building anc-scorer image..."
docker compose -f docker/score/compose.yml build

# 4. Optionally run.
if [[ "${1:-}" == "--run" ]]; then
  echo "==> Running anc-scorer..."
  mkdir -p docker/score/out
  docker compose -f docker/score/compose.yml run --rm scorer
fi

echo "==> done."
