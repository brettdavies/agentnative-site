#!/usr/bin/env bash
# Regenerate every committed scorecard against the locally installed `anc`.
#
# H6 Unit 0 procedure: once `anc` v0.1.3+ is on the box, running this refreshes
# scorecards/<name>-v<version>.json against the new binary so the audience
# banner / suppressed-check rendering / agent-optimized filter all light up
# with real CLI output instead of falling through the v1.1/v1.2 null path.
#
# For each tool with a committed scorecard the script:
#   1. Reads `binary`, `version`, optional `audit_profile`, optional
#      `version_extract` from registry.yaml.
#   2. Extracts the *actually-installed* binary version. Default extractor
#      pulls the first SemVer-shaped token from the first --version line.
#      Tools that don't yield to the default declare their own
#      `version_extract` shell snippet in registry.yaml. The extracted
#      version is the source of truth — the scorecard filename and the
#      registry's `version` field are derived from it, so the filename can
#      never lie about which release was actually scored.
#   3. If the extracted version differs from the registry's pinned
#      `version`, warns and updates registry to the extracted value. The
#      old `<name>-v<old>.json` file is left on disk to be cleaned up
#      manually with `trash`.
#   4. Runs `anc check --command <binary> [--audit-profile <category>]
#      --output json` and writes to scorecards/<name>-v<extracted>.json.
#   5. Bumps `scored_at` for that tool to today's UTC date.
#
# Idempotent — running twice in a row regenerates the same files. Stops on
# the first failure (`set -euo pipefail`); partial state is left on disk so a
# rerun picks up where it stopped.
#
# Usage:
#   bash scripts/regen-scorecards.sh                # run for real
#   bash scripts/regen-scorecards.sh --dry-run      # print what would happen
#   bash scripts/regen-scorecards.sh --only fd,gh   # narrow to specific tools

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SITE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REGISTRY="$SITE_ROOT/registry.yaml"
SCORECARDS_DIR="$SITE_ROOT/scorecards"
MIN_ANC_VERSION="0.1.3"

# Default extractor: first SemVer-shaped token (2 or 3 components) on the
# first --version line. Mirrors DEFAULT_VERSION_EXTRACT_REGEX exported from
# src/build/scorecards.mjs — keep in sync.
DEFAULT_VERSION_REGEX='[0-9]+\.[0-9]+(\.[0-9]+)?'

DRY_RUN=0
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --only)
      ONLY="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "error: unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

# --- preflight ------------------------------------------------------------

for cmd in anc yq jaq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: missing required tool: $cmd" >&2
    exit 1
  fi
done

anc_version="$(anc --version | awk '{print $NF}')"
oldest="$(printf '%s\n%s\n' "$anc_version" "$MIN_ANC_VERSION" | sort -V | head -n1)"
if [[ "$oldest" != "$MIN_ANC_VERSION" ]]; then
  echo "error: anc $anc_version is older than required $MIN_ANC_VERSION" >&2
  echo "  brew upgrade brettdavies/tap/agentnative" >&2
  echo "  # or: cargo install --version $MIN_ANC_VERSION agentnative" >&2
  exit 1
fi

today="$(date -u +%Y-%m-%d)"

# --- helpers --------------------------------------------------------------

# Extract the actually-installed version of $binary. If $override is non-
# empty, evaluate it as a shell snippet that prints the bare version;
# otherwise apply the default regex to the first --version line.
# Fails loudly when neither path produces a SemVer-shaped token.
extract_version() {
  local binary=$1
  local override=$2
  local version

  if [[ -n "$override" ]]; then
    version="$(eval "$override" 2>/dev/null)" || true
  else
    version="$($binary --version 2>&1 | head -1 | grep -oE "$DEFAULT_VERSION_REGEX" | head -1)" || true
  fi

  if [[ -z "$version" ]]; then
    echo "error: could not extract version for binary '$binary'." >&2
    if [[ -z "$override" ]]; then
      echo "       Default extractor (first SemVer token in --version output) yielded nothing." >&2
      echo "       Add a 'version_extract' shell snippet to registry.yaml for this tool." >&2
    else
      echo "       version_extract snippet: $override" >&2
      echo "       Snippet produced empty output." >&2
    fi
    exit 1
  fi

  # Sanity-check the shape; reject anything that isn't dot-separated digits.
  if ! [[ "$version" =~ ^[0-9]+(\.[0-9]+)+$ ]]; then
    echo "error: extracted version '$version' for '$binary' isn't SemVer-shaped." >&2
    exit 1
  fi

  echo "$version"
}

