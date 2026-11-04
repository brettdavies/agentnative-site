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
# Credentials go only to anc.dev or *.workers.dev over https, or to localhost;
# any other target with credentials set exits 2 before a request is sent.
#
# Exit codes:
#   0  smoke passed
#   1  smoke failed (no 200, not JSON, or the body breaks the contract)
#   2  prerequisite missing or unsafe (no or malformed base URL, no curl or jq,
#      one Access variable without the other, credentials for an unknown target)

set -euo pipefail

BASE_URL="${1:-}"
if [ -z "$BASE_URL" ]; then
  echo "FATAL: missing base URL. Usage: $0 <base-url>" >&2
  exit 2
fi

case "$BASE_URL" in
  http://* | https://*) ;;
  *)
    echo "FATAL: base URL must be a full http(s) origin, got: $BASE_URL" >&2
    exit 2
    ;;
esac

if ! command -v curl >/dev/null; then
  echo "FATAL: curl is not installed." >&2
  exit 2
fi

JQ_BIN="$(command -v jaq || command -v jq || true)"
if [ -z "$JQ_BIN" ]; then
  echo "FATAL: neither jaq nor jq is installed. Install one (brew install jaq) and retry." >&2
  exit 2
fi

# The whole authority has to parse before its host is trusted: a naive split reads
# https://anc.dev:pw@evil.example as anc.dev, and curl would send it to evil.example.
may_receive_credentials() {
  local scheme="${BASE_URL%%://*}" authority="${BASE_URL#*://}" host
  authority="${authority%%[/?#]*}"
  [[ "$authority" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || return 1
  host="${authority%%:*}"
  case "$host" in
    localhost | 127.0.0.1) return 0 ;;
    anc.dev | *.workers.dev) [ "$scheme" = https ] ;;
    *) return 1 ;;
  esac
}

if { [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -z "${CF_ACCESS_CLIENT_SECRET:-}" ]; } ||
  { [ -z "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; }; then
  echo "FATAL: set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither." >&2
  exit 2
fi
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && ! may_receive_credentials; then
  echo "FATAL: refusing to send Access credentials to $BASE_URL. Unset CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to check it without them." >&2
  exit 2
fi

URL="${BASE_URL%/}/api/web-audit/version"

# A mode-600 config keeps the secret off curl's command line.
curl_config="$(mktemp)"
chmod 600 "$curl_config"
trap 'rm -f "$curl_config"' EXIT
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ]; then
  printf 'header = "CF-Access-Client-Id: %s"\n' "$CF_ACCESS_CLIENT_ID" >>"$curl_config"
  printf 'header = "CF-Access-Client-Secret: %s"\n' "$CF_ACCESS_CLIENT_SECRET" >>"$curl_config"
fi

# Stdout alone: curl reports each failed attempt on stderr, and a retry that
# later succeeds must not read as part of the body. -q comes first so a caller's
# .curlrc cannot turn on verbose output and print the headers.
if ! response="$(curl -q -fsS -m 10 --retry "${SMOKE_RETRIES:-5}" --retry-delay "${SMOKE_RETRY_DELAY:-10}" \
  --retry-all-errors -K "$curl_config" -w '\n%{http_code} %{content_type}' "$URL")"; then
  echo "FAIL: $URL did not answer 200" >&2
  exit 1
fi
trailer="${response##*$'\n'}"
body="${response%$'\n'*}"
status="${trailer%% *}"
content_type="${trailer#* }"

# curl -f lets 2xx and 3xx through, and Access answers a stale token with a 302.
if [ "$status" != 200 ]; then
  echo "FAIL: $URL answered HTTP $status, expected 200. On staging, a redirect usually means missing or stale Access credentials." >&2
  exit 1
fi

case "$content_type" in
  application/json | "application/json;"*) ;;
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

if ! printf '%s' "$body" | "$JQ_BIN" -se "length == 1 and (.[0] | $contract)" >/dev/null 2>&1; then
  echo "FAIL: $URL broke the contract: $body" >&2
  exit 1
fi

echo "PASS: $URL $body"
