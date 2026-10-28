#!/usr/bin/env bash
# Live check of the scorecard social card on a deployed site Worker.
#
# Deploys tests/e2e/og-cards-fixture on three fresh og-<kind>-<run>.anc.dev
# custom domains, runs the og-cards Playwright project against <base-url>,
# and deletes the fixture Worker, with its domains, whatever the outcome.
# Fresh hosts mean every audit, card and logo lookup starts empty, so the
# drawn path and each logo tier run for real on every pass.
#
# Usage: scripts/og/smoke.sh <base-url>
#   <base-url>  the site Worker to check: the staging workers.dev host, or
#               http://localhost:8787 for `bun run dev` (MCP_ENABLED and
#               CONTEXT_DEV_API_KEY in .dev.vars.staging)
#
# Staging sits behind Cloudflare Access: export ANC_STAGING_ACCESS_CLIENT_ID
# and ANC_STAGING_ACCESS_CLIENT_SECRET first (scripts/release/preflight.sh e2e
# stages them). wrangler needs Workers write and the anc.dev zone; dig and
# curl must be on PATH.
set -euo pipefail

BASE="${1:?usage: scripts/og/smoke.sh <base-url>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="$ROOT/tests/e2e/og-cards-fixture/wrangler.jsonc"
RUN="$(date +%s)"
HOSTS=("og-hires-$RUN.anc.dev" "og-lowres-$RUN.anc.dev" "og-baddata-$RUN.anc.dev")

teardown() {
  if ! (cd "$ROOT" && bunx wrangler delete --config "$CONFIG" --force >/dev/null 2>&1); then
    echo "warn: the fixture Worker was not deleted; run: bunx wrangler delete --config $CONFIG --force" >&2
  fi
}
trap teardown EXIT

domains=()
for host in "${HOSTS[@]}"; do domains+=(--domain "$host"); done
(cd "$ROOT" && bunx wrangler deploy --config "$CONFIG" "${domains[@]}")

# A new custom domain answers once its DNS record and edge certificate are
# live. Readiness asks the zone's own nameserver and pins curl to the answer,
# because a lookup through this machine's resolver before the record exists
# caches NXDOMAIN for the zone's negative TTL (30 minutes on anc.dev), and the
# audits that follow would inherit it.
NAMESERVER="$(dig +short NS anc.dev | head -1)"
[[ -n "$NAMESERVER" ]] || {
  echo "error: no nameserver found for anc.dev (is dig installed?)" >&2
  exit 1
}
for host in "${HOSTS[@]}"; do
  ready=0
  for _ in $(seq 1 36); do
    ip="$(dig +short A "$host" "@$NAMESERVER" | head -1)"
    if [[ -n "$ip" ]] && curl -fs -o /dev/null --resolve "$host:443:$ip" "https://$host/"; then
      ready=1
      break
    fi
    sleep 5
  done
  if [[ $ready -ne 1 ]]; then
    echo "error: fixture host $host did not answer within 3 minutes" >&2
    exit 1
  fi
done

cd "$ROOT"
ANC_STAGING_BASE_URL="$BASE" OG_FIXTURE_HOSTS="$(
  IFS=,
  echo "${HOSTS[*]}"
)" bunx playwright test --project=og-cards --reporter=line
