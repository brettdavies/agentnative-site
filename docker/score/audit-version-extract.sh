#!/usr/bin/env bash
# Audit which registry entries' `--version` output the default extractor
# (first SemVer-shaped token on the first --version line) cannot parse.
# Designed to run INSIDE the anc-scorer container (where every tool is
# pre-installed); never on the host (which deliberately doesn't have
# all 100 binaries).
#
# Usage (from repo root):
#   docker compose -f docker/score/compose.yml run --rm scorer \
#     bash /work/audit-version-extract.sh
#
# Or inside an interactive container shell:
#   bash /work/audit-version-extract.sh
#
# Output: tab-separated lines, one per registry entry that needs attention,
# of the form:
#   <name>\t<binary>\t<status>\t<first --version line>
#
# Status values:
#   OK              — default regex extracts a SemVer-shaped token
#   NEEDS-OVERRIDE  — default regex extracts nothing, OR extracts something
#                     not SemVer-shaped (false positive). Add a `version_extract:`
#                     entry to registry.yaml for this tool.
#   BINARY-MISSING  — install layer didn't put the binary in PATH. Different
#                     class of fix (install method) — handled separately.
#   ALREADY-OVERRIDDEN — registry already declares a custom `version_extract`.

set -uo pipefail

REGISTRY=/work/registry.yaml
DEFAULT_REGEX='[0-9]+\.[0-9]+(\.[0-9]+)?'

# Read all installable entries (skip nvidia-smi / curl / no-install-method).
mapfile -t entries < <(
  yq -r '.tools[] | select(.install != null) | select(.install | test("^(included|curl)") | not) | [.name, .binary, .version_extract // ""] | @tsv' "$REGISTRY"
)

printf "%-22s %-22s %-22s %s\n" "NAME" "BINARY" "STATUS" "FIRST --VERSION LINE"
printf "%-22s %-22s %-22s %s\n" "----" "------" "------" "--------------------"

needs_override=()
binary_missing=()
already_overridden=()
ok_count=0

for line in "${entries[@]}"; do
  IFS=$'\t' read -r name binary extractor <<<"$line"

  if [[ -n "$extractor" ]]; then
    # Validate the override actually works.
    val="$(eval "$extractor" 2>/dev/null | head -1)"
    status=$([[ "$val" =~ ^[0-9]+(\.[0-9]+)+$ ]] && echo "ALREADY-OVERRIDDEN" || echo "OVERRIDDEN-BUT-BROKEN")
    first_line="(custom: $extractor → $val)"
    already_overridden+=("$name")
  elif ! command -v "$binary" >/dev/null 2>&1; then
    status="BINARY-MISSING"
    first_line=""
    binary_missing+=("$name")
  else
    first_line="$("$binary" --version 2>&1 | head -1 | tr -d '\r')"
    extracted="$(echo "$first_line" | grep -oE "$DEFAULT_REGEX" | head -1)"
    if [[ -n "$extracted" ]] && [[ "$extracted" =~ ^[0-9]+(\.[0-9]+)+$ ]]; then
      status="OK"
      ok_count=$((ok_count + 1))
    else
      status="NEEDS-OVERRIDE"
      needs_override+=("$name|$binary|$first_line")
    fi
  fi

  printf "%-22s %-22s %-22s %s\n" "$name" "$binary" "$status" "$first_line"
done

echo
echo "==== summary ===="
echo "  OK:                  $ok_count"
echo "  NEEDS-OVERRIDE:      ${#needs_override[@]}"
echo "  BINARY-MISSING:      ${#binary_missing[@]}"
echo "  ALREADY-OVERRIDDEN:  ${#already_overridden[@]}"

if (( ${#needs_override[@]} > 0 )); then
  echo
  echo "==== tools needing version_extract: overrides ===="
  for entry in "${needs_override[@]}"; do
    IFS='|' read -r name binary first_line <<<"$entry"
    echo "  $name (binary: $binary)"
    echo "    --version → $first_line"
    echo "    suggested: try '$binary --version | <pattern>' to isolate the SemVer token"
    echo
  done
fi

if (( ${#binary_missing[@]} > 0 )); then
  echo
  echo "==== install-missing (different class of fix) ===="
  printf "  %s\n" "${binary_missing[@]}"
fi
