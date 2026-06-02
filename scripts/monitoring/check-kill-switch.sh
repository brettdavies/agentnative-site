#!/usr/bin/env bash
# scripts/monitoring/check-kill-switch.sh — JSON wrapper for the SCORE_KV
# scoring_disabled flag. Pairs with the manual playbook in
# docs/runbooks/live-scoring-monitoring.md § Kill-switch flip.
#
# Status semantics:
#   ok    — kill switch absent or "false" (live scoring serving)
#   warn  — kill switch present and "true" (intentional during incident,
#           surprising otherwise; raises noise so cron / agents notice)
#   error — wrangler call failed (no verdict possible)
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

Reads SCORE_KV.scoring_disabled via wrangler and emits a JSON verdict.
With --dry-run, prints the wrangler command it would run inside the
JSON envelope under evidence.would_run and exits 0 without calling
wrangler.
Exit: 0 ok, 1 warn, 3 prerequisite missing, 4 wrangler error.
EOF
      exit 0
      ;;
    *) echo "FATAL: unknown arg '$1'. Try --help." >&2; exit 3 ;;
  esac
done

case "$ENV_ARG" in
  staging|production) ;;
  *) echo "FATAL: --env must be 'staging' or 'production' (got '$ENV_ARG')" >&2; exit 3 ;;
esac

JQ_BIN="$(command -v jaq || command -v jq || true)"
if [ -z "$JQ_BIN" ]; then
  echo "FATAL: neither jaq nor jq is installed (brew install jaq)" >&2
  exit 3
fi

WRANGLER_ENV_FLAG=()
[ "$ENV_ARG" = "staging" ] && WRANGLER_ENV_FLAG=(--env staging)

NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

WOULD_RUN="bun x wrangler kv key get --binding=SCORE_KV${WRANGLER_ENV_FLAG[*]:+ ${WRANGLER_ENV_FLAG[*]}} scoring_disabled"

if [ "$DRY_RUN" = true ]; then
  "$JQ_BIN" -n \
    --arg env "$ENV_ARG" \
    --arg checked_at "$NOW" \
    --arg would_run "$WOULD_RUN" \
    '{
       check: "kill-switch",
       env: $env,
       status: "dry-run",
       checked_at: $checked_at,
       evidence: { would_run: [$would_run] }
     }'
  exit 0
fi

STDERR_FILE="$(mktemp)"
trap 'rm -f "$STDERR_FILE"' EXIT

set +e
WRANGLER_STDOUT="$(bun x wrangler kv key get --binding=SCORE_KV "${WRANGLER_ENV_FLAG[@]}" scoring_disabled 2>"$STDERR_FILE")"
WRANGLER_EXIT=$?
set -e
WRANGLER_STDERR="$(cat "$STDERR_FILE")"
VALUE="$(printf '%s' "$WRANGLER_STDOUT" | tr -d '\n')"

if [ "$WRANGLER_EXIT" -eq 0 ]; then
  case "$VALUE" in
    true|1)     STATUS="warn";  DISABLED="true";    EXIT_CODE=1 ;;
    ""|false|0) STATUS="ok";    DISABLED="false";   EXIT_CODE=0 ;;
    *)          STATUS="warn";  DISABLED="unknown"; EXIT_CODE=1 ;;
  esac
elif printf '%s' "$WRANGLER_STDERR" | grep -qiE "not found|does not exist|key.*does.*not"; then
  STATUS="ok"; DISABLED="false"; EXIT_CODE=0
else
  STATUS="error"; DISABLED="unknown"; EXIT_CODE=4
fi

"$JQ_BIN" -n \
  --arg env "$ENV_ARG" \
  --arg status "$STATUS" \
  --arg checked_at "$NOW" \
  --arg scoring_disabled "$DISABLED" \
  --arg raw_value "$VALUE" \
  --arg wrangler_exit "$WRANGLER_EXIT" \
  --arg wrangler_stderr "$WRANGLER_STDERR" \
  '{
     check: "kill-switch",
     env: $env,
     status: $status,
     checked_at: $checked_at,
     evidence: {
       scoring_disabled: $scoring_disabled,
       raw_value: $raw_value,
       wrangler_exit: ($wrangler_exit | tonumber),
       wrangler_stderr: $wrangler_stderr
     }
   }'

exit "$EXIT_CODE"
