#!/usr/bin/env bash
# arm-common.sh — shared helpers sourced by run-arm{1,2,3}.sh.
#
# Plan: docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md U4
#
# Exposes:
#   ARM_REPO_ROOT      — resolved repo root.
#   ARM_OUT_DIR        — docs/research/2026-06-12-brew-v6-anc100/.
#   ARM_REGISTRY_FILE  — registry.yaml.
#   load_arm_env       — sources measure-entry.sh so measure_entry is
#                         available; resolves SPIKE_TAG against the
#                         current git HEAD if unset; bails if the image
#                         or jaq is missing.
#   parse_brew_pkg_from_install — given an `install:` field like
#                         `brew install <pkg>`, prints <pkg>. Empty
#                         output means the entry isn't a brew-install
#                         entry.
#   list_entries       — emits TSV (name<TAB>binary<TAB>install) to stdout
#                         for every registry.yaml entry, honoring
#                         optional --limit N and --only <comma,list>
#                         filters parsed from $@.
#   write_arm_array    — given a temp dir of per-entry JSON files,
#                         combines them into the named output file as a
#                         single JSON array, sorted by entry order
#                         encountered.

set -uo pipefail

# Repo root is resolved via git rather than BASH_SOURCE path arithmetic
# so the helper works both when sourced from another script and when
# sourced manually from the shell. Override via ARM_REPO_ROOT for
# alternate worktrees.
if [[ -z "${ARM_REPO_ROOT:-}" ]]; then
  ARM_REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
fi
ARM_OUT_DIR="${ARM_OUT_DIR:-$ARM_REPO_ROOT/docs/research/2026-06-12-brew-v6-anc100}"
ARM_REGISTRY_FILE="${ARM_REGISTRY_FILE:-$ARM_REPO_ROOT/registry.yaml}"
ARM_SPIKE_DIR="${ARM_SPIKE_DIR:-$ARM_REPO_ROOT/docker/spike}"
ARM_BREW_OVERRIDES_FILE="${ARM_BREW_OVERRIDES_FILE:-$ARM_SPIKE_DIR/brew-overrides.yaml}"

load_arm_env() {
  if [[ ! -f "$ARM_REGISTRY_FILE" ]]; then
    echo "error: registry not found at $ARM_REGISTRY_FILE" >&2
    return 2
  fi

  for tool in yq jaq docker; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "error: required host tool '$tool' not installed" >&2
      return 2
    fi
  done

  GIT_SHA="$(git -C "$ARM_REPO_ROOT" rev-parse --short HEAD)"
  export SPIKE_TAG="${SPIKE_TAG:-anc-sandbox-spike:${GIT_SHA}}"

  if ! docker image inspect "$SPIKE_TAG" >/dev/null 2>&1; then
    echo "error: $SPIKE_TAG not present locally — run docker/spike/build.sh first" >&2
    return 2
  fi

  # shellcheck disable=SC1091
  source "$ARM_SPIKE_DIR/measure-entry.sh"

  mkdir -p "$ARM_OUT_DIR"
}

