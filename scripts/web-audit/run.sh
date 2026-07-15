#!/usr/bin/env bash
# Dead-simple runner for the web-audit engine against a live target.
# See docs/runbooks/web-audit-operations.md.
#
# Runs the CURRENT working tree's audit logic (scripts/web-audit/audit.ts,
# under Bun) against real remote content. The default target is staging, which
# sits behind Cloudflare Access; this script resolves the Access service token
# from 1Password and ensures a fresh build before running.
#
# Usage:
#   scripts/web-audit/run.sh                              # audit staging, full report
#   scripts/web-audit/run.sh --check mcp-get-fast-fail    # gate one check (exit 0 = pass)
#   scripts/web-audit/run.sh --target https://anc.dev/    # audit a public target (post-release)
#   scripts/web-audit/run.sh --json                       # full scorecard JSON
#   scripts/web-audit/run.sh --site-type api              # force the declared site type
#
# Exit codes (with --check): 0 pass, 1 present-but-failing, 2 setup error, 3 not evaluable.
# Add --no-build to reuse the existing dist/ (skips the rebuild).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGING_URL="${STAGING_URL:-https://agentnative-site-staging.brettdavies.workers.dev/}"

TARGET="$STAGING_URL"
BUILD=true
PASS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --target | -t)
      TARGET="$2"
      shift 2
      ;;
    --no-build)
      BUILD=false
      shift
      ;;
    *)
      PASS_ARGS+=("$1")
      shift
      ;;
  esac
done

# Cloudflare Access: the staging Worker bounces unauthenticated requests to
# the Access login wall, so the engine's self-fetches need service-token
# headers. Resolve them from 1Password (never inline the values). Public
# targets (e.g. anc.dev after a release) need no token.
case "$TARGET" in
  *agentnative-site-staging*)
    OP_READ="${OP_READ:-$HOME/.claude/skills/1password/scripts/read_field.sh}"
    OP_ITEM="Cloudflare Access Service Token - agentnative-site-staging"
    if [ ! -x "$OP_READ" ]; then
      echo "FATAL: 1Password helper not found at $OP_READ (install the 1password skill or export OP_READ)." >&2
      exit 2
    fi
    CF_ACCESS_CLIENT_ID="$("$OP_READ" "$OP_ITEM" client_id 2>/dev/null || true)"
    CF_ACCESS_CLIENT_SECRET="$("$OP_READ" "$OP_ITEM" client_secret 2>/dev/null || true)"
    if [ -z "$CF_ACCESS_CLIENT_ID" ] || [ -z "$CF_ACCESS_CLIENT_SECRET" ]; then
      echo "FATAL: could not read CF Access token from 1Password item '$OP_ITEM'." >&2
      exit 2
    fi
    export CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET
    ;;
esac

if [ "$BUILD" = true ]; then
  (cd "$REPO_ROOT" && bun run build >/dev/null)
fi

exec bun run "$REPO_ROOT/scripts/web-audit/audit.ts" --target "$TARGET" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}
