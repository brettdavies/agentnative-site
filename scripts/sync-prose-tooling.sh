#!/usr/bin/env bash
# Vendor the prose-check tooling shipped on agentnative-spec.
#
# Parallel sync vehicle to scripts/sync-spec.sh, decoupled because prose
# tooling and the principles/contract release on different cadences.
# sync-spec.sh covers the contract anc lints against (principles, VERSION,
# CHANGELOG); this script covers the shared prose-check tooling (Vale rule
# packs, vocabulary, orchestrator, generator, and BRAND.md narrative SoT).
#
# Resolves the latest v* tag of agentnative-spec, preferring the remote
# repository, and falls back to a local checkout if the remote is
# unreachable. Extracts files via `git show <tag>:<path>` so neither
# checkout's working tree is perturbed.
#
# Vendored manifest (paths at the spec tag, mirrored verbatim into this
# repo at the same paths):
#
#   BRAND.md                                            (universal voice SoT)
#   styles/brand/*.yml                                  (universal rule pack)
#   styles/brand/README.md                              (released companion)
#   styles/config/vocabularies/brand/{accept,reject}.txt  (universal vocab)
#   scripts/prose-check.sh                              (orchestrator)
#   scripts/generate-pack-readme.mjs                    (generator)
#
# The brand README is a *released artifact*, not regenerated downstream:
# sync-script atomicity is the integrity guarantee, and downstream
# regeneration would invite tooling-version drift (js-yaml renderer skew,
# generator-vs-YAML version skew across consumers).
#
# Usage:
#   scripts/sync-prose-tooling.sh
#   SPEC_ROOT=/path/to/agentnative-spec scripts/sync-prose-tooling.sh
#   SPEC_REMOTE_URL=git@github.com:brettdavies/agentnative.git scripts/sync-prose-tooling.sh
#
# Env vars (shared with sync-spec.sh):
#   SPEC_REMOTE_URL  Remote URL to query first.
#                    Default: https://github.com/brettdavies/agentnative.git
#   SPEC_ROOT        Local checkout to fall back to when the remote is
#                    unreachable. Default: $HOME/dev/agentnative-spec
#
# Resync cadence: rerun after the spec ships a tag that touches any path
# in the manifest above. Spec's `repository_dispatch:spec-release` event
# fires here on tag publish; a consumer-side handler that auto-PRs the
# resync is tracked as deferred follow-up alongside the same handler for
# sync-spec.sh.
#
# Idempotent at a fixed spec tag: re-running produces no `git diff`.

set -euo pipefail

SPEC_REMOTE_URL="${SPEC_REMOTE_URL:-https://github.com/brettdavies/agentnative.git}"
SPEC_ROOT="${SPEC_ROOT:-$HOME/dev/agentnative-spec}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Cleanup hook for the temp clone (set only after mktemp succeeds).
tmp_root=""
cleanup() {
    if [[ -n "$tmp_root" && -d "$tmp_root" ]]; then
        rm -rf "$tmp_root"
    fi
}
trap cleanup EXIT

# === Remote-first resolution ===========================================
spec_source=""
spec_tag=""

echo "querying $SPEC_REMOTE_URL for latest v* tag..."
remote_tag="$(git ls-remote --tags --sort='-version:refname' \
    "$SPEC_REMOTE_URL" 'refs/tags/v*' 2>/dev/null \
    | awk '{print $2}' \
    | sed 's|refs/tags/||' \
    | grep -v '\^{}$' \
    | head -n 1 || true)"

if [[ -n "$remote_tag" ]]; then
    tmp_root="$(mktemp -d -t agentnative-prose-XXXXXX)"
    if git clone --depth 1 --branch "$remote_tag" --quiet \
            "$SPEC_REMOTE_URL" "$tmp_root" 2>/dev/null; then
        spec_source="$tmp_root"
        spec_tag="$remote_tag"
        resolved_sha="$(git -C "$spec_source" rev-parse --short=7 "$spec_tag^{commit}")"
        echo "vendoring $spec_tag ($resolved_sha) from remote $SPEC_REMOTE_URL"
    fi
fi