# parse_brew_pkg_from_install <install-string> → prints package name or empty.
# Accepts variants:
#   "brew install foo"          → foo
#   "brew install foo bar"      → foo (first package, the rest are deps)
#   "uv tool install foo"       → (empty)
#   "included with ..."         → (empty)
parse_brew_pkg_from_install() {
  local install="$1"
  if [[ "$install" =~ ^brew[[:space:]]+install[[:space:]]+([^[:space:]]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    printf '\n'
  fi
}

# lookup_brew_override <registry_name> → prints brew formula name or empty.
# Reads the manual override map at $ARM_BREW_OVERRIDES_FILE (default
# docker/spike/brew-overrides.yaml). The map covers non-brew-pinned
# registry entries whose brew formula has been verified at spike-prep
# time. See the file's preamble for the verification protocol.
lookup_brew_override() {
  local registry_name="$1"
  if [[ ! -f "$ARM_BREW_OVERRIDES_FILE" ]]; then
    printf '\n'
    return
  fi
  NAME="$registry_name" yq -r '.overrides[env(NAME)] // ""' "$ARM_BREW_OVERRIDES_FILE"
}

# resolve_brew_formula <registry_name> <install_field> → prints brew
# formula name or empty. Combines registry parsing with the manual
# override map so callers (arm 2, arm 3) get a single source of truth.
# Registry parsing wins when the install field is `brew install <pkg>`
# because that is the authoritative pinned form; the override map
# applies only when registry parsing returns empty.
resolve_brew_formula() {
  local registry_name="$1"
  local install_field="$2"
  local pkg
  pkg=$(parse_brew_pkg_from_install "$install_field")
  if [[ -n "$pkg" ]]; then
    printf '%s\n' "$pkg"
    return
  fi
  lookup_brew_override "$registry_name"
}

# load_resolution_from_file <entry_name> → prints the cached
# resolution JSON object (the inner `.resolution` value, NOT the full
# row) for the named entry, or empty if the file is missing OR the
# entry is not in it. The brew-resolutions.json file is produced by
# docker/spike/prep-resolutions.sh; it caches the result of running
# `resolveBrewFallback` (via the Bun shim) per registry entry. Arm 1
# and arm 3 read from this file to use the production-fidelity
# install path rather than approximating with `brew install`.
load_resolution_from_file() {
  local entry="$1"
  local file="${2:-$ARM_OUT_DIR/brew-resolutions.json}"
  if [[ ! -f "$file" ]]; then
    printf '\n'
    return
  fi
  # shellcheck disable=SC2016  # $ENV.ENTRY is a jaq filter expression
  ENTRY="$entry" jaq -c '.[] | select(.entry == $ENV.ENTRY) | .resolution' < "$file" 2>/dev/null
}

# list_entries — emits TSV rows (name<TAB>binary<TAB>install) one per
# registry entry. Honors `--limit N` and `--only name1,name2` filters
# passed as positional args. The skipped/notable distinction is up to
# the calling arm; this helper just enumerates.
list_entries() {
  local limit=0 only=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit) limit="$2"; shift 2 ;;
      --only) only="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [[ -n "$only" ]]; then
    # mikefarah yq reads env vars via env(NAME). $names is the local
    # yq alias for the parsed list.
    # shellcheck disable=SC2016  # the single-quoted expression IS the yq filter
    ONLY="$only" yq -r '
      (env(ONLY) | split(",")) as $names |
      .tools[] | select(.name as $n | $names | contains([$n])) |
      [.name, .binary, .install] | @tsv
    ' "$ARM_REGISTRY_FILE"
  elif [[ "$limit" -gt 0 ]]; then
    yq -r '.tools[] | [.name, .binary, .install] | @tsv' "$ARM_REGISTRY_FILE" | head -n "$limit"
  else
    yq -r '.tools[] | [.name, .binary, .install] | @tsv' "$ARM_REGISTRY_FILE"
  fi
}

# write_arm_array <tmp_dir> <out_file> — combine per-entry JSON files
# in tmp_dir into a single JSON array at out_file, preserving the
# numeric prefix order set by the caller (e.g. 0001-curl.json).
write_arm_array() {
  local tmp_dir="$1"
  local out_file="$2"

  if ! compgen -G "$tmp_dir/*.json" >/dev/null; then
    printf '[]\n' > "$out_file"
    return 0
  fi

  # jaq treats multiple file args as separate input streams (one array
  # per file when -s/slurp is set), so the cat-into-stdin form is the
  # only way to slurp into a single combined array.
  local files
  mapfile -t files < <(printf '%s\n' "$tmp_dir"/*.json | sort)
  cat "${files[@]}" | jaq -s '.' > "$out_file"
}
