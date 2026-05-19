---
title: "feat: Show HN launch readiness — agentnative-site"
type: feat
status: active
date: 2026-04-28
last-revised: 2026-04-30
shipped_in: HELD — launch did NOT occur 2026-04-30; relaunch target Mon 2026-05-04 contingent on live-scoring v2 surface (`docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md`) shipping over the weekend.
parent: ~/.gstack/projects/brettdavies-agentnative/brett-dev-design-show-hn-launch-inversion-20260427-144756.md
---

> **CORRECTION (2026-04-30 PM PT) — LAUNCH WAS HELD, NOT SHIPPED.** The Show HN post did not go up Thu 2026-04-30
> 09:00 PT. Primary blocker: the live-scoring v2 surface is unbuilt
> (`docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md`, `status: active`, all units `[ ]` unchecked) — the
> "paste a repo URL → live `anc` scorecard" hook that justifies the post's anc.dev click-through doesn't exist yet.
> Asset-only landing-page-about-an-opinionated-CLI is too thin a Show HN. The `release/<YYYY-MM-DD>-show-hn-cut` PR was
> never cut. `main` is still at the v0 scaffold from 2026-04-14 (commit `0128e7e feat: agentnative.dev v0 scaffold`);
> all 109 commits of launch-week work (96/96 leaderboard, badge surface, `/skill` split, scorecard schema 0.4, brand
> OG, block-level normative rendering) sit unpromoted on `dev`. Plan flipped back to `status: active`.
>
> **Forward plan (locked 2026-04-30 PM PT with user):**
>
> - **Today (2026-04-30):** Run brand-OG Unit 5 visual QA via `/design-review` (gating step skipped pre-held-launch),
>   then `release/2026-04-30-<slug>` cut promoting today's `dev` to `main` — gets anc.dev off the v0 scaffold without
>   triggering the Show HN post. Spec-sync vendoring (`2026-04-23-001`) folded in if scope holds.
> - **Weekend (Fri-Sun 2026-05-01 → 2026-05-03):** Build live scoring per `2026-04-28-002`. Target Sun PM `dev` ready.
> - **Mon 2026-05-04 09:00 PT:** Cut `release/2026-05-04-show-hn-cut` from `dev`, deploy, cold-device verify, post.
>
> The blocks BELOW this CORRECTION — labeled "Post-launch update," "Post-launch additive work," "Planning-doc cleanup
> pass," and "Remaining post-launch follow-up" — describe what was *intended* / *staged on dev*, NOT what *shipped to
> anc.dev*. Treat all `completed` / `shipped` / `clean` claims in those blocks as point-in-time records of dev-branch
> state captured pre-mortem ahead of the planned launch, then never corrected when launch was held. The PR #52
> scorecard schema 0.4 work + the doc-flip commits + brand-OG PRs #54/#56/#57 DID merge to `dev` — that part is
> accurate; only the "shipped to production" framing is wrong.
>
> **Sibling plans incorrectly flipped to `status: completed` in the 2026-04-30 cleanup pass need their own correction
> pass** — `2026-04-29-002` (scorecard schema 0.4), `2026-04-27-001` (skill-distribution Units 2–5), `2026-04-24-001`
> (skill-distribution master), `2026-04-23-002` (badge surface). They report dev-state-at-cleanup-time as if it were
> production-state. Address in a follow-on `docs(plans):` correction commit.
>
> **Branch-name convention update:** every `release/launch` token in this plan body has been globally renamed to the
> CalVer placeholder `release/<YYYY-MM-DD>-show-hn-cut` per `RELEASES.md` § Branches (CalVer date prefix is mandatory
> for `release/*` branches). When the actual cut happens, substitute the real date (e.g. `release/2026-05-04-show-hn-
> cut`).

---

> **Parent:** `~/.gstack/projects/brettdavies-agentnative/brett-dev-design-show-hn-launch-inversion-20260427-144756.md`
> (the central Show HN launch tracker — single source of truth for gates, scope, approach across spec/CLI/site/skill).
> This per-repo plan inherits gates from the parent and is authoritative for repo-internal execution detail only.
>
> **Release version + order:** see central tracker § Release Versions and Order — SoT for v0.3.0 launch wave.
> Site `release/<YYYY-MM-DD>-show-hn-cut` → `main` deploy is **step 4** of the launch wave (cherry-pick scope includes
> `skill.json` re-pin to skill v0.2.0 commit SHA from step 3b). Cutover ops are **step 5**; cold-device prod smoke
> is **step 6**. Hard-blocked on steps 1–3b (spec v0.3.0, CLI v0.2.0 + tap, skill v0.2.0). Slip → push launch 24h.

# feat: Show HN launch readiness — agentnative-site

