#!/usr/bin/env bash
# Vendor agentnative-cli's package version into src/data/anc/VERSION.
#
# Default behavior: resolves the latest v* tag of agentnative-cli via the
# GitHub API, fetches Cargo.toml at that tag, extracts the `version`
# field under `[package]`, and writes it to src/data/anc/VERSION. The
# vendored value is the build-time input for src/build/00-spec-version-gen.mjs
# (ANC_VERSION emitted into src/worker/spec-version.gen.ts), which test
# fixtures import so they auto-track the currently-published anc release.
#
# Override behavior (--ref / CLI_REF): vendors from an explicit branch
# HEAD, tag, or commit SHA instead of the latest v* tag. Use for
# cross-repo coordination of in-flight cli work that has not released
# yet (e.g., a test fixture that needs to track an unreleased anc
# version before a tag cuts). The resolved short SHA is printed every
# run so the user knows exactly what landed; record that SHA in any
# consumer PR body that vendors non-released content.
#
# Transport: `gh api` against the GitHub REST contents endpoint. Pulls
# Cargo.toml individually (no clone, no tarball) so branches, tags,
# and SHAs take the same code path via `?ref=<X>`. Requires `gh`
# authenticated against github.com. When the API path fails (network
# down, gh unauthenticated, repo unreachable), the script falls back
# to a local checkout for offline development.
#
# Usage:
#   scripts/sync-cli-version.sh                       # latest v* tag (default)
#   scripts/sync-cli-version.sh --ref dev             # HEAD of dev branch
#   scripts/sync-cli-version.sh --ref v0.5.0          # explicit tag
#   scripts/sync-cli-version.sh --ref 1b282d4         # explicit SHA
#   CLI_REF=dev scripts/sync-cli-version.sh           # env-var form
#
# Env vars:
#   CLI_REF          Same as --ref but via env. CLI flag wins on conflict.
#   CLI_REMOTE_URL   Remote URL identifying the repo. The script parses
#                    `<owner>/<repo>` out of it for the `gh api` calls
#                    and for the local-fallback's remote-name lookup.
#                    Default: https://github.com/brettdavies/agentnative-cli.git
#   CLI_ROOT         Local checkout to fall back to when the API is
#                    unreachable. Default: $HOME/dev/agentnative-cli
#
# Resync cadence: rerun after every new agentnative-cli tag. The default
# API query picks up new tags automatically.

set -euo pipefail

CLI_REMOTE_URL="${CLI_REMOTE_URL:-https://github.com/brettdavies/agentnative-cli.git}"
CLI_ROOT="${CLI_ROOT:-$HOME/dev/agentnative-cli}"
CLI_REF="${CLI_REF:-}"

# --- Argument parsing ---------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --ref)
            if [[ $# -lt 2 || -z "$2" ]]; then
                echo "error: --ref requires a value (branch, tag, or SHA)" >&2
                exit 2
            fi
            CLI_REF="$2"
            shift 2
            ;;
        --ref=*)
            CLI_REF="${1#--ref=}"
            if [[ -z "$CLI_REF" ]]; then
                echo "error: --ref= requires a value (branch, tag, or SHA)" >&2
                exit 2
            fi
            shift
            ;;
        -h|--help)
            sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'
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
DEST_DIR="$REPO_ROOT/src/data/anc"
DEST_FILE="$DEST_DIR/VERSION"

