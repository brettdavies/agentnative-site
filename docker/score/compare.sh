#!/usr/bin/env bash
# Corpus before/after harness: score the registry with two anc builds inside
# one scorer image and report the rows that moved between them.
#
# Builds, runs and captures land under the gitignored docker/score/out/.
# Nothing here writes to scorecards/, builds an image, or pulls one.
#
# Commands:
#   build   --cli <repo> <ref>
#       Build anc at <ref> into out/compare/builds/<commit>/. A commit already
#       built is reused; a binary that differs from its manifest is rebuilt.
#   aa      --cli <repo> --image <image> <ref>
#       Run one build twice and write the rows that differ to noise.tsv.
#   diff    --cli <repo> --image <image> [--noise <tsv>] <base-ref> <head-ref>
#       Run both builds, each in its own container. Every tool with a moved row
#       or a noise-listed row then runs three more times per build, and a row
#       moves when its majority result differs between the builds. A
#       noise-listed row moves only when the builds share no result.
#   capture --image <image> [--subcommands <tsv>]
#       Save each tool's `--help` under out/captures/. With --subcommands (lines
#       of binary<TAB>subcommand) save each `<binary> <subcommand> --help`.
#
# Options:
#   --cli <repo>         agentnative-cli checkout the builds come from
#   --image <image>      scorer image, any ref; resolved once to its ID and run by ID
#   --only a,b,c         registry names to run (default: every entry)
#   --jobs <n>           tools in flight at once (default 4)
#   --timeout <seconds>  limit per anc audit (default 300) or per capture (default 5)
#   --network <mode>     docker network mode for every container (default bridge)
#   --label <name>       run directory under out/compare/ (default: commits and start time)
#   --noise <tsv>        noise.tsv from an A/A run; diff only
#   --subcommands <tsv>  capture only
#   -h, --help           print this header
#
# Usage (from repo root):
#   bash docker/score/compare.sh aa --cli ~/dev/agentnative-cli --image <image> dev
#   bash docker/score/compare.sh diff --cli ~/dev/agentnative-cli --image <image> \
#     --noise docker/score/out/compare/<aa-label>/noise.tsv <base-ref> <head-ref>

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCORE_DIR="$REPO_ROOT/docker/score"
COMPARE_DIR="$SCORE_DIR/out/compare"
CAPTURE_DIR="$SCORE_DIR/out/captures"
WORKTREE="$COMPARE_DIR/worktree"
RERUNS=3

declare -A OPT=([cli]="" [image]="" [only]="" [jobs]=4 [timeout]="" [network]=bridge [label]="" [noise]="" [subcommands]="")
REFS=()

die() {
  echo "error: $*" >&2
  exit 1
}

usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \?//'; }

usage_error() {
  echo "error: $*" >&2
  echo "       try: $0 --help" >&2
  exit 2
}

