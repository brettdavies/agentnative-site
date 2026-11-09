#!/usr/bin/env bash
# Canonical version: 2026.11.03 (generic)
#
# Print a site's release version, `<base>.<epoch>-g<sha7>`, the site deploy
# stamp of github-repo-setup's references/versioning.md:
#
#   <base>   SITE_VERSION_BASE in scripts/release/release.env, the site's
#            major.minor. Only a person raises it, by hand, and it never goes down.
#   <epoch>  the committer time, in Unix seconds, of the dev commit the release
#            is cut from
#   <sha7>   the first seven characters of that commit's sha
#
# The same commit always yields the same version. A version whose numbers do
# not sort above the newest `v` tag's is refused, so no release tags below one
# already out, and so is one already tagged: a release that is out is never cut
# again. Every caller (the cut, preflight, a release workflow's tag check)
# runs this rather than rebuilding the format.
#
# Usage:
#   scripts/release/site-version.sh [--commit <rev>]
#   scripts/release/site-version.sh --verify <vVERSION>
#
# Options:
#   --commit REV      The dev commit the release is cut from (default: origin/dev).
#   --verify VERSION  Check a stamp: its -g<sha7> names a commit on origin/dev,
#                     and that commit's version is VERSION. A tag of that name
#                     may already exist, and the sort guard skips it, so a
#                     release workflow can check the tag it runs for.
#   -h, --help        This text.
#
# Exit codes:
#   0 = printed, or verified
#   1 = refused: the version is already tagged or does not sort above the newest
#       tag, or VERSION is not the stamp of a commit on origin/dev
#   2 = setup error: no SITE_VERSION_BASE, a commit git cannot find, a bad
#       argument
#
# Every refusal names the values it compared and ends on a `fix:` line.

set -euo pipefail

# shellcheck disable=SC1091  # sibling _lib.sh, always vendored alongside
. "$(dirname "$0")/_lib.sh"

usage() {
  print_usage_header
  exit "${1:-2}"
}

COMMIT="origin/dev"
VERIFY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit)
      [[ $# -ge 2 ]] || usage
      COMMIT="$2"
      shift 2
      ;;
    --verify)
      [[ $# -ge 2 ]] || usage
      VERIFY="$2"
      shift 2
      ;;
    -h | --help) usage 0 ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      ;;
  esac
done

# refuse CODE MESSAGE FIX: prints the message and, last, the fix; exits CODE.
refuse() {
  printf 'site-version: %s\nfix: %s\n' "$2" "$3" >&2
  exit "$1"
}

BASE="${SITE_VERSION_BASE:-}"
[[ -n "$BASE" ]] || refuse 2 "SITE_VERSION_BASE is not set" \
  "set SITE_VERSION_BASE=<major.minor> in scripts/release/release.env, the site's current major.minor"
[[ "$BASE" =~ ^[0-9]+\.[0-9]+$ ]] || refuse 2 "SITE_VERSION_BASE is $BASE, not a major.minor" \
  "set SITE_VERSION_BASE in scripts/release/release.env to the site's major.minor, such as 2.0"

# stamp_of SHA: the version a full commit sha names.
stamp_of() {
  printf '%s.%s-g%s' "$BASE" "$(git log -1 --format=%ct "$1")" "${1:0:7}"
}

# newest_tag EXCEPT: the `v` tag whose major.minor.patch numbers are highest,
# EXCEPT left out. Compared by number, so the stamp's ten-digit patch and an
# older SemVer tag's single digit order the way the versions do.
newest_tag() {
  git tag --list 'v[0-9]*' | awk -v except="$1" '
    $0 == except || !match($0, /^v[0-9]+\.[0-9]+\.[0-9]+/) { next }
    {
      split(substr($0, 2, RLENGTH - 1), n, ".")
      if (!found || n[1] + 0 > a || (n[1] + 0 == a && (n[2] + 0 > b || (n[2] + 0 == b && n[3] + 0 > c)))) {
        a = n[1] + 0; b = n[2] + 0; c = n[3] + 0; best = $0; found = 1
      }
    }
    END { if (found) print best }'
}

# above A B: true when version A's major.minor.patch numbers exceed B's.
above() {
  awk -v a="${1#v}" -v b="${2#v}" 'BEGIN {
    split(a, x, /[.-]/); split(b, y, /[.-]/)
    for (i = 1; i <= 3; i++) {
      if (x[i] + 0 > y[i] + 0) exit 0
      if (x[i] + 0 < y[i] + 0) exit 1
    }
    exit 1
  }'
}

# guard VERSION [EXCEPT]: refuses VERSION unless it sorts above every `v` tag
# but EXCEPT. --verify passes the stamp's own tag, which a release workflow
# checks after it is pushed.
guard() {
  local newest
  newest=$(newest_tag "${2:-}")
  [[ -z "$newest" ]] || above "v$1" "$newest" \
    || refuse 1 "v$1 does not sort above the newest tag, $newest" \
      "cut from a dev commit newer than $newest's, or raise SITE_VERSION_BASE in scripts/release/release.env above $BASE (a maintainer's decision; the base never goes down)"
}

if [[ -z "$VERIFY" ]]; then
  sha=$(git rev-parse --verify --quiet "$COMMIT^{commit}") \
    || refuse 2 "$COMMIT names no commit" \
      "git fetch origin dev, or pass --commit <sha> of the dev commit the release is cut from"
  version=$(stamp_of "$sha")
  if git rev-parse --verify --quiet "refs/tags/v$version" >/dev/null; then
    refuse 1 "v$version is already tagged: $COMMIT (${sha:0:12}) is released" \
      "merge the next change into dev and cut from it, or pass --commit <a newer dev commit>"
  fi
  guard "$version"
  echo "$version"
  exit 0
fi

version="${VERIFY#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-g([0-9a-f]{7})$ ]] \
  || refuse 2 "$VERIFY is not a site stamp, v<base>.<epoch>-g<sha7>" \
    "pass the stamp the release was cut as, such as v$BASE.<epoch>-g<sha7>"
sha7="${BASH_REMATCH[1]}"
git rev-parse --verify --quiet origin/dev >/dev/null \
  || refuse 2 "origin/dev is not in this checkout" "git fetch origin dev"

expected=""
while IFS= read -r sha; do
  expected=$(stamp_of "$sha")
  if [[ "$expected" == "$version" ]]; then
    guard "$version" "v$version"
    echo "v$version is the stamp of $sha on origin/dev"
    exit 0
  fi
done < <(git rev-list origin/dev | grep "^$sha7" || true)

[[ -n "$expected" ]] || refuse 1 "v$version names $sha7, and no commit on origin/dev starts with it" \
  "tag the release from the dev commit it was cut from: scripts/release/site-version.sh --commit <that commit>"
refuse 1 "v$version does not match its commit: $sha7 on origin/dev gives v$expected" \
  "tag the release as v$expected, or check SITE_VERSION_BASE in scripts/release/release.env"
