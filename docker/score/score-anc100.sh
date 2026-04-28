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
# Output structure (per-tool):
#   scored OK    → scorecards/<name>-v<version>.json
#   install fail → no scorecard file (registry's existing fallback UX renders)
#   score fail   → no scorecard file + entry added to score-failures.txt
#
# Run inside the docker/score/Dockerfile-built image.

set -uo pipefail

REGISTRY=/work/registry.yaml
OUT_DIR=/work/scorecards
SUMMARY=/work/scoring-summary.txt
FAILURES=/work/scoring-failures.txt

mkdir -p "$OUT_DIR"
: > "$SUMMARY"
: > "$FAILURES"

echo "=== anc100 batch scorer ==="
echo "anc version: $(anc --version)"
echo "registry:    $REGISTRY"
echo "output dir:  $OUT_DIR"
echo

today=$(date -u +%Y-%m-%d)

mapfile -t entries < <(
  yq -r '.tools[] | [.name, .binary, .audit_profile // "", .version_extract // ""] | @tsv' "$REGISTRY"
)

total=${#entries[@]}
scored=0
install_missing=0
score_failed=0
skipped=0

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

for line in "${entries[@]}"; do
  IFS=$'\t' read -r name binary profile extractor <<<"$line"
  echo "----- $name ($binary) -----"

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

  # `anc check` exits non-zero when any check fails or warns. The JSON output
  # is still well-formed; we keep stderr but allow non-zero exit.
  # shellcheck disable=SC2086 # profile_flag must word-split on the space
  if anc check --command "$binary" $profile_flag --output json >"$out" 2>/dev/null; then
    : # exit 0
  else
    rc=$?
    # exit 1 = checks failed/warned but JSON is valid; exit 2+ = real error
    if (( rc > 1 )); then
      echo "  [fail] anc check exited $rc"
      echo "$name anc-check-error-rc=$rc" >> "$FAILURES"
      rm -f "$out"
      score_failed=$((score_failed + 1))
      continue
    fi
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
  echo "  scored:          $scored / $total"
  echo "  install-missing: $install_missing"
  echo "  score-failed:    $score_failed"
  echo "  skipped:         $skipped"
} | tee "$SUMMARY"
echo "==============================="

if [[ -s "$FAILURES" ]]; then
  echo
  echo "Failures (see $FAILURES inside container, also bind-mounted to host):"
  cat "$FAILURES"
fi
