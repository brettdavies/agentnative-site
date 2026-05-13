#!/usr/bin/env bash
# Vendor the prose-check tooling shipped on agentnative-spec.
#
# Parallel sync vehicle to scripts/sync-spec.sh, decoupled because prose
# tooling and the principles/contract release on different cadences.
# sync-spec.sh covers the contract anc lints against (principles, VERSION,
# CHANGELOG); this script covers the shared prose-check tooling (Vale rule
# packs, vocabulary, orchestrator, generator, and BRAND.md narrative SoT).
#
# Tracks `main` HEAD by design: tag-pinning is for the principle contract
# via `sync-spec.sh`. The prose-tooling stack is tooling, not contract, so
# it follows faster cadence with no release ceremony. Resolves the current
# `main` HEAD SHA of agentnative-spec, preferring the remote repository,
# and falls back to a local checkout's `main` if the remote is unreachable.
# Extracts files via `git show <ref>:<path>` so neither checkout's working
# tree is perturbed.
#
# Vendored manifest (paths at the spec `main` HEAD, mirrored verbatim into
# this repo at the same paths):
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
# Resync cadence: rerun when the spec's `main` branch advances with changes
# touching any path in the manifest above. Tracks `main` HEAD by design;
# tag-pinning is for the principle contract via `sync-spec.sh`.
#
# Idempotent at a fixed `main` HEAD SHA: re-running produces no `git diff`
# until upstream `main` moves.

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
spec_ref=""
resolved_sha=""

echo "querying $SPEC_REMOTE_URL for main HEAD..."
remote_sha="$(git ls-remote "$SPEC_REMOTE_URL" 'refs/heads/main' 2>/dev/null | awk '{print $1}')"

if [[ -n "$remote_sha" ]]; then
    tmp_root="$(mktemp -d -t agentnative-prose-XXXXXX)"
    if git clone --depth 1 --branch main --quiet \
            "$SPEC_REMOTE_URL" "$tmp_root" 2>/dev/null; then
        spec_source="$tmp_root"
        spec_ref="main"
        resolved_sha="$(git -C "$spec_source" rev-parse --short=7 main)"
        echo "pulled from main @ $resolved_sha (remote $SPEC_REMOTE_URL)"
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
    if ! git -C "$spec_source" rev-parse --verify --quiet main >/dev/null; then
        echo "error: no \`main\` branch found in $SPEC_ROOT" >&2
        echo "       try \`git -C $SPEC_ROOT fetch origin main:main\` to pick up upstream main" >&2
        exit 1
    fi
    spec_ref="main"
    resolved_sha="$(git -C "$spec_source" rev-parse --short=7 main)"
    echo "pulled from main @ $resolved_sha (local $spec_source)"
fi

# === Verify expected paths exist at main HEAD =========================
required_paths=(
    "BRAND.md"
    "styles/brand"
    "styles/brand/README.md"
    "styles/config/vocabularies/brand"
    "scripts/prose-check.sh"
    "scripts/generate-pack-readme.mjs"
)
for path in "${required_paths[@]}"; do
    if ! git -C "$spec_source" cat-file -e "$spec_ref:$path" 2>/dev/null; then
        echo "error: main @ $resolved_sha is missing required path: $path" >&2
        echo "       (the prose-check stack may not be present at this revision)" >&2
        exit 1
    fi
done

# === Extract: top-level singletons =====================================
mkdir -p \
    "$REPO_ROOT/styles/brand" \
    "$REPO_ROOT/styles/config/vocabularies/brand" \
    "$REPO_ROOT/scripts"

git -C "$spec_source" show "$spec_ref:BRAND.md" >"$REPO_ROOT/BRAND.md"
git -C "$spec_source" show "$spec_ref:styles/brand/README.md" >"$REPO_ROOT/styles/brand/README.md"
git -C "$spec_source" show "$spec_ref:scripts/prose-check.sh" >"$REPO_ROOT/scripts/prose-check.sh"
git -C "$spec_source" show "$spec_ref:scripts/generate-pack-readme.mjs" \
    >"$REPO_ROOT/scripts/generate-pack-readme.mjs"

# git show drops the executable bit; restore it for the orchestrator.
chmod +x "$REPO_ROOT/scripts/prose-check.sh"

# === Extract: brand rule pack YAMLs ====================================
yaml_count=0
while IFS= read -r path; do
    case "$path" in
        styles/brand/*.yml)
            dest="$REPO_ROOT/$path"
            git -C "$spec_source" show "$spec_ref:$path" >"$dest"
            yaml_count=$((yaml_count + 1))
            ;;
    esac
done < <(git -C "$spec_source" ls-tree --name-only "$spec_ref" styles/brand/)

if [[ "$yaml_count" -eq 0 ]]; then
    echo "error: no styles/brand/*.yml files found at main @ $resolved_sha" >&2
    exit 1
fi

# === Extract: brand vocabulary =========================================
vocab_count=0
while IFS= read -r path; do
    case "$path" in
        styles/config/vocabularies/brand/*.txt)
            dest="$REPO_ROOT/$path"
            git -C "$spec_source" show "$spec_ref:$path" >"$dest"
            vocab_count=$((vocab_count + 1))
            ;;
    esac
done < <(git -C "$spec_source" ls-tree --name-only "$spec_ref" \
    styles/config/vocabularies/brand/)

if [[ "$vocab_count" -eq 0 ]]; then
    echo "error: no styles/config/vocabularies/brand/*.txt files found at main @ $resolved_sha" >&2
    exit 1
fi

# === Report ============================================================
echo "pulled from main @ $resolved_sha"
echo "wrote BRAND.md to repo root"
echo "wrote $yaml_count brand rule pack YAML(s) + README.md to styles/brand/"
echo "wrote $vocab_count brand vocab file(s) to styles/config/vocabularies/brand/"
echo "wrote scripts/prose-check.sh (executable) + scripts/generate-pack-readme.mjs"
echo
echo "next: review \`git diff\` for unexpected changes, then commit."
