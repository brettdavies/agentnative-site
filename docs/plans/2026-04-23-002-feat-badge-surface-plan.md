---
title: "feat: Badge surface for agent-native-standard conformance"
type: feat
status: completed
date: 2026-04-23
last-revised: 2026-04-30
shipped_in: site-side units U3–U7 shipped on `feat/badge-surface` (merged 2026-04-29 ahead of Show HN launch). Live at /badge and /badge/<tool>.svg.
parents:
  - docs/plans/2026-04-28-001-feat-show-hn-launch-readiness-plan.md
---

# feat: Badge surface for agent-native-standard conformance

> **Post-launch update (2026-04-30):** All site-side units (U3–U7) shipped and live in production:
>
> - `https://anc.dev/badge` — convention page (200 OK)
> - `https://anc.dev/badge/<tool>.svg` — per-tool live-score SVGs (200 OK; 96 SVGs emitted by current build)
> - Per-tool scorecard pages render the embed snippet above the eligibility floor and the gap-hint below
> - Leaderboard callout at `/scorecards` cites the eligible-vs-total count and links to `/badge`
>
> **Out-of-repo work still pending** (intentional — separate repos, separate lifecycles):
>
> - **U1 + U2 (spec-side surface #4):** `agentnative-spec/docs/badge.md` and `README.md` cross-references are
>   not yet created (`gh api repos/brettdavies/agentnative-spec/contents/docs/badge.md` → 404 as of 2026-04-30).
>   The site `/badge` page is the canonical author-facing surface for now.
> - **Surface #5 (CLI hint after passing `anc check`):** tracked as `agentnative-cli` todo
>   `017-pending-p1-agent-native-badge-hint-on-passing-check.md`. Will surface in a future CLI release.
>
> Status flipped to `completed` because every unit owned by this repo (U3–U7) is shipped. The two pending pieces
> (U1, U2 in agentnative-spec; surface #5 in agentnative-cli) are tracked in their respective repos' planning
> surfaces, not here.

---

> **Origin: filed 2026-04-23 in `agentnative-spec` as `docs/plans/2026-04-23-001-feat-badge-surface-plan.md`; moved to
> `agentnative-site` on 2026-04-29 (same date as the launch-eve design pass) to consolidate ownership in the
> launch-coupled hub repo. Three of the four launch-wave surfaces ship from this repo, so the coordinator lives here.**
>
> **Status: site-side units shipped 2026-04-29 — spec-side and CLI deferred post-launch.** Site-side surfaces #1–#3
> (per-tool scorecard embed snippet, leaderboard callout, `/badge` convention page) plus the build-time SVG render
> (`badge-maker`) and the worker `image/svg+xml` content-type wiring landed on `feat/badge-surface` and merge into
> `dev` ahead of the Show HN launch wave (Thu 2026-04-30 09:00 PT). Surface #4 (spec `docs/badge.md`) is deferred
> post-launch — the `/badge` page is the canonical author-facing surface for launch, and the spec repo gets a
> doctrinal mirror once the launch dust settles. Surface #5 (CLI hint after passing `anc check`) remains tracked
> separately as `agentnative-cli` todo #017 (`017-pending-p1-agent-native-badge-hint-on-passing-check.md`),
> post-launch.
>
> **Decisions confirmed during the 2026-04-29 design pass:**
>
> - **Model: per-tool, live-score** ("Model C" in the design conversation). Each scored tool has its own badge SVG
>   reflecting that tool's actual score; the badge links to the tool's live scorecard page so a reader can verify the
>   claim. Universal "this references the standard" stickers and per-tool static-text "conformant" badges were both
>   considered and rejected in favor of the live-score model.
> - **Render: self-host SVGs via [`badge-maker`](https://www.npmjs.com/package/badge-maker) at site build time.** No
>   shields.io endpoint, no shields.io account, no third-party render dependency. `badge-maker` is the same library
>   shields.io uses internally — visually identical output, zero runtime upstream. Embed shape:
>   `[![agent-native](https://anc.dev/badge/<tool>.svg)](https://anc.dev/scorecards/<tool>)`.
> - **Embed-box display: threshold-gated, with helpful hints below the floor.** Scorecards above the eligibility floor
>   show a copy-paste embed snippet inline. Scorecards below the floor show a brief "your score is X — here's what to
>   address: [top issues]" block instead. Soft guidance, not public shaming. Aligns with the trust-and-verify posture.
>
> **Decisions locked during 2026-04-29 implementation (resolving the four formerly TBD items):**
>
> - **Eligibility floor: ≥80% pass-rate.** Captures the top quartile of the 96-tool launch corpus (24 tools currently
>   eligible). Above the 70% median so the badge means "upper segment"; below 90% so the embed snippet appears on a
>   meaningful portion of pages. Single gate — no second principle-count gate, since 80% pass-rate already implies most
>   principles are met.
> - **Score-text format: `XX%`** (rounded percent). Matches the leaderboard's score column. `91/100` and
>   `6/7 principles met` were the alternatives; the rounded percent reads cleanest at badge size.
> - **Color thresholds: ≥80% brightgreen, 60–79% yellow, <60% red.** Matches the brightline floor and what readers
>   intuit from the leaderboard. Below-floor scorecards still get a rendered SVG so a tool watching its own regression
>   sees the visual color drop.
> - **Version-pinning: `/badge/<tool>.svg` is always-latest; the badge label carries `agent-native vMAJOR.MINOR`.**
>   Trust-and-verify means the URL must reflect current state, not a snapshot. Spec version goes in the label text, not
>   the path.

## Overview

A shields-style badge that CLI authors can embed in their own READMEs to declare agent-native-standard conformance. The
badge links to the live `anc.dev/scorecards/<tool>` scorecard, so any reader can follow a claim to current evidence
rather than trusting a self-declaration.

This plan coordinates the **cross-repo badge surface** — five surfaces across three repos (see Surface layout below).
The plan lives in `agentnative-site` because the site is the launch-coupled hub: three of the four launch-wave surfaces
(scorecard page embed snippet, leaderboard callout, `/badge` convention page) are site-owned. Surface #4 (spec
`docs/badge.md` doctrinal convention) is implemented in `agentnative-spec`; this plan describes that work but does not
ship it from this repo.

## Problem Frame

The SoT contract (`sot_contract.md` in session memory) commits to a "trust-and-verify" posture: conformance claims must
be checkable against live verification, not just a static marker. Today a CLI author who wants to advertise
agent-native-standard adherence has no canonical way to do so — a self-hosted SVG badge linked to
`anc.dev/scorecards/<tool>` closes that gap, but only if:

1. The spec defines what "claiming the badge" means (conformance floor, version pinning, honest grading expectations).
2. The site renders per-tool SVGs consistent with that meaning.
3. The leaderboard has enough baseline tools that a badge sits in a credible context.

Item 1 is the spec-side surface (#4 below). Items 2 and 3 are site-side surfaces; (3) is already met as of the
2026-04-29 design pass (96 scorecards on `dev`).

## Requirements Trace

- R1. Define the minimum conformance posture a CLI must meet to claim the badge (score threshold, required principles,
  handling of exceptions).
- R2. Define the version-pinning convention — does the badge cite the spec version it was scored against, the tool
  version scored, or both?
- R3. Define the honesty expectation — self-grading is acceptable, but the badge URL must resolve to a live scorecard
  that anyone can re-run.
- R4. Define the removal / change policy — when a tool regresses below the threshold, what happens to the badge claim?

## Surface layout

The badge surface is implemented across five surfaces, four of which are launch-coupled. Spec owns surface 4; site owns
surfaces 1, 2, and 3; CLI owns surface 5.

| #   | Surface                               | Owner repo                            | Launch-wave?         | Status                          |
| --- | ------------------------------------- | ------------------------------------- | -------------------- | ------------------------------- |
| 1   | Per-tool scorecard page embed snippet | `agentnative-site` (this plan, U5)    | yes                  | ✅ shipped 2026-04-29            |
| 2   | Leaderboard callout linking to /badge | `agentnative-site` (this plan, U6)    | yes                  | ✅ shipped 2026-04-29            |
| 3   | `/badge` convention page              | `agentnative-site` (this plan, U4)    | yes                  | ✅ shipped 2026-04-29            |
| 4   | `docs/badge.md` doctrinal convention  | `agentnative-spec` (this plan, U1+U2) | **no** — post-launch | deferred — `/badge` page covers |
| 5   | `anc check` post-pass embed hint      | `agentnative-cli` (todo #017)         | **no** — post-launch | post-launch                     |

> Site-side units U3–U7 (added during the 2026-04-29 implementation) cover surfaces 1–3 plus the build-time SVG render
> (`badge-maker`) and the worker `image/svg+xml` content-type wiring. Spec-side U1+U2 remain in this plan as
> post-launch follow-up — the `/badge` page (surface #3) carries the doctrinal copy at launch, and the spec repo gets
> a `docs/badge.md` mirror once the launch wave settles.

This plan tracks U1+U2 (surface 4) explicitly; surfaces 1–3 are site-owned and tracked by additional units (or a
separate site-side companion plan, depending on how the work is sliced when the launch-eve PR pair is cut). Surface 5 is
filed at
`agentnative-cli/.context/compound-engineering/todos/017-pending-p1-agent-native-badge-hint-on-passing-check.md`
(local-only per project convention; not committed).

## Scope Boundaries

- Badge SVG rendering (the `dist/badge/<tool>.svg` build step using `badge-maker`) — owned by this repo
  (`agentnative-site`); will be filed as additional units in this plan or a sibling plan when the launch-eve PR is cut.
- Leaderboard UX — separate concern on the site.
- Any changes to the `anc` CLI scoring itself — out of scope; the spec defines what the badge means, the CLI already
  scores.
- The post-pass CLI hint — owned by the CLI repo per the todo above; deliberately deferred until the spec convention
  publishes the eligibility floor.

---

## Context & Research

### Relevant Code and Patterns

- `agentnative-spec:CONTRIBUTING.md` — contains the coupled-release protocol and AI disclosure policy; badge convention
  may extend this doc or live in a new `agentnative-spec:docs/badge.md`. Decision deferred to U1.
- `agentnative-spec:principles/AGENTS.md` — governance for principle edits; the badge convention inherits the
  MINOR-on-contract-change versioning rule.
- `src/build/scorecards.mjs` — `computeScore()` and `computePrincipleScore()` already exist in this repo. The build-time
  SVG step reads from these.

### Institutional Learnings

- `sot_contract.md` (session memory) — hybrid propagation (IDs are SoT, versions are decoupled). Badge URL structure
  must honor this: badge cites the spec version, the tool version, and the scorecard JSON SHA, not the running tool's
  opinion of itself.

### External References

- [`badge-maker` (npm)](https://www.npmjs.com/package/badge-maker) — the renderer the site uses at build time to emit
  `dist/badge/<tool>.svg`. Same library shields.io uses internally; identical visual output, no runtime upstream
  dependency. The spec convention prose must be specific enough that the renderer's parameters (label, message format,
  color thresholds) can be derived without reinterpretation.

---

## Key Technical Decisions

- **Convention lives in spec repo, rendering lives in site repo.** Splitting avoids entangling doctrine with visual
  chrome. Doctrine evolves slowly (MINOR bumps); rendering can iterate freely.
- **Plan lives in the site repo as the cross-repo coordinator** (this file). Three of four launch-wave surfaces ship
  from this repo, so the launch-coupled hub holds the plan.
- **Badge claim is a doc edit, not a registry addition.** No new machine-readable artifact here — just prose that
  authors cite when embedding the badge. The registry (`registry.yaml` in this repo) is already the machine-readable
  record of scored tools.
- **Defer doc location (CONTRIBUTING.md section vs. new docs/badge.md) to U1.** Both work; the right call depends on how
  much prose the convention actually needs, which is easier to judge when drafting.

## Open Questions

### Resolved During Planning (2026-04-23 + 2026-04-29)

- Does the badge require a minimum score? — **Yes.** Floor value still TBD (see Deferred), but the presence of a
  threshold is non-negotiable.
- Does the spec own the render? — **No.** Spec owns the contract; site owns the SVG render via `badge-maker` at build
  time.
- What model does the badge follow — universal sticker, per-tool static-text, or per-tool live-score? — **Per-tool
  live-score** ("Model C"). Each tool gets a badge whose text reflects that tool's actual current score; the badge links
  to the live scorecard for verification.
- Do we depend on shields.io? — **No.** Self-host SVGs via `badge-maker` (same library shields.io uses). No third-party
  endpoint, no account, no runtime upstream.
- Embed-box display on per-tool scorecard pages — gated or always-on? — **Threshold-gated, with helpful below-floor
  hints.** Above-floor scorecards show the embed snippet; below-floor scorecards show "your score is X — here's what to
  address" instead. No public shaming.

### Deferred to Implementation

- **Eligibility floor value** (the actual percentage cutoff that lets a tool legitimately embed the badge) — TBD. Draft
  in U1, pressure-test before publishing.
- **Score-text format** on the badge — `91%` vs `91/100` vs `6/7 principles met` vs some hybrid. Decide during U1 based
  on what reads cleanest at badge size and aligns with the leaderboard's own score presentation.
- **Color thresholds** for the badge — where green / yellow / red cut. Public commitment; should match the
  scorecard-page styling so a reader sees the same color story across surfaces.
- **Version-pinning convention in the URL or JSON** — `/badge/<tool>.svg` (always-latest) vs
  `/badge/<tool>/<spec-version>.svg` (pinned). The SoT contract argues for visible spec_version somewhere; URL is
  loudest, badge label text is quieter, scorecard JSON is invisible-but-citable.
- Whether to require a minimum `anc` CLI version scored against — likely yes, but exact floor is a U1 call.

---

## Implementation Units

> **Note:** U1 and U2 below describe surface 4 (spec-side doctrinal convention). They ship from `agentnative-spec`,
> not from this repo. Site-side surfaces 1–3 will be added as additional units (or a sibling plan) when the launch-eve
> PR pair is cut.

- [ ] U1. **Draft badge-claim convention** *(ships from `agentnative-spec`)*

**Goal:** Produce the prose that defines what claiming the badge means.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None (spec-side prose). Coordination with site-side render units (when filed) under the
coupled-release protocol — the eligibility floor and score-text format set in U1 are read by the site's `badge-maker`
build step.

**Files (paths in `agentnative-spec`):**

- Create (if prose is >~40 lines): `docs/badge.md`
- Modify (if prose is short): `CONTRIBUTING.md` (add `## Badge claim` section)
- Modify: `README.md` (add a pointer under "Related" or "## Contributing")

**Approach:**

- Write out the conformance floor, version-pinning rule, honesty expectation, and regression policy as prose.
- Choose between `docs/badge.md` vs `CONTRIBUTING.md` based on length — if the convention fits in under ~40 lines, keep
  it in `CONTRIBUTING.md` under a new `## Badge claim` section; if longer, split to `docs/badge.md`.
- Cite `sot_contract.md` framing ("trust-and-verify, badge links to live evidence").
- Reference the `badge-maker` parameter set (label, message format, color thresholds) so site-side render is mechanical.

**Patterns to follow:**

- `agentnative-spec:CONTRIBUTING.md` voice — direct, tables where choices branch, examples inline.
- Frontmatter date rule from `agentnative-spec:principles/AGENTS.md` — badge-convention doc gets `last-revised:
  YYYY-MM-DD`.

**Test scenarios:**

- Happy path: a CLI author reading the convention can answer "what score do I need, what version do I cite, what URL do
  I embed" without asking a maintainer. Verification is a readability pass, not an automated test.
- Edge case: the convention addresses what happens when the tool regresses below threshold (badge URL should
  auto-reflect the drop via live scorecard — no separate action required).
- Test expectation: no automated tests. This unit is prose-only. Verification is human review + the site-side render
  units being able to implement against the contract without needing clarification.

**Verification:**

- A human reader (ideally a CLI author candidate) can explain, in their own words, what the badge guarantees and what
  obligations it places on them.
- The site-side render units can be filed referencing this doc without needing to invent convention details.

---

- [ ] U2. **Wire references into top-level docs** *(ships from `agentnative-spec`)*

**Goal:** Make the convention discoverable from the spec repo's entry points.

**Requirements:** R1 (discoverability complements definition)

**Dependencies:** U1

**Files (paths in `agentnative-spec`):**

- Modify: `README.md` (add pointer under "Related" or a new "Badge" subsection)
- Modify: `CONTRIBUTING.md` (cross-link if U1 placed the convention in `docs/badge.md`)

**Approach:**

- One-line pointer in README pointing at the convention doc.
- If the convention lives in `docs/badge.md`, `CONTRIBUTING.md` gets a cross-link under a relevant section.
- The README pointer should also mention `anc.dev/badge` (the site `/badge` convention page, surface #3) as the
  canonical author-facing surface.

**Patterns to follow:**

- Existing "## Related" section in `agentnative-spec:README.md` (links to `anc.dev`, `agentnative-cli`,
  `agentnative-site`).

**Test scenarios:**

- Happy path: reader of spec README finds the convention within one click.
- Test expectation: link-check pre-push hook (`agentnative-spec:scripts/check-links.mjs`) catches a broken link if U1's
  filename changes between drafting and landing.

**Verification:**

- `agentnative-spec:scripts/hooks/pre-push` passes (link check + markdownlint + validate-principles — badge convention
  doesn't touch principles but the hook runs anyway).

---

### Site-side units (added 2026-04-29 during implementation)

The five units below ship from this repo and cover surfaces 1–3 of the badge surface. All shipped on
`feat/badge-surface` ahead of the Show HN launch wave.

- [x] U3. **`badge-maker` dependency + build-time SVG render**

**Goal:** Site build emits `dist/badge/<tool>.svg` for every scored tool via
[`badge-maker`](https://www.npmjs.com/package/badge-maker) — same library shields.io uses internally, zero runtime
upstream dependency.

**Files:** `package.json`, `bun.lock`, `src/build/badge.mjs` (new), `src/build/build.mjs`, `src/build/util.mjs` (adds
`BADGE_FLOOR` and `SPEC_VERSION` constants), `tests/build.test.ts` (color-threshold + label-format tests).

**Verification:** `bun run build` produces 96 SVGs in `dist/badge/`; `bun test` covers `badgeColor`, `badgeFormat`, and
`renderBadgeSvg`.

- [x] U4. **`/badge` convention page (surface #3)**

**Goal:** Author the doctrinal page CLI authors land on when they want to know what claiming the badge means — floor,
score format, color bands, version-pinning rule, honesty + regression policy, claim flow.

**Files:** `content/badge.md` (new), `src/build/build.mjs` (wire into `subPages` array + sitemap `extraPaths`).

**Verification:** Page renders at `/badge.html`; markdown twin at `/badge.md`; included in sitemap.

- [x] U5. **Per-tool scorecard embed snippet (surface #1)**

**Goal:** Threshold-gated section on `/score/<tool>`. Above floor: copy-paste embed snippet + live SVG preview. Below
floor: brief "your score is X — top issues are the place to start" hint pointing at `/badge`.

**Files:** `src/build/scorecards-render.mjs` (`buildEmbedMarkdown`, `renderEligibleEmbed`, `renderBelowFloorHint`,
markdown-twin parity), `src/styles/site.css`, `tests/build.test.ts`.

**Verification:** Tests cover the 0.79/0.80 brightline, gap-math singular/plural, top-issues vs full-checks pointer
branches.

- [x] U6. **Leaderboard callout linking to /badge (surface #2)**

**Goal:** Brief callout between the leaderboard table and the methodology section, citing the live eligible/total count
and routing readers to `/badge`.

**Files:** `src/build/scorecards-render.mjs` (`buildLeaderboardBody`), `src/styles/site.css`, `tests/build.test.ts`.

**Verification:** Tests confirm the callout cites the floor + eligible/total count and excludes unscored entries from
the eligible numerator.

- [x] U7. **Worker SVG content-type + CORS + cache**

**Goal:** `/badge/*.svg` served with `Content-Type: image/svg+xml; charset=utf-8`, `Access-Control-Allow-Origin: *`, and
the standard short cache so re-scored tools' badge colors flip within a TTL of the next site build.

**Files:** `src/worker/headers.ts` (add `isSvg` branch), `tests/worker.test.ts`.

**Verification:** Tests cover the production SVG branch, the staging-host noindex composition, and the negative case
(non-`.svg` paths keep HTML-branch headers).

---

## System-Wide Impact

- **Interaction graph:** Cross-repo. The spec convention (U1) is read by the site's `badge-maker` build step and the
  site `/badge` convention page (surface #3); the site SVG endpoint (surface #1 inside scorecard pages) is consumed by
  external tool authors embedding the badge.
- **API surface parity:** The site-side `/badge/<tool>.svg` artifact becomes a new consumer of the conformance contract
  defined in U1. When U1 writes the contract, keep the renderer in mind — the prose should be specific enough that the
  `badge-maker` parameter set can be constructed directly from the convention without re-interpretation.
- **Unchanged invariants:** Principle files, requirement IDs, publish workflow, CHANGELOG convention — none touched by
  U1+U2. Site-side render units (when filed) will touch `src/build/` only.

---

## Risks & Dependencies

| Risk                                                                                  | Mitigation                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec convention prose under-specifies what the renderer needs                         | U1 explicitly states the `badge-maker` parameter set (label, message format, color thresholds) so site implementation is mechanical, not interpretive.                                                     |
| Convention over-constrains; locks out valid edge cases                                | Keep U1 minimal — conformance floor + versioning + honesty + regression. Anything more is future-work.                                                                                                     |
| Eligibility floor lands too high or too low; first batch of tools confuses HN readers | U1 picks a floor that the launch-day leaderboard's median tool would clear. Pressure-test against the actual 96-scorecard distribution before publishing.                                                  |
| Launch-eve coordination fails between spec U1+U2 and site render units                | Use the coupled-release protocol (`agentnative-spec:CONTRIBUTING.md`): site PR cites this plan's URL and the agreed floor/format/color values. Both PRs merge in the same launch-wave window or both wait. |

---

## Documentation / Operational Notes

- When U1+U2 land in `agentnative-spec`, that repo's `CHANGELOG.md` gets a release-PR entry (spec-side convention is
  doc-only; no VERSION bump unless the convention touches a requirement's MUST/SHOULD/MAY).
- Site-side render units, when filed, follow this repo's standard release flow.
- The two repos coordinate under the coupled-release protocol (`agentnative-spec:CONTRIBUTING.md`).

## Sources & References

- **Origin:** filed at `brettdavies/agentnative` (spec) on 2026-04-23 as
  `docs/plans/2026-04-23-001-feat-badge-surface-plan.md`; moved to `brettdavies/agentnative-site` on 2026-04-29 to
  consolidate ownership in the launch-coupled hub repo.
- **Launch coordinator:**
  [`docs/plans/2026-04-28-001-feat-show-hn-launch-readiness-plan.md`](2026-04-28-001-feat-show-hn-launch-readiness-plan.md)
  (this repo's launch readiness plan).
- Related session memory: `sot_contract.md` (trust-and-verify posture), `doctrine_decisions.md` (leaderboard baseline).
- External: [`badge-maker` (npm)](https://www.npmjs.com/package/badge-maker) — the renderer.
- Related repos: `brettdavies/agentnative` (spec — owns U1+U2 + the doctrinal convention), `brettdavies/agentnative-cli`
  (CLI — owns surface 5 / todo #017).
