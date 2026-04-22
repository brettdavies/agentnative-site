#!/usr/bin/env bash
# Regenerate every committed scorecard against the locally installed `anc`.
#
# H6 Unit 0 procedure: once `anc` v0.1.3+ is on the box, running this refreshes
# scorecards/<name>-v<version>.json against the new binary so the audience
# banner / suppressed-check rendering / agent-optimized filter all light up
# with real CLI output instead of falling through the v1.1/v1.2 null path.
#
# For each tool with a committed scorecard, the script:
#   1. Reads `binary`, `version`, optional `audit_profile` from registry.yaml.
#   2. Confirms the version on disk matches the registry's pinned version
#      (otherwise the regen would silently shift `<name>-v<version>.json` to
#      a different tool release without bumping the version field).
#   3. Runs `anc check --command <binary> [--audit-profile <category>]
#      --output json` and writes the result to scorecards/<name>-v<version>.json.
#   4. Bumps `scored_at` for that tool to today's UTC date.
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
# Sort -V for proper semver comparison; first line == oldest.
oldest="$(printf '%s\n%s\n' "$anc_version" "$MIN_ANC_VERSION" | sort -V | head -n1)"
if [[ "$oldest" != "$MIN_ANC_VERSION" ]]; then
  echo "error: anc $anc_version is older than required $MIN_ANC_VERSION" >&2
  echo "  brew upgrade brettdavies/tap/agentnative" >&2
  echo "  # or: cargo install --version $MIN_ANC_VERSION agentnative" >&2
  exit 1
fi

today="$(date -u +%Y-%m-%d)"

# --- iterate over tools that have a committed scorecard -------------------

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

for name in "${scored_names[@]}"; do
  binary="$(yq -r ".tools[] | select(.name == \"$name\") | .binary" "$REGISTRY")"
  version="$(yq -r ".tools[] | select(.name == \"$name\") | .version" "$REGISTRY")"
  profile="$(yq -r ".tools[] | select(.name == \"$name\") | .audit_profile // \"\"" "$REGISTRY")"

  out="$SCORECARDS_DIR/${name}-v${version}.json"
  profile_flag=""
  profile_label=""
  if [[ -n "$profile" ]]; then
    profile_flag="--audit-profile $profile"
    profile_label=" (audit_profile: $profile)"
  fi

  echo "  ${name} → $(basename "$out")${profile_label}"

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "    would run: anc check --command $binary $profile_flag --output json"
    continue
  fi

  # shellcheck disable=SC2086 # profile_flag must word-split on the space
  anc check --command "$binary" $profile_flag --output json >"$out"

  # In-place bump of scored_at for this tool. yq -i with a name-keyed
  # selector preserves field order and comments around it.
  yq -i "(.tools[] | select(.name == \"$name\") | .scored_at) = \"$today\"" "$REGISTRY"
done

echo
if [[ $DRY_RUN -eq 1 ]]; then
  echo "dry-run complete. Re-run without --dry-run to write."
else
  echo "done. ${#scored_names[@]} scorecards refreshed; scored_at bumped to $today."
  echo "Next: ./scripts/sync-coverage-matrix.sh && bun test && bun run build"
fi
