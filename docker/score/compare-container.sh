#!/usr/bin/env bash
# In-container half of compare.sh, which mounts this file into the scorer
# image and runs one mode per container:
#
#   score   <build> <jobs> <timeout> <only>  audit each registry tool with one build
#   capture <jobs> <timeout> <only> [<tsv>]  save --help output; <tsv> switches to subcommands
#
# <build> is `base` or `head`, the label the output is filed under. <only> is
# a comma-separated list of registry names; empty selects every entry.
#
# Mounts compare.sh provides:
#   /harness/registry.yaml     the registry, read-only
#   /harness/anc               the build this container audits with, read-only
#   /harness/out               the run's output directory
#
# score writes out/status-<build>.tsv (tool, status) and one
# out/<build>/<tool>.json per scored audit. A status is ok, binary-absent,
# timeout, anc-exit-<code> or invalid-json.

set -uo pipefail

H=/harness
MODE=${1:-}
shift

# Registry entries as name<TAB>binary<TAB>profile. "-" stands in for an unset
# profile because `read` collapses consecutive tabs and would shift the fields.
entries() {
  local only=${1//[[:space:]]/} line name names=, missing=()
  local -a all asked
  mapfile -t all < <(yq -r '.tools[] | [.name, .binary, .audit_profile // "-"] | join("\t")' "$H/registry.yaml")
  if ((${#all[@]} == 0)); then
    echo "error: no tools read from the registry" >&2
    return 2
  fi
  for line in "${all[@]}"; do names+="${line%%$'\t'*},"; done
  IFS=, read -r -a asked <<<"$only"
  for name in "${asked[@]}"; do
    [[ "$names" == *",$name,"* ]] || missing+=("$name")
  done
  if ((${#missing[@]} > 0)); then
    echo "error: --only names no registry entry: ${missing[*]}" >&2
    return 2
  fi
  for line in "${all[@]}"; do
    [[ -z "$only" || ",$only," == *",${line%%$'\t'*},"* ]] && printf '%s\n' "$line"
  done
  return 0
}

# The terminal the container gives its processes, for the run manifest. TERM
# and COLUMNS come from the environment: bash sets a TERM of its own when the
# environment has none.
container_env() {
  local tty=false
  [[ -t 0 || -t 1 || -t 2 ]] && tty=true
  jq -n --argjson tty "$tty" --arg term "$(printenv TERM)" --arg columns "$(printenv COLUMNS)" \
    '{tty: $tty, term: ($term | select(. != "")) // null, columns: ($columns | select(. != "")) // null}'
}

audit() {
  local build=$1 name=$2 binary=$3 profile=$4 limit=$5 rc status=ok
  local out=$H/out/$build/$name.json err=$H/out/$build/$name.stderr
  local -a args=(audit --command "$binary" --output json)
  [[ "$profile" != "-" ]] && args+=(--audit-profile "$profile")

  timeout --kill-after=10 "$limit" "$H/anc" "${args[@]}" >"$out" 2>"$err" </dev/null
  rc=$?
  # anc exits 0, 1 or 2 beside a well-formed scorecard; a higher code is anc
  # itself failing. timeout exits 124, or 137 when the kill was needed.
  if ((rc == 124 || rc == 137)); then
    status=timeout
  elif ((rc > 2)); then
    status="anc-exit-$rc"
  elif ! jq -e '.schema_version' "$out" >/dev/null 2>&1; then
    status=invalid-json
  fi
  [[ "$status" == ok ]] || rm -f "$out"
  [[ -s "$err" ]] || rm -f "$err"
  echo "$status"
}

score_one() {
  local build=$1 limit=$2 name binary profile status=binary-absent started=$SECONDS
  IFS=$'\t' read -r name binary profile <<<"$3"
  if type -P "$binary" >/dev/null; then
    status=$(audit "$build" "$name" "$binary" "$profile" "$limit")
  fi
  printf '%s\t%s\n' "$name" "$status"
  printf '  %-18s %s=%s (%ss)\n' "$name" "$build" "$status" "$((SECONDS - started))" >&2
}

score() {
  local build=$1 jobs=$2 limit=$3 lines
  lines=$(entries "$4") || exit 2
  mkdir -p "$H/out/$build"
  container_env >"$H/out/container-$build.json"
  printf '%s\n' "$lines" | xargs -d '\n' -n 1 -P "$jobs" bash "$0" score-one "$build" "$limit" >"$H/out/status-$build.tsv"
}

# Captures what anc's runner reads: the binary by its resolved real path, anc's
# probe environment, a closed stdin, and stdout followed by stderr.
capture_one() {
  local limit=$1 name binary args path file out err rc
  local -a argv
  IFS=$'\t' read -r name binary args <<<"$2"
  path=$(type -P "$binary") || {
    echo "  $binary: not in the image, nothing captured" >&2
    return 0
  }
  read -r -a argv <<<"$args"
  file="${binary}__${args// /_}.txt"
  out=$(mktemp) err=$(mktemp)
  NO_COLOR=1 TERM=dumb COLUMNS=80 PAGER=cat \
    timeout --kill-after=2 "$limit" "$(realpath "$path")" "${argv[@]}" >"$out" 2>"$err" </dev/null
  rc=$?
  cat "$out" "$err" >"$H/out/$file"
  rm -f "$out" "$err"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$file" "$name" "$binary" "$args" "$rc" "$(wc -c <"$H/out/$file")"
}

capture() {
  local jobs=$1 limit=$2 subcommands=${4:-} lines work index=$H/out/_index.tsv
  lines=$(entries "$3") || exit 2
  container_env >"$H/out/_container.json"
  if [[ -z "$subcommands" ]]; then
    work=$(awk -F'\t' -v OFS='\t' '{ print $1, $2, "--help" }' <<<"$lines")
  else
    work=$(awk -F'\t' -v OFS='\t' 'FILENAME == ARGV[1] { name[$2] = $1; next }
      $1 in name { print name[$1], $1, $2 " --help" }' <(printf '%s\n' "$lines") "$subcommands")
    echo "capture: $(grep -c . <<<"$work") of $(grep -c . "$subcommands") subcommand lines name a selected registry binary" >&2
  fi
  [[ -n "$work" ]] || exit 0
  printf '%s\n' "$work" | xargs -d '\n' -n 1 -P "$jobs" bash "$0" capture-one "$limit" >"$index.new"
  {
    printf 'file\tname\tbinary\targs\texit\tbytes\n'
    {
      [[ -f "$index" ]] && awk -F'\t' 'FILENAME == ARGV[1] { fresh[$1]; next } FNR > 1 && !($1 in fresh)' "$index.new" "$index"
      cat "$index.new"
    } | LC_ALL=C sort
  } >"$index.tmp"
  mv "$index.tmp" "$index"
  rm -f "$index.new"
  echo "capture: $(($(wc -l <"$index") - 1)) files indexed in _index.tsv" >&2
}

case "$MODE" in
  score) score "$@" ;;
  score-one) score_one "$@" ;;
  capture) capture "$@" ;;
  capture-one) capture_one "$@" ;;
  *)
    echo "error: unknown mode: $MODE" >&2
    exit 2
    ;;
esac
