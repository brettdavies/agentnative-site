#!/usr/bin/env bash
# Restore the Sounding implementation to the tagged broken patient and
# redeploy the Worker. The script refuses dev and main before any Git write.
#
# The annotated tag `sounding-broken` identifies the patient SHA. Override it
# with SOUNDING_BROKEN_REF.
#
# Usage:
#   scripts/sounding-restore.sh              restore demo/ + wrangler deploy
#   scripts/sounding-restore.sh --no-deploy  skip wrangler
#
# Feature branches cut from dev already contain the committed broken patient,
# leaving the recording fix as the branch's only commit.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="${SOUNDING_BROKEN_REF:-sounding-broken}"
DEPLOY=true

while [ $# -gt 0 ]; do
  case "$1" in
    --no-deploy)
      DEPLOY=false
      shift
      ;;
    -h | --help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

cd "$REPO_ROOT"

BRANCH="$(git branch --show-current)"
case "$BRANCH" in
  main | dev)
    echo "FATAL: restore refuses $BRANCH (read-only). Switch to a feat/* branch." >&2
    exit 2
    ;;
esac

if ! git rev-parse --verify "$REF^{commit}" >/dev/null 2>&1; then
  echo "FATAL: missing ref '$REF'. Fetch tags (git fetch --tags) or set SOUNDING_BROKEN_REF." >&2
  exit 2
fi

SHA="$(git rev-parse --short "$REF^{commit}")"
echo "Restoring demo/ from $REF ($SHA)"
git restore --source "$REF" --worktree -- demo/src/index.ts

if [ "$DEPLOY" = true ]; then
  (cd "$REPO_ROOT/demo" && npx wrangler deploy)
fi
