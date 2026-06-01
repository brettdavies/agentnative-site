#!/usr/bin/env bash
# scripts/ops/flip-kill-switch.sh — flip the SCORE_KV.scoring_disabled
# kill switch. Write counterpart to scripts/monitoring/check-kill-switch.sh.
# Pairs with the operator playbook in
# docs/runbooks/live-scoring-monitoring.md § Kill-switch flip.
#
# Status semantics:
#   ok      — wrangler write succeeded
#   dry-run — --dry-run was passed; prints would_run, no write
#   error   — wrangler call failed
#
# Production flips (either direction) require --yes to guard against typos
# that would turn /api/score into a 503 (--on) or restore traffic before
# the incident is resolved (--off). Staging flips both directions are
# free; staging exists to be flipped.
set -euo pipefail

ENV_ARG="staging"
ACTION=""
DRY_RUN=false
YES=false

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_ARG="$2"; shift 2 ;;
    --on) ACTION="on"; shift ;;
    --off) ACTION="off"; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --yes) YES=true; shift ;;
    --help|-h)
      cat <<EOF
Usage: $0 --on|--off [--env staging|production] [--dry-run] [--yes]

Flips SCORE_KV.scoring_disabled via wrangler.
  --on   sets scoring_disabled=true  (kill switch ON; /api/score live path returns 503)
  --off  deletes the key            (kill switch OFF; live path serves)

--env defaults to staging. Production flips (either direction) require
--yes. --dry-run prints the wrangler command it would run inside the
JSON envelope under evidence.would_run and exits 0 without calling
wrangler.

Exit: 0 ok / dry-run, 3 prerequisite missing, 4 wrangler error.
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

case "$ACTION" in
  on|off) ;;
  "") echo "FATAL: --on or --off is required. Try --help." >&2; exit 3 ;;
esac

if [ "$ENV_ARG" = "production" ] && [ "$YES" = false ] && [ "$DRY_RUN" = false ]; then
  echo "FATAL: production flips require --yes. Re-run with --yes (or --dry-run to preview)." >&2
  exit 3
fi

JQ_BIN="$(command -v jaq || command -v jq || true)"
if [ -z "$JQ_BIN" ]; then
  echo "FATAL: neither jaq nor jq is installed (brew install jaq)" >&2
  exit 3
fi

WRANGLER_ENV_FLAG=()
[ "$ENV_ARG" = "staging" ] && WRANGLER_ENV_FLAG=(--env staging)

NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

if [ "$ACTION" = "on" ]; then
  WOULD_RUN="bun x wrangler kv key put --binding=SCORE_KV${WRANGLER_ENV_FLAG[*]:+ ${WRANGLER_ENV_FLAG[*]}} scoring_disabled true"
else
  WOULD_RUN="bun x wrangler kv key delete --binding=SCORE_KV${WRANGLER_ENV_FLAG[*]:+ ${WRANGLER_ENV_FLAG[*]}} scoring_disabled"
fi

if [ "$DRY_RUN" = true ]; then
  "$JQ_BIN" -n \
    --arg env "$ENV_ARG" \
    --arg action "$ACTION" \
    --arg checked_at "$NOW" \
    --arg would_run "$WOULD_RUN" \
    '{
       check: "flip-kill-switch",
       env: $env,
       status: "dry-run",
       checked_at: $checked_at,
       evidence: { action: $action, would_run: [$would_run] }
     }'
  exit 0
fi

STDERR_FILE="$(mktemp)"
trap 'rm -f "$STDERR_FILE"' EXIT

set +e
if [ "$ACTION" = "on" ]; then
  WRANGLER_STDOUT="$(bun x wrangler kv key put --binding=SCORE_KV "${WRANGLER_ENV_FLAG[@]}" scoring_disabled true 2>"$STDERR_FILE")"
else
  WRANGLER_STDOUT="$(bun x wrangler kv key delete --binding=SCORE_KV "${WRANGLER_ENV_FLAG[@]}" scoring_disabled 2>"$STDERR_FILE")"
fi
WRANGLER_EXIT=$?
set -e
WRANGLER_STDERR="$(cat "$STDERR_FILE")"

if [ "$WRANGLER_EXIT" -eq 0 ]; then
  STATUS="ok"; EXIT_CODE=0
else
  STATUS="error"; EXIT_CODE=4
fi

"$JQ_BIN" -n \
  --arg env "$ENV_ARG" \
  --arg action "$ACTION" \
  --arg status "$STATUS" \
  --arg checked_at "$NOW" \
  --arg would_run "$WOULD_RUN" \
  --arg wrangler_stdout "$WRANGLER_STDOUT" \
  --arg wrangler_stderr "$WRANGLER_STDERR" \
  --arg wrangler_exit "$WRANGLER_EXIT" \
  '{
     check: "flip-kill-switch",
     env: $env,
     status: $status,
     checked_at: $checked_at,
     evidence: {
       action: $action,
       would_run: [$would_run],
       wrangler_exit: ($wrangler_exit | tonumber),
       wrangler_stdout: $wrangler_stdout,
       wrangler_stderr: $wrangler_stderr
     }
   }'

exit "$EXIT_CODE"
