#!/usr/bin/env bash
# Canonical version: 2026.11.03 (generic)
#
# Shared helpers for scripts/hooks/pre-push, sourced, never executed directly.
# A subset of github-repo-setup's hooks-lib.sh: the push-scope helpers this
# repo's pre-push uses. Its checks run inline, so the library's check and step
# helpers are not carried.
#
# Activate the hooks per clone: git config core.hooksPath scripts/hooks
#
# Callers cd to the repo root before sourcing, so relative paths resolve.

# Require bash >= 4.4: mapfile, and safe empty-array expansion under `set -u`.
# Sourced, so return rather than exit, which would kill an interactive shell;
# the sourcing hook aborts on the non-zero return.
if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  printf 'error: bash >= 4.4 required, but this is bash %s.\n' "${BASH_VERSION:-unknown}" >&2
  printf 'Install a newer bash: brew install bash\n' >&2
  # shellcheck disable=SC2317  # `exit` runs only when executed rather than sourced
  return 1 2>/dev/null || exit 1
fi

# ---------------------------------------------------------------------------
# Push scope
# ---------------------------------------------------------------------------

# push_only_deletes: true when every ref line git hands pre-push on stdin,
# `<local ref> <local sha> <remote ref> <remote sha>`, deletes a remote ref.
# A delete carries an all-zero local sha (40 zeros, or 64 in a SHA-256
# repository) and delivers no commit for any check to read.
#
# False, so the checks run, when stdin is a terminal (the hook run by hand),
# when it carries no ref lines, and when it stays open for
# HOOK_STDIN_WAIT_SECONDS (default 5) with no next line. Git writes its lines
# and closes stdin at once, so a real push never waits.
#
# Stdin can be read only once, so every line read is left in HOOK_PUSH_REFS
# for a later step that needs the refs too.
push_only_deletes() {
  local wait_s="${HOOK_STDIN_WAIT_SECONDS:-5}" line local_ref local_sha rc deletes=0 others=0
  HOOK_PUSH_REFS=''
  [ -t 0 ] && return 1
  while :; do
    rc=0
    IFS= read -r -t "$wait_s" line || rc=$?
    # At end of input read returns 1 but still fills line with a last line
    # that has no newline, which counts like any other.
    [ "$rc" -eq 0 ] || { [ "$rc" -le 128 ] && [ -n "$line" ]; } || break
    HOOK_PUSH_REFS+="$line"$'\n'
    read -r local_ref local_sha _ <<<"$line"
    [ -n "$local_ref" ] || continue
    if [[ "$local_sha" =~ ^0+$ ]]; then
      deletes=$((deletes + 1))
    else
      others=$((others + 1))
    fi
  done
  # read returns above 128 on a timeout and 1 at end of input.
  [ "$rc" -le 128 ] && [ "$deletes" -gt 0 ] && [ "$others" -eq 0 ]
}

# push_only_known_commits REMOTE: true when every ref line push_only_deletes
# kept in HOOK_PUSH_REFS deletes or names a commit a REMOTE remote-tracking
# branch already reaches, as a tag or a new branch at a pushed commit does, and
# at least one line names a commit. rev-list peels an annotated tag to its
# commit. False, so the checks run, with no REMOTE (the hook run by hand) and
# with no line that names a commit. A push to a URL instead of a remote name
# matches no remote-tracking branch, so every commit it carries counts as new.
push_only_known_commits() {
  local remote="${1:-}" local_sha known=0
  [ -n "$remote" ] || return 1
  while read -r _ local_sha _; do
    [ -n "${local_sha:-}" ] || continue
    [[ "$local_sha" =~ ^0+$ ]] && continue
    brings_new_commits "$remote" "$local_sha" && return 1
    known=$((known + 1))
  done <<<"${HOOK_PUSH_REFS:-}"
  [ "$known" -gt 0 ]
}

# brings_new_commits REMOTE SHA: true when SHA reaches a commit no REMOTE
# remote-tracking branch reaches, and when git cannot read SHA.
brings_new_commits() {
  local out
  out=$(git rev-list -n 1 "$2" --not --remotes="$1" 2>/dev/null) || return 0
  [ -n "$out" ]
}
