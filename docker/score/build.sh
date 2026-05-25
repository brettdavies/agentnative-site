#!/usr/bin/env bash
# Build the anc-scorer image and (optionally) run it.
#
# Default mode: brew-install anc from brettdavies/tap/agentnative inside
# the image (Dockerfile §"The anc binary", ANC_SOURCE=brew). The image
# always uses a published release; no local cargo build, no operator-state
# coupling.
#
# Inject mode: `--from-source <path-to-agentnative-cli>` cargo-builds anc
# from that repo (release profile), copies the resulting binary into
# docker/score/inject/anc, and builds the image with ANC_SOURCE=inject
# so the Dockerfile bypasses brew install and uses the injected binary.
# Use this to score the registry against an unreleased anc (feature
# branch, pre-tag dev work) without waiting on a tap formula bump.
#
# Steps:
#   1. (Inject mode only) cargo build --release in the CLI repo.
#   2. (Inject mode only) Stage the binary at docker/score/inject/anc.
#   3. Build the docker image via compose.
#   4. (Optional, with --run) Run the scorer with bind-mounts to write
#      scorecards back to the host.
#
# Usage (from repo root):
#   bash docker/score/build.sh                                 # brew, build only
#   bash docker/score/build.sh --run                           # brew, build + run
#   bash docker/score/build.sh --from-source ~/dev/agentnative-cli         # inject, build only
#   bash docker/score/build.sh --from-source ~/dev/agentnative-cli --run   # inject, build + run
#   bash docker/score/build.sh --run -- --only bat,fd          # build + run, partial scoring
#   bash docker/score/build.sh --run -- --no-update            # build + run, skip per-tool update
#
# Arguments after a literal `--` sentinel are passed through to score-anc100.sh
# inside the container. Use this to flip --only / --no-update without touching
# the wrapper script.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INJECT_DIR="$REPO_ROOT/docker/score/inject"

RUN_AFTER=0
ANC_SRC=""
PASSTHROUGH=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)
      RUN_AFTER=1
      shift
      ;;
    --from-source)
      if [[ -z "${2:-}" || "$2" == --* ]]; then
        echo "error: --from-source requires a path to the agentnative-cli repo" >&2
        exit 2
      fi
      ANC_SRC="$2"
      shift 2
      ;;
    --)
      shift
      PASSTHROUGH=("$@")
      break
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

if [[ -n "$ANC_SRC" ]]; then
  if [[ ! -d "$ANC_SRC" ]]; then
    echo "error: --from-source path does not exist or is not a directory: $ANC_SRC" >&2
    exit 1
  fi
  if [[ ! -f "$ANC_SRC/Cargo.toml" ]]; then
    echo "error: $ANC_SRC does not look like a Cargo workspace (no Cargo.toml at root)" >&2
    exit 1
  fi

  echo "==> Building anc from source: $ANC_SRC"
  (cd "$ANC_SRC" && cargo build --release)

  built_binary="$ANC_SRC/target/release/anc"
  if [[ ! -f "$built_binary" ]]; then
    echo "error: cargo build succeeded but $built_binary is missing" >&2
    exit 1
  fi

  echo "==> Staging binary into $INJECT_DIR/anc"
  install -m 0755 "$built_binary" "$INJECT_DIR/anc"
  echo "    $($INJECT_DIR/anc --version) from $ANC_SRC ($(cd "$ANC_SRC" && git rev-parse --short HEAD))"

  export ANC_SOURCE=inject
else
  export ANC_SOURCE=brew
fi

echo "==> Building anc-scorer image (ANC_SOURCE=$ANC_SOURCE)..."
docker compose -f docker/score/compose.yml build

if [[ $RUN_AFTER -eq 1 ]]; then
  echo "==> Running anc-scorer${PASSTHROUGH:+ (passthrough: ${PASSTHROUGH[*]})}..."
  mkdir -p docker/score/out
  docker compose -f docker/score/compose.yml run --rm scorer "${PASSTHROUGH[@]}"
fi

echo "==> done."