need() {
  local name
  for name in "$@"; do
    [[ -n "${OPT[$name]}" ]] || usage_error "$COMMAND requires --$name"
  done
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

resolve_commit() {
  git -C "${OPT[cli]}" rev-parse --verify --quiet "$1^{commit}" || die "not a commit in ${OPT[cli]}: $1"
}

resolve_image() {
  docker image inspect --format '{{.Id}}' "${OPT[image]}" 2>/dev/null || die "no local image matches --image ${OPT[image]}"
}

build_matches_manifest() { [[ "$(jq -r .sha256 "$1/manifest.json")" == "$(sha256_of "$1/anc")" ]]; }

build_commit() {
  local commit=$1 dir=$COMPARE_DIR/builds/$1
  echo "==> building anc at $commit" >&2
  mkdir -p "$COMPARE_DIR"
  git -C "${OPT[cli]}" worktree add --detach "$WORKTREE" "$commit" >&2 \
    || die "could not add a worktree at $WORKTREE. If an interrupted build left one, remove it with: git -C ${OPT[cli]} worktree remove --force $WORKTREE"
  trap 'git -C "${OPT[cli]}" worktree remove --force "$WORKTREE" >&2' EXIT
  (cd "$WORKTREE" && CARGO_TARGET_DIR="$COMPARE_DIR/target" cargo build --release --locked >&2)
  mkdir -p "$dir"
  install -m 0755 "$COMPARE_DIR/target/release/anc" "$dir/anc"
  jq -n --arg commit "$commit" --arg sha256 "$(sha256_of "$dir/anc")" '{commit: $commit, sha256: $sha256}' >"$dir/manifest.json"
  git -C "${OPT[cli]}" worktree remove --force "$WORKTREE" >&2
  trap - EXIT
}

ensure_build() {
  local dir=$COMPARE_DIR/builds/$1
  if [[ ! -f "$dir/anc" || ! -f "$dir/manifest.json" ]]; then
    build_commit "$1"
  fi
}

verify_builds() {
  local dir
  for dir in "$BASE_DIR" "$HEAD_DIR"; do
    build_matches_manifest "$dir" && continue
    {
      echo "error: $dir/anc does not match its manifest; refusing to run."
      echo "  manifest sha256: $(jq -r .sha256 "$dir/manifest.json")"
      echo "  binary sha256:   $(sha256_of "$dir/anc")"
      echo "  rebuild with:    bash docker/score/compare.sh build --cli ${OPT[cli]} $(jq -r .commit "$dir/manifest.json")"
    } >&2
    exit 1
  done
}

cmd_build() {
  need cli
  ((${#REFS[@]} == 1)) || usage_error "build takes one ref"
  local commit dir
  commit=$(resolve_commit "${REFS[0]}")
  dir=$COMPARE_DIR/builds/$commit
  if [[ -f "$dir/anc" && -f "$dir/manifest.json" ]] && build_matches_manifest "$dir"; then
    echo "==> already built: $dir/anc" >&2
  else
    build_commit "$commit"
  fi
  cat "$dir/manifest.json"
}

# Every container shares these: one image ID, one network mode, no TTY, and the
# registry and the in-container script read-only.
docker_run() {
  docker run --rm --network "${OPT[network]}" --entrypoint /bin/bash \
    -v "$REPO_ROOT/registry.yaml:/harness/registry.yaml:ro" \
    -v "$SCORE_DIR/compare-container.sh:/harness/compare-container.sh:ro" \
    "$@"
}

# One container per build, started together from the same image. A tool can
# change its own state on its first run (broot installs a shell launcher, glow
# opens a log), so a second audit in the same container would see a different
# tool than the first did.
run_round() {
  local round=$1 only=$2 out=$RUN_DIR/runs/$1 build dir pid failed=0
  local -a pids=()
  mkdir -p "$out"
  verify_builds
  echo "==> run $round: ${only:-every registry entry}" >&2
  for build in base head; do
    dir=$BASE_DIR
    [[ "$build" == head ]] && dir=$HEAD_DIR
    # PATH's anc is the base build in both containers, so the registry's anc
    # entry audits one fixed target while the auditor varies.
    docker_run \
      -e AGENTNATIVE_HOME_CONFIG=/harness/home-config.toml \
      -v "$RUN_DIR/home-config.toml:/harness/home-config.toml:ro" \
      -v "$dir/anc:/harness/anc:ro" \
      -v "$BASE_DIR/anc:/home/runner/.local/bin/anc:ro" \
      -v "$out:/harness/out" \
      "$IMAGE_ID" /harness/compare-container.sh score "$build" "${OPT[jobs]}" "${OPT[timeout]}" "$only" >&2 &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do
    wait "$pid" || failed=1
  done
  ((failed == 0)) || die "a scoring container failed in run $round"
  join -t $'\t' <(LC_ALL=C sort "$out/status-base.tsv") <(LC_ALL=C sort "$out/status-head.tsv") >"$out/status.tsv"
}

cmd_run() {
  local mode=$1 base head label rerun="" started=$SECONDS started_at
  local -a noise_args=()
  need cli image
  # The diff step needs bun and node_modules; learn that before the run, not after it.
  bun -e "await import('$SCORE_DIR/compare-diff.mjs')" || die "compare-diff.mjs does not load; run \`bun install\` in $REPO_ROOT"
  if [[ -n "${OPT[noise]}" ]]; then
    [[ -f "${OPT[noise]}" ]] || die "no such noise list: ${OPT[noise]}"
    noise_args=(--noise "${OPT[noise]}")
  fi

  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  IMAGE_ID=$(resolve_image)
  base=$(resolve_commit "${REFS[0]}")
  head=$(resolve_commit "${REFS[-1]}")
  ensure_build "$base"
  ensure_build "$head"
  BASE_DIR=$COMPARE_DIR/builds/$base
  HEAD_DIR=$COMPARE_DIR/builds/$head
  verify_builds

  label=${base:0:12}-${head:0:12}
  [[ "$mode" == aa ]] && label=aa-${base:0:12}
  label=${OPT[label]:-$label-$(date -u +%Y%m%dT%H%M%SZ)}
  RUN_DIR=$COMPARE_DIR/$label
  mkdir "$RUN_DIR" || die "could not create $RUN_DIR; if it exists, choose another --label"
  : >"$RUN_DIR/home-config.toml"

  jq -n --arg mode "$mode" --arg label "$label" --arg image_ref "${OPT[image]}" --arg image_id "$IMAGE_ID" \
    --arg registry_sha256 "$(sha256_of "$REPO_ROOT/registry.yaml")" \
    --slurpfile base "$BASE_DIR/manifest.json" --slurpfile head "$HEAD_DIR/manifest.json" \
    --arg network "${OPT[network]}" --argjson jobs "${OPT[jobs]}" --argjson timeout "${OPT[timeout]}" \
    --arg only "${OPT[only]}" --arg noise "${OPT[noise]}" \
    --arg noise_sha256 "$([[ -z "${OPT[noise]}" ]] || sha256_of "${OPT[noise]}")" --arg started_at "$started_at" '
    {mode: $mode, label: $label, image: {ref: $image_ref, id: $image_id}, registry_sha256: $registry_sha256,
     builds: {base: $base[0], head: $head[0]}, network: $network, jobs: $jobs, timeout_seconds: $timeout,
     only: ($only | select(. != "")) // null,
     noise: (if $noise == "" then null else {path: $noise, sha256: $noise_sha256} end),
     started_at: $started_at}' >"$RUN_DIR/manifest.json"

  run_round 0 "${OPT[only]}"
  if [[ "$mode" == diff ]]; then
    rerun=$(bun "$SCORE_DIR/compare-diff.mjs" rerun-set "$RUN_DIR" "${noise_args[@]}")
    if [[ -n "$rerun" ]]; then
      for ((round = 1; round <= RERUNS; round++)); do
        run_round "$round" "$(paste -sd, <<<"$rerun")"
      done
    fi
  fi

  jq --slurpfile container "$RUN_DIR/runs/0/container-base.json" --arg rerun "$rerun" \
    --arg finished_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson wall "$((SECONDS - started))" '
    . + {container: $container[0], rerun_tools: ($rerun | split("\n") | map(select(. != ""))),
         finished_at: $finished_at, wall_seconds: $wall}' "$RUN_DIR/manifest.json" >"$RUN_DIR/manifest.json.tmp"
  mv "$RUN_DIR/manifest.json.tmp" "$RUN_DIR/manifest.json"

  bun "$SCORE_DIR/compare-diff.mjs" report "$RUN_DIR" "${noise_args[@]}"
  echo "==> wrote $RUN_DIR" >&2
}

cmd_capture() {
  local phase=toplevel started=$SECONDS started_at
  local -a mounts=() script_args=()
  need image
  ((${#REFS[@]} == 0)) || usage_error "capture takes no ref"
  if [[ -n "${OPT[subcommands]}" ]]; then
    [[ -f "${OPT[subcommands]}" ]] || die "no such subcommand list: ${OPT[subcommands]}"
    phase=subcommands
    mounts=(-v "$(realpath "${OPT[subcommands]}"):/harness/subcommands.tsv:ro")
    script_args=(/harness/subcommands.tsv)
  fi

  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  IMAGE_ID=$(resolve_image)
  mkdir -p "$CAPTURE_DIR"
  docker_run "${mounts[@]}" -v "$CAPTURE_DIR:/harness/out" "$IMAGE_ID" \
    /harness/compare-container.sh capture "${OPT[jobs]}" "${OPT[timeout]}" "${OPT[only]}" "${script_args[@]}"

  jq -n --arg phase "$phase" --arg image_ref "${OPT[image]}" --arg image_id "$IMAGE_ID" \
    --arg registry_sha256 "$(sha256_of "$REPO_ROOT/registry.yaml")" \
    --slurpfile container "$CAPTURE_DIR/_container.json" \
    --arg network "${OPT[network]}" --argjson jobs "${OPT[jobs]}" --argjson timeout "${OPT[timeout]}" \
    --arg only "${OPT[only]}" \
    --arg subcommands_sha256 "$([[ -z "${OPT[subcommands]}" ]] || sha256_of "${OPT[subcommands]}")" \
    --arg started_at "$started_at" --arg finished_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson wall "$((SECONDS - started))" '
    {mode: "capture", phase: $phase, image: {ref: $image_ref, id: $image_id}, registry_sha256: $registry_sha256,
     network: $network, container: $container[0], jobs: $jobs, timeout_seconds: $timeout,
     only: ($only | select(. != "")) // null,
     subcommands_sha256: ($subcommands_sha256 | select(. != "")) // null,
     started_at: $started_at, finished_at: $finished_at, wall_seconds: $wall}' >"$CAPTURE_DIR/_manifest-$phase.json"
  echo "==> wrote $CAPTURE_DIR" >&2
}

[[ $# -gt 0 ]] || usage_error "missing command"
COMMAND=$1
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --cli | --image | --only | --jobs | --timeout | --network | --label | --noise | --subcommands)
      [[ -n "${2:-}" && "$2" != --* ]] || usage_error "$1 requires a value"
      OPT[${1#--}]=$2
      shift 2
      ;;
    --*) usage_error "unknown flag: $1" ;;
    *)
      REFS+=("$1")
      shift
      ;;
  esac
done

[[ "${OPT[jobs]}" =~ ^[1-9][0-9]*$ ]] || usage_error "--jobs takes a positive integer"
[[ "${OPT[timeout]:-1}" =~ ^[1-9][0-9]*$ ]] || usage_error "--timeout takes a positive number of seconds"

case "$COMMAND" in
  -h | --help) usage ;;
  build) cmd_build ;;
  aa)
    ((${#REFS[@]} == 1)) || usage_error "aa takes one ref"
    OPT[timeout]=${OPT[timeout]:-300}
    cmd_run aa
    ;;
  diff)
    ((${#REFS[@]} == 2)) || usage_error "diff takes a base ref and a head ref"
    OPT[timeout]=${OPT[timeout]:-300}
    cmd_run diff
    ;;
  capture)
    OPT[timeout]=${OPT[timeout]:-5}
    cmd_capture
    ;;
  *) usage_error "unknown command: $COMMAND" ;;
esac
