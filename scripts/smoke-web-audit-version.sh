#!/usr/bin/env bash
# Post-deploy smoke for the web-audit version signal. Exits 0 when
# GET /api/web-audit/version answers 200 with JSON holding exactly its three
# fields, each in its expected shape; exits non-zero otherwise.
#
# A client treats any failure of the signal as no signal, so no consumer reports
# a broken one and this is where it turns red. Invoked from
# .github/workflows/deploy.yml after each deploy, the daily production sweep, and
# the release postflight, and runnable locally for parity.
#
# Usage:
#   scripts/smoke-web-audit-version.sh <base-url>
#
# Environment variables (all optional):
#   CF_ACCESS_CLIENT_ID      Sent as CF-Access-Client-Id, with the secret.
#   CF_ACCESS_CLIENT_SECRET  Sent as CF-Access-Client-Secret, with the id.
#                            Both are required for staging (Worker is behind
#                            Cloudflare Access) and unused for production.
#   SMOKE_RETRIES            Attempts after the first. Default 5, so an isolate
#                            still running the previous deploy inside the
#                            propagation window cannot fail the deploy on its
#                            own.
#   SMOKE_RETRY_DELAY        Seconds between attempts. Default 10.
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

# A mode-600 config keeps the secret off curl's command line.
curl_config="$(mktemp)"
chmod 600 "$curl_config"
trap 'rm -f "$curl_config"' EXIT
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  printf 'header = "CF-Access-Client-Id: %s"\n' "$CF_ACCESS_CLIENT_ID" >>"$curl_config"
  printf 'header = "CF-Access-Client-Secret: %s"\n' "$CF_ACCESS_CLIENT_SECRET" >>"$curl_config"
fi

# Stdout alone: curl reports each failed attempt on stderr, and a retry that
# later succeeds must not read as part of the body.
if ! response="$(curl -fsS -m 10 --retry "${SMOKE_RETRIES:-5}" --retry-delay "${SMOKE_RETRY_DELAY:-10}" \
  --retry-all-errors -K "$curl_config" -w '\n%{content_type}' "$URL")"; then
  echo "FAIL: $URL did not answer 200" >&2
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
  and (.registry_fingerprint | type == "string" and test("^[0-9a-f]{12}\\z"))
  and (.spec_version | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?\\z"))
  and (.web_schema_version | type == "string" and test("^[0-9]+\\.[0-9]+\\z"))'

if ! printf '%s' "$body" | "$JQ_BIN" -e "$contract" >/dev/null 2>&1; then
  echo "FAIL: $URL broke the contract: $body" >&2
  exit 1
fi

echo "PASS: $URL $body"
