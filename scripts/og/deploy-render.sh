#!/usr/bin/env bash
# Deploys the og:video render Worker (anc-og-render) for one environment.
#
#   scripts/og/deploy-render.sh <staging|production>
#
# A Worker's first deploy uploads the script, then reads the Worker back from
# the Workers API to settle its workers.dev subdomain. That read can lag the
# upload and answer 10007 ("This Worker does not exist on your account"),
# which wrangler does not retry. The upload has landed by then, so the same
# deploy after a wait completes it; any other failure fails at once.
#
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or wrangler logged in.

set -euo pipefail

case "${1:-}" in
  staging) ENV_FLAGS=(--env staging) ;;
  production) ENV_FLAGS=(--env=) ;;
  *)
    echo "usage: scripts/og/deploy-render.sh <staging|production>" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="$REPO_ROOT/src/og-render/wrangler.jsonc"
read -ra WAITS <<<"${OG_DEPLOY_RETRY_WAITS:-15 30 45}"
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT

attempt=0
while :; do
  status=0
  bunx wrangler deploy --config "$CONFIG" "${ENV_FLAGS[@]}" 2>&1 | tee "$LOG" || status=$?
  [[ "$status" -eq 0 ]] && exit 0
  grep -q 'code: 10007' "$LOG" || exit "$status"
  [[ "$attempt" -lt "${#WAITS[@]}" ]] || exit "$status"
  echo "deploy-render: the Workers API does not list the uploaded Worker yet; deploying again in ${WAITS[$attempt]} s" >&2
  sleep "${WAITS[$attempt]}"
  attempt=$((attempt + 1))
done
