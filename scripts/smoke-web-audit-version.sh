#!/usr/bin/env bash
# Post-deploy smoke for the web-audit version signal. Exits 0 when
# GET /api/web-audit/version answers 200 with one JSON document holding its four
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
#                            answers 404 or 200 with its own body. Default 12
#                            when an expected fingerprint is set: two minutes at
#                            the default delay, and 4 minutes 10 seconds if every
#                            attempt times out, which leaves room in both deploy
#                            jobs' timeouts.
#   SMOKE_RETRY_DELAY        Seconds between attempts. Default 10.
#   SMOKE_EXPECT_CONTRACT_FINGERPRINT
#                            The deployed tree's build/FINGERPRINT, trimmed. The
#                            check then also requires exactly this value. On a
#                            deploy that moves the value, an isolate still on the
#                            previous deploy cannot pass. A deploy that leaves
#                            the value alone can pass on such an isolate's
#                            identical answer. Empty compares nothing.
#
# Credentials go only to the deployed origins named in scripts/release/release.env,
# or to localhost; any other target with credentials set exits 2 before a request
# is sent.
#
# Exit codes:
#   0  smoke passed
#   1  smoke failed (no 200, not JSON, the body breaks the contract, or the
#      expected fingerprint never arrived)
#   2  prerequisite missing or unsafe (no or malformed base URL, no curl or jq,
#      one Access variable without the other, credentials for an unknown target,
#      a malformed expected fingerprint)

set -euo pipefail
{ set +x; } 2>/dev/null

# Captured and unset before the first child starts, so no child's environment
# holds them.
access_id="${CF_ACCESS_CLIENT_ID:-}"
access_secret="${CF_ACCESS_CLIENT_SECRET:-}"
unset CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET

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

EXPECTED="${SMOKE_EXPECT_CONTRACT_FINGERPRINT:-}"
if [ -n "$EXPECTED" ] && ! [[ "$EXPECTED" =~ ^[0-9a-f]{12}$ ]]; then
  echo "FATAL: SMOKE_EXPECT_CONTRACT_FINGERPRINT must be 12 lowercase hex characters, got: $EXPECTED" >&2
  exit 2
fi

default_retries=5
[ -z "$EXPECTED" ] || default_retries=12
retries="${SMOKE_RETRIES:-$default_retries}"
for setting in "SMOKE_RETRIES=$retries" "SMOKE_RETRY_DELAY=${SMOKE_RETRY_DELAY:-10}"; do
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

if { [ -n "$access_id" ] && [ -z "$access_secret" ]; } ||
  { [ -z "$access_id" ] && [ -n "$access_secret" ]; }; then
  echo "FATAL: set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither." >&2
  exit 2
fi
if [ -n "$access_id" ] && ! may_receive_credentials; then
  echo "FATAL: refusing to send Access credentials to $BASE_URL. Unset CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to check it without them." >&2
  exit 2
fi

# curl's config format reads these inside quotes, where a quote or backslash
# changes the value and a line break starts a new directive, which could name
# another URL and step around the check above.
case "$access_id$access_secret" in
  *[$'\n\r"\\']*)
    echo "FATAL: CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must not hold a quote, backslash, or line break." >&2
    exit 2
    ;;
esac

URL="${BASE_URL%/}/api/web-audit/version"

# A process substitution keeps the headers off curl's command line and off disk:
# no trap can remove a config file after a SIGKILL, or reliably after the SIGHUP
# a closing terminal sends. It can be read only once, so each attempt builds its own.
access_headers=""
if [ -n "$access_id" ]; then
  printf -v access_headers 'header = "CF-Access-Client-Id: %s"\nheader = "CF-Access-Client-Secret: %s"\n' \
    "$access_id" "$access_secret"
fi
unset access_id access_secret

# shellcheck disable=SC2016 # the filter is jq, not shell
contract='(.registry_fingerprint | type == "string" and test("^[0-9a-f]{12}\\z"))
  and (.contract_fingerprint | type == "string" and test("^[0-9a-f]{12}\\z"))
  and (.spec_version | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?\\z"))
  and (.web_schema_version | type == "string" and test("^[0-9]+\\.[0-9]+\\z"))'

# Stdout alone from curl: a failed attempt's message on stderr must not read as
# part of the body. -q comes first so a caller's .curlrc cannot turn on verbose
# output and print the headers, and --noproxy keeps a local proxy from seeing
# credentials sent to localhost in the clear.
access_hint='On staging, a redirect or refusal usually means missing or stale Access credentials.'

check_once() {
  local response trailer status content_type served
  if ! response="$(curl -q -fsS -m 10 --noproxy localhost,127.0.0.1 -K <(printf '%s' "$access_headers") \
    -w '\n%{http_code} %{content_type}' "$URL")"; then
    # curl -f still writes the trailer on an HTTP error, so the status is known.
    status="${response##*$'\n'}"
    status="${status%% *}"
    case "$status" in
      000 | '') failure="$URL did not answer 200: no HTTP answer" ;;
      2??) failure="$URL answered HTTP $status but the transfer failed" ;;
      401 | 403) failure="$URL did not answer 200: HTTP $status. $access_hint" ;;
      *) failure="$URL did not answer 200: HTTP $status" ;;
    esac
    return 1
  fi
  trailer="${response##*$'\n'}"
  body="${response%$'\n'*}"
  status="${trailer%% *}"
  content_type="${trailer#* }"

  # curl -f lets 2xx and 3xx through, and Access answers a stale token with a 302.
  if [ "$status" != 200 ]; then
    failure="$URL answered HTTP $status, expected 200. $access_hint"
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
  if [ -n "$EXPECTED" ]; then
    served="$(printf '%s' "$body" | "$JQ_BIN" -r .contract_fingerprint)"
    if [ "$served" != "$EXPECTED" ]; then
      failure="$URL serves contract_fingerprint $served"
      return 1
    fi
  fi
}

retries_left="$retries"
until check_once; do
  if [ "$retries_left" -le 0 ]; then
    echo "FAIL: $failure${EXPECTED:+ (expected contract_fingerprint $EXPECTED)}" >&2
    exit 1
  fi
  retries_left=$((retries_left - 1))
  sleep "${SMOKE_RETRY_DELAY:-10}"
done

echo "PASS: $URL $body${EXPECTED:+ (contract_fingerprint compared)}"
