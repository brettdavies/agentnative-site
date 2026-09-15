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
DRY_RUN=false
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_ARG="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h)
      cat <<EOF
Usage: $0 [--env staging|production] [--dry-run]

Counts scores/ prefix objects via wrangler r2 object list and confirms
the scores-7day-ttl lifecycle rule is intact. Emits a JSON verdict.
With --dry-run, prints the wrangler commands it would run inside the
JSON envelope under evidence.would_run and exits 0 without calling
wrangler.
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

# Wrangler has no `r2 object list`; it can only get/put/delete one key. The
# bucket's object listing is REST-only, so reachability is probed there while
# the lifecycle rule still comes from wrangler.
OBJECTS_API="accounts/<account>/r2/buckets/$BUCKET/objects?prefix=scores/"
WOULD_RUN_LIST="curl https://api.cloudflare.com/client/v4/$OBJECTS_API"
WOULD_RUN_LIFECYCLE="bun x wrangler r2 bucket lifecycle list $BUCKET"

if [ "$DRY_RUN" = true ]; then
  "$JQ_BIN" -n \
    --arg env "$ENV_ARG" \
    --arg bucket "$BUCKET" \
    --arg checked_at "$NOW" \
    --arg cmd_list "$WOULD_RUN_LIST" \
    --arg cmd_lifecycle "$WOULD_RUN_LIFECYCLE" \
    '{
       check: "r2-cache",
       env: $env,
       status: "dry-run",
       checked_at: $checked_at,
       evidence: { bucket: $bucket, would_run: [$cmd_list, $cmd_lifecycle] }
     }'
  exit 0
fi

STDERR_FILE="$(mktemp)"
trap 'rm -f "$STDERR_FILE"' EXIT

# The account id is deliberately absent from the repo, the same way
# wrangler.jsonc leaves it out; take it from the environment, else from the
# authenticated wrangler session.
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
if [ -z "$ACCOUNT_ID" ]; then
  ACCOUNT_ID="$(bun x wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1 || true)"
fi
if [ -z "$ACCOUNT_ID" ] || [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "FATAL: need CLOUDFLARE_API_TOKEN, and CLOUDFLARE_ACCOUNT_ID or an authenticated wrangler" >&2
  exit 3
fi

set +e
OBJECT_LIST_STDOUT="$(curl -sS --fail-with-body -m 30 \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/r2/buckets/$BUCKET/objects?prefix=scores/&per_page=1000" \
  2>"$STDERR_FILE")"
OBJECT_LIST_EXIT=$?
set -e
OBJECT_LIST_STDERR="$(cat "$STDERR_FILE")"
: >"$STDERR_FILE"

# A 200 carrying `success: false` is still a failed listing.
if [ "$OBJECT_LIST_EXIT" -eq 0 ]; then
  if [ "$(printf '%s' "$OBJECT_LIST_STDOUT" | "$JQ_BIN" -r '.success' 2>/dev/null)" != "true" ]; then
    OBJECT_LIST_EXIT=1
    OBJECT_LIST_STDERR="$(printf '%s' "$OBJECT_LIST_STDOUT" | "$JQ_BIN" -r '[.errors[]?.message] | join("; ")' 2>/dev/null)"
  fi
fi

set +e
LIFECYCLE_STDOUT="$(bun x wrangler r2 bucket lifecycle list "$BUCKET" 2>"$STDERR_FILE")"
LIFECYCLE_EXIT=$?
set -e
LIFECYCLE_STDERR="$(cat "$STDERR_FILE")"

OBJECT_COUNT="$(printf '%s' "$OBJECT_LIST_STDOUT" | "$JQ_BIN" -r '.result | length' 2>/dev/null || echo 0)"
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
