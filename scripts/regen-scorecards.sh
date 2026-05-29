#!/usr/bin/env bash
# Regenerate every committed scorecard against the locally installed `anc`.
#
# H6 Unit 0 procedure: once `anc` v0.1.3+ is on the box, running this refreshes
# scorecards/<name>-v<version>.json against the new binary so the audience
# banner / suppressed-check rendering / agent-optimized filter all light up
# with real CLI output instead of falling through the v1.1/v1.2 null path.
#
# For each registry entry the script:
#   1. Reads `binary`, optional `audit_profile`, optional `version_extract`
#      from registry.yaml. Post-U4 the registry has no `version:` field;
#      the scorecard filename owns the canonical version anchor.
#   2. Extracts the *actually-installed* binary version. Default extractor
#      pulls the first SemVer-shaped token from the first --version line.
#      Tools that don't yield to the default declare their own
#      `version_extract` shell snippet in registry.yaml. The extracted
#      version determines the scorecard filename, so the filename can
#      never lie about which release was actually scored.
#   3. Runs `anc audit --command <binary> [--audit-profile <category>]
#      --output json` and writes to scorecards/<name>-v<extracted>.json.
#      Older `<name>-v<old>.json` files are left on disk; the build's
#      auto-discovery picks the highest-versioned scorecard per slug, so
#      stale ones are silently superseded. Clean up manually with `trash`
#      when version drift outpaces what auto-discovery should hold onto.
#
# Idempotent — running twice in a row regenerates the same files. Stops on
# the first failure (`set -euo pipefail`); partial state is left on disk so a
# rerun picks up where it stopped.
#
# Usage:
#   bash scripts/regen-scorecards.sh                       # run for real
#   bash scripts/regen-scorecards.sh --dry-run             # print what would happen
#   bash scripts/regen-scorecards.sh --only fd,gh          # narrow to specific tools
#   bash scripts/regen-scorecards.sh --exclude anc         # skip specific tools
#   bash scripts/regen-scorecards.sh --allow-dev-build     # bypass MIN_ANC_VERSION
#                                                          # (use a locally-built dev anc)

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
EXCLUDE=""
ALLOW_DEV_BUILD=0

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
    --exclude)
      EXCLUDE="$2"
      shift 2
      ;;
    --allow-dev-build)
      ALLOW_DEV_BUILD=1
      shift
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
if [[ $ALLOW_DEV_BUILD -eq 0 ]]; then
  oldest="$(printf '%s\n%s\n' "$anc_version" "$MIN_ANC_VERSION" | sort -V | head -n1)"
  if [[ "$oldest" != "$MIN_ANC_VERSION" ]]; then
    echo "error: anc $anc_version is older than required $MIN_ANC_VERSION" >&2
    echo "  brew upgrade brettdavies/tap/agentnative" >&2
    echo "  # or: cargo install --version $MIN_ANC_VERSION agentnative" >&2
    echo "  # or: pass --allow-dev-build to score with a locally-built dev anc" >&2
    exit 1
  fi
fi

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

# --- iterate over every registry entry -----------------------------------
#
# Post-U4 the registry no longer carries `version:` per entry — the
# scorecard filename owns the canonical version anchor. Every registry
# entry is a regen candidate; --only / --exclude scope the run.

mapfile -t scored_names < <(
  yq -r '.tools[].name' "$REGISTRY"
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

if [[ -n "$EXCLUDE" ]]; then
  IFS=',' read -ra unwanted <<<"$EXCLUDE"
  filtered=()
  for n in "${scored_names[@]}"; do
    skip=0
    for u in "${unwanted[@]}"; do
      if [[ "$n" == "$u" ]]; then
        skip=1
        break
      fi
    done
    [[ $skip -eq 0 ]] && filtered+=("$n")
  done
  scored_names=("${filtered[@]}")
fi

echo "regenerating ${#scored_names[@]} scorecards against anc $anc_version"
[[ $DRY_RUN -eq 1 ]] && echo "(dry-run mode — no files will be written)"
echo

for name in "${scored_names[@]}"; do
  binary="$(yq -r ".tools[] | select(.name == \"$name\") | .binary" "$REGISTRY")"
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

  echo "  ${name} v${actual} → $(basename "$out")${profile_label}"

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "    would run: anc audit --command $binary $profile_flag --output json"
    continue
  fi

  # `anc audit` is a linter — it exits non-zero whenever any check fails or
  # warns, even on a successful run. The JSON output is still well-formed.
  # Allow non-zero exit and validate the result instead.
  # shellcheck disable=SC2086 # profile_flag must word-split on the space
  anc audit --command "$binary" $profile_flag --output json >"$out" || true
  if ! jaq -e '.schema_version' "$out" >/dev/null 2>&1; then
    echo "error: anc audit did not produce valid JSON for $name (file: $out)" >&2
    exit 1
  fi
done

echo

if [[ $DRY_RUN -eq 1 ]]; then
  echo "dry-run complete. Re-run without --dry-run to write."
else
  echo "done. ${#scored_names[@]} scorecards refreshed."
  echo "Next: ./scripts/sync-coverage-matrix.sh && bun test && bun run build"
fi
