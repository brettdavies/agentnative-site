#!/usr/bin/env bash
# Post-deploy smoke for the web-audit version signal. Exits 0 when
# GET /api/web-audit/version answers 200 with JSON holding exactly its three
# fields, each in its expected shape; exits non-zero otherwise.
#
# Its one consumer, the anc CLI's staleness note, skips silently on any
# failure, so this is where a broken signal turns red. Invoked from
# .github/workflows/deploy.yml after each deploy and from the release
# postflight, and runnable locally for parity.
#
# Usage:
#   scripts/smoke-web-audit-version.sh <base-url>
#
# Environment variables (all optional):
#   CF_ACCESS_CLIENT_ID      Sent as CF-Access-Client-Id when non-empty.
#   CF_ACCESS_CLIENT_SECRET  Sent as CF-Access-Client-Secret when non-empty.
#                            Both are required for staging (Worker is behind
#                            Cloudflare Access) and unused for production.
#   SMOKE_CURL_CONFIG        A curl config file carrying the same headers.
#   SMOKE_RETRIES            Attempts after the first, ten seconds apart.
#                            Default 5, so an isolate still running the
#                            previous deploy inside the propagation window
#                            cannot fail the deploy on its own.
#
# Exit codes:
#   0  smoke passed
#   1  smoke failed (no 200, not JSON, or the body breaks the contract)
#   2  prerequisite missing (no base URL, no jq)

set -euo pipefail

BASE_URL="${1:-}"
if [ -z "$BASE_URL" ]; then
  echo "FATAL: missing base URL. Usage: $0 <base-url>" >&2
  exit 2
fi

JQ_BIN="$(command -v jaq || command -v jq || true)"
if [ -z "$JQ_BIN" ]; then
  echo "FATAL: neither jaq nor jq is installed. Install one (brew install jaq) and retry." >&2
  exit 2
fi

URL="${BASE_URL%/}/api/web-audit/version"

curl_args=(-fsS -m 10 --retry "${SMOKE_RETRIES:-5}" --retry-delay 10 --retry-all-errors -w '\n%{content_type}')
if [ -n "${SMOKE_CURL_CONFIG:-}" ]; then
  curl_args+=(-K "$SMOKE_CURL_CONFIG")
fi
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ]; then
  curl_args+=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID")
fi
if [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  curl_args+=(-H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
fi

if ! response="$(curl "${curl_args[@]}" "$URL" 2>&1)"; then
  echo "FAIL: $URL did not answer 200: $response" >&2
  exit 1
fi
content_type="${response##*$'\n'}"
body="${response%$'\n'*}"

case "$content_type" in
  application/json*) ;;
  *)
    echo "FAIL: $URL answered Content-Type '$content_type', expected application/json" >&2
    exit 1
    ;;
esac

# shellcheck disable=SC2016 # the filter is jq, not shell
contract='(keys == ["registry_fingerprint", "spec_version", "web_schema_version"])
  and (.registry_fingerprint | type == "string" and test("^[0-9a-f]{12}$"))
  and (.spec_version | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+"))
  and (.web_schema_version | type == "string" and test("^[0-9]+\\.[0-9]+$"))'

if ! printf '%s' "$body" | "$JQ_BIN" -e "$contract" >/dev/null 2>&1; then
  echo "FAIL: $URL broke the contract: $body" >&2
  exit 1
fi

echo "PASS: $URL $body"
