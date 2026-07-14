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

# Cloudflare's DNS API takes SVCB/HTTPS records as a structured data object
# (priority + target + value), not a BIND presentation string. The SvcParams
# live in `value`; `proxied` is not a field SVCB accepts.
TARGET="anc.dev"
SVCB_VALUE='alpn="mcp,h2,h3" port=443 mandatory="alpn,port"'

# POST/PUT and fail loud with the API's own error array on a non-success body.
cf_write() {
  local method="$1" url="$2" payload="$3" what="$4"
  local resp
  resp="$(curl -sS -X "$method" "${AUTH[@]}" -d "$payload" "$url")"
  if ! echo "$resp" | jq -e '.success' >/dev/null 2>&1; then
    echo "FAILED: $what" >&2
    echo "$resp" | jq -c '.errors' >&2
    return 1
  fi
}

upsert_svcb() {
  local name="$1"
  local list
  list="$(curl -fsS "${AUTH[@]}" "${API}?name=${name}&type=SVCB")"
  local id
  id="$(echo "$list" | jq -r '.result[0].id // empty')"
  local payload
  payload="$(jq -n --arg name "$name" --arg target "$TARGET" --arg value "$SVCB_VALUE" \
    '{type:"SVCB",name:$name,ttl:3600,data:{priority:1,target:$target,value:$value}}')"
  if [[ -n "$id" ]]; then
    cf_write PUT "${API}/${id}" "$payload" "update SVCB ${name}"
    echo "updated SVCB ${name}"
  else
    cf_write POST "$API" "$payload" "create SVCB ${name}"
    echo "created SVCB ${name}"
  fi
}

upsert_svcb "_index._agents.anc.dev"
upsert_svcb "_mcp._agents.anc.dev"

echo "DNS-AID SVCB records published. Verify with:"
echo "  dig SVCB _index._agents.anc.dev +short"
echo "  dig SVCB _mcp._agents.anc.dev +short"