# === Local fallback ====================================================
if [[ -z "$spec_source" ]]; then
    if [[ ! -d "$SPEC_ROOT/.git" ]]; then
        echo "error: remote unreachable and SPEC_ROOT is not a git repository: $SPEC_ROOT" >&2
        echo "       remote: $SPEC_REMOTE_URL" >&2
        echo "       set SPEC_ROOT to your agentnative-spec checkout, or check network access." >&2
        exit 1
    fi
    echo "warning: remote query failed; falling back to local $SPEC_ROOT" >&2

    spec_source="$SPEC_ROOT"
    spec_tag="$(git -C "$spec_source" tag --list 'v*' --sort='-version:refname' | head -n 1)"
    if [[ -z "$spec_tag" ]]; then
        echo "error: no v* tags found in $SPEC_ROOT" >&2
        echo "       try \`git -C $SPEC_ROOT fetch --tags\` to pick up upstream tags" >&2
        exit 1
    fi
    resolved_sha="$(git -C "$spec_source" rev-parse --short=7 "$spec_tag^{commit}")"
    echo "vendoring $spec_tag ($resolved_sha) from local $spec_source"
fi

# === Verify expected paths exist at the tag ===========================
required_paths=(
    "BRAND.md"
    "styles/brand"
    "styles/brand/README.md"
    "styles/config/vocabularies/brand"
    "scripts/prose-check.sh"
    "scripts/generate-pack-readme.mjs"
)
for path in "${required_paths[@]}"; do
    if ! git -C "$spec_source" cat-file -e "$spec_tag:$path" 2>/dev/null; then
        echo "error: $spec_tag is missing required path: $path" >&2
        echo "       (the prose-check stack may not have shipped at this tag)" >&2
        exit 1
    fi
done

# === Extract: top-level singletons =====================================
mkdir -p \
    "$REPO_ROOT/styles/brand" \
    "$REPO_ROOT/styles/config/vocabularies/brand" \
    "$REPO_ROOT/scripts"

git -C "$spec_source" show "$spec_tag:BRAND.md" >"$REPO_ROOT/BRAND.md"
git -C "$spec_source" show "$spec_tag:styles/brand/README.md" >"$REPO_ROOT/styles/brand/README.md"
git -C "$spec_source" show "$spec_tag:scripts/prose-check.sh" >"$REPO_ROOT/scripts/prose-check.sh"
git -C "$spec_source" show "$spec_tag:scripts/generate-pack-readme.mjs" \
    >"$REPO_ROOT/scripts/generate-pack-readme.mjs"

# git show drops the executable bit; restore it for the orchestrator.
chmod +x "$REPO_ROOT/scripts/prose-check.sh"

# === Extract: brand rule pack YAMLs ====================================
yaml_count=0
while IFS= read -r path; do
    case "$path" in
        styles/brand/*.yml)
            dest="$REPO_ROOT/$path"
            git -C "$spec_source" show "$spec_tag:$path" >"$dest"
            yaml_count=$((yaml_count + 1))
            ;;
    esac
done < <(git -C "$spec_source" ls-tree --name-only "$spec_tag" styles/brand/)

if [[ "$yaml_count" -eq 0 ]]; then
    echo "error: no styles/brand/*.yml files found at $spec_tag" >&2
    exit 1
fi

# === Extract: brand vocabulary =========================================
vocab_count=0
while IFS= read -r path; do
    case "$path" in
        styles/config/vocabularies/brand/*.txt)
            dest="$REPO_ROOT/$path"
            git -C "$spec_source" show "$spec_tag:$path" >"$dest"
            vocab_count=$((vocab_count + 1))
            ;;
    esac
done < <(git -C "$spec_source" ls-tree --name-only "$spec_tag" \
    styles/config/vocabularies/brand/)

if [[ "$vocab_count" -eq 0 ]]; then
    echo "error: no styles/config/vocabularies/brand/*.txt files found at $spec_tag" >&2
    exit 1
fi

# === Report ============================================================
echo "wrote BRAND.md to repo root"
echo "wrote $yaml_count brand rule pack YAML(s) + README.md to styles/brand/"
echo "wrote $vocab_count brand vocab file(s) to styles/config/vocabularies/brand/"
echo "wrote scripts/prose-check.sh (executable) + scripts/generate-pack-readme.mjs"
echo
echo "next: review \`git diff\` for unexpected changes, then commit."
