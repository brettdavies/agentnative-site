#!/usr/bin/env bash
# Vendor the MCP Server Card extension schema (SEP-2127) into
# src/data/web-audit/server-card.schema.json.
#
# Default behavior: fetches schema.json from
# modelcontextprotocol/experimental-ext-server-card at the pinned commit
# PINNED_REF below, byte for byte. The extension has no releases, so a
# commit SHA is the only immutable ref; the pin moves only by editing
# PINNED_REF in a reviewed change.
#
# Override behavior (--ref / SERVER_CARD_SCHEMA_REF): vendors an explicit
# branch HEAD, tag, or commit SHA instead of the pin, to inspect an
# upstream change before re-pinning. The resolved full SHA is always
# printed so the vendoring is traceable; record it in the consumer PR body.
#
# The spec-drift manifest (src/data/standards/watch.yaml, entry
# `mcp-server-card-schema`) pins the canonical hash of this same file on
# the extension's main branch, and tests/standards-drift.test.ts requires
# the two to agree. After vendoring a new commit, copy the hash that
# `bun scripts/standards/check-drift.ts` reports for that entry into its
# `pinned` value, and update PINNED_REF and the manifest comment.
#
# Transport: `gh api` against the GitHub REST contents endpoint, so
# branches, tags, and SHAs take the same code path. Requires `gh`
# authenticated against github.com.
#
# Usage:
#   scripts/sync-server-card-schema.sh                  # the pinned commit
#   scripts/sync-server-card-schema.sh --ref main       # HEAD of main
#   SERVER_CARD_SCHEMA_REF=<sha> scripts/sync-server-card-schema.sh
#
# Flags:
#   --ref <git-ref>  Branch name, tag, or commit SHA to vendor. Wins over
#                    SERVER_CARD_SCHEMA_REF.

set -euo pipefail

REPO="modelcontextprotocol/experimental-ext-server-card"
PINNED_REF="526201bbc80231daa40ffcdecfc9da4e54e5dc93"
REF="${SERVER_CARD_SCHEMA_REF:-$PINNED_REF}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --ref)
            if [[ $# -lt 2 || -z "$2" ]]; then
                echo "error: --ref requires a value (branch, tag, or SHA)" >&2
                exit 2
            fi
            REF="$2"
            shift 2
            ;;
        --ref=*)
            REF="${1#--ref=}"
            if [[ -z "$REF" ]]; then
                echo "error: --ref= requires a value (branch, tag, or SHA)" >&2
                exit 2
            fi
            shift
            ;;
        -h|--help)
            sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "error: unknown argument: $1" >&2
            echo "       run \`$0 --help\` for usage" >&2
            exit 2
            ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$REPO_ROOT/src/data/web-audit/server-card.schema.json"

if ! full_sha="$(gh api "repos/$REPO/commits/$REF" --jq '.sha')"; then
    echo "error: could not resolve \`$REF\` in $REPO" >&2
    echo "       check \`gh auth status\` and network access." >&2
    exit 1
fi

echo "vendoring schema.json at $REF ($full_sha) from github.com:$REPO"

tmp="$(mktemp)"
trap 'trash "$tmp" 2>/dev/null || true' EXIT
gh api -H "Accept: application/vnd.github.raw" "repos/$REPO/contents/schema.json?ref=$full_sha" >"$tmp"
cp "$tmp" "$DEST"

echo "wrote $DEST"
echo
echo "next: review \`git diff\`, then run \`bun test tests/standards-drift.test.ts\`; re-pin the manifest if it fails."
