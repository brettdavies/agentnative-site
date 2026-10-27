#!/usr/bin/env bash
# Edge User-Agent ban probe. Sends the default User-Agent of stdlib HTTP
# clients to `<base-url>/llms.txt` and `<base-url>/mcp` and fails when any
# request is refused.
#
# Cloudflare Browser Integrity Check bans these signatures with HTTP 403 and
# error 1010 before the Worker runs, so the refusal reaches neither Workers
# Logs nor Security Events on this plan, and every probe that names itself in
# its User-Agent (mcp-smoke, agent-web-audit) passes while an agent using
# Python's urllib cannot connect.
#
# Production only: BIC on *.workers.dev cannot be turned off, so the staging
# Worker refuses these signatures by design.
#
# Callers:
#   - .github/workflows/mcp-sweep.yml (sweep-production leg) -> https://anc.dev
#
# Usage:
#   scripts/release/ua-ban-probe.sh <base-url>
#
# Exit codes:
#   0  every signature was served
#   1  at least one request was refused
#   2  usage error or missing dependency

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
readonly REPO_ROOT

. "$REPO_ROOT/scripts/release/_lib.sh"

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <base-url>" >&2
  exit 2
fi
BASE_URL="${1%/}"
readonly BASE_URL

require_bin curl

# The defaults that Python's urllib.request and Perl's LWP send. BIC matches
# the signature family, so one version of each stands for the rest.
readonly STDLIB_USER_AGENTS=('Python-urllib/3.12' 'libwww-perl/6.72')

readonly INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"anc-ua-ban-probe","version":"0"}}}'

OUT="$(mktemp -d)"
readonly OUT
trap 'rm -rf "$OUT"' EXIT

# Args: $1 label, $2 User-Agent, then the curl request arguments.
probe() {
  local label=$1 ua=$2 status detail
  shift 2
  status=$(curl -sS -m 15 -o "$OUT/body" -w '%{http_code}' -A "$ua" "$@" 2>"$OUT/err") || status="curl-error"
  if [[ "$status" == "200" ]]; then
    gate_pass "$label as $ua"
    return
  fi
  detail="HTTP $status: $(cat "$OUT/body" "$OUT/err" 2>/dev/null | head -c 200 | tr '\n' ' ')"
  if grep -q '1010' "$OUT/body" 2>/dev/null; then
    detail="Cloudflare Browser Integrity Check refused the signature (error 1010). Turn it off for the zone: dashboard Security > Settings > Browser integrity check, or PATCH /zones/<zone-id>/settings/browser_check with {\"value\":\"off\"}."
  fi
  gate_fail "$label as $ua" "$detail"
  echo "::error::$label as $ua: $detail"
}

header "stdlib User-Agents against $BASE_URL"
for ua in "${STDLIB_USER_AGENTS[@]}"; do
  probe "GET /llms.txt" "$ua" "$BASE_URL/llms.txt"
  probe "POST /mcp initialize" "$ua" -X POST "$BASE_URL/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json' --data "$INIT_BODY"
done

print_summary
[[ $FAIL_COUNT -eq 0 ]] || exit 1
