---
title: "feat: P0 — evaluate skill PR #25 release-flow hardening for site applicability"
type: feat
status: proposed
priority: P0
date: 2026-06-01
origin: "cross-repo mirror of brettdavies/agentnative-skill PR #25 (merged 2026-06-01); this repo has neither script the PR touches, so the task is an applicability evaluation"
---

# feat: P0 — evaluate skill PR #25 release-flow hardening for site applicability

## Summary

`agentnative-skill` PR #25 hardened its release flow with two changes to `scripts/sync-dev-after-release.sh` and two
changes to `scripts/generate-changelog.sh`. **This repo has neither script.** `RELEASES.md` notes a future
`CHANGELOG.md` flow as still-to-come ("Future generated changelog (if a `CHANGELOG.md` flow lands here).") and the site
deploys continuously via Cloudflare on push-to-main rather than via versioned releases with backport commits.

This plan is therefore an **applicability evaluation** rather than a direct mirror. Decide whether either script
belongs here at all; if yes, add it with the items from PR #25 and the follow-up
[PR #26](https://github.com/brettdavies/agentnative-skill/pull/26).

Reference PRs (read the exact diffs before deciding): <https://github.com/brettdavies/agentnative-skill/pull/25> and
<https://github.com/brettdavies/agentnative-skill/pull/26>.

## Scope

### Step 1 — applicability decision

Decide each independently:

1. **Does `scripts/generate-changelog.sh` belong in this repo?** The site has no versioned-release crate to changelog,
   but `RELEASES.md` already anticipates a future flow. If a flow lands, the script (with the four PR #25 items plus
   the two PR #26 follow-up items below) is the canonical shape — do not reinvent.
2. **Does `scripts/sync-dev-after-release.sh` belong in this repo?** The site's branching model is
   `feat/* → dev → release/<date>-<slug> → main` with continuous deploy on merge-to-main, not the
   `tag-then-backport-to-dev` shape the sync script targets. Most likely the answer is "no" — the dev/main divergence
   the sync script reconciles does not exist here in the same way. Confirm explicitly rather than implicitly.

### Step 2 — if either script lands, mirror these items

If step 1 decides yes for `scripts/generate-changelog.sh`, port the four items from PR #25 (not just the ones the
skill repo added net-new — the duplicate-section guard is the foundation the others sit on), plus the two PR #26
follow-up items:

1. **Duplicate-section guard** — refuse to prepend a `## [X.Y.Z]` section when `CHANGELOG.md` already has one for the
   current tag. Skip the prepend and exit non-zero with an explanatory message. (This guard was the original
   pre-existing fix mirrored across the skill/cli/spec repos before PR #25 added the rest.)
2. **`--dry-run` flag** — stash `CHANGELOG.md`, run the normal generation flow in place, print a unified diff to
   stderr if the regenerated content differs from the stashed copy, restore the original via `trap … EXIT`, exit 0
   when idempotent and exit 1 on drift.
3. **PR-number extraction regex fix** (from
   [skill PR #26](https://github.com/brettdavies/agentnative-skill/pull/26)) — `grep -oP '\(#\K\d+'` only matches the
   parenthesized `(#14)` form git-cliff emits on initial prepend, not the markdown-link form `[#14](…)` the script's
   Python expansion step rewrites those to. A second run (e.g. `--dry-run` against an already-processed
   `CHANGELOG.md`) extracts zero PR numbers; with `set -euo pipefail`, grep's exit-1-on-no-match aborts the script
   with empty output. Change the regex to `[\(\[]#\K\d+` (accepts both forms) and append `|| true` so the downstream
   `[[ -z "$PR_NUMBERS" ]]` branch handles the empty case via `summarize_and_exit`.
4. **`--dry-run` wrap-tolerant comparison** — known follow-up the skill repo did *not* ship in PR #26. The dry-run
   comparison uses byte-exact `cmp -s`; the on-disk `CHANGELOG.md` is line-wrapped by the repo's markdownlint /
   `md-wrap` hook while the script's direct writes are unwrapped, so the dry-run will false-positive "drift" on every
   release until the comparison is made wrap-tolerant. Suggested approach: run both files through `fmt -w 9999` (or
   an equivalent paragraph-flatten) before diffing, then use `diff --ignore-all-space --ignore-blank-lines`. Land
   alongside item 2.

If step 1 decides yes for `scripts/sync-dev-after-release.sh`, port the two preconditions:

5. **GitHub Release published-state precondition** — `gh release view "$VERSION" --json isDraft --jq .isDraft` must
   return `false` before proceeding. Exit 67 on missing or draft.
6. **Post-sync regen-idempotency check** — run `scripts/generate-changelog.sh --dry-run --tag $VERSION` after the
   backport commit. Warn (do not fail) when PR bodies have drifted from main's `CHANGELOG.md`. This consumer is the
   reason items 3 and 4 above matter — without item 3, the check aborts with opaque empty output on every release;
   without item 4, the check fires a "drift" warning on every release regardless of real drift.

## Acceptance

- A written decision (in this plan's `status` and/or a follow-up commit message on `dev`) for each of the two
  scripts: ported, deferred, or rejected as not-applicable. "Rejected" requires one sentence of why for future
  maintainers.
- If ported, behavior matches the skill repo's PR #25 + PR #26 implementations per the items above.

## Notes for the implementer

- Site deploys continuously; the sync script's whole premise (tag → publish → backport to dev) may not exist here.
  Most likely outcome: `sync-dev-after-release.sh` is rejected as not-applicable, and `generate-changelog.sh` is
  deferred until the future `CHANGELOG.md` flow `RELEASES.md` anticipates actually lands.
- If you reject either script, update this plan's `status` to `rejected` (not `completed`) and add a one-line
  rationale to the frontmatter, so future cross-repo audits don't re-open the question.