# --- iterate over tools that have a committed scorecard ------------------

mapfile -t scored_names < <(
  yq -r '.tools[] | select(.version != null) | .name' "$REGISTRY"
)

if [[ -n "$ONLY" ]]; then
  IFS=',' read -ra wanted <<<"$ONLY"
  filtered=()
  for n in "${scored_names[@]}"; do
    for w in "${wanted[@]}"; do
      if [[ "$n" == "$w" ]]; then
        filtered+=("$n")
      fi
    done
  done
  scored_names=("${filtered[@]}")
fi

echo "regenerating ${#scored_names[@]} scorecards against anc $anc_version"
[[ $DRY_RUN -eq 1 ]] && echo "(dry-run mode — no files will be written)"
echo

drift_warnings=()

for name in "${scored_names[@]}"; do
  binary="$(yq -r ".tools[] | select(.name == \"$name\") | .binary" "$REGISTRY")"
  pinned="$(yq -r ".tools[] | select(.name == \"$name\") | .version" "$REGISTRY")"
  profile="$(yq -r ".tools[] | select(.name == \"$name\") | .audit_profile // \"\"" "$REGISTRY")"
  extractor="$(yq -r ".tools[] | select(.name == \"$name\") | .version_extract // \"\"" "$REGISTRY")"

  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "  $name → SKIPPED (binary '$binary' not in PATH)" >&2
    exit 1
  fi

  actual="$(extract_version "$binary" "$extractor")"
  out="$SCORECARDS_DIR/${name}-v${actual}.json"

  profile_flag=""
  profile_label=""
  if [[ -n "$profile" ]]; then
    profile_flag="--audit-profile $profile"
    profile_label=" (audit_profile: $profile)"
  fi

  drift_label=""
  if [[ "$actual" != "$pinned" ]]; then
    drift_label=" [drift: registry pinned $pinned]"
    drift_warnings+=("  $name: pinned=$pinned → actual=$actual; old scorecards/${name}-v${pinned}.json should be removed (\`trash\`)")
  fi

  echo "  ${name} v${actual} → $(basename "$out")${profile_label}${drift_label}"

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "    would run: anc check --command $binary $profile_flag --output json"
    continue
  fi

  # `anc check` is a linter — it exits non-zero whenever any check fails or
  # warns, even on a successful run. The JSON output is still well-formed.
  # Allow non-zero exit and validate the result instead.
  # shellcheck disable=SC2086 # profile_flag must word-split on the space
  anc check --command "$binary" $profile_flag --output json >"$out" || true
  if ! jaq -e '.schema_version' "$out" >/dev/null 2>&1; then
    echo "error: anc check did not produce valid JSON for $name (file: $out)" >&2
    exit 1
  fi

  # In-place updates: bump scored_at, and bump version if drift detected.
  # Use awk for targeted edits — `yq -i` strips blank-line separators between
  # tool entries, destroying the registry's section structure. awk only
  # rewrites the matching lines inside the named tool's block, leaving every
  # other byte untouched.
  new_version=""
  if [[ "$actual" != "$pinned" ]]; then
    new_version="$actual"
  fi
  awk \
    -v target="$name" \
    -v new_scored_at="$today" \
    -v new_version="$new_version" \
    '
      /^  - name:/ { in_target = ($0 == "  - name: " target) }
      in_target && /^    scored_at:/ {
        print "    scored_at: \"" new_scored_at "\""
        next
      }
      in_target && new_version != "" && /^    version:/ {
        print "    version: \"" new_version "\""
        next
      }
      { print }
    ' "$REGISTRY" >"$REGISTRY.tmp" && mv "$REGISTRY.tmp" "$REGISTRY"
done

echo

if [[ ${#drift_warnings[@]} -gt 0 ]]; then
  echo "version drift detected — registry was auto-bumped to match installed binaries:"
  for w in "${drift_warnings[@]}"; do echo "$w"; done
  echo
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo "dry-run complete. Re-run without --dry-run to write."
else
  echo "done. ${#scored_names[@]} scorecards refreshed; scored_at bumped to $today."
  echo "Next: ./scripts/sync-coverage-matrix.sh && bun test && bun run build"
fi