> **[HISTORICAL — see CORRECTION above; launch did NOT ship.] Post-launch update (2026-04-30):** Launch shipped Thu
> 2026-04-30 09:00 PT on schedule. Site cuts (steps 4–6 of the launch wave per the central tracker) completed clean:
> `release/<YYYY-MM-DD>-show-hn-cut` → `main` deployed to anc.dev, skill-distribution cutover ops ran clean, and the
> cold-device prod smoke passed before the post went up. Plan flipped `active → completed`.
>
> ---
>
> **Post-launch additive work — NOT scoped in the original plan.** PR #52 ("scorecard schema 0.4 + scorecard-driven
> discovery with registry editorial join") merged to `dev` 2026-04-30 morning (commit `ab6e7e3`, 108 files, +3970/-451).
> Eight implementation units (U1–U8) inverted the build pipeline to read scorecards-first and join the registry as the
> editorial layer, regenerated all 95 scorecards to schema 0.4, surfaced v0.4 audit metadata in per-tool Details, added
> 11 binary-name redirects with collision invariants, and shipped CI annotations for orphan warnings. Authoritative plan:
> [`2026-04-29-002-feat-scorecard-schema-0.4-pipeline-inversion-plan.md`](2026-04-29-002-feat-scorecard-schema-0.4-pipeline-inversion-plan.md)
> (`status: completed`).
>
> ---
>
> **Planning-doc cleanup pass (2026-04-30, dev commits `ac3cf41` + `2afc8b1` + `1c89b1d`):** four sibling plans flipped
> to `status: completed` with post-shipment update blocks recording what actually shipped vs. the original plan body —
> `2026-04-29-002` (scorecard schema 0.4 / PR #52), `2026-04-27-001` (skill-distribution Units 2–5 / PRs #36–#39),
> `2026-04-24-001` (skill-distribution master), `2026-04-23-002` (badge surface / PRs #49–#51). One plan stays `active`:
> [`2026-04-23-001-feat-sync-spec-plan.md`](2026-04-23-001-feat-sync-spec-plan.md) — annotated as UNSTARTED on `dev`,
> remains the post-launch v0.4.x track for CLI-feeds-site coverage-matrix vendoring.
>
> ---
>
> **Remaining post-launch follow-up:** the `dev → main` release covering everything since 2026-04-28 (PR #52 plus the
> doc-flip commits and any `dev`-only fixes accumulated during launch week) still needs to ship in a `release/*` PR per
> `RELEASES.md`. No user-visible regression — `main` is at the launch-cut HEAD and serving anc.dev cleanly — but `dev` is
> the post-launch v0.4.x integration line and should not be left to drift indefinitely.

## Status snapshot (2026-04-29 PT, late evening)

Today: 2026-04-29 PT. Post lands Thu 2026-04-30 09:00 PT (~16h out).

- **U1 ✅ shipped** — `scripts/sync-coverage-matrix.sh` rename drift fixed via commit `2467e5c`. Todo `014` is
  `complete`.
- **U2 ✅ moot — full coverage** — Registry holds 96 entries; `scorecards/` holds 96 JSON files. Effective audit decision
  is "(a) full batch-scoring already done"; no gap to fill.
- **U3 ✅ shipped — no fallback rows needed** — `dist/scorecards.html` renders 96 `<tr>` rows from 96 scorecards via
  `d710ade feat(scoring): full anc100 leaderboard (96/96 clean) via patched docker pipeline (#40)`. The
  `.leaderboard-row--skipped` class was never written because zero rows are skipped — the U3 contingency design is
  retired.
- **U4 ✅ shipped — site-copy red-team pass (Gate 11)** — PR #48 squash `a71767a`, merged 2026-04-29 20:35 UTC. 8
  parallel adversarial reviewers across 7 principle pages + 1 supporting-pages dispatch; 12 files; +191/-117. Tier 3
  deferrals captured in the Red-Team Log subsection of this plan.
- **U5 — cold-device smoke (Gate 12):**
- Pre-cut staging pass: ✅ confirmed on phone (SVG icons render correctly in iOS Safari, theme toggle works, nav links
  resolve). Did not block on the missing-icon regression that PR #46 fixed.
- Post-cut prod pass: pending — runs Thu morning before 09:00 PT after `release/<YYYY-MM-DD>-show-hn-cut` deploys.
- **U6 — `release/<YYYY-MM-DD>-show-hn-cut` PR cut + cutover ops:** still blocked, but on a narrower chain. Central
  tracker as of 2026-04-29 evening: step 1 (spec v0.3.0) ✅ done; step 3a (skill v0.2.0 PR-merge) ✅ done at 16:38 PT
  (squash `2b10c84`); step 3b (skill v0.2.0 tag + GitHub Release) ✅ done at 22:16 UTC (tag `054c249`). **Only step 2
  (CLI v0.2.0) remains.** The earlier `src/data/skill.json` re-pin requirement is retired per the central tracker's
  step-4 entry — skill v0.2.0 ships `bin/check-update` (PR #8) for consumer-side staleness detection, replacing
  per-release SHA pinning.
- **Launch-coupled side-quest ✅ shipped** — Badge surface for agent-native conformance landed on `dev` 2026-04-29
  evening. Plan: [`docs/plans/2026-04-23-002-feat-badge-surface-plan.md`](2026-04-23-002-feat-badge-surface-plan.md).
  PRs: [#49](https://github.com/brettdavies/agentnative-site/pull/49) (build-time SVGs via `badge-maker` + `/badge`
  convention page + scorecard embed snippet + leaderboard callout),
  [#50](https://github.com/brettdavies/agentnative-site/pull/50) (dark-mode contrast fix on the leaderboard callout),
  [#51](https://github.com/brettdavies/agentnative-site/pull/51) (visual-fidelity gates documented in AGENTS.md). Rides
  the `release/<YYYY-MM-DD>-show-hn-cut` cherry-pick automatically (scope is "all of `dev`"). Surface #4 of the badge
  plan (spec `docs/badge.md`) deferred post-launch; the `/badge` page is the doctrinal copy at launch.
- **Gate 9 — issue templates on `main`:** still passive-clear via U6's full-`dev` cherry-pick. Confirmed
  `.github/ISSUE_TEMPLATE/{config.yml,site-bug.yml}` exist on `dev` and not on `main`.

## Overview

The site repo is the **primary surface** on launch day — `~100% click-through` per the central tracker's ecosystem
table. The post points at `anc.dev`. Everything the site repo owes the launch falls out of that single fact:
`/scorecards` shows a credible full-registry leaderboard, every page works on a phone over cellular, every visible
string survives an adversarial reading, and all in-repo links resolve on `main` (not just `dev`). This plan stages four
launch-day gates (G8 + G9 + G11 + G12), one P0 todo (`014` — `sync-coverage-matrix.sh` rename drift), and the
night-before `release/<YYYY-MM-DD>-show-hn-cut` cherry-pick that pushes everything from `dev` to `main`. It explicitly
does NOT execute anything — the plan IS the deliverable for this session.

The skill-distribution stretch track (Units 1–5 of `2026-04-24-001`) is **already on `dev` and live on staging** as of
2026-04-28 PM. It rides the same `release/<YYYY-MM-DD>-show-hn-cut` PR. The only stretch-track work remaining is the
cutover ops (cache-purge + skill-availability seed) which run AFTER the release lands on `main`.

---

## Problem Frame

The site has accumulated 47+ commits on `dev` since the most recent release was promoted to `main`. The launch-blocking
work is therefore not "ship more code" but "decide what ships, verify it works on a cold device, and do the night-before
cut clean." The substantive remaining items split four ways:

1. **Gate 8 — full anc100 leaderboard.** Status `not-started` per the central tracker. Largest unknown: the
   `/scorecards` page has the leaderboard infrastructure (shipped via H6, commit `c71a6d2 feat(v0.1.3): ANC 100
   leaderboard launch`) and the registry is at 100 entries (`51c8281 chore(v0.1.1): regenerate scorecards with anc
   v0.1.1`), but the central tracker explicitly requires "full anc100 results, not ≥3 tools" with "fallback display for
   tools that fail to score (do not ship blank rows)." Need an audit pass: how many of the 100 registry entries
   currently have a scorecard? If gaps exist, decide between (a) a batch-scoring pass to fill them, (b) a graceful
   fallback row design, or (c) some mix. This is the largest scope item and the biggest risk to the launch date.

2. **P0 todo 014 — `sync-coverage-matrix.sh` rename drift.** `~10 min fix`, gates Gate 8 (the script populates
   `src/data/coverage-matrix.json` which `/coverage` reads, and a fresh sync is expected post-CLI-v0.2.0 launch).
   Direct- to-`dev` chore per the trivial-work exemption.

3. **Gate 9 — `.github/ISSUE_TEMPLATE/` on `dev`, not on `main`.** Confirmed: `.github/ISSUE_TEMPLATE/{config.yml,
   site-bug.yml}` exists on `dev` (committed in `70b38f9`) but `git ls-tree main -- .github/ISSUE_TEMPLATE/` returns
   empty. With `blank_issues_enabled: false` in `config.yml`, a Show HN visitor clicking the issue-template link from
   the spec repo's CONTRIBUTING.md hits a degraded UI. **Fix is passive** — the night-before
   `release/<YYYY-MM-DD>-show-hn-cut` PR already includes everything on `dev`, so this gate clears automatically as long
   as the cherry-pick scope is "all of `dev`." Codified in the Pre-launch release PR checklist below.

4. **Gate 11 — site-copy red-team pass.** Adversarial review of every visible string on `/`, `/p1`–`/p7`, `/check`,
   `/about`, `/methodology`, `/scorecards`, `/score/<tool>`, `/install`, plus the OG image text and footer. Spec-side
   already shipped via PR #13 (`ca1e4f6` on spec `dev`). Site-side is the remaining slice. Catches "but the spec
   contradicts itself at X" comments BEFORE they land on the public HN thread.

5. **Gate 12 — cold-device reachability.** `not-started` per the tracker. Verifies anc.dev DNS, HTTPS, OG-tag rendering,
   mobile layout, and link integrity from a phone on cellular (not the dev machine on its own network). Tuesday morning
   per the tracker's Assignment.

Naming-alignment work that touched this repo is already shipped per the spec-side close-out (`6d76ae9` on site `dev`).
No execution remains for that gate from the site side.

---

## Requirements Trace

Inherited from the central tracker. Site-owned gates only:

- **Gate 8 — Leaderboard shows full anc100 results.** Full registry, not ≥3 tools. Fallback display for tools that fail
  to score. (PRIMARY — largest scope)
- **Gate 9 — Issue routing sanity check.** Site-repo action item: release `.github/ISSUE_TEMPLATE/` to `main`. (PASSIVE
  — clears via the night-before release PR)
- **Gate 11 — Red-team pass on site copy.** Adversarial review of every public-facing string. (CONTENT)
- **Gate 12 — `anc.dev` reachable from cold device + HTTPS valid.** Phone on cellular, Tuesday morning. (VERIFICATION)
- **P0 todo `014` — `sync-coverage-matrix.sh` rename drift.** Functional: default `ANC_ROOT` no longer resolves.
  (HOUSEKEEPING — gates Gate 8 indirectly)

Gates **not** owned by this repo: 1, 2, 3, 4, 5, 6, 7, 10. Listed in Cross-references for awareness.

---

## Scope Boundaries

- This plan is the deliverable for THIS session. **Do not execute the gates** — execution begins in the next session per
  the handoff's Step 6.
- This plan does **not** subsume `2026-04-24-001-feat-skill-distribution-endpoint-plan.md` (skill distribution master)
  or `2026-04-27-001-feat-skill-distribution-site-plan.md` (site execution Units 2–5). Both stay `active` and ship via
  the same `release/<YYYY-MM-DD>-show-hn-cut` PR. The central tracker treats skill distribution as the launch-adjacent
  stretch track — this launch-readiness plan coordinates with it but does not own it.
- This plan does **not** subsume `2026-04-23-001-feat-sync-spec-plan.md` (sync-spec.sh vendoring). That plan stays
  `active` and ships post-launch — sync-spec is invisible to Show HN readers (it's an internal CLI-feeds-site sync
  mechanism for the post-launch v0.4.0 cycle).
- This plan does **not** include any new Worker bindings, content pages, or visual redesign. Anything that would
  meaningfully widen the cherry-pick diff between `dev` and `main` at branch-cut time is out of scope.
- Cosmetic copy edits caught during Gate 11's red-team pass that are NOT load-bearing for credibility (typo fixes, minor
  phrasing improvements that don't change meaning) MAY land on `dev` if discovered before branch-cut, but should not
  delay branch-cut if they accumulate past the deadline.

### Deferred to Follow-Up Work

- **sync-spec workflow** (`2026-04-23-001`): post-launch. Wires the CLI-spec-vendor → site-coverage-matrix loop for
  v0.4.0+.
- **Skill-distribution cutover ops (cache-purge + probe seed)**: runs AFTER `release/<YYYY-MM-DD>-show-hn-cut` lands on
  `main`, not as part of the cut itself. Sequenced in the Pre-launch release PR checklist below.
- **Bundle migration of `~/dev/agent-skills/agent-native-cli/` content into the site repo**: no — handled separately via
  the `agentnative-skill` repo per the master plan (Unit 1 done as of 2026-04-28).
- **Status-string normalization across `docs/plans/*.md`**: post-launch chore. Not credibility-load-bearing.

---

## Context & Research

### Unreleased work on `dev` (the cherry-pick scope)

Snapshot at 2026-04-28 PM (post-PR-#39, post-skill-distribution unit-checkbox sweep):

```text
d6dc041 docs(plans): mark skill-distribution units 1-5 as shipped to staging
f594a92 feat(content): lead with brew install for agentnative-cli (#39)
b89df79 fix(design): copy button stays pinned when pre is horizontally scrolled (#38)
44056eb fix(design): copy-button raised in dark mode + /score Details alignment (#37)
5fc517e feat(install): /install + /install.json endpoints + skill-distribution release runbook (#36)
c33542e chore(pr-template): add Renamed field to Files Modified section (#35)
8dfeb23 docs(plans): point sync-spec plan at agentnative-cli reference impl
e596a72 docs(plans): close out spec-governance plan with unit-by-unit fate
784da98 chore(docs): move misfiled handoffs out of docs/plans
3816a7e docs(plans): add skill-distribution master + site-execution plans
6d76ae9 docs(plans): correct upstream spec repo name in sync-spec plan
9717616 docs(releases): document ci.yml + ci-stub.yml stub-check pattern (#34)
d4abb89 ci: skip heavy PR pipeline on docs-only changes via stub-check pattern (#33)
5f391fd docs(releases): document deploy.yml paths-ignore behavior (#32)
7d94d73 ci(deploy): skip push-trigger on docs-only commits (#31)
1b66c35 docs(plans): add sync-spec.sh vendoring plan (2026-04-23-001)
b1782e4 docs(release): carve out direct-to-dev path for docs/plans/
2fa25c6 docs(plans): H6 day-1 addendum — merge mishap retro + tomorrow's batch (#30)
bfc48d4 fix(scorecards): per-tool reproduction command in CTA (was generic) (#29)
cb296e2 fix: post-H6 cleanup — broken lint on dev + ruleset gate (#28)
c71a6d2 feat(v0.1.3): ANC 100 leaderboard launch — audience signals + methodology (#27)
[+ 25 earlier commits going back to v0 milestones]
```

**The `release/<YYYY-MM-DD>-show-hn-cut` PR's cherry-pick scope is the entire `dev..main` window.** Site-repo precedent
is: full fast-forward from a `release/*` branch cut from `origin/main`, applying the path-filtered diff from `dev`.
There is no selective cherry-picking of feature commits — everything that's been merged to `dev` ships together at
launch time. Plan-only commits (`docs(plans):` etc.) ride along as-is per the carve-out for `docs/plans/**` direct
commits. Two specific must-include items:

1. **`.github/ISSUE_TEMPLATE/`** (Gate 9) — already on `dev` via `70b38f9`, must reach `main` in this PR.
2. **Skill-distribution Units 2–5** (PRs #36 + #37 + #38 + #39 plus their dependent commits) — must reach `main` in this
   PR for the post body to name-drop `anc.dev/skill`. Otherwise omit `/skill` from the post.

### Coordinating in-flight plans (do NOT dual-file)

- `docs/plans/2026-04-24-001-feat-skill-distribution-endpoint-plan.md` — `status: active`. Implementation Units 1–5
  shipped (checkboxes flipped 2026-04-28 PM in commit `d6dc041`); cutover ops pending. **Coordinated, not subsumed:**
  the cutover ops (cache-purge + probe seed) run AFTER `release/<YYYY-MM-DD>-show-hn-cut` lands on `main`. Listed in the
  Pre-launch release PR checklist below.
- `docs/plans/2026-04-27-001-feat-skill-distribution-site-plan.md` — `status: active`. Site execution detail for Units
  2–5. Same coordination as above. Mostly-redundant with the master plan once execution is done; kept active for the
  cutover-ops record.
- `docs/plans/2026-04-23-001-feat-sync-spec-plan.md` — `status: active`. CLI-feeds-site coverage-matrix vendoring loop.
  **Out of scope for this launch.** Stays active through launch.
- `docs/plans/2026-04-23-002-feat-badge-surface-plan.md` — `status: active`. Cross-repo badge surface; site-side units
  U3–U7 shipped on `dev` 2026-04-29 evening (PRs #49, #50, #51). Rides the `release/<YYYY-MM-DD>-show-hn-cut`
  cherry-pick automatically. Surface #4 (spec `docs/badge.md`) and surface #5 (CLI `anc check` post-pass hint,
  `agentnative-cli` todo #017) are deferred post-launch. Plan stays active through launch and flips to `complete` at the
  post-launch retro.

### Release pipeline (existing infrastructure — already in use)

- `RELEASES.md` `## Releasing dev to main` section — the canonical procedure. Branch from `origin/main` (NOT `dev`),
  apply the path-filtered diff from `dev`, open PR base `main`, squash-merge after CI is green. Auto-merge is enabled
  (`feedback_auto_squash_merge.md`).
- `.github/workflows/deploy.yml` — push-to-main triggers production deploy to `anc.dev` via wrangler.
- `.github/workflows/ci.yml` + `ci-stub.yml` — required PR checks. Both pass on docs-only PRs via the stub pattern.
- Branch protection on `main` (per `RELEASES.md` `## Branch protection`): required signatures, linear history,
  squash-only merges, required status checks (`ci`, `guard-docs`, `guard-release-branch`).
- Skill-availability probe (`.github/workflows/skill-availability.yml`) — daily 13:00 UTC. Will fire after launch
  morning; first manual seed run goes in the cutover-ops checklist.

### Institutional learnings (`docs/solutions/`)

Searched via `qmd query "leaderboard scoring fallback"` and `qmd query "cold device verification cloudflare"`. Two
relevant entries:

- `docs/solutions/best-practices/cloudflare-workers-static-assets-custom-headers-2026-04-14.md` — confirms all custom
  headers MUST be set in `src/worker/headers.ts`, never in a `_headers` file. Relevant to Gate 12 if any header issue
  surfaces during cold-device verification.
- `docs/solutions/best-practices/byte-equivalence-regression-tests-for-copied-design-artifacts-2026-04-14.md` — the
  pattern that backstops Gate 11's red-team pass: any string we ship is also tested for byte-equivalence between the
  source and the rendered/twin form, so red-team edits land cleanly without drift between HTML, markdown, and JSON
  surfaces.

A post-launch retro (per the central tracker's Distribution Plan section) compounds any new learnings into
`docs/solutions/`.

### External references

- `Show HN best practices` (HN community wisdom, ad-hoc): post in the morning PT, peak window 9-11 AM. Drop on Tue/Wed/
  Thu, never Mon (fatigue) or Fri (weekend dilution).
- `Cloudflare cache-purge API`: token in 1Password. Per `RELEASES.md` `## Skill releases` runbook step 5.

---

## Key Technical Decisions

- **Gate 8 fallback display strategy is "skipped" status with a one-line reason, not blank rows.** When a registry entry
  has no scorecard, the leaderboard renders a row with the tool name, a `—` for the score, a `skipped` badge, and a
  one-line reason (`"not yet scored: …"`). This honors the central tracker's "do not ship blank rows" requirement while
  keeping the row interactive (linked to a placeholder `/score/<tool>` page that explains the gap). Concrete acceptance
  criteria in U3 below.
- **Cherry-pick scope is "all of `dev`," not selective.** Per `RELEASES.md` precedent and the CLI plan's pattern. The
  release branch resets to `dev` HEAD at branch-cut time. Skill-distribution Units 2–5 ship with everything else.
- **Cold-device verify happens BEFORE branch-cut, not after.** Per the central tracker's Assignment ("Tuesday morning"
  for Gate 12) — surface any DNS / HTTPS / OG / mobile-layout issues with time to fix. After branch-cut is too late.
- **Red-team pass uses `compound-engineering:ce-doc-review`** (the spec-side red-team did the same — PR #13 on spec).
  Single-pass adversarial review across all rendered surfaces, dispatch to the skill, apply prose edits inline, capture
  deferred items as `[later]` notes for v0.2.0 follow-up.
- **No status-flip on this plan until launch ships.** Frontmatter stays `active` until the post lands and the launch
  retro is filed. Then flip to `complete` with a Completion Notes section summarizing what shipped, what slipped, and
  what compounded into `docs/solutions/`.

---

## Open Questions

### Resolved during planning

- **Should this plan subsume the skill-distribution plans?** No. They stay independent and ship via the same release PR.
  Coordination is via the Pre-launch release PR checklist below.
- **Is sync-spec in scope?** No. Its visibility on launch day is zero. Post-launch.
- **Does the `release/<YYYY-MM-DD>-show-hn-cut` PR cherry-pick selectively?** No — full `dev` to
  `release/<YYYY-MM-DD>-show-hn-cut` reset, per `RELEASES.md` precedent.

### Deferred to implementation

- **Q-SITE1: How many of the 100 registry entries have scorecards today vs. need batch-scoring?** Audit at U3 kickoff.
  Decide there whether to (a) run a batch-scoring pass for missing entries, (b) ship the fallback-row design only, or
  (c) mix (e.g., score the top-priority gaps, fall-back the long tail). The central tracker's "full anc100 results"
  requirement is satisfied either way; the question is throughput-vs-coverage.
- **Q-SITE2: Does Gate 11's red-team pass require running on `main`-deployed pages or `dev`-staging-deployed pages?**
  Recommend `dev`-staging — the post points at `anc.dev` (production, `main`) but the content is byte-identical between
  `dev` (staging) and `main` (production) once the release PR lands. Running red-team on staging gives feedback time
  before the cherry-pick. Final-pass smoke check on production after deploy is part of Gate 12.
- **Q-SITE3: Cold-device cellular network — which carrier?** Whatever phone Brett has. The point is not "Verizon vs.
  AT&T" but "different network than the dev machine's WiFi." Single-carrier verification is sufficient.
- **Q-SITE4: Which night to cut the release branch?** Inherits from the CLI plan's Q-CLI2 decision (now superseded by
  parent Q4, then re-superseded 2026-04-29 by a 24h push): **Wednesday 2026-04-29 PT for Thursday 2026-04-30 09:00 AM PT
  post.** Site cuts the same night, ideally after the CLI's `v0.2.0` tag has triggered the homebrew dispatch and the
  formula has updated AND the skill `v0.2.0` tag is published. Tag-cut sequence is: spec `v0.3.0` → CLI `v0.2.0` → skill
  `v0.2.0` (steps 3a/3b) → site `release/<YYYY-MM-DD>-show-hn-cut` (with `skill.json` re-pinned to skill v0.2.0 SHA) →
  site main deploy. See central tracker § Release Versions and Order — SoT for v0.3.0 launch wave for the canonical
  ordered sequence.
- **Q-SITE5: Skill-distribution cutover-ops sequencing.** Cache-purge runs AFTER `release/<YYYY-MM-DD>-show-hn-cut`
  merges and the production deploy completes. The skill-availability probe seed run (`gh workflow run
  skill-availability.yml`) runs AFTER cache-purge confirms `/skill.json` returns the correct headers from `anc.dev`.
  Codified in the Pre-launch release PR checklist.

---

## Implementation Units

- [x] **U1. Fix `scripts/sync-coverage-matrix.sh` rename drift (P0 todo `014`)** — shipped `2467e5c`

**Goal:** Default invocation works on the post-rename layout. `bash scripts/sync-coverage-matrix.sh` (no env vars) syncs
the coverage matrix from `~/dev/agentnative-cli/coverage/matrix.json` cleanly.

**Status:** `not-started`

**Requirements:** P0 todo `014`. Indirect dependency for Gate 8 (post-CLI-launch coverage-matrix re-sync).

**Dependencies:** None. Can run any time.

**Files:**

- Modify: `scripts/sync-coverage-matrix.sh` — three lines (4, 16, 23) per the diff in the todo body.

**Approach:**

- Apply the 3-line patch from
  `.context/compound-engineering/todos/014-pending-p0-coverage-matrix-script-rename-drift.md`.
- Direct-to-`dev` chore commit per the trivial-work exemption (single file, <20 lines, mechanical correction).
- Suggested commit message in the todo body.

**Test scenarios:**

- `unset ANC_ROOT && bash scripts/sync-coverage-matrix.sh` runs without error, syncs matrix.json from
  `~/dev/agentnative-cli/`.
- Cosmetic: re-grep for `agentnative` (without `-cli` suffix) in the script — should return zero hits except the
  `agentnative-cli` and `agentnative-site` matches.

**Verification:**

- Local invocation succeeds with default env. No regressions to existing operators who set `ANC_ROOT` explicitly.

**Acceptance:** Direct-to-`dev` commit lands; post-CLI-launch operator can run the sync without env-var coaching.

**Suggested commit boundary:** `chore(scripts): fix sync-coverage-matrix.sh post-rename drift (agentnative →
agentnative-cli)`

---

- [x] **U2. Audit anc100 leaderboard coverage and decide fill strategy (Gate 8 — Phase 1)** — moot; coverage is 96/96

**Goal:** Know how many of the 100 registry entries have scorecards today, what the gap looks like (which tools, which
tiers), and pick the right mix of batch-scoring vs. fallback rows.

**Status:** `not-started`

**Requirements:** Gate 8.

**Dependencies:** None.

**Files (read-only at audit time):**

- Read: `registry.yaml` — full registry (100 entries).
- Read: `scorecards/` — committed per-tool scorecards.
- Read: `src/build/scorecards.mjs` — the scorecard loader (see `loadScorecards`).

**Approach:**

- Run an audit script (one-off, throwaway): for each entry in `registry.yaml`, check whether
  `scorecards/<name>-v<version>.json` exists. Output: count per tier, list of missing entries.
- Categorize the gap by tier (workhorse / agent / notable). Per `feedback_no_soft_fail_gates.md`: do NOT ship a silent
  gap — every missing scorecard surfaces in some form.
- Decide between:
- **(a) Full batch-scoring pass** — run `anc check` against every binary in the registry, regenerate scorecards.
  Plausible if the gap is small (<10 entries) and all binaries are installable on the dev machine.
- **(b) Fallback-row-only** — render every registry entry, skipped entries get a `skipped` badge with a one-line reason.
  No scorecard regeneration.
- **(c) Mixed** — score what can be scored quickly (workhorse + agent tiers), fall-back the long tail (notable tier).
- Ship the decision as a follow-up commit and proceed to U3 with the chosen approach.

**Test scenarios:**

- Audit script's output is reproducible across two runs (no false positives from filesystem state).
- Decision is recorded in this plan's "Decision Log" addendum (added as a `### Decision Log (2026-04-XX)` subsection
  below the Implementation Units when the call is made).

**Verification:**

- Audit completes; decision is documented and approved by Brett.

**Acceptance:** Brett approves the chosen mix. U3 proceeds with that mix.

**Patterns to follow:**

- `src/build/scorecards.mjs` `loadScorecards` (lines 116–135) for the existence check.
- `scripts/regen-scorecards.sh` (existing) for the batch-scoring path if (a) or (c) is chosen.

---

- [x] **U3. Render full anc100 leaderboard with fallback rows (Gate 8 — Phase 2)** — shipped `d710ade` (#40), 96/96 real
  scores; fallback class never needed

**Goal:** `/scorecards` renders 100 rows. Each row is either a real scored row or a clearly-marked skipped row with a
one-line reason. No blank rows. The leaderboard reads as a credible full-registry render, not a partial sample.

**Status:** `not-started`

**Requirements:** Gate 8. Inherits the U2 audit decision.

**Dependencies:** U2 (audit + decision). U1 (sync-coverage-matrix script working — needed if U2 chose batch-scoring).

**Files (modify):**

- Modify if (a) or (c): per-tool scorecards under `scorecards/`. Generated by `scripts/regen-scorecards.sh` after the
  CLI's `v0.2.0` is installed locally. Re-vendor against spec `v0.3.0` per the CLI plan's U1.5.
- Modify if (b) or (c): `src/build/scorecards-render.mjs` — extend `buildLeaderboardBody()` and the per-row render to
  emit the fallback-row variant. New CSS class `.leaderboard-row--skipped` in `src/styles/site.css`. Skipped row shows
  tool name + tier + a `skipped` badge + a one-line reason (linked to a placeholder `/score/<tool>` that explains the
  gap).
- Modify: `tests/regression.test.ts` — extend regression #4 (scorecard pages) to assert: (i) the leaderboard has 100
  rows, (ii) every registry entry has a corresponding row (scored or skipped), (iii) skipped rows are visually distinct
  from scored rows.

**Approach:**

- Phase the work: scoring pass first (if any), then renderer changes, then test updates, then regression.
- For each skipped tool, write a short reason string in the registry entry (`skipped_reason: ...`) — keeps the data and
  presentation coupled.
- Keep the existing leaderboard sort behavior (score descending; skipped rows sort to the bottom within their tier
  block).

**Test scenarios:**

- After `bun run build`: `dist/scorecards.html` contains exactly 100 `<tr>` rows in the leaderboard `<table>`. (One per
  registry entry.)
- For every `<entry name="X">` in `registry.yaml`, `dist/scorecards.html` contains either a `data-tool="X"` scored row
  or a `data-tool="X"` skipped row.
- Skipped rows render the `skipped` badge and the reason string from the registry entry.
- Lighthouse smoke (cold mobile): `/scorecards` LCP < 2.5s. Skipped-row rendering doesn't introduce CLS.
- Regression test passes for both rendered HTML and `/scorecards.md` byte-twin.

**Verification:**

- Open `https://agentnative-site-staging.brettdavies.workers.dev/scorecards` after dev push: 100 rows, no blanks, no
  visual drift.
- Cold-device check (deferred to U5): scorecards page is readable on a phone.

**Acceptance:** 100 rows render. Lighthouse + regression green. Brett eyeballs the result and approves.

**Patterns to follow:**

- Existing `buildLeaderboardBody` in `src/build/scorecards-render.mjs` — keep the table shape; widen the row variants.
- Tier-based sort logic in `src/build/scorecards.mjs` `computeLeaderboard`.

**Suggested commit boundary:** `feat(scorecards): full anc100 leaderboard with fallback skipped rows`

---

- [x] **U4. Site-copy red-team pass (Gate 11)** — shipped via PR #48 (`feat/red-team-pass-launch-content` → `a71767a`);
  Tier 1 + Tier 2 prose edits across 12 files; Tier 3 deferrals captured in the Red-Team Log below

**Goal:** Every visible string on every public-facing page survives an adversarial reading. No "but X exists," "that's
overclaiming," or "the spec contradicts itself at Y" comments land in the public HN thread.

**Status:** `not-started`

**Requirements:** Gate 11.

**Dependencies:** U3 (so the leaderboard is feature-complete before the prose around it is reviewed).

**Files (modify, prose-only edits expected — no schema changes):**

- Modify: `content/_intro.md` — homepage hero + lede.
- Modify: `content/principles/p[1-7]-*.md` — each principle's prose. (Adversarial review covers Definition / Why /
  Evidence / Anti-Patterns sections; Requirements section stays untouched per the locked principle-page shape.)
- Modify: `content/check.md` — `/check` page copy.
- Modify: `content/methodology.md` — methodology page.
- Modify: `content/about.md` — about page.
- Modify: `src/build/skill.mjs` (if needed) — `buildSkillMarkdown` prose template (trust-model paragraph, programmatic
  section). Voice register is documented in `docs/VOICE.md` `## Surface-Specific Notes`.
- Modify: `src/build/scorecards-render.mjs` — methodology blurb in the leaderboard CTA.
- Optional: `dist/og-image.png` — only re-generate if the post hook above the principles changes meaningfully (Gate 3
  spec-side already handled the spec-repo equivalent; site-side OG image was generated for v0 and only refreshed if the
  homepage hero changes).

**Approach:**

- Dispatch `compound-engineering:ce-adversarial-document-reviewer` in parallel across the 7 principle files (mirrors
  spec-side PR #13's pattern).
- For non-principle pages (`/check`, `/about`, `/methodology`, `/install`), single-pass adversarial review without
  parallel dispatch — they're shorter and have less internal cross-reference.
- Apply prose edits inline that pass the "would I defend this in an HN comment?" test.
- Capture deferred edits (registry-affecting changes, larger restructure) as `[later]` notes for a post-launch v0.2.0
  follow-up. Mirror the spec-side handling.
- Capture `[wontfix]` notes for findings that are intentional design choices (mirror spec-side).
- DO NOT re-run /typeset or /design-review concurrently; this is a copy-only pass.

**Test scenarios:**

- After all edits land, a fresh adversarial pass surfaces zero NEW critical findings (only previously-deferred ones).
- All RFC-keyword annotations (MUST/SHOULD/MAY) in principle pages still render via the rfc-keywords plugin (regression
  test #1 covers this — must stay green).
- byte-equivalence (regression test #3): `dist/p<n>.md` matches `content/principles/p<n>-*.md`. Edits to principle .md
  source must not break this.

**Verification:**

- Adversarial reviewer reports clean (or only deferred findings).
- All existing regression tests still pass.
- Brett does a final read-through of the homepage + 1-2 principle pages and approves.

**Acceptance:** Reviewer dispatch returns clean; Brett approves. Findings written to a `### Red-Team Log` subsection of
this plan with each finding tagged applied / `[later]` / `[wontfix]`.

**Patterns to follow:** Spec-side PR #13 (`ca1e4f6` on `agentnative` `dev`) — same dispatch pattern, same per-finding
classification.

**Suggested commit boundary:** `docs(content): red-team pass on launch surfaces — apply prose edits` (one squash commit
even if multiple files; the unit of work is the red-team session, not per-file).

---

- [ ] **U5. Cold-device reachability + smoke checks (Gate 12)**

**Goal:** anc.dev (and its staging URL) load cleanly on a phone over cellular. DNS resolves, HTTPS is valid, OG tags
render in social-share previews, mobile layout doesn't break, every nav link works, every install command copy-button
works.

**Status:** `not-started`

**Requirements:** Gate 12.

**Dependencies:** None for staging-side smoke; production-side smoke depends on the `release/<YYYY-MM-DD>-show-hn-cut`
PR landing.

**Files (no edits expected — verification only):**

- Read-only: every `dist/*.html`. Verification reaches them via fetch from a phone, not file inspection.

**Approach:**

- **Pre-cut staging smoke (Wednesday 2026-04-29 morning, before cuts begin):** phone on cellular hits
  `https://agentnative-site-staging.brettdavies.workers.dev/` and walks every link in the homepage hero + footer + at
  least one principle page. Verifies HTTPS, mobile rendering, copy-button taps, theme toggle.
- **Post-cut production smoke (Thursday 2026-04-30 morning, before 09:00 AM PT post; after Wednesday night
  `release/<YYYY-MM-DD>-show-hn-cut` merges):** same flow against `https://anc.dev/`. Plus: OG-tag preview via a
  text/Slack/Twitter share to confirm the OG image and meta tags render.
- **Failure handling:** any blocker (HTTPS error, page-load 5xx, broken nav, missing OG tag) blocks the post. Decide
  ship-without-fixing only if the issue is clearly cosmetic and limited in blast radius.
- **Skill-distribution surfaces (`/skill`, `/skill.json`, `/skill.md`):** included in the smoke pass post-cut. Live
  verification of `curl -s https://anc.dev/skill.json | jq -e '.source.commit | length == 40'` per the cutover ops
  checklist.

**Test scenarios:**

- Cold phone (no recent visits, cache cleared) loads the homepage in <2s on cellular.
- `https://anc.dev/p1` through `/p7` all 200; HTML renders; theme toggle works; copy-buttons work.
- `https://anc.dev/skill` 200; per-host commands visible; copy-button works (light + dark mode).
- `https://anc.dev/skill.json` 200; `Content-Type: application/json`; JSON parseable; `source.commit` is 40-char hex.
- OG-tag preview in a fresh-share text shows the correct image + title + description.

**Verification:**

- All checks pass on phone-on-cellular. No HTTPS errors, no broken links, no rendering bugs.

**Acceptance:** Brett does the cold-device pass himself (Wed 2026-04-29 morning for staging, Thu 2026-04-30 morning
before 09:00 AM PT for prod) and confirms green. Failures escalate per the failure-handling note above.

---

- [ ] **U6. Pre-launch release PR cut + post-deploy cutover ops**

**Goal:** Cut `release/<YYYY-MM-DD>-show-hn-cut` from `origin/main`, full diff from `dev`. Squash-merge to `main` after
CI green. Production deploys to anc.dev. Run skill-distribution cutover ops (cache-purge + probe seed). Verify
everything live.

**Status:** `not-started`

**Requirements:** Gates 8, 9, 11, 12 all `done` or `on-dev-pending`. P0 todo 014 done. Skill-distribution Units 2–5
already on `dev`.

**Dependencies:** U1, U2, U3, U4, U5 (or U5 deferred to post-cut). CLI `v0.2.0` tag must be live (so the homebrew tap is
correct on launch morning). Spec `v0.3.0` tag must be live (CLI's U1.5 hard-blocks on it).

**Files (modify / create):**

- Branch operation: `git checkout -b release/<YYYY-MM-DD>-show-hn-cut origin/main` then path-filter the dev diff per
  `RELEASES.md`.
- Modify (during cut): `CHANGELOG.md` if the project keeps one — site CHANGELOG generation is not currently wired (no
  `cliff.toml` in the site repo per the CLI plan's cross-repo recon). Skip if no CHANGELOG infrastructure exists.
- Reference: `RELEASES.md` `## Releasing dev to main` for the full procedure.

**Approach (Tuesday 2026-04-28 PT evening, after spec + CLI + skill tags clear):**

1. **Pre-flight:** confirm `gh release view --repo brettdavies/agentnative v0.3.0` and `gh release view --repo
   brettdavies/agentnative-cli v0.2.0` both succeed. Confirm `agentnative-skill` is PUBLIC.
2. **Branch:** `git checkout main && git pull && git checkout -b release/<YYYY-MM-DD>-show-hn-cut`. Apply diff from
   `dev` per `RELEASES.md` step 3 (`git rev-list main..dev` → cherry-pick selectively, or full reset to dev HEAD per
   repo precedent).
3. **Verify cherry-pick scope:** confirm `.github/ISSUE_TEMPLATE/{config.yml,site-bug.yml}` is in the diff (Gate 9
   passive clear). Confirm skill-distribution PRs (#36, #37, #38, #39) are in the diff. Optionally drop the
   `docs/VOICE.md` hunk from `f594a92` per the user's earlier "drop from release branch" preference (it's an internal
   style guide).
4. **Push + open PR:** `gh pr create --base main --head release/<YYYY-MM-DD>-show-hn-cut ...`. Use the canonical PR
   template.
5. **Wait for CI green:** ci.yml runs against the release branch.
6. **Squash-merge:** auto-merge fires. Production deploys to anc.dev via `deploy.yml`.
7. **Skill-distribution cutover ops** (per the master plan's Unit 5 cutover sequence): a. `gh repo view
   brettdavies/agentnative-skill --json visibility -q .visibility` → confirm PUBLIC. b. Run `bun x playwright test
   --project=skill` against the live `anc.dev` URL. All four host clones must succeed via HTTPS now. Failure here is a
   launch-block. c. Cache-purge `/skill`, `/skill.json`, `/skill.md` via Cloudflare API (token in 1Password). **One-time
   legacy eviction:** also purge `/install`, `/install.json`, `/install.md` once on this first deploy after PR #44 — the
   bundle no longer lives at those paths, but the CDN may still cache pre-split bundle responses. Verify with `curl -sI
   https://anc.dev/skill.json | grep cf-cache-status` returns `MISS` on the first request after purge. d. Smoke-check
   live: `curl -s https://anc.dev/skill.json | jq -e '.source.commit | length == 40'`. Expect `true`. e. Seed daily
   probe: `gh workflow run skill-availability.yml`. Confirm green run within 5 minutes.
8. **Cold-device prod smoke (U5 second pass):** phone on cellular hits `https://anc.dev/` and walks the same checklist.
9. **Update central tracker:** record this entry in the Day-1 Status Log with the gates flipped to `done`. Commit as
   `chore: update launch tracker — pre-launch release cut`.

**Test scenarios:**

- All required CI checks pass on `release/<YYYY-MM-DD>-show-hn-cut`.
- Deploy to anc.dev completes within 2 minutes of merge.
- All cutover-ops smoke checks return expected output.
- Cold-device verification on production passes.

**Verification:**

- All gates flip to `done` in the central tracker.
- Show HN post can name-drop `anc.dev/skill` (skill-distribution shipped).

**Acceptance:** Production is green; central tracker is updated; Brett approves the post body and the assignment moves
to "post the post."

---

## Pre-launch Release PR Checklist

Run this checklist Wednesday 2026-04-29 PT evening, in order. Do not skip steps. Launch-day post lands Thu 2026-04-30
09:00 AM PT.

### Pre-flight (before branching `release/<YYYY-MM-DD>-show-hn-cut`)

- [ ] **Spec `v0.3.0` tag exists and is public:** `gh release view --repo brettdavies/agentnative v0.3.0` succeeds.
- [ ] **CLI `v0.2.0` tag exists and is public:** `gh release view --repo brettdavies/agentnative-cli v0.2.0` succeeds.
- [ ] **CLI homebrew tap formula updated to `v0.2.0`:** `brew info brettdavies/tap/agentnative` shows the new version,
  OR `gh release view --repo brettdavies/homebrew-tap` confirms the latest formula commit references `v0.2.0`.
- [ ] **Skill repo is public:** `gh repo view brettdavies/agentnative-skill --json visibility -q .visibility` returns
  `PUBLIC`.
- [ ] **Site `dev` is at the expected HEAD:** all PRs #36–#39 are merged to `dev`. P0 todo 014's fix is committed.
- [ ] **Site `dev` CI is green:** latest `dev` push triggered a green `ci.yml`.

### Branch + cherry-pick (Wednesday 2026-04-29 PT evening)

- [ ] `git checkout main && git pull --ff-only origin main`
- [ ] `git checkout -b release/<YYYY-MM-DD>-show-hn-cut`
- [ ] Apply diff from `dev` per `RELEASES.md` step 3. Either: (a) full reset (`git reset --hard origin/dev` then
  preserve only the path-filtered diff), or (b) cherry-pick by SHA. Repo precedent leans (a).
- [ ] **Path-filter check:** `git diff main release/<YYYY-MM-DD>-show-hn-cut -- .github/ISSUE_TEMPLATE/` is non-empty
  (Gate 9).
- [ ] **Path-filter check:** `git diff main release/<YYYY-MM-DD>-show-hn-cut -- src/data/skill.json src/build/skill.mjs
  src/worker/headers.ts src/worker/index.ts` shows the skill-distribution PR diffs (Units 2–3 of the master plan).
- [ ] **Path-filter check (badge surface, PRs #49–#51):** `git diff main release/<YYYY-MM-DD>-show-hn-cut --
  src/build/badge.mjs content/badge.md` is non-empty AND `git diff main release/<YYYY-MM-DD>-show-hn-cut --
  src/worker/headers.ts` includes the SVG content-type branch (`isSvg`). Confirms the badge surface ships in this cut.
- [ ] **Optional drop:** drop `docs/VOICE.md` hunk from `f594a92` (per user direction — internal style guide).
- [ ] **Verify no guarded paths leaked:** `git diff main release/<YYYY-MM-DD>-show-hn-cut -- docs/plans/ docs/solutions/
  docs/brainstorms/` → guard-main-docs check should fail-cleanly if anything's wrong; resolve before pushing.

### PR (Wednesday 2026-04-29 PT evening, after branch is ready)

- [ ] `git push -u origin release/<YYYY-MM-DD>-show-hn-cut`
- [ ] `gh pr create --base main --head release/<YYYY-MM-DD>-show-hn-cut --title "chore(release): launch — anc.dev
  v0.x.0" --body "..."` with the canonical PR template populated (Summary + Changelog + Type + Files Modified).
- [ ] CI runs (`ci.yml` + `guard-docs` + `guard-release-branch`) — wait for all green.
- [ ] **Auto-merge fires** (squash). Production deploys.

### Post-merge cutover (immediately after deploy lands)

- [ ] `curl -s https://anc.dev/skill.json | jq -e '.source.commit | length == 40'` returns `true`.
- [ ] `curl -sI https://anc.dev/skill.json | grep -i 'content-type: application/json'` matches.
- [ ] `bun x playwright test --project=skill` against `https://anc.dev/skill` — all 4 host clones green.
- [ ] **Cache-purge** `/skill`, `/skill.json`, `/skill.md` via Cloudflare API. Use the 1Password token by name, DO NOT
  echo the value. **One-time legacy eviction:** also purge `/install`, `/install.json`, `/install.md` once on this first
  deploy after PR #44 — bundle content moved off those paths but the CDN may still serve pre-split cached responses.
- [ ] `gh workflow run skill-availability.yml` — seed first green probe run.
- [ ] **Cold-device prod smoke** — phone on cellular hits anc.dev, walks every link, verifies OG-tag preview in a share.

### Tracker update (Wednesday 2026-04-29 PT evening / Thursday early AM, after smoke is green)

- [ ] Update central tracker `Day-1 Status Log`: add a 2026-04-30 entry summarizing the cut + cutover. Flip Gates 8, 9,
  11, 12 to `done`.
- [ ] Commit as `chore: update launch tracker — pre-launch release cut`.

### Launch-morning final check (Thursday 2026-04-30 AM PT, before 09:00 AM post)

- [ ] Re-curl the live smoke checks. If anything regressed overnight (Cloudflare incident, DNS hiccup), pause the post.
- [ ] Re-verify `gh repo view brettdavies/agentnative-skill --json visibility` → `PUBLIC`.
- [ ] Brett posts on HN.

---

## Risks & Mitigations

| Risk                                                                                                                  | Mitigation                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate 8 batch-scoring blows up — too many missing scorecards, can't fill in time                                       | Fallback-row-only path (U2 decision option (b)). Trade coverage for credibility — skipped rows with reasons beat blank rows OR "we cherry-picked the working tools."                                                                                                |
| Adversarial reviewer surfaces a load-bearing finding mid-week (something that requires a data change, not just prose) | Defer to v0.2.0 with a `[later]` note. Don't expand Gate 11 scope. Only ship if truly factually wrong.                                                                                                                                                              |
| Cold-device verification reveals a Cloudflare cache / DNS / HTTPS issue Wednesday                                     | If reproducible, escalate immediately — Cloudflare's CN headers + custom-domain attach is tested but not invincible. Push the post by 24h if the fix is non-trivial.                                                                                                |
| `release/<YYYY-MM-DD>-show-hn-cut` PR's CI fails on a guarded-path or stub-check edge case                            | Read the failure carefully. The stub-check pattern is documented in `RELEASES.md` `### Why the stub` — common failures are: ci.yml's paths-ignore drift, guard-main-docs catching a docs commit. Resolve before merging. Do not bypass via admin.                   |
| Skill-distribution e2e fails post-cutover (Playwright `--project=skill` red against live anc.dev)                     | Investigate IMMEDIATELY — the skill bundle URLs are user-facing on launch day. If the issue is the producer-repo public flip didn't propagate, retry. If it's a header issue (CN rewrite firing on `.json`), it's a Worker bug — patch and re-deploy before launch. |
| User cherry-picks `docs/VOICE.md` into the release branch by accident                                                 | Path-filter check in the checklist catches it. If it slips through, that's an accepted outcome (per earlier user direction).                                                                                                                                        |

---

## Files Touched (this repo)

```text
src/
  build/
    skill.mjs              # MODIFY (red-team prose pass — only if findings warrant)
    scorecards-render.mjs  # MODIFY (Gate 8 fallback rows; red-team methodology blurb)
  styles/
    site.css               # MODIFY (new .leaderboard-row--skipped class)

scripts/
  sync-coverage-matrix.sh  # MODIFY (P0 todo 014 — 3 lines)

scorecards/
  *.json                   # MODIFY (only if U2 decision is (a) or (c) — batch-score new entries)

content/
  _intro.md                # MODIFY (red-team pass)
  about.md                 # MODIFY (red-team pass)
  check.md                 # MODIFY (red-team pass)
  methodology.md           # MODIFY (red-team pass)
  principles/p[1-7]-*.md   # MODIFY (red-team pass)

tests/
  regression.test.ts       # MODIFY (regression #4 extension — 100-row leaderboard assertion)

docs/
  plans/
    2026-04-28-001-feat-show-hn-launch-readiness-plan.md  # this plan, committed alongside the work
```

The `release/<YYYY-MM-DD>-show-hn-cut` PR carries the entire `dev` diff — including the skill-distribution PRs from
earlier in the week. The above is the NEW scope this plan introduces.

---

## Red-Team Log (2026-04-29)

Adversarial review session run via 8 parallel `compound-engineering:document-review:adversarial-document-reviewer`
dispatches: 7 per-principle reviewers + one combined supporting-pages reviewer (`_intro`, `about`, `check`,
`methodology`, `install`, `src/data/skill.json` prose). Findings classified `applied` / `[later]` / `[wontfix]`.

All `applied` items shipped via PR #48 (`feat/red-team-pass-launch-content`, squash `a71767a`, merged
2026-04-29T20:35Z). The summary below is the durable record of what changed and what was deferred.

### Tier 1 — site-spec drift + factual errors (all `applied`)

- **Site-spec drift caught up.** P5 Definition + Why and P7 Why-Agents-Need-It paragraphs ported from spec PR #13's
  resolved wording (`agentnative` `ca1e4f6`, never propagated to site since no sync-spec mechanism is wired yet).
- **Check-ID truthing across all 7 principle pages.** Every "Measured by check IDs" trailer verified against
  `scorecards/*.json` and rewritten. Real ship-set:
- P1: `p1-non-interactive`, `p1-flag-existence`, `p1-env-hints`
- P2: `p2-json-output` only
- P3: `p3-help`, `p3-version` only
- P4: `p4-bad-args` only
- P5: none ship; trailer now says so
- P6: `p6-sigpipe`, `p6-no-color-behavioral`, `p6-no-pager-behavioral`
- P7: `p7-quiet` only
- **Fake check IDs in `/check.md` example output** (`p3-after-help`, `p4-process-exit`, `p1-non-interactive-source`)
  replaced with real ones; "Rust today" → "Rust and Python today".
- **Binary-name standardization:** `agentnative` → `anc` across `/check`, `/install`, `_intro`, with one-line "(`anc`
  and `agentnative` are aliases)" callout where the longer form survives.
- **`/install` platform coverage corrected** to actual reality (Apple Silicon macOS 14/15 + x86_64 Linux bottles only;
  Intel Mac and arm64 Linux compile from source). "Signed bottles" claim removed — Homebrew uses SHA256 integrity
  hashes, not cryptographic signing. cargo-binstall prerequisite called out.

### Tier 2 — defensible HN-bait softening (all `applied`)

- **P1**: "single most common cause" → "a leading cause"; stdin/stderr inconsistency in SHOULD bullet fixed;
  `--no-browser` MUST narrowed to interactive OAuth (with explicit static-token alternative).
- **P2**: `text|json|jsonl` MUST softened to "machine-readable format flag"; sysexits.h provenance for codes 77/78 added
  (with acknowledgement that most CLIs don't make the auth/config distinction at the exit-code layer);
  `OutputFormat`/`OutputConfig` Rust idiom moved out of MUST into a "Rust reference implementation" subsection;
  `jq`/`dasel` passthrough exemption added to envelope SHOULD; error-stderr rephrased.
- **P3**: language-agnostic preamble naming `cobra`, `argparse`, `docopt`, `gh`, `kubectl` analogs; "2-3 examples"
  softened to "at least one … 2-3 when multiple use cases"; `--output json` SHOULD now hedged on P2 capability.
- **P4**: sysexits.h provenance paragraph added to Why; "self-describing" softened to "paired with this standard's
  published mapping"; "config and auth before any network call" scoped to "locally-verifiable invariants" (auth often
  needs a network call); P2 cross-reference for stderr/stdout discipline; `process::exit` only-in-main carved out for
  signal/panic handlers.
- **P6**: `--timeout` 30s default reframed as "we recommend"; subcommand-naming taxonomy expanded for verb-only (`git
  commit`); single-operation-tool exemption (`grep`/`curl`/`jq`) added to subcommands-not-flags SHOULD; three-tier
  dependency framed as implementation note vs. observable property; SIGPIPE example acknowledges Go and Python
  equivalents.
- **P7**: Why paragraph rewritten to cover non-LLM agents (token cost for LLMs, parse cost for scripts); "10,000 lines"
  softened to "tens of thousands"; "high-signal" defined explicitly in Definition; "falsey-value parser" clap-jargon
  replaced with explicit override semantics.
- **`_intro.md`**: "shells out to a binary" → "frequently shells out … the lowest-common-denominator interface where
  APIs don't exist or don't compose"; "every popular CLI tool" → "100 widely-used CLI tools"; example check IDs in
  trailer text (`p1-non-interactive`, `p2-json-output`, `p6-sigpipe`) updated to real ones.
- **`about.md`**: new `## Provenance` section ("authored and maintained in the open by Brett Davies … pressure-tested in
  public, not a ratified industry standard"); new `## Prior art` section citing **clig.dev**, **12factor.net**, **IETF
  RFC 2119**, and **Cloudflare's
  [Building a CLI for all of Cloudflare](https://blog.cloudflare.com/cf-cli-local-explorer)**
- the 2026-04-13 [HN thread](https://news.ycombinator.com/item?id=47753689) — the actual external validation source from
  the vault research archive that informed P3, P4, and P6 framing directly. Redirect promise softened to future tense;
  numbered-list rendering bug fixed.

- **`methodology.md`**: explanatory paragraph added acknowledging the headline pass rate weighs MUST and SHOULD
  violations equally; readers pointed to the principles-met column for conformance. "Warn at most once" allowance for
  the audience classifier justified (signal-check correlation rationale).

### Tier 3 — `[later]` (deferred to v0.4.0 + ride along to spec deferrals)

These mirror or extend the spec's already-deferred items; they ship in the v0.4.0 cycle alongside the matching spec
edits:

- **P3**: language-agnostic restructuring of Evidence/Anti-Patterns sections (mostly `clap`/Rust today). Spec already
  deferred this to v0.4.0 with `applicability` cleanup tied to the registry parser.
- **P4**: Rust-leaning structural framing of the `try_parse()` MUST and the `thiserror` enum SHOULD. Reframe as
  observable behavior with Rust as worked example. Strategic, not urgent.
- **P5**: `--no-interactive` composition with `--force`/`--yes` (do you error or dry-run when neither is set + non-TTY
- headless?); `read-write-distinction` MUST verifiability rewrite (currently subjective); flag-name prescription →
  contract-first framing (`--dry-run` vs. `plan`/`apply` etc.); rollback → reconciliation framing in Anti-Patterns;
  idempotency precision (state-equivalence vs. retry-safety).

- **P6**: `NO_COLOR` and `TERM=dumb` lumped together (no-color.org's "any non-empty value" semantics not surfaced);
  `--principle 6 .` example uses Rust-flavored anti-pattern phrasing; `jaq` vs `jq` in pipeline example (judgment call —
  `jaq` is technically fine but `jq` is the well-known reader expectation).
- **P7**: `100 items` ceiling justification; `--timeout` MUST/SHOULD overlap with P6 (P6 has conditional MUST for
  network CLIs; P7 has SHOULD universal — both true, but the relationship isn't on the page); MAY → SHOULD promotion for
  "automatic verbosity reduction in non-TTY contexts" (registry coordination required).
- **`skill.json`**: SHA pin discipline. Current `expected: 47a76cce…` is stale vs. live HEAD; `git clone --depth 1`
  install command lands on HEAD, so verify command always reports mismatch. Plan U6 already accounts for re-pinning to
  skill v0.2.0 SHA at release cut. Per-host install paths (`~/.codex/skills/`, `~/.cursor/skills/`) need verification
  against host loader conventions — likely some don't actually load skills from those paths and need different extension
  mechanisms. Defer to v0.4.0 alongside skill ecosystem expansion.
- **`methodology.md`**: `fd`'s `file-traversal` profile is a no-op in v0.1.3 (the row admits "reserved for future
  suppressions" but a careful reader still asks "why is `fd` profiled then?"). Either remove from applied-profiles table
  or add explicit "no-op today, reserved for v0.2 suppressions" annotation. Low impact.

### `[wontfix]`

- **Rust-only language examples in MUST bullets** (`FalseyValueParser` in P1, `try_parse()` in P4): the language
  examples are illustrative — they show the *non-obvious* gotchas concretely. The principle is language-agnostic; the
  example is what makes the gotcha tractable. Keep.
- **"Agents cannot open browsers"** (P1): an HN commenter could cite Anthropic's computer-use API or browser-use as
  counterexamples. The Scope paragraph already calls out computer-use desktop agents as a deferred case; the claim is
  true for the subprocess-agent definition that's the spec's primary scope. Keep.
- **Definite article in "The agent-native CLI standard"** (`_intro.md` H1): provenance paragraph in `/about` now earns
  the "the" by stating explicitly that this is one author's proposal pressure-tested in public. Brand survives.

---

## Sources & References

- **Central tracker:**
  `~/.gstack/projects/brettdavies-agentnative/brett-dev-design-show-hn-launch-inversion-20260427-144756.md`
- **Launch handoff:** `~/dev/agentnative-spec/.context/handoffs/2026-04-27-001-show-hn-launch-readiness-handoff.md`
- **Sibling per-repo plans:**
- Spec: `~/dev/agentnative-spec/docs/plans/2026-04-28-001-feat-show-hn-launch-readiness-plan.md` (Gates 1–5, 9, 11)
- CLI: `~/dev/agentnative-cli/docs/plans/2026-04-28-001-feat-show-hn-launch-readiness-plan.md` (Gate 7)
- **Coordinated in-repo plans (NOT subsumed):**
- `docs/plans/2026-04-24-001-feat-skill-distribution-endpoint-plan.md` (skill-distribution master)
- `docs/plans/2026-04-27-001-feat-skill-distribution-site-plan.md` (site execution Units 2–5)
- `docs/plans/2026-04-23-001-feat-sync-spec-plan.md` (post-launch)
- **P0 todo (local-only, gitignored):**
  `.context/compound-engineering/todos/014-pending-p0-coverage-matrix-script-rename-drift.md`
- **Existing site code:**
- `src/build/scorecards.mjs`, `src/build/scorecards-render.mjs` — leaderboard renderer
- `src/build/build.mjs` — build orchestrator
- `tests/regression.test.ts` — regression suite (regression #4 covers leaderboard pages)
- `RELEASES.md` — branch + release protocol
- **Solutions referenced:**
- `docs/solutions/best-practices/cloudflare-workers-static-assets-custom-headers-2026-04-14.md`
- `docs/solutions/best-practices/byte-equivalence-regression-tests-for-copied-design-artifacts-2026-04-14.md`
- **Session memory (auto-loaded):** `~/.claude/projects/-home-brett-dev-agentnative-site/memory/MEMORY.md` —
  particularly the dev-flow squash-merge, auto-squash-merge, no-soft-fail, CI env parity, and route-visual-via-skills
  entries.
- **Global rules:** `~/.claude/CLAUDE.md` — branch discipline, secret handling, no AI attribution, plans-on-dev
  carve-out, long-artifacts-go-to-files.
