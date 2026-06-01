#!/usr/bin/env bash
# scripts/monitoring/check-error-tier-sample.sh — recent error-code
# distribution via the Workers Analytics Engine SQL API. Mirrors the
# canonical "Error code distribution" query in
# docs/runbooks/live-scoring-analytics.md and the threshold semantics in
# docs/runbooks/live-scoring-monitoring.md § Error rate by code.
#
# Status semantics:
#   alarm — service_misconfigured OR incomplete_response_contract present
#           (per the runbook: any occurrence is operator-actionable)
#   warn  — total error count above WARN_THRESHOLD in the window
#   ok    — no signal-bearing codes and total below threshold
#   error — AE SQL call failed (no verdict possible)
#
# Requires CF_ACCOUNT_ID and CF_API_TOKEN environment variables.
# The API token needs the "Account Analytics:Read" permission.
set -euo pipefail

ENV_ARG="staging"
WINDOW_HOURS="1"
WARN_THRESHOLD="${WARN_THRESHOLD:-50}"

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_ARG="$2"; shift 2 ;;
    --window-hours) WINDOW_HOURS="$2"; shift 2 ;;
    --warn-threshold) WARN_THRESHOLD="$2"; shift 2 ;;
    --help|-h)
      cat <<EOF
Usage: $0 [--env staging|production] [--window-hours N] [--warn-threshold N]

Queries the SCORE_TELEMETRY Analytics Engine dataset for error-code
counts over the last N hours (default 1) and emits a JSON verdict.

Requires CF_ACCOUNT_ID and CF_API_TOKEN env vars. The token needs
"Account Analytics:Read".

Exit: 0 ok, 1 warn, 2 alarm, 3 prerequisite missing, 4 AE error.
EOF
      exit 0
      ;;
    *) echo "FATAL: unknown arg '$1'. Try --help." >&2; exit 3 ;;
  esac
done

case "$ENV_ARG" in
  staging)    DATASET="anc_live_score_staging" ;;
  production) DATASET="anc_live_score_prod" ;;
  *) echo "FATAL: --env must be 'staging' or 'production' (got '$ENV_ARG')" >&2; exit 3 ;;
esac

if ! [[ "$WINDOW_HOURS" =~ ^[0-9]+$ ]] || [ "$WINDOW_HOURS" -lt 1 ]; then
  echo "FATAL: --window-hours must be a positive integer (got '$WINDOW_HOURS')" >&2
  exit 3
fi

if ! [[ "$WARN_THRESHOLD" =~ ^[0-9]+$ ]]; then
  echo "FATAL: --warn-threshold must be a non-negative integer (got '$WARN_THRESHOLD')" >&2
  exit 3
fi

JQ_BIN="$(command -v jaq || command -v jq || true)"
if [ -z "$JQ_BIN" ]; then
  echo "FATAL: neither jaq nor jq is installed (brew install jaq)" >&2
  exit 3
fi

if [ -z "${CF_ACCOUNT_ID:-}" ] || [ -z "${CF_API_TOKEN:-}" ]; then
  echo "FATAL: CF_ACCOUNT_ID and CF_API_TOKEN must be set." >&2
  echo "Pull from 1Password; see docs/runbooks/live-scoring-analytics.md." >&2
  exit 3
fi

NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

read -r -d '' SQL <<EOF || true
SELECT
  blob3 AS error_code,
  COUNT() AS hits,
  AVG(double4) AS avg_status
FROM ${DATASET}
WHERE timestamp > NOW() - INTERVAL '${WINDOW_HOURS}' HOUR
  AND blob3 IS NOT NULL
GROUP BY error_code
ORDER BY hits DESC
FORMAT JSONCompact
EOF

STDERR_FILE="$(mktemp)"
trap 'rm -f "$STDERR_FILE"' EXIT

set +e
RESPONSE="$(curl --silent --show-error --fail-with-body --max-time 30 \
  -X POST \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: text/plain" \
  --data-binary "$SQL" \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql" \
  2>"$STDERR_FILE")"
CURL_EXIT=$?
set -e
CURL_STDERR="$(cat "$STDERR_FILE")"

if [ "$CURL_EXIT" -ne 0 ]; then
  "$JQ_BIN" -n \
    --arg env "$ENV_ARG" \
    --arg dataset "$DATASET" \
    --arg checked_at "$NOW" \
    --arg curl_stderr "$CURL_STDERR" \
    --arg response "$RESPONSE" \
    '{
       check: "error-tier-sample",
       env: $env,
       status: "error",
       checked_at: $checked_at,
       evidence: { dataset: $dataset, curl_stderr: $curl_stderr, response: $response }
     }'
  exit 4
fi

# AE SQL JSONCompact response: { "meta": [...], "data": [[code, hits, avg_status], ...], "rows": N, ... }
# Flatten data rows into objects.
ROWS_JSON="$(printf '%s' "$RESPONSE" \
  | "$JQ_BIN" -c '
      if has("data") then
        [.data[] | { error_code: .[0], hits: .[1], avg_status: .[2] }]
      else
        []
      end
    ' 2>/dev/null || echo '[]')"

TOTAL_HITS="$(printf '%s' "$ROWS_JSON" | "$JQ_BIN" '[.[].hits] | add // 0')"
SIGNAL_BEARING_PRESENT="$(printf '%s' "$ROWS_JSON" \
  | "$JQ_BIN" '[.[] | select(.error_code == "service_misconfigured" or .error_code == "incomplete_response_contract")] | length')"

if [ "${SIGNAL_BEARING_PRESENT:-0}" -gt 0 ]; then
  STATUS="alarm"; EXIT_CODE=2
elif [ "${TOTAL_HITS:-0}" -gt "$WARN_THRESHOLD" ]; then
  STATUS="warn"; EXIT_CODE=1
else
  STATUS="ok"; EXIT_CODE=0
fi

"$JQ_BIN" -n \
  --arg env "$ENV_ARG" \
  --arg dataset "$DATASET" \
  --arg status "$STATUS" \
  --arg checked_at "$NOW" \
  --argjson window_hours "$WINDOW_HOURS" \
  --argjson warn_threshold "$WARN_THRESHOLD" \
  --argjson total_hits "${TOTAL_HITS:-0}" \
  --argjson error_codes "$ROWS_JSON" \
  '{
     check: "error-tier-sample",
     env: $env,
     status: $status,
     checked_at: $checked_at,
     evidence: {
       dataset: $dataset,
       window_hours: $window_hours,
       warn_threshold: $warn_threshold,
       total_hits: $total_hits,
       error_codes: $error_codes
     }
   }'

exit "$EXIT_CODE"
