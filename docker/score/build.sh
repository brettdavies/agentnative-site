#!/usr/bin/env bash
# Build the anc-scorer image and (optionally) run it.
#
# `anc` is brew-installed inside the image from brettdavies/tap/agentnative
# (see Dockerfile §"The anc binary"). No local cargo build, no operator-state
# coupling — the image always uses a published release.
#
# Steps:
#   1. Build the docker image via compose.
#   2. (Optional, with --run) Run the scorer with bind-mounts to write
#      scorecards back to the host.
#
# Usage (from repo root):
#   bash docker/score/build.sh           # build only
#   bash docker/score/build.sh --run     # build + run

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cd "$REPO_ROOT"

# 1. Build the image via compose.
echo "==> Building anc-scorer image..."
docker compose -f docker/score/compose.yml build

# 2. Optionally run.
if [[ "${1:-}" == "--run" ]]; then
  echo "==> Running anc-scorer..."
  mkdir -p docker/score/out
  docker compose -f docker/score/compose.yml run --rm scorer
fi

echo "==> done."
