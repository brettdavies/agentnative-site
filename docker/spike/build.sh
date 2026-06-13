#!/usr/bin/env bash
# Build the spike harness image for the Homebrew 6.0 live-scoring spike.
#
# Plan: docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md
# Origin: docs/brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md
#
# Tags the image as `anc-sandbox-spike:<git-sha>` so it is visually
# distinct from the production `anc-sandbox` tag, and carries the
# `com.agentnative.image-class=spike` label set in the Dockerfile (KD1
# firewall — see docker/spike/README.md).
#
# Dependencies:
#   1. The sandbox base image (`anc-sandbox:local` by default; override
#      via $SANDBOX_TAG). The spike extends this image with Linuxbrew;
#      if the tag is missing locally, this script rebuilds it from
#      docker/sandbox/Dockerfile.
#   2. Docker Engine with BuildKit (default on Compose v2 / modern
#      Docker). Cache mounts depend on it.
#
# Usage (from repo root):
#   bash docker/spike/build.sh                  # build only
#   bash docker/spike/build.sh --print-tag      # build, print final tag
#                                               # on stdout for piping
#   SANDBOX_TAG=anc-sandbox:my-sha \
#     bash docker/spike/build.sh                # build against an
#                                               # explicit sandbox tag
#
# After the build, dispose with:
#   docker image rm anc-sandbox-spike:<sha>

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SANDBOX_TAG="${SANDBOX_TAG:-anc-sandbox:local}"
PRINT_TAG=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print-tag)
      PRINT_TAG=1
      shift
      ;;
    -h | --help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "error: unknown flag: $1" >&2
      echo "       try: $0 --help" >&2
      exit 2
      ;;
  esac
done

cd "$REPO_ROOT"

GIT_SHA="$(git rev-parse --short HEAD)"
SPIKE_TAG="anc-sandbox-spike:${GIT_SHA}"

# Sandbox base presence check. The spike extends the sandbox runtime so
# the arm 1 measurement reflects the exact install paths the live DO
# would receive. Rebuilding here when the tag is missing keeps the spike
# self-bootstrapping; rebuilding when it IS present would invalidate
# every spike layer for no gain.
if ! docker image inspect "$SANDBOX_TAG" >/dev/null 2>&1; then
  echo "==> Sandbox base $SANDBOX_TAG not present locally; building from docker/sandbox/Dockerfile..." >&2
  DOCKER_BUILDKIT=1 docker build \
    --progress=plain \
    -f docker/sandbox/Dockerfile \
    -t "$SANDBOX_TAG" \
    docker/sandbox/
fi

echo "==> Building $SPIKE_TAG from $SANDBOX_TAG..." >&2
DOCKER_BUILDKIT=1 docker build \
  --progress=plain \
  --build-arg "SANDBOX_TAG=$SANDBOX_TAG" \
  -f docker/spike/Dockerfile \
  -t "$SPIKE_TAG" \
  .

# Verify the KD1 label landed. If it didn't, the firewall workflow's
# inspect step would catch it on push, but failing fast here keeps the
# implementer from running the spike against an unlabeled image.
LABEL_VALUE="$(docker inspect --format '{{ index .Config.Labels "com.agentnative.image-class" }}' "$SPIKE_TAG")"
if [[ "$LABEL_VALUE" != "spike" ]]; then
  echo "error: $SPIKE_TAG missing or mismatched com.agentnative.image-class label (got: '$LABEL_VALUE'; expected: 'spike')" >&2
  echo "       The KD1 firewall depends on this label. Check docker/spike/Dockerfile." >&2
  exit 1
fi

echo "==> Built $SPIKE_TAG (label: com.agentnative.image-class=spike)" >&2
echo "    Dispose after the spike completes:" >&2
echo "      docker image rm $SPIKE_TAG" >&2

if [[ $PRINT_TAG -eq 1 ]]; then
  printf '%s\n' "$SPIKE_TAG"
fi
