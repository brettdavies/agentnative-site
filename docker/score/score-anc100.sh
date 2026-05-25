#!/usr/bin/env bash
# Score every registry entry against the pre-installed `anc` linter and write
# scorecards/<name>-v<version>.json into the bind-mounted scorecards/ dir.
#
# Mirrors the host-side scripts/regen-scorecards.sh (single source of truth
# for the scoring pipeline) but: (a) iterates the FULL registry, not just
# entries with a `version` field; (b) records install/score failures
# explicitly instead of stopping; (c) writes to a bind-mounted directory so
# the host filesystem ends up with the scorecards.
#
# Each tool gets a per-tool update attempt before its check runs, so a
# scoring run always tests against the latest version each package manager
# can resolve (brew upgrade / uv tool upgrade / bun add -g re-resolution).
# This decouples "tool freshness" from "image build cache" — install-tools
# in the Dockerfile pre-bakes baseline binaries, and this script upgrades
# them at run time. Disable with --no-update.
#
# Output structure (per-tool):
#   scored OK    → scorecards/<name>-v<version>.json
#   install fail → no scorecard file (registry's existing fallback UX renders)
#   score fail   → no scorecard file + entry added to score-failures.txt
#
# Run inside the docker/score/Dockerfile-built image.
#
# Flags (passed via `docker compose run --rm scorer <flags>`):
#   --only NAME1,NAME2     Score only listed registry names; skip the rest.
#   --no-update            Skip the per-tool update step; score what's baked.
#   --help                 Print this header and exit.

set -uo pipefail

REGISTRY=/work/registry.yaml             # run-time (bind-mounted from host)
BUILD_REGISTRY=/build/registry.yaml      # build-time (baked into image)
OUT_DIR=/work/scorecards                 # bind-mounted to host scorecards/
LOG_DIR=/work/out                        # bind-mounted to host docker/score/out/
# Summary + failures land in the bind-mounted /work/out so the host has them
# after the container exits. Without this, both files lived in the container's
# ephemeral filesystem and were lost on every run — forcing the next session
# to either re-run scoring or grep the (potentially-wiped) /tmp/ run log.
SUMMARY=$LOG_DIR/scoring-summary.txt
FAILURES=$LOG_DIR/scoring-failures.txt

ONLY=""
DO_UPDATE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      if [[ -z "${2:-}" || "$2" == --* ]]; then
        echo "error: --only requires a comma-separated tool list" >&2
        exit 2
      fi
      ONLY="$2"
      shift 2
      ;;
    --no-update)
      DO_UPDATE=0
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

mkdir -p "$OUT_DIR" "$LOG_DIR"
: > "$SUMMARY"
: > "$FAILURES"

echo "=== anc100 batch scorer ==="
echo "anc version: $(anc --version)"
echo "anc path:    $(command -v anc)"
echo "registry:    $REGISTRY (run-time)"
echo "output dir:  $OUT_DIR"
if [[ $DO_UPDATE -eq 1 ]]; then
  echo "update step: enabled (per-tool, before each check)"
else
  echo "update step: disabled (--no-update)"
fi
if [[ -n "$ONLY" ]]; then
  echo "only:        $ONLY"
fi
echo

# Drift check: if the run-time registry diverges from the build-time one,
# any tools added since the build won't be installed. Warn explicitly so
# the operator knows to rebuild before relying on full coverage.
if [[ -f "$BUILD_REGISTRY" ]] && ! diff -q "$BUILD_REGISTRY" "$REGISTRY" >/dev/null 2>&1; then
  echo "WARNING: run-time registry differs from build-time registry."
  echo "         Tools added since image build will report 'install-missing'."
  echo "         Rebuild the image (bash docker/score/build.sh) for full coverage."
  echo
fi

today=$(date -u +%Y-%m-%d)

