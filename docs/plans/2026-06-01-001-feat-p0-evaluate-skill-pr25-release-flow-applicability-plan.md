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
belongs here at all; if yes, add it with the four items from PR #25.

Reference PR (read the exact diff before deciding): <https://github.com/brettdavies/agentnative-skill/pull/25>.

## Scope

### Step 1 — applicability decision

Decide each independently:

1. **Does `scripts/generate-changelog.sh` belong in this repo?** The site has no versioned-release crate to changelog,
   but `RELEASES.md` already anticipates a future flow. If a flow lands, the script (with the four PR #25 items
   below) is the canonical shape — do not reinvent.
2. **Does `scripts/sync-dev-after-release.sh` belong in this repo?** The site's branching model is
   `feat/* → dev → release/<date>-<slug> → main` with continuous deploy on merge-to-main, not the
   `tag-then-backport-to-dev` shape the sync script targets. Most likely the answer is "no" — the dev/main divergence
   the sync script reconciles does not exist here in the same way. Confirm explicitly rather than implicitly.

### Step 2 — if either script lands, mirror these items

If step 1 decides yes for `scripts/generate-changelog.sh`, port the four items from PR #25 (not just the ones the
skill repo added net-new — the duplicate-section guard is the foundation the others sit on):

1. **Duplicate-section guard** — refuse to prepend a `## [X.Y.Z]` section when `CHANGELOG.md` already has one for the
   current tag. Skip the prepend and exit non-zero with an explanatory message. (This guard was the original
   pre-existing fix mirrored across the skill/cli/spec repos before PR #25 added the rest.)
2. **`--dry-run` flag** — stash `CHANGELOG.md`, run the normal generation flow in place, print a unified diff to
   stderr if the regenerated content differs from the stashed copy, restore the original via `trap … EXIT`, exit 0
   when idempotent and exit 1 on drift.

If step 1 decides yes for `scripts/sync-dev-after-release.sh`, port the two preconditions:

3. **GitHub Release published-state precondition** — `gh release view "$VERSION" --json isDraft --jq .isDraft` must
   return `false` before proceeding. Exit 67 on missing or draft.
4. **Post-sync regen-idempotency check** — run `scripts/generate-changelog.sh --dry-run --tag $VERSION` after the
   backport commit. Warn (do not fail) when PR bodies have drifted from main's `CHANGELOG.md`.

## Acceptance

- A written decision (in this plan's `status` and/or a follow-up commit message on `dev`) for each of the two
  scripts: ported, deferred, or rejected as not-applicable. "Rejected" requires one sentence of why for future
  maintainers.
- If ported, behavior matches the skill repo's PR #25 implementation per the items above.

## Notes for the implementer

- Site deploys continuously; the sync script's whole premise (tag → publish → backport to dev) may not exist here.
  Most likely outcome: `sync-dev-after-release.sh` is rejected as not-applicable, and `generate-changelog.sh` is
  deferred until the future `CHANGELOG.md` flow `RELEASES.md` anticipates actually lands.
- If you reject either script, update this plan's `status` to `rejected` (not `completed`) and add a one-line
  rationale to the frontmatter, so future cross-repo audits don't re-open the question.
