#!/usr/bin/env bash
# Restore demo/ to the tagged broken Sounding patient and redeploy the Worker.
# After a recording take you run this so the next take starts from the same
# three MUST fails. It never touches files outside demo/.
#
# The annotated tag `sounding-broken` is the patient SHA (created on the
# commit that introduced demo/). Override with SOUNDING_BROKEN_REF.
#
# Usage:
#   scripts/sounding-restore.sh              restore demo/ + wrangler deploy
#   scripts/sounding-restore.sh --commit     also commit demo/ on this branch
#   scripts/sounding-restore.sh --no-deploy  skip wrangler
#
# --commit refuses main and dev (branch protection). Recording takes belong
# on feat/* ; default restore is working-tree + deploy, which is enough
# between takes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="${SOUNDING_BROKEN_REF:-sounding-broken}"
COMMIT=false
DEPLOY=true

while [ $# -gt 0 ]; do
  case "$1" in
    --commit)
      COMMIT=true
      shift
      ;;
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

if ! git rev-parse --verify "$REF^{commit}" >/dev/null 2>&1; then
  echo "FATAL: missing ref '$REF'. Fetch tags (git fetch --tags) or set SOUNDING_BROKEN_REF." >&2
  exit 2
fi

SHA="$(git rev-parse --short "$REF^{commit}")"
echo "Restoring demo/ from $REF ($SHA)"
git checkout "$REF" -- demo/

if [ "$COMMIT" = true ]; then
  BRANCH="$(git branch --show-current)"
  case "$BRANCH" in
    main | dev)
      echo "FATAL: --commit refuses $BRANCH (protected). Stay on feat/* or omit --commit." >&2
      exit 2
      ;;
  esac
  if git diff --cached --quiet -- demo/ && git diff --quiet -- demo/; then
    echo "demo/ already matches $REF; nothing to commit"
  else
    git add demo/
    git commit -m "chore(demo): restore sounding patient from ${REF}"
  fi
fi

if [ "$DEPLOY" = true ]; then
  (cd "$REPO_ROOT/demo" && npx wrangler deploy)
fi
