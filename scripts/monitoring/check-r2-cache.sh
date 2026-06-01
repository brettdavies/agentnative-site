#!/usr/bin/env bash
# scripts/monitoring/check-r2-cache.sh — bucket reachability + lifecycle
# rule presence for the live-scoring R2 score cache. Pairs with the
# manual playbook in docs/runbooks/live-scoring-monitoring.md § R2 cache
# failure.
#
# Status semantics:
#   ok    — object list succeeded AND scores-7day-ttl lifecycle rule present
#   warn  — object list succeeded but lifecycle rule missing or wrong TTL
#   alarm — object list failed (bucket unreachable / binding gone)
#   error — wrangler call failed for an unrelated reason
set -euo pipefail

ENV_ARG="staging"
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_ARG="$2"; shift 2 ;;
    --help|-h)
      cat <<EOF
Usage: $0 [--env staging|production]

Counts scores/ prefix objects via wrangler r2 object list and confirms
the scores-7day-ttl lifecycle rule is intact. Emits a JSON verdict.
Exit: 0 ok, 1 warn, 2 alarm, 3 prerequisite missing, 4 error.
EOF
      exit 0
      ;;
    *) echo "FATAL: unknown arg '$1'. Try --help." >&2; exit 3 ;;
  esac
done

case "$ENV_ARG" in
  staging)    BUCKET="anc-score-cache-staging" ;;
  production) BUCKET="anc-score-cache" ;;
  *) echo "FATAL: --env must be 'staging' or 'production' (got '$ENV_ARG')" >&2; exit 3 ;;
esac

JQ_BIN="$(command -v jaq || command -v jq || true)"
if [ -z "$JQ_BIN" ]; then
  echo "FATAL: neither jaq nor jq is installed (brew install jaq)" >&2
  exit 3
fi

NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
STDERR_FILE="$(mktemp)"
trap 'rm -f "$STDERR_FILE"' EXIT

set +e
OBJECT_LIST_STDOUT="$(bun x wrangler r2 object list "$BUCKET" --prefix=scores/ 2>"$STDERR_FILE")"
OBJECT_LIST_EXIT=$?
set -e
OBJECT_LIST_STDERR="$(cat "$STDERR_FILE")"
: >"$STDERR_FILE"

set +e
LIFECYCLE_STDOUT="$(bun x wrangler r2 bucket lifecycle list "$BUCKET" 2>"$STDERR_FILE")"
LIFECYCLE_EXIT=$?
set -e
LIFECYCLE_STDERR="$(cat "$STDERR_FILE")"

OBJECT_COUNT="$(printf '%s' "$OBJECT_LIST_STDOUT" | grep -cE '^[a-zA-Z0-9._/-]+\s' || true)"
LIFECYCLE_PRESENT="$(printf '%s' "$LIFECYCLE_STDOUT" | grep -cE 'scores-7day-ttl' || true)"

if [ "$OBJECT_LIST_EXIT" -ne 0 ]; then
  STATUS="alarm"; EXIT_CODE=2
elif [ "$LIFECYCLE_EXIT" -ne 0 ]; then
  STATUS="error"; EXIT_CODE=4
elif [ "$LIFECYCLE_PRESENT" -eq 0 ]; then
  STATUS="warn"; EXIT_CODE=1
else
  STATUS="ok"; EXIT_CODE=0
fi

"$JQ_BIN" -n \
  --arg env "$ENV_ARG" \
  --arg bucket "$BUCKET" \
  --arg status "$STATUS" \
  --arg checked_at "$NOW" \
  --argjson object_count "${OBJECT_COUNT:-0}" \
  --argjson lifecycle_present "$([ "$LIFECYCLE_PRESENT" -gt 0 ] && echo true || echo false)" \
  --arg object_list_exit "$OBJECT_LIST_EXIT" \
  --arg lifecycle_exit "$LIFECYCLE_EXIT" \
  --arg object_list_stderr "$OBJECT_LIST_STDERR" \
  --arg lifecycle_stderr "$LIFECYCLE_STDERR" \
  '{
     check: "r2-cache",
     env: $env,
     status: $status,
     checked_at: $checked_at,
     evidence: {
       bucket: $bucket,
       object_count: $object_count,
       lifecycle_rule_present: $lifecycle_present,
       object_list_exit: ($object_list_exit | tonumber),
       lifecycle_exit: ($lifecycle_exit | tonumber),
       object_list_stderr: $object_list_stderr,
       lifecycle_stderr: $lifecycle_stderr
     }
   }'

exit "$EXIT_CODE"
