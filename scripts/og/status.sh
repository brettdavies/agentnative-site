#!/usr/bin/env bash
# One line on a scorecard's card and clip, read from public routes.
#
# Usage: scripts/og/status.sh <base-url> <target> [--json]
#   <base-url>  the site: https://anc.dev, the staging workers.dev host, or
#               http://localhost:8787
#   <target>    the scorecard target, as in /score/<target>
#   --json      print one result object (scripts/og/contract.sh)
#
# Prints the card key, x-anc-card and the logo tier, x-anc-clip and
# x-anc-clip-run from an uncached ?v= fetch of the page, whether the page
# names og:video, and the next command when something is missing. Each
# x-anc-clip value maps to the cause and command the og-cards smoke names
# (tests/e2e/og-clip-causes.ts). Staging sits behind Cloudflare Access:
# export ANC_STAGING_ACCESS_CLIENT_ID and ANC_STAGING_ACCESS_CLIENT_SECRET.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/og/contract.sh
. "$ROOT/scripts/og/contract.sh"

usage() { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

JSON=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      exit 2
      ;;
    *) ARGS+=("$arg") ;;
  esac
done
[[ ${#ARGS[@]} -eq 2 ]] || {
  usage >&2
  exit 2
}
BASE="${ARGS[0]%/}"
TARGET="${ARGS[1]}"

ENV_NAME=staging
[[ "$BASE" =~ ^https?://(www\.)?anc\.dev$ ]] && ENV_NAME=production
og_names "$ENV_NAME"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
: >"$WORK/access"
chmod 600 "$WORK/access"
if [[ -n "${ANC_STAGING_ACCESS_CLIENT_ID:-}" && -n "${ANC_STAGING_ACCESS_CLIENT_SECRET:-}" ]]; then
  printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' \
    "$ANC_STAGING_ACCESS_CLIENT_ID" "$ANC_STAGING_ACCESS_CLIENT_SECRET" >"$WORK/access"
fi

fetch() { curl -sS -m 30 -H @"$WORK/access" -D "$WORK/$1.headers" -o "$WORK/$1.body" -w '%{http_code}' "${@:2}"; }
header() { awk -v name="$2" 'tolower($1) == name ":" { sub(/\r$/, "", $2); print $2 }' "$WORK/$1.headers" | tail -1; }
meta() {
  [[ -f "$WORK/$1.body" ]] || return 0
  { grep -o "<meta property=\"$2\" content=\"[^\"]*\"" "$WORK/$1.body" || true; } | head -1 | sed 's/.*content="//; s/"$//'
}

page_status=$(fetch page -H 'accept: text/html' "$BASE/score/$TARGET?v=$(date +%s)") || page_status=000
clip=$(header page x-anc-clip)
run=$(header page x-anc-clip-run)
# The run id comes from a response header and lands in a command an agent may run, so only an id's shape passes.
[[ "$run" =~ ^[A-Za-z0-9-]{1,64}$ ]] || run=""
image=$(meta page og:image)
video=$(meta page og:video)
key=""
card=""
logo=""
if [[ -n "$image" ]]; then
  card_path="/${image#*://*/}"
  key="$(basename "$card_path" .png)"
  fetch card "$BASE$card_path" >/dev/null || true
  card=$(header card x-anc-card)
  logo=$(header card x-anc-card-logo)
fi

value=$(jq -cn --arg target "$TARGET" --arg key "$key" --arg card "$card" --arg logo "$logo" --arg clip "${clip:-none}" \
  --arg run "$run" --arg video "$video" --arg status "$page_status" \
  '{target: $target, key: $key, card: $card, logo: $logo, clip: $clip, run: $run, og_video: $video, page_status: ($status | tonumber)}')
line="$TARGET key=${key:--} card=${card:--} logo=${logo:--} clip=${clip:-none} run=${run:--} og:video=$([[ -n "$video" ]] && echo named || echo absent)"

tail_cmd() {
  printf 'bunx wrangler tail %s --format json' "$1"
  [[ -z "$2" ]] || printf ' --search %s' "$2"
}

if [[ "$page_status" != 200 ]]; then
  reason='clip-missing'
  message="the page answered $page_status, so neither card nor clip could be read: check the target name, and on staging ANC_STAGING_ACCESS_CLIENT_ID and ANC_STAGING_ACCESS_CLIENT_SECRET: $line"
  command="curl -sS -o /dev/null -w '%{http_code}\n' $BASE/score/$TARGET"
elif [[ "$card" == fallback ]]; then
  reason=card-fallback message="the render Worker could not draw the card: $line" command="$(tail_cmd "$SITE" fallback)"
else
  case "${clip:-none}" in
    present) reason=ok message="$line" command="scripts/og/status.sh $BASE $TARGET" ;;
    off) reason=switch-off message="OG_VIDEO_ENABLED is not set: $line" command="scripts/og/setup.sh $ENV_NAME --check" ;;
    queued | rendering) reason=clip-rendering message="the clip is on its way: $line" command="$(tail_cmd "$RENDER" "$run")" ;;
    failed) reason=clip-failed message="the RenderJob failed its last retry: $line" command="$(tail_cmd "$RENDER" "$run")" ;;
    unknown) reason=clip-unknown message="the RenderJob did not answer the page within 250 ms; ask again: $line" command="scripts/og/status.sh $BASE $TARGET" ;;
    *) reason=clip-missing message="no render was asked for the current card, or its job ended without a stored clip: $line" command="$(tail_cmd "$SITE" score.og)" ;;
  esac
fi

status=0
og_emit "$JSON" "$reason" "$message" "$value" "$command" || status=$?
exit "$status"