mapfile -t entries < <(
  # Use join("\t") instead of @tsv so embedded `"` in version_extract scripts
  # aren't CSV-quoted (`foo"bar` → `"foo""bar"`), which would survive into the
  # eval and break the override at runtime.
  #
  # Fields use "-" as the empty-value sentinel rather than "" because bash's
  # `read -r ... <<<"$line"` collapses consecutive IFS tabs into a single
  # delimiter (observed on bash 5.3.9), which would silently drop the
  # version_extract field whenever audit_profile is unset.
  yq -r '.tools[] | [.name, .binary, .audit_profile // "-", .version_extract // "-", .install // "-"] | join("\t")' "$REGISTRY"
)

# Build the --only allow-set as a comma-bookended string so we can do exact-
# match lookups via substring containment ("name" matches ",name," only).
ONLY_SET=""
if [[ -n "$ONLY" ]]; then
  ONLY_SET=",${ONLY//[[:space:]]/},"
fi

total=${#entries[@]}
scored=0
install_missing=0
score_failed=0
skipped=0
filtered_out=0
updated=0
update_failed=0
update_skipped=0

# Default extractor: first SemVer-shaped token on the first --version line.
DEFAULT_VERSION_REGEX='[0-9]+\.[0-9]+(\.[0-9]+)?'

extract_version() {
  local binary=$1
  local override=$2
  local version
  if [[ -n "$override" ]]; then
    version="$(eval "$override" 2>/dev/null)" || true
  else
    version="$("$binary" --version 2>&1 | head -1 | grep -oE "$DEFAULT_VERSION_REGEX" | head -1)" || true
  fi
  if [[ -z "$version" ]]; then return 1; fi
  if ! [[ "$version" =~ ^[0-9]+(\.[0-9]+)+$ ]]; then return 1; fi
  echo "$version"
}

# Derive the upgrade command for a tool from its registry `install:` field.
# Echoes the upgrade command on stdout, or "SKIP" if the install method has
# no upgrade path (OS-bundled, etc.). Exits non-zero if the install method
# is unrecognized.
#
# Special case: the registry's `anc` entry resolves via PATH to whatever's
# baked into the image (brew in ANC_SOURCE=brew, inject in ANC_SOURCE=inject).
# In inject mode we explicitly do NOT upgrade anc — the inject binary is the
# whole point of the run and we must not let brew silently replace it. The
# scoring loop checks PATH and skips upgrade when the active anc is the
# inject-mode binary.
derive_upgrade() {
  local install=$1
  case "$install" in
    "brew install "*)
      # Pulls the package spec (everything after "brew install ").
      local pkg="${install#brew install }"
      echo "brew upgrade $pkg"
      ;;
    "uv tool install "*)
      local pkg="${install#uv tool install }"
      echo "uv tool upgrade $pkg"
      ;;
    "bun add -g "*)
      # `bun add -g <pkg>` re-resolves to latest each call (Bun's behavior).
      echo "$install"
      ;;
    "included with "*)
      echo "SKIP"
      ;;
    *)
      return 1
      ;;
  esac
}

# In inject mode, the inject anc lives at /home/runner/.local/bin/anc.
# When scoring the registry's `anc` entry we must not let `brew upgrade`
# touch the brew-installed anc and shadow the inject binary (it can't, since
# /home/runner/.local/bin sits ahead of brew bin in PATH, but the upgrade is
# pure churn in that case). Detect inject mode by checking which path `anc`
# resolves to.
ANC_INJECT_PATH=/home/runner/.local/bin/anc
ANC_IS_INJECT=0
if [[ "$(command -v anc)" == "$ANC_INJECT_PATH" ]]; then
  ANC_IS_INJECT=1
fi

