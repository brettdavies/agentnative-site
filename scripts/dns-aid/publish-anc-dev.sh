#!/usr/bin/env bash
# Publish DNS for AI Discovery (DNS-AID) SVCB records for anc.dev.
#
# DNS-AID is validated via DNS-over-HTTPS by agent-readiness scanners
# (isitagentready.com). The site Worker cannot emit these records; they
# live in the anc.dev zone on Cloudflare.
#
# Prerequisites:
#   - CLOUDFLARE_API_TOKEN with Zone.DNS Edit on anc.dev
#   - CLOUDFLARE_ZONE_ID for anc.dev (or pass as first argument)
#   - DNSSEC enabled on the zone (Cloudflare dashboard: DNS > Settings)
#
# Usage:
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=... ./scripts/dns-aid/publish-anc-dev.sh
#   ./scripts/dns-aid/publish-anc-dev.sh <zone-id>
#
# Records published (draft-mozleywilliams-dnsop-dnsaid):
#   _index._agents.anc.dev  SVCB -> anc.dev  alpn=mcp,h2,h3 port=443
#   _mcp._agents.anc.dev    SVCB -> anc.dev  alpn=mcp,h2,h3 port=443
#
# Idempotent: existing matching records are updated in place.

set -euo pipefail

ZONE_ID="${1:-${CLOUDFLARE_ZONE_ID:-}}"
API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"

if [[ -z "$ZONE_ID" || -z "$API_TOKEN" ]]; then
  echo "usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=... $0" >&2
  echo "   or: CLOUDFLARE_API_TOKEN=... $0 <zone-id>" >&2
  exit 1
fi

API="https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records"
AUTH=(-H "Authorization: Bearer ${API_TOKEN}" -H "Content-Type: application/json")

TARGET="anc.dev"
SVCB_DATA="1 ${TARGET}. alpn=\"mcp,h2,h3\" port=443 mandatory=alpn,port"

upsert_svcb() {
  local name="$1"
  local list
  list="$(curl -fsS "${AUTH[@]}" "${API}?name=${name}&type=SVCB")"
  local id
  id="$(echo "$list" | jq -r '.result[0].id // empty')"
  local payload
  payload="$(jq -n --arg name "$name" --arg data "$SVCB_DATA" '{type:"SVCB",name:$name,ttl:3600,data:$data,proxied:false}')"
  if [[ -n "$id" ]]; then
    curl -fsS -X PUT "${AUTH[@]}" -d "$payload" "${API}/${id}" | jq -e '.success' >/dev/null
    echo "updated SVCB ${name}"
  else
    curl -fsS -X POST "${AUTH[@]}" -d "$payload" "$API" | jq -e '.success' >/dev/null
    echo "created SVCB ${name}"
  fi
}

upsert_svcb "_index._agents.anc.dev"
upsert_svcb "_mcp._agents.anc.dev"

echo "DNS-AID SVCB records published. Verify with:"
echo "  dig SVCB _index._agents.anc.dev +short"
echo "  dig SVCB _mcp._agents.anc.dev +short"
