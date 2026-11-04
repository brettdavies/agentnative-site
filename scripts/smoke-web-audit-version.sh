#!/usr/bin/env bash
# Post-deploy smoke for the web-audit version signal. Exits 0 when
# GET /api/web-audit/version answers 200 with one JSON document holding its three
# fields, each in its expected shape; exits non-zero otherwise. An additional
# field passes, so adding one does not need this script to change first.
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
#   SMOKE_RETRIES            Attempts after the first, each repeating the whole
#                            check. Default 5, so an isolate still running the
#                            previous deploy inside the propagation window
#                            cannot fail the deploy on its own, whether it
#                            answers 404 or 200 with its own body.
#   SMOKE_RETRY_DELAY        Seconds between attempts. Default 10.
#
# Credentials go only to the deployed origins named in scripts/release/release.env,
# or to localhost; any other target with credentials set exits 2 before a request
# is sent.
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

# The whole authority has to parse: a naive split reads
# https://anc.dev:pw@evil.example as anc.dev, and curl would send it to evil.example.
authority="${BASE_URL#*://}"
authority="${authority%%[/?#]*}"
case "$BASE_URL" in
  *[?#]*) authority="" ;;
  http://* | https://*) ;;
  *) authority="" ;;
esac
if ! [[ "$authority" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]+)?$ ]]; then
  echo "FATAL: base URL must be a full http(s) origin, got: $BASE_URL" >&2
  exit 2
fi

for setting in "SMOKE_RETRIES=${SMOKE_RETRIES:-5}" "SMOKE_RETRY_DELAY=${SMOKE_RETRY_DELAY:-10}"; do
  if ! [[ "${setting#*=}" =~ ^(0|[1-9][0-9]*)$ ]]; then
    echo "FATAL: ${setting%%=*} must be a whole number, got: ${setting#*=}" >&2
    exit 2
  fi
done

if ! command -v curl >/dev/null; then
  echo "FATAL: curl is not installed." >&2
  exit 2
fi

JQ_BIN="$(command -v jaq || command -v jq || true)"
if [ -z "$JQ_BIN" ]; then
  echo "FATAL: neither jaq nor jq is installed. Install one (brew install jaq) and retry." >&2
  exit 2
fi

# Read only when credentials are set, so a check without them needs nothing else.
may_receive_credentials() {
  case "${authority%%:*}" in
    localhost | 127.0.0.1) return 0 ;;
  esac
  # shellcheck source=scripts/release/release.env
  . "$(dirname "$0")/release/release.env"
  local origin="${BASE_URL%%://*}://$authority"
  [ "$origin" = "${STAGING_URL_DEFAULT:-}" ] || [ "$origin" = "${PROD_URL_DEFAULT:-}" ]
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

# curl's config format reads these inside quotes, where a quote or backslash
# changes the value and a line break starts a new directive, which could name
# another URL and step around the check above.
case "${CF_ACCESS_CLIENT_ID:-}${CF_ACCESS_CLIENT_SECRET:-}" in
  *[$'\n\r"\\']*)
    echo "FATAL: CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must not hold a quote, backslash, or line break." >&2
    exit 2
    ;;
esac

URL="${BASE_URL%/}/api/web-audit/version"

# A mode-600 config keeps the secret off curl's command line.
curl_config="$(mktemp)"
chmod 600 "$curl_config"
trap 'rm -f "$curl_config"' EXIT
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ]; then
  printf 'header = "CF-Access-Client-Id: %s"\n' "$CF_ACCESS_CLIENT_ID" >>"$curl_config"
  printf 'header = "CF-Access-Client-Secret: %s"\n' "$CF_ACCESS_CLIENT_SECRET" >>"$curl_config"
fi

# shellcheck disable=SC2016 # the filter is jq, not shell
contract='(.registry_fingerprint | type == "string" and test("^[0-9a-f]{12}\\z"))
  and (.spec_version | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?\\z"))
  and (.web_schema_version | type == "string" and test("^[0-9]+\\.[0-9]+\\z"))'

# Stdout alone from curl: a failed attempt's message on stderr must not read as
# part of the body. -q comes first so a caller's .curlrc cannot turn on verbose
# output and print the headers, and --noproxy keeps a local proxy from seeing
# credentials sent to localhost in the clear.
check_once() {
  local response trailer status content_type
  if ! response="$(curl -q -fsS -m 10 --noproxy localhost,127.0.0.1 -K "$curl_config" \
    -w '\n%{http_code} %{content_type}' "$URL")"; then
    failure="$URL did not answer 200"
    return 1
  fi
  trailer="${response##*$'\n'}"
  body="${response%$'\n'*}"
  status="${trailer%% *}"
  content_type="${trailer#* }"

  # curl -f lets 2xx and 3xx through, and Access answers a stale token with a 302.
  if [ "$status" != 200 ]; then
    failure="$URL answered HTTP $status, expected 200. On staging, a redirect usually means missing or stale Access credentials."
    return 1
  fi
  case "$content_type" in
    application/json | "application/json;"*) ;;
    *)
      failure="$URL answered Content-Type '$content_type', expected application/json"
      return 1
      ;;
  esac
  if ! printf '%s' "$body" | "$JQ_BIN" -se "length == 1 and (.[0] | $contract)" >/dev/null 2>&1; then
    failure="$URL broke the contract: $body"
    return 1
  fi
}

retries_left="${SMOKE_RETRIES:-5}"
until check_once; do
  if [ "$retries_left" -le 0 ]; then
    echo "FAIL: $failure" >&2
    exit 1
  fi
  retries_left=$((retries_left - 1))
  sleep "${SMOKE_RETRY_DELAY:-10}"
done

echo "PASS: $URL $body"
