#!/usr/bin/env bash
# Post-deploy smoke for the live-scoring Worker. Exits 0 when /api/score for
# a curated slug returns the response triad; exits non-zero otherwise.
#
# Invoked from .github/workflows/deploy.yml after a successful wrangler
# deploy, and runnable locally for parity. Exercises the registry-fast-path
# only: gate behaviour and live-sandbox dispatch are covered by unit tests
# and the opt-in homepage-score-live e2e suite. Rationale lives in
# RELEASES-RATIONALE.md § Post-deploy smoke scope.
#
# Usage:
#   scripts/smoke-api-score.sh <base-url>
#
# Environment variables (all optional):
#   CF_ACCESS_CLIENT_ID      Sent as CF-Access-Client-Id when non-empty.
#   CF_ACCESS_CLIENT_SECRET  Sent as CF-Access-Client-Secret when non-empty.
#                            Both come from repo secrets in GH Actions; they
#                            are required for staging (Worker is behind
#                            Cloudflare Access) and unused for production
#                            (anc.dev is public).
#   TURNSTILE_TOKEN          Defaults to "x". The literal "x" succeeds only
#                            against the CF always-passes test secret used
#                            on staging. Production needs a real strategy.
#   SMOKE_SLEEP_SEC          Edge-propagation delay before the POST.
#                            Default 10. Tune up if regional latency starts
#                            producing intermittent 404s.
#   SLUG                     Curated slug to score. Default "ripgrep".
#                            Must be present in registry.yaml.
#
# Exit codes:
#   0  smoke passed
#   1  smoke failed (assertion mismatch or non-200 from /api/score)
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

SLEEP_SEC="${SMOKE_SLEEP_SEC:-10}"
SLUG="${SLUG:-ripgrep}"
TURNSTILE_TOKEN="${TURNSTILE_TOKEN:-x}"

ACCESS_HEADERS=()
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  ACCESS_HEADERS+=(-H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}")
  ACCESS_HEADERS+=(-H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}")
fi

if [ "$SLEEP_SEC" -gt 0 ]; then
  echo "Waiting ${SLEEP_SEC}s for edge propagation..."
  sleep "$SLEEP_SEC"
fi

echo "POST ${BASE_URL}/api/score (slug=${SLUG})"
response="$(curl --silent --show-error --fail-with-body \
  --max-time 30 \
  "${ACCESS_HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"input\":\"${SLUG}\",\"turnstile_token\":\"${TURNSTILE_TOKEN}\"}" \
  "${BASE_URL}/api/score")"

echo "::group::smoke response"
echo "${response}" | "$JQ_BIN" .
echo "::endgroup::"

# Contract: scorecard.kind === "registry_hit" plus four-field response triad.
# Missing any field is a deploy-stop signal.
if ! echo "${response}" | "$JQ_BIN" --exit-status '
    .scorecard.kind == "registry_hit"
    and (.spec_version | type) == "string"
    and (.site_spec_version | type) == "string"
    and (.anc_version | type) == "string"
    and (.auditor_url | type) == "string"
  ' > /dev/null; then
  echo "FATAL: /api/score response missing required fields for ${SLUG}" >&2
  exit 1
fi

echo "[pass] /api/score returned registry_hit with full response triad"
