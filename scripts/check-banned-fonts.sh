#!/usr/bin/env bash
# Scan source files (CSS, TypeScript, build scripts) for banned font names.
#
# Vale only lints *.md, so the prose-layer rule (`site.BannedFonts` in
# `styles/site/BannedFonts.yml`) cannot catch a CSS commit changing
# `font-family` or a build script swapping a font URL. This script closes
# that gap at the deployment-surface layer.
#
# The token list lives in exactly one place — `styles/site/BannedFonts.yml`
# — and is read at runtime via `yq`. Keeping a single SoT prevents drift
# between the prose-layer rule and the deployment-layer check; the auto-
# generated `styles/site/README.md` enumerates the same tokens for human
# reference.
#
# Scope: src/ (shipped CSS, TypeScript, OG image generation, the Worker),
# scripts/ (build scripts and design-time generators that pin font names).
# Exclusions: node_modules/ anywhere, .git/, vendored data (src/data/spec/),
# the rule pack itself (styles/site/BannedFonts.yml — its tokens ARE the
# list), the auto-generated styles/site/README.md (which prints the list),
# and prose-policy artifacts the prose-check stack already covers
# (BRAND.md, PRODUCT.md, *.md anywhere — Vale handles those at the
# prose layer).
#
# Usage:
#   scripts/check-banned-fonts.sh                  # exit 0 / 1 (silent on clean)
#   scripts/check-banned-fonts.sh --verbose        # always print the token list
#
# Exit codes:
#   0  no matches in scope
#   1  one or more matches found (path:line:match printed to stderr)
#   2  configuration / environment error (yq missing, YAML unreadable, etc.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKENS_YAML="$REPO_ROOT/styles/site/BannedFonts.yml"

VERBOSE=0
for arg in "$@"; do
    case "$arg" in
        -v|--verbose) VERBOSE=1 ;;
        -h|--help)
            sed -n '2,30p' "$0" | sed 's|^# \{0,1\}||'
            exit 0
            ;;
        *)
            echo "check-banned-fonts: unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

if ! command -v yq >/dev/null 2>&1; then
    echo "check-banned-fonts: yq not found (brew install yq)" >&2
    exit 2
fi

if [[ ! -f "$TOKENS_YAML" ]]; then
    echo "check-banned-fonts: token YAML missing: $TOKENS_YAML" >&2
    echo "                    expected to be vendored or authored at U1" >&2
    exit 2
fi

# Read tokens (one per line). yq emits null-byte-safe values; the array
# is the SoT — no editing, no caching.
mapfile -t TOKENS < <(yq '.tokens[]' "$TOKENS_YAML")

if (( ${#TOKENS[@]} == 0 )); then
    echo "check-banned-fonts: no tokens in $TOKENS_YAML" >&2
    exit 2
fi

if (( VERBOSE )); then
    echo "checking against ${#TOKENS[@]} banned font token(s):"
    printf '  - %s\n' "${TOKENS[@]}"
    echo ""
fi

# Build a single grep alternation. Tokens may contain spaces (multi-word
# font names); escape regex metacharacters, then join with `|`.
escape_for_grep() {
    # Escape characters with regex meaning in extended-regex syntax.
    sed -E 's/[][\\.*+?(){}|^$]/\\&/g' <<<"$1"
}

ALTERNATION=""
for tok in "${TOKENS[@]}"; do
    esc="$(escape_for_grep "$tok")"
    if [[ -z "$ALTERNATION" ]]; then
        ALTERNATION="$esc"
    else
        ALTERNATION="$ALTERNATION|$esc"
    fi
done

# Search scope: source code under src/ and scripts/. Markdown is handled
# by Vale at the prose layer; vendored content (src/data/spec/) lints
# upstream; node_modules is irrelevant. ripgrep handles the file-type
# selection cleanly.
mapfile -t MATCHES < <(
    rg --no-config \
       --line-number \
       --color=never \
       --case-sensitive \
       --glob '!node_modules/' \
       --glob '!.git/' \
       --glob '!*.md' \
       --glob '!BannedFonts.yml' \
       --glob '!check-banned-fonts.sh' \
       -e "\\b($ALTERNATION)\\b" \
       "$REPO_ROOT/src" "$REPO_ROOT/scripts" 2>/dev/null || true
)

if (( ${#MATCHES[@]} == 0 )); then
    if (( VERBOSE )); then
        echo "check-banned-fonts: 0 matches in src/ and scripts/"
    fi
    exit 0
fi

echo "check-banned-fonts: ${#MATCHES[@]} match(es) for banned font names:" >&2
printf '%s\n' "${MATCHES[@]}" >&2
echo "" >&2
echo "Source-of-truth token list: $TOKENS_YAML" >&2
echo "If a match is intentional (e.g., a comment explaining the ban), wrap it" >&2
echo "in a phrase yq's match couldn't extract — or carve out a per-path" >&2
echo "exclusion in this script. The prose-layer rule (site.BannedFonts) is" >&2
echo "Vale-only and does not catch CSS / TypeScript / build scripts." >&2
exit 1
