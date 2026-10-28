#!/usr/bin/env bash
# One idempotent command that sets og:video up for an environment, and checks it.
#
# Usage: scripts/og/setup.sh <staging|production> [--check] [--json]
#   --check  verify only; change nothing
#   --json   print one result object (scripts/og/contract.sh) instead of prose
#
# In order: create the environment's og-rendered queue when it is missing;
# set CONTEXT_DEV_API_KEY on the render Worker from 1Password, piped without
# echoing it; delete the key from the site Worker; then report the switch.
# The render Worker's secret steps need that Worker deployed. Before its first
# deploy they report render-worker-missing and exit non-zero: rerun after the
# deploy. OG_VIDEO_ENABLED's value is not readable, so the check reports
# whether it is set; the switch is on only when it is 'true'.
#
# Needs wrangler logged in with Queues and Workers write, jq, and the
# 1Password skill's read_field.sh (on PATH, or in ~/.claude/skills/1password).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/og/contract.sh
. "$ROOT/scripts/og/contract.sh"
PATH="$PATH:$ROOT/node_modules/.bin"

usage() { sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

ENV_NAME=""
CHECK=0
JSON=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --json) JSON=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    staging | production) ENV_NAME="$arg" ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done
[[ -n "$ENV_NAME" ]] || {
  usage >&2
  exit 2
}

if [[ "$ENV_NAME" == staging ]]; then
  QUEUE=og-rendered-staging RENDER=anc-og-render-staging SITE=agentnative-site-staging
else
  QUEUE=og-rendered RENDER=anc-og-render SITE=agentnative-site
fi
# 1Password item "Context.dev API Key".
KEY_ITEM=p74cl4fnnccvfjegihcctqjbha
READ_FIELD="$(command -v read_field.sh || echo "$HOME/.claude/skills/1password/scripts/read_field.sh")"
SELF="scripts/og/setup.sh $ENV_NAME"
CHANGED=()

value() {
  local changed='[]'
  ((${#CHANGED[@]} > 0)) && changed=$(printf '%s\n' "${CHANGED[@]}" | jq -R . | jq -cs .)
  jq -cn --arg env "$ENV_NAME" --arg queue "$QUEUE" --arg render "$RENDER" --arg site "$SITE" \
    --argjson changed "$changed" '{environment: $env, queue: $queue, render_worker: $render, site_worker: $site, changed: $changed}'
}

finish() {
  local status=0
  og_emit "$JSON" "$1" "$2" "$(value)" "$3" || status=$?
  exit "$status"
}

say() { [[ "$JSON" -eq 1 ]] || printf '%s\n' "$1"; }

queues=$(wrangler queues list 2>/dev/null) \
  || finish wrangler-failed "wrangler could not list queues; check that it is logged in" "bunx wrangler whoami"
if ! grep -Eq "(^|[^a-z0-9-])$QUEUE([^a-z0-9-]|$)" <<<"$queues"; then
  [[ "$CHECK" -eq 0 ]] || finish queue-missing "the $QUEUE queue does not exist" "$SELF"
  wrangler queues create "$QUEUE" >/dev/null
  CHANGED+=("created queue $QUEUE")
  say "created queue $QUEUE"
fi

if ! render_secrets=$(wrangler secret list --name "$RENDER" --format json 2>/dev/null); then
  branch=$(git -C "$ROOT" branch --show-current 2>/dev/null || true)
  finish render-worker-missing \
    "$RENDER is not deployed, so its secret steps are pending; deploy it, then rerun $SELF" \
    "gh workflow run deploy.yml -f ref=${branch:-dev} -f environment=$ENV_NAME"
fi
if ! jq -e 'any(.[]; .name == "CONTEXT_DEV_API_KEY")' <<<"$render_secrets" >/dev/null; then
  [[ "$CHECK" -eq 0 ]] || finish secret-missing "CONTEXT_DEV_API_KEY is not set on $RENDER" "$SELF"
  "$READ_FIELD" "$KEY_ITEM" credential | wrangler secret put CONTEXT_DEV_API_KEY --name "$RENDER" >/dev/null
  CHANGED+=("set CONTEXT_DEV_API_KEY on $RENDER")
  say "set CONTEXT_DEV_API_KEY on $RENDER"
fi

site_secrets=$(wrangler secret list --name "$SITE" --format json 2>/dev/null) \
  || finish wrangler-failed "wrangler could not list the secrets of $SITE" "bunx wrangler whoami"
if jq -e 'any(.[]; .name == "CONTEXT_DEV_API_KEY")' <<<"$site_secrets" >/dev/null; then
  [[ "$CHECK" -eq 0 ]] || finish site-secret-present "$SITE still holds CONTEXT_DEV_API_KEY" "$SELF"
  wrangler secret delete CONTEXT_DEV_API_KEY --name "$SITE" </dev/null >/dev/null
  CHANGED+=("deleted CONTEXT_DEV_API_KEY from $SITE")
  say "deleted CONTEXT_DEV_API_KEY from $SITE"
fi

if ! jq -e 'any(.[]; .name == "OG_VIDEO_ENABLED")' <<<"$site_secrets" >/dev/null; then
  finish switch-off "setup is done; OG_VIDEO_ENABLED is not set on $SITE, so no clip renders" \
    "printf true | bunx wrangler secret put OG_VIDEO_ENABLED --name $SITE"
fi
finish ok "the $QUEUE queue, $RENDER's key and the switch are in place" "$SELF --check"