for line in "${entries[@]}"; do
  IFS=$'\t' read -r name binary profile extractor install <<<"$line"
  # Decode "-" sentinel back to empty string (see yq pipeline above).
  [[ "$profile" == "-" ]] && profile=""
  [[ "$extractor" == "-" ]] && extractor=""
  [[ "$install" == "-" ]] && install=""

  if [[ -n "$ONLY_SET" && "$ONLY_SET" != *",$name,"* ]]; then
    filtered_out=$((filtered_out + 1))
    continue
  fi

  echo "----- $name ($binary) -----"

  if [[ $DO_UPDATE -eq 1 && -n "$install" ]]; then
    if [[ "$name" == "anc" && $ANC_IS_INJECT -eq 1 ]]; then
      echo "  [update] skip — inject anc is the linter, do not replace"
      update_skipped=$((update_skipped + 1))
    else
      upgrade_cmd="$(derive_upgrade "$install" 2>/dev/null || echo UNRECOGNIZED)"
      case "$upgrade_cmd" in
        UNRECOGNIZED)
          echo "  [update] skip — unrecognized install method: $install"
          update_skipped=$((update_skipped + 1))
          ;;
        SKIP)
          echo "  [update] skip — OS-bundled ($install)"
          update_skipped=$((update_skipped + 1))
          ;;
        *)
          echo "  [update] $upgrade_cmd"
          if eval "$upgrade_cmd" >/dev/null 2>&1; then
            updated=$((updated + 1))
          else
            echo "  [update] failed (rc=$?); continuing with installed version"
            update_failed=$((update_failed + 1))
          fi
          ;;
      esac
    fi
  fi

  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "  [skip] binary '$binary' not in PATH (install-failed at image-build time)"
    echo "$name install-missing" >> "$FAILURES"
    install_missing=$((install_missing + 1))
    continue
  fi

  version="$(extract_version "$binary" "$extractor" || true)"
  if [[ -z "$version" ]]; then
    echo "  [skip] could not extract version from '$binary --version'"
    echo "$name version-extract-failed" >> "$FAILURES"
    skipped=$((skipped + 1))
    continue
  fi

  out="$OUT_DIR/${name}-v${version}.json"
  profile_flag=""
  if [[ -n "$profile" ]]; then profile_flag="--audit-profile $profile"; fi

  # `anc check` exit-code contract:
  #   0 — every check passed
  #   1 — at most warn-severity results (no failures)
  #   2 — at least one fail-severity result (JSON is still well-formed)
  #   >=3 — anc itself errored (panic, missing binary, malformed args)
  # Treat 0/1/2 as scoreable; let JSON validation below catch missing/empty
  # output even on rc <= 2.
  # shellcheck disable=SC2086 # profile_flag must word-split on the space
  anc check --command "$binary" $profile_flag --output json >"$out" 2>/dev/null
  rc=$?
  if (( rc > 2 )); then
    echo "  [fail] anc check exited $rc"
    echo "$name anc-check-error-rc=$rc" >> "$FAILURES"
    rm -f "$out"
    score_failed=$((score_failed + 1))
    continue
  fi

  # Validate the JSON output.
  if ! jaq -e '.schema_version' "$out" >/dev/null 2>&1; then
    echo "  [fail] anc check did not produce valid JSON"
    echo "$name invalid-json" >> "$FAILURES"
    rm -f "$out"
    score_failed=$((score_failed + 1))
    continue
  fi

  echo "  [ok] $name v$version → $(basename "$out")"
  scored=$((scored + 1))
done

echo
echo "==============================="
{
  echo "anc100 batch-scoring summary ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "  scored:          $scored / $((total - filtered_out))"
  echo "  install-missing: $install_missing"
  echo "  score-failed:    $score_failed"
  echo "  skipped:         $skipped"
  if [[ -n "$ONLY" ]]; then
    echo "  filtered out:    $filtered_out  (--only $ONLY)"
  fi
  if [[ $DO_UPDATE -eq 1 ]]; then
    echo "  updates:         $updated ok, $update_failed failed, $update_skipped skipped"
  fi
} | tee "$SUMMARY"
echo "==============================="

if [[ -s "$FAILURES" ]]; then
  echo
  echo "Failures (see $FAILURES inside container, also bind-mounted to host):"
  cat "$FAILURES"
fi