# Parse `<owner>/<repo>` out of CLI_REMOTE_URL for `gh api` calls.
# Handles both URL shapes:
#   https://github.com/<owner>/<repo>.git
#   git@github.com:<owner>/<repo>.git
cli_repo="${CLI_REMOTE_URL%.git}"
cli_repo="${cli_repo#*github.com[/:]}"
cli_repo="${cli_repo%/}"
if [[ -z "$cli_repo" || "$cli_repo" == "$CLI_REMOTE_URL" || "$cli_repo" != */* ]]; then
    echo "error: could not parse owner/repo from CLI_REMOTE_URL: $CLI_REMOTE_URL" >&2
    exit 1
fi

# === Resolution =========================================================
resolved_ref=""
resolved_sha=""
source_label=""
api_ok=false

if [[ -n "$CLI_REF" ]]; then
    if full_sha="$(gh api "repos/$cli_repo/commits/$CLI_REF" --jq '.sha' 2>/dev/null)"; then
        resolved_ref="$CLI_REF"
        resolved_sha="${full_sha:0:7}"
        source_label="github.com:$cli_repo via gh api"
        api_ok=true
    fi
else
    latest_tag="$(gh api "repos/$cli_repo/tags?per_page=100" --jq '.[].name' 2>/dev/null \
        | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+' \
        | sort -V -r \
        | head -n 1 || true)"
    if [[ -n "$latest_tag" ]]; then
        if full_sha="$(gh api "repos/$cli_repo/commits/$latest_tag" --jq '.sha' 2>/dev/null)"; then
            resolved_ref="$latest_tag"
            resolved_sha="${full_sha:0:7}"
            source_label="github.com:$cli_repo via gh api"
            api_ok=true
        fi
    fi
fi

# === Local fallback =====================================================
if ! $api_ok; then
    if [[ ! -d "$CLI_ROOT/.git" ]]; then
        echo "error: API path failed and CLI_ROOT is not a git repository: $CLI_ROOT" >&2
        echo "       remote: $CLI_REMOTE_URL" >&2
        if [[ -n "$CLI_REF" ]]; then
            echo "       requested ref: $CLI_REF" >&2
        fi
        echo "       check \`gh auth status\`, network access, or point CLI_ROOT at a local checkout." >&2
        exit 1
    fi
    echo "warning: gh api unreachable; falling back to local $CLI_ROOT" >&2

    if [[ -n "$CLI_REF" ]]; then
        if ! git -C "$CLI_ROOT" rev-parse --verify --quiet "$CLI_REF^{commit}" >/dev/null; then
            echo "error: ref \`$CLI_REF\` not found in $CLI_ROOT" >&2
            echo "       try \`git -C $CLI_ROOT fetch --all --tags\` to pick up upstream refs," >&2
            echo "       or pass a SHA the local checkout already contains." >&2
            exit 1
        fi
        resolved_ref="$CLI_REF"
    else
        resolved_ref="$(git -C "$CLI_ROOT" tag --list 'v*' --sort='-version:refname' | head -n 1)"
        if [[ -z "$resolved_ref" ]]; then
            echo "error: no v* tags found in $CLI_ROOT" >&2
            echo "       try \`git -C $CLI_ROOT fetch --tags\` to pick up upstream tags" >&2
            exit 1
        fi
    fi
    resolved_sha="$(git -C "$CLI_ROOT" rev-parse --short=7 "$resolved_ref^{commit}")"
    source_label="local $CLI_ROOT"
fi

echo "vendoring $resolved_ref ($resolved_sha) from $source_label"

# === Extract =============================================================
# Fetch Cargo.toml at the resolved ref. API path uses gh api raw; local
# path uses git show.
if $api_ok; then
    cargo_toml="$(gh api -H "Accept: application/vnd.github.raw" \
        "repos/$cli_repo/contents/Cargo.toml?ref=$resolved_ref")"
else
    cargo_toml="$(git -C "$CLI_ROOT" show "$resolved_ref:Cargo.toml")"
fi

# Parse the version field under [package]. The awk script enters the
# [package] block on its header, exits at the next [section], and
# captures the first `version = "X.Y.Z"` line. Tolerates whitespace
# around `=` and any trailing comment after the closing quote.
version="$(printf '%s\n' "$cargo_toml" | awk '
    /^\[package\]/ { in_pkg = 1; next }
    /^\[/          { in_pkg = 0 }
    in_pkg && /^version[[:space:]]*=[[:space:]]*"/ {
        sub(/^version[[:space:]]*=[[:space:]]*"/, "")
        sub(/".*$/, "")
        print
        exit
    }
')"

# Validate: must look like semver `X.Y.Z` plus optional prerelease /
# build-metadata. Bail loudly otherwise so a malformed Cargo.toml does
# not silently corrupt the vendored marker.
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][[:alnum:].-]+)?$ ]]; then
    echo "error: failed to extract a valid semver from Cargo.toml [package].version" >&2
    echo "       got: \"$version\"" >&2
    echo "       at ref: $resolved_ref ($resolved_sha)" >&2
    exit 1
fi

mkdir -p "$DEST_DIR"
printf '%s\n' "$version" >"$DEST_FILE"

echo "wrote $version to $DEST_FILE"
echo
echo "next: review \`git diff\` for unexpected changes, then commit."
