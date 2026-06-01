#!/usr/bin/env bash
# scripts/monitoring/check-recent-deploys.sh — last 5 Worker deploys via
# wrangler deployments list. Pure data surface (no threshold); useful
# from the operator playbook in docs/runbooks/live-scoring-monitoring.md
# § Sandbox crash or cold-start timeout for the "did a recent deploy
# coincide with the spike?" question.
#
# Status semantics:
#   ok    — wrangler returned a deploy list (even if empty)
#   error — wrangler call failed
set -euo pipefail

ENV_ARG="staging"
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_ARG="$2"; shift 2 ;;
    --help|-h)
      cat <<EOF
Usage: $0 [--env staging|production]

Lists the last 5 Worker deploys via wrangler and emits them as JSON.
Exit: 0 ok, 3 prereq missing, 4 wrangler error.
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
STDERR_FILE="$(mktemp)"
trap 'rm -f "$STDERR_FILE"' EXIT

set +e
WRANGLER_STDOUT="$(bun x wrangler deployments list "${WRANGLER_ENV_FLAG[@]}" 2>"$STDERR_FILE")"
WRANGLER_EXIT=$?
set -e
WRANGLER_STDERR="$(cat "$STDERR_FILE")"

if [ "$WRANGLER_EXIT" -ne 0 ]; then
  "$JQ_BIN" -n \
    --arg env "$ENV_ARG" \
    --arg checked_at "$NOW" \
    --arg wrangler_stderr "$WRANGLER_STDERR" \
    '{
       check: "recent-deploys",
       env: $env,
       status: "error",
       checked_at: $checked_at,
       evidence: { wrangler_stderr: $wrangler_stderr }
     }'
  exit 4
fi

# wrangler deployments list emits a free-form text block per deploy
# separated by blank lines. Each block contains "Deployment ID:",
# "Created on:", "Author:", and "Source:" lines. Parse the first 5.
DEPLOYS_JSON="$(printf '%s\n' "$WRANGLER_STDOUT" \
  | awk '
    BEGIN { RS=""; n=0 }
    {
      id=""; created=""; author=""; source=""
      split($0, lines, "\n")
      for (i in lines) {
        line=lines[i]
        if (match(line, /Deployment ID:[[:space:]]*(.*)/, m)) id=m[1]
        else if (match(line, /Created on:[[:space:]]*(.*)/, m)) created=m[1]
        else if (match(line, /Author:[[:space:]]*(.*)/, m)) author=m[1]
        else if (match(line, /Source:[[:space:]]*(.*)/, m)) source=m[1]
      }
      if (id != "" && n < 5) {
        gsub(/"/, "\\\"", id); gsub(/"/, "\\\"", created)
        gsub(/"/, "\\\"", author); gsub(/"/, "\\\"", source)
        printf "%s{\"id\":\"%s\",\"created_on\":\"%s\",\"author\":\"%s\",\"source\":\"%s\"}", (n>0?",":""), id, created, author, source
        n++
      }
    }
    END { printf "\n" }
  ')"

"$JQ_BIN" -n \
  --arg env "$ENV_ARG" \
  --arg checked_at "$NOW" \
  --argjson deployments "[${DEPLOYS_JSON}]" \
  '{
     check: "recent-deploys",
     env: $env,
     status: "ok",
     checked_at: $checked_at,
     evidence: { deployments: $deployments }
   }'

exit 0
