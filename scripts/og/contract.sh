# shellcheck shell=bash
# The og:video scripts' result contract, sourced by setup.sh and status.sh.
# Prose by default; with --json, one object:
#   {reason, exit_code, message, value, next_step: {action, command, docs}}
# `reason` comes from the closed set below, each failure class exits with its
# own code, and `next_step.command` is safe to run unattended. No secret value
# reaches either form.

# Reason, exit code, and next-step action, one per line.
OG_REASONS='ok 0 none
usage 2 run
queue-missing 10 run
render-worker-missing 11 deploy
secret-missing 12 run
site-secret-present 13 run
switch-off 14 set-secret
clip-missing 20 inspect
clip-rendering 21 wait
clip-failed 22 inspect-logs
card-fallback 23 inspect-logs
clip-unknown 24 wait
wrangler-failed 30 run'

OG_DOCS='https://github.com/brettdavies/agentnative-site/blob/dev/RELEASES-PREFLIGHT.md#ogvideo-reason-codes'

# og_names <staging|production>: set QUEUE, RENDER and SITE to the
# environment's og-rendered queue, render Worker and site Worker.
# shellcheck disable=SC2034 # the scripts that source this file read them
og_names() {
  if [[ "$1" == production ]]; then
    QUEUE=og-rendered RENDER=anc-og-render SITE=agentnative-site
  else
    QUEUE=og-rendered-staging RENDER=anc-og-render-staging SITE=agentnative-site-staging
  fi
}

og_reason_field() {
  awk -v r="$1" -v f="$2" '$1 == r { print $f; found = 1 } END { exit !found }' <<<"$OG_REASONS"
}

# og_emit <json:0|1> <reason> <message> <value-json> <next-command>
# Prints the result and returns the reason's exit code.
og_emit() {
  local json="$1" reason="$2" message="$3" value="$4" command="$5"
  local code action
  code=$(og_reason_field "$reason" 2) || {
    echo "og contract: unknown reason $reason" >&2
    return 2
  }
  action=$(og_reason_field "$reason" 3)
  if [[ "$json" -eq 1 ]]; then
    jq -cn --arg reason "$reason" --argjson code "$code" --arg message "$message" --argjson value "$value" \
      --arg action "$action" --arg command "$command" --arg docs "$OG_DOCS" \
      '{reason: $reason, exit_code: $code, message: $message, value: $value,
        next_step: {action: $action, command: $command, docs: $docs}}'
  else
    printf '%s: %s\n' "$reason" "$message"
    [[ -n "$command" ]] && printf 'next: %s\n' "$command"
    [[ "$reason" == ok ]] || printf 'docs: %s\n' "$OG_DOCS"
  fi
  return "$code"
}

# og_usage_error <json:0|1> <script> <message> <value-json>
# An argument that is missing, unknown or malformed, rejected before any work.
# With --json the usage reason, else the message and the caller's usage() on
# stderr. Exits 2 either way.
og_usage_error() {
  if [[ "$1" -eq 1 ]]; then
    og_emit 1 usage "$3" "$4" "$2 --help" || true
  else
    printf '%s: %s\n' "${2##*/}" "$3" >&2
    usage >&2
  fi
  exit 2
}
