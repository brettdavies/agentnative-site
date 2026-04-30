---
title: "feat: Adopt scorecard schema 0.4 + scorecard-driven discovery with registry editorial join"
type: feat
status: completed
date: 2026-04-29
shipped_in: PR #52 merged to `dev` 2026-04-30 morning. NOT YET on `main`/anc.dev — see CORRECTION block below.
---

> **CORRECTION (2026-04-30 PM PT) — DEV-MERGED, NOT PRODUCTION-SHIPPED.** PR #52 landed on `dev` as claimed; the
> `dev → main` release that would have promoted it to anc.dev was never cut. Show HN launch was HELD; see
> [`2026-04-28-001-feat-show-hn-launch-readiness-plan.md`](2026-04-28-001-feat-show-hn-launch-readiness-plan.md)
> § CORRECTION for the full story. `status: completed` here means the implementation work landed on the `dev` branch
> as scoped; production deployment is pending the next `release/<YYYY-MM-DD>-<slug>` cut.

# feat: Adopt scorecard schema 0.4 + scorecard-driven discovery with registry editorial join

## Overview

`agentnative-cli` PR [#34](https://github.com/brettdavies/agentnative-cli/pull/34) (merged 2026-04-29) bumped the
scorecard schema from `0.3` to `0.4` by adding four self-describing top-level metadata blocks: `tool` (name, binary,
self-reported version), `anc` (the `anc` build that produced this scorecard, with version + git commit), `run`
(invocation, started_at RFC 3339, duration_ms, platform os/arch), and `target` (kind = project | binary | command, plus
path or command).

The site currently reads `version` and `scored_at` from `registry.yaml` to render per-tool pages and to drive the regen
pipeline's filename + state-tracking. With v0.4, the scorecard is self-describing: those fields move to the scorecard,
the registry shrinks, and the build can flip from registry-iterating-then-looking-up-scorecards to
**scorecard-iterating-then-joining-registry-for-editorial-metadata**. That inversion is what the user asked for in the
prompt phrasing "rely on the existence of a scorecard without even checking the registry."

This plan ships both the data refresh (regen all 96 scorecards against a local CLI build of `dev` so v0.2.0's release
cadence isn't a blocker) and the site-side consumption changes (read v0.4, switch to scorecard-driven discovery, drop
redundant registry fields, surface new metadata).

### What v0.4 unlocks beyond the user's stated wins

The user named two specific gains: drop `version` and `scored_at` from the registry. The full unlock surface is broader.
Each item below is either landed in this plan or explicitly deferred:

| Unlock                                                                          | What it enables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Status in this plan                                                    |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `tool.version` self-reported                                                    | Removes the registry's `version` pin; filename remains the canonical version anchor (`<name>-v<X>.json`); display shows self-reported when present, filename version as fallback                                                                                                                                                                                                                                                                                                                                                                                                  | Landed (U2 + U4)                                                       |
| `run.started_at` (RFC 3339)                                                     | Removes the registry's `scored_at` (date-only) field; display gets a real timestamp; sortable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Landed (U2 + U4)                                                       |
| `anc.version` + `anc.commit`                                                    | Provenance per scorecard ("scored with `anc v0.2.0` commit `abc1234`") rendered on the per-tool page. The build-time anc-version floor invariant is **deferred** (R5) until v0.2.0 ships and a re-regen tightens it.                                                                                                                                                                                                                                                                                                                                                              | Landed-display (U5); floor-invariant deferred                          |
| `run.invocation`                                                                | Literal argv that produced the score; the per-tool "Reproduce locally" CTA can show the verbatim command instead of constructing one                                                                                                                                                                                                                                                                                                                                                                                                                                              | Landed (U5)                                                            |
| `run.duration_ms`                                                               | How long the run took; surface on per-tool page; potential future: median across the corpus as a friction signal                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Landed (U5)                                                            |
| `run.platform.os` / `run.platform.arch`                                         | Where the scorecard was produced; visibility for platform-specific behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Landed (U5)                                                            |
| `target.kind`                                                                   | Disambiguates `command` vs `binary` vs `project` mode runs; future-proofs source-layer scorecards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Landed (U5) — just the kind label; no per-mode rendering yet           |
| Scorecard-driven discovery + registry editorial join                            | Build iterates `scorecards/*.json`; joins to registry for editorial fields; both directions of mismatch (scorecard-without-registry, registry-without-scorecard) emit symmetric stderr warnings and exclude the entry from the leaderboard. Leaderboard hero gains a `N audited tools in the corpus` subhead; the `(N)` count is dropped from the `All` tier-filter button (redundant with the new subhead). Refined from doc-review pass 2: earlier framing called this "pipeline inversion" — the registry editorial join remains mandatory, so it's a hybrid not an inversion. | Landed (U3)                                                            |
| Build-time integrity invariants                                                 | Assert `schema_version >= "0.4"` (floor), filename-derived slug exists in `registry.tools[].name`, `scorecard.tool.name === registry.binary` for the joined entry (catches the 11 name-vs-binary tools correctly), `run.started_at` parses as RFC 3339. Anc-version floor + target.command cross-check + future-date guard explicitly out of scope (R5).                                                                                                                                                                                                                          | Landed (U2 + U3)                                                       |
| `audit_profile` derivable from scorecard                                        | Already in scorecard since v0.2; not a v0.4 unlock                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | No-op — the registry's `audit_profile` stays as a regen-pipeline input |
| `version_extract` removable from registry                                       | Not actually replaceable: the regen script needs an external probe to derive the filename version for tools whose `--version` output doesn't yield to the default regex, BEFORE the scorecard exists                                                                                                                                                                                                                                                                                                                                                                              | No-op — `version_extract` stays as a regen-pipeline input              |
| Editorial fields (tier, language, creator, description, install) into scorecard | Would let the registry shrink to a name list; requires upstream CLI schema change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Out of scope — flagged for future v0.5+ consideration                  |
| Source-layer scorecard rendering (`*-src-YYYYMMDD-branch-commit7.json`)         | Future capability; v0.4's `target.kind: "project"` is the placeholder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Out of scope; this plan doesn't render source-layer scorecards         |
| RSS / "recently scored" feed                                                    | `run.started_at` makes a chronological feed trivially possible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Out of scope; potentially future work                                  |

## Problem Frame

The scorecard artifact and the registry currently overlap on three fields — `version`, `scored_at`, and (implicitly)
`audit_profile`. That overlap is a contract risk: the regen script writes `scored_at` back into the registry on every
run, the per-tool page reads `version` from the registry but displays the filename-derived version when the registry pin
is missing, and a reader who fetches a scorecard JSON in isolation cannot answer "which `anc` build produced this, on
what platform, when, with what argv" — they have to cross-reference the registry to even know what tool the scorecard
belongs to.

`agentnative-cli` PR #34 closes that gap upstream by making the scorecard self-describing. The site is the largest
downstream consumer; this plan is the corresponding consumption change. It also takes the opportunity to flip the
iteration direction of the build pipeline so the site renders what scorecards actually exist on disk, rather than what
the registry says should be scored — eliminating the "unscored row with em-dash" failure mode and turning
scorecard-without-registry into a loud build warning (with scorecard excluded from the leaderboard) instead of a silent
skip.

## Requirements Trace

- **R1.** Site consumes `schema_version: "0.4"` scorecards correctly: the four new metadata blocks (`tool`, `anc`,
  `run`, `target`) are read, validated, and either surfaced in the UI or used for build-time invariants.
- **R2.** `version` and `scored_at` are removed from `registry.yaml`. Display sources move to the scorecard
  (filename-as-canonical for version; `run.started_at` for date).
- **R3.** Build pipeline shifts to scorecard-driven discovery: `scorecards/*.json` is the iteration source.
  `registry.yaml` is joined for editorial fields (tier, language, creator, description, install, repo/url). A scorecard
  without a registry entry is a build **warning** with the scorecard excluded from the leaderboard (refined from
  doc-review: softened from hard error to warning + exclusion, decouples regen + editorial flows, supports rename/retire
  workflows). A registry entry without a scorecard is **also a warning** with the entry excluded from the leaderboard
  (refined from doc-review pass 2: symmetric warnings — both directions emit stderr warnings; the contributor flow
  expects registry-first PRs as a transient pending state, and the warning is the "don't forget the scorecard" nudge).
  The leaderboard hero renders an `N audited tools in the corpus` subhead — corpus-descriptor framing, not "showing N"
  (which would lie when the audience-filter UI hides rows). The `(N)` count is dropped from the `All` tier-filter button
  since it's redundant with the new hero subhead. `registry.yaml`'s header documents the contributor flow (editorial PR
  can land before scorecard PR, build warns until the scorecard arrives).
- **R4.** Per-tool page surfaces the new metadata: `anc.version` + `anc.commit`, `run.started_at`, `run.duration_ms`,
  `run.platform.os` / `arch`, `target.kind`, and `run.invocation` as the verbatim "reproduce locally" command for
  command-mode runs.
- **R5.** Build-time invariants protect the corpus (refined from doc-review): (a) every committed scorecard has
  `schema_version` at-or-above `"0.4"` **except `scorecards/anc-v0.1.3.json` which is grandfathered at "0.3" until CLI
  v0.2.0 ships** (per the user-locked product position: anc must always exist on the leaderboard at the most-recent
  public version); (b) every scorecard's filename-derived slug exists as a `registry.tools[].name` (the editorial join);
  (c) for the joined registry entry, `scorecard.tool.name === registry.binary` for v0.4 scorecards (anc-v0.1.3
  grandfather skips this check too — the v0.3 schema doesn't carry tool.name); (d) every v0.4 scorecard's
  `run.started_at` parses as RFC 3339 (grandfather skips). Additionally (e): when `tool.version` is non-null, it must
  equal the filename-derived version (refined from doc-review pass 2 — promoted from a UI display branch to a build-time
  invariant; if drift happens it's a build error, not a per-page note). Anc-version floor, `target.command` cross-check,
  and future-date guard are out of scope for v1.
- **R6.** 95 of 96 scorecards in `scorecards/` are regenerated to v0.4 shape (anc-v0.1.3 grandfathered, see U1) using a
  local build of `~/dev/agentnative-cli` from the `dev` branch (PR #34's merge commit). Site does not block on the
  v0.2.0 release.
- **R7.** Public-facing schema docs (`content/scorecard-schema.md` → `/scorecard-schema`) describe the new fields,
  null-state semantics, and security guidance for `run.invocation` / `target.path` (paths can leak local filesystem
  layout when scoring in project mode).

## Scope Boundaries

- **Out of scope: upstream CLI schema changes.** The plan consumes v0.4 as-is. No request for a v0.5 schema.
- **Out of scope: source-layer scorecard rendering.** v0.4's `target.kind: "project"` is the placeholder for future
  source-mode scorecards (`*-src-YYYYMMDD-branch-commit7.json`). This plan handles the metadata read but does not render
  a separate "source layer" surface; that remains a deferred capability per `registry.yaml` header.
- **Out of scope: RSS / "recently scored" feed.** `run.started_at` makes it trivial; not requested in this iteration.
- **Out of scope: cross-platform leaderboard filters.** `run.platform.{os,arch}` is captured + displayed but not used
  for filter UI.
- **Out of scope: removing `audit_profile` or `version_extract` from the registry.** Both remain regen-pipeline input
  fields, not display fields.

### Deferred to Separate Tasks

- **Migrate editorial fields (tier, language, creator, description, install) from registry into scorecard.** Would let
  the registry shrink to a name list. Requires a CLI schema change; not done here.
- **Stale-`anc.version` warnings on the leaderboard.** Once the corpus has provenance, surface scorecards produced by
  outdated `anc` builds. Future work; floor invariant in U2 is the foundation.
- **Cross-platform leaderboard filtering.** Requires a UX decision on which platforms count as canonical; deferred.

## Context & Research

### Relevant Code and Patterns

- `src/build/scorecards.mjs` — current loader. `loadRegistry()` validates required fields; `loadScorecards()` resolves
  by filename (registry pin → exact match; otherwise auto-discover highest-version `<name>-v*.json`).
- `src/build/scorecards-render.mjs` — `buildScorecardBody()` reads `tool.scored_at` for the "Audit date" line and
  resolves version via `resolvedVersion ?? tool.version ?? null`. The "Details" `<dl>` is the metadata surface to
  enrich.
- `src/build/build.mjs` — orchestrator. The leaderboard render loop iterates `leaderboard` (registry-driven). Per-tool
  emit loop is where the inversion lands. Existing `runInvariantChecks()` (lines 108–153) is the precedent for
  build-time fail-fast contracts.
- `src/build/util.mjs` — shared constants (`PRINCIPLE_GROUPS`, `BADGE_FLOOR`, `SPEC_VERSION`). The schema-version floor
  lives in U2 directly via `compareVersions()`; no `ANC_VERSION_FLOOR` constant in v1 (the anc-version floor invariant
  is dropped per doc-review).
- `scripts/regen-scorecards.sh` — current regen pipeline. Uses `version_extract` from registry, derives filename
  version, runs `anc check`, writes `scored_at` back into registry. The `scored_at` writeback (lines 200–238) gets
  removed.
- `docker/score/score-anc100.sh` — docker variant of the regen pipeline. Same writeback patterns.
- `content/scorecard-schema.md` — public docs page. Currently describes v0.3 fields; needs v0.4 expansion.

### Institutional Learnings

- `docs/solutions/architecture-patterns/cross-repo-artifact-sync-commit-over-fetch-20260420.md` — the pattern this repo
  uses for spec + scorecard artifacts. Reinforces the choice to commit v0.4 scorecards to disk via a local CLI build
  rather than fetching at build time.
- `docs/solutions/best-practices/triple-emit-content-negotiation-rename-safe-2026-04-29.md` — the HTML/MD/JSON
  triple-emit pattern. The new metadata needs to surface in all three (per-tool HTML, markdown twin, and the
  llms-full.txt aggregation).
- `docs/solutions/best-practices/byte-equivalence-regression-tests-for-copied-design-artifacts-2026-04-14.md` — pattern
  for catching drift between source-of-truth and rendered surfaces. Applies to the scorecard-schema docs page vs. the
  actual schema.

### External References

- `agentnative-cli` PR [#34](https://github.com/brettdavies/agentnative-cli/pull/34) — the upstream schema change.
- `agentnative-cli/src/scorecard/mod.rs` on `dev` — the `Scorecard`, `ToolInfo`, `AncInfo`, `RunInfo`, `PlatformInfo`,
  `TargetInfo` struct definitions are the binding contract.
- `agentnative-cli/docs/plans/2026-04-29-001-feat-scorecard-schema-metadata-plan.md` — the upstream plan with the
  field-by-field rationale, including the publishing-PII review reminder for `run.invocation` and `target.path`.

## Key Technical Decisions

- **Regen via local CLI build, not via the v0.2.0 release.** `~/dev/agentnative-cli` `dev` already has PR #34 merged.
  Building a local release binary unblocks site v0.4 work from the v0.2.0 release pipeline. Trade-off: the resulting
  scorecards will carry `anc.version` matching whatever `Cargo.toml` says on `dev` (likely `0.1.0` per the established
  pre-tag convention) and `anc.commit` will be a SHA from `dev`, not the eventual `v0.2.0` tag. Acceptable — once v0.2.0
  ships and the next regen runs, the `anc.version` will tick to `0.2.0`. Document this clearly in U1's Notes. **The
  `anc` binary itself is exempted from this regen** — see U1 (refined from doc-review): regenerating `anc` against the
  dev-branch local build would produce `anc-v0.1.0.json`, which is a *lower* version than the corpus's existing
  `anc-v0.1.3.json` (the last released CLI). Falsely advertising `anc 0.1.0` is worse than briefly carrying a v0.3
  scorecard for `anc` itself.
- **Filename remains the canonical version anchor.** `tool.version` in the scorecard is best-effort (null when the
  binary's `--version` doesn't parse). The leaderboard's "Score" column and the per-tool URL slug both come from the
  filename. Display shows `tool.version` when present and the filename version when null. The two are not expected to
  disagree in steady-state (refined from doc-review pass 2 — the regen probes once per binary and emits both into the
  same artifact; daylight only opens via parser-asymmetry between the regen script's `version_extract` snippet and the
  CLI's internal probe, which is a build-time data error, not a runtime display state). When they DO disagree it
  surfaces as a build invariant violation (R5(e)), not a UI note.
- **Invariants enforce schema floor + corpus consistency** (refined from doc-review pass 2 — the older bullet named four
  invariants the trim removed). Build-time invariants (in the existing `runInvariantChecks()` mechanism) refuse to ship
  if any committed scorecard is below `schema_version: "0.4"` (floor via `compareVersions()`), if a scorecard's
  filename-derived slug isn't a `registry.tools[].name`, if for the joined registry entry `scorecard.tool.name !==
  registry.binary`, or if `run.started_at` doesn't parse as RFC 3339. Anc-version floor, target-command cross-check, and
  future-date guard are explicitly out of scope (R5). Fail-fast is the convention (precedent: `runInvariantChecks()`
  already throws on RFC-keyword leaks and missing locked slugs).
- **Hybrid pipeline — scorecard discovery first, registry join for editorial.** Build iterates `readdir('scorecards/')`
  and parses `<name>-v<version>.json`. For each name, it joins to `registry.yaml`. Missing registry entry = build
  **warning** with the scorecard excluded from the leaderboard (refined from doc-review per Q4: softened from hard error
  to warning + exclusion; decouples regen + editorial flows; supports rename/retire workflows). Registry entry without a
  scorecard = **also a warning** with the entry excluded (refined pass 2: symmetric warnings). The current "unscored row
  with em-dash" code path is removed. The leaderboard hero renders an `N audited tools in the corpus` subhead
  (corpus-descriptor framing, not "showing N" which would mislead under client-side filtering); the redundant `(N)`
  count drops from the `All` tier-filter button.
- **Reproduce-locally CTA uses `run.invocation` verbatim for command-mode scorecards only.** Project-mode invocations
  may include local filesystem paths (`anc check ./local/repo`), which are user/machine-specific and could leak. For
  command-mode (every leaderboard entry today), `run.invocation` is safe and authoritative. The CTA renders
  `run.invocation` directly when `target.kind === "command"`; for `target.kind === "project"` or `"binary"`, it falls
  back to the synthesized `anc check --command <tool.name>` shape used today.
- **`anc.version` floor is a constant in `src/build/util.mjs`, not a hardcoded literal.** Same pattern as `BADGE_FLOOR`
  and `SPEC_VERSION`. Initial value: whatever `anc.version` shows in the regenerated v0.4 scorecards (likely `"0.1.0"`
  from the local dev build, bumping to `"0.2.0"` after the next regen post-CLI-release).

## Open Questions

### Resolved During Planning

- **When does this ship — pre- or post-launch?** User answered with the regen tactic ("use the local dist binary"), not
  a timing pick. Default: post-launch (clean, no clock pressure on launch eve). The user can expedite by invoking
  `/ce-work` on this plan tonight; nothing structurally prevents it.
- **Does the registry stop existing entirely?** No. Editorial fields (tier, language, creator, description, install,
  repo/url) live there. Regen-pipeline inputs (`audit_profile`, `version_extract`) also live there. What goes away is
  `version` and `scored_at` (now self-described in the scorecard).
- **Should the build still emit unscored rows?** No. With scorecard-driven discovery, only tools with a real scorecard
  appear on the leaderboard. (Auto-fix from doc-review: clarifying — launch-readiness U3 confirmed the unscored DATA
  situation was retired by PR #40, all 96/96 scored. The em-dash CODE PATH itself is still live in
  `src/build/scorecards-render.mjs:76,85,528,530`; this plan's U3 is what removes that code path.) This plan confirms
  the decision.
- **Can `audit_profile` be dropped from the registry?** No. The regen pipeline reads it as input to pass
  `--audit-profile X` when invoking `anc check`. Same shape as today; not a redundancy v0.4 unlocks.
- **Can `version_extract` be dropped?** No. The regen script needs an external `--version` probe to derive the
  filename's version BEFORE invoking `anc` (the scorecard's `tool.version` exists only after the scorecard does). Tools
  with non-default `--version` output rely on `version_extract`. Stays in the registry.

### Deferred to Implementation

- **Exact RFC 3339 parsing approach.** Bun has native `Date` parsing of ISO 8601; v0.4 emits a strict RFC 3339 subset.
  Use `new Date(str)` with a `!Number.isNaN(date.getTime())` validity check, or pull a small dep. Decide at U2 time.
- **Display granularity for `run.duration_ms`.** Show as `0.4s` / `12s` / `2m 14s`? Or millisecond literal? Decide
  during U5 with eyes on the rendered page; not load-bearing for any contract.
- **`target.path` redaction policy for project-mode runs.** Today every leaderboard entry is command-mode, so
  `target.path` is null. When source-layer scorecards land (out of scope), local paths could leak through this field.
  Defer — the plan that adds source-layer rendering owns the redaction policy.
- **Where exactly the new metadata renders on the per-tool page.** Most likely a new `<dl>` block under the existing
  "Details" section (Audit date, Install). Specifics are styling choices; resolve at U5.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.
> The implementing agent should treat it as context, not code to reproduce.*

**Build pipeline shape (after inversion):**

```text
                          ┌─────────────────────────────────┐
                          │    scorecards/*.json (96 files) │
                          │    schema_version: "0.4"        │
                          └──────────────┬──────────────────┘
                                         │ readdir + parse filename
                                         ▼
                       ┌──────────────────────────────────────┐
                       │   For each scorecard:                │
                       │   1. Validate v0.4 invariants        │
                       │   2. Extract slug from filename      │
                       │      (slug = registry.name; the      │
                       │       filename was built as          │
                       │       `${name}-v${version}.json`)    │
                       │   3. Lookup registry[slug]           │
                       │      ├─ found  → join + render       │
                       │      └─ missing → WARNING + exclude  │
                       │   4. Invariant: scorecard.tool.name  │
                       │      === registry[slug].binary       │
                       │      (the CLI's tool.name comes from │
                       │       the --command argv = binary,   │
                       │       not the filename slug; for the │
                       │       11 name≠binary tools they are  │
                       │       different identifiers)         │
                       └──────────────────┬───────────────────┘
                                          │
                                          ▼
                       ┌──────────────────────────────────────┐
                       │   registry.yaml                      │
                       │   • tier, language, creator,         │
                       │     description, install,            │
                       │     repo/url                         │
                       │   • audit_profile (regen input)      │
                       │   • version_extract (regen input)    │
                       │   ✗ version (REMOVED)                │
                       │   ✗ scored_at (REMOVED)              │
                       └──────────────────────────────────────┘

After registry join:
  • registry-entries-without-scorecards → silently dropped
    (no em-dash row; the leaderboard shows real scores only)
```

**Field-mapping table (where each datum comes from after this plan):**

| Datum                                                               | Today                                                                                     | After this plan                                                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Tool name (URL slug)                                                | `registry.yaml:.tools[].name`                                                             | Filename `<name>-v*.json` (registry name kept for editorial join)                                   |
| Filename version anchor                                             | Computed from `registry.yaml:.tools[].version` or auto-discovered                         | Filename pattern; auto-discovered from disk                                                         |
| Display version (per-tool page)                                     | Filename version, fallback to `registry.yaml:.tools[].version`                            | `scorecard.tool.version` (self-reported), fallback to filename version; both shown if they disagree |
| Audit date                                                          | `registry.yaml:.tools[].scored_at`                                                        | `scorecard.run.started_at` (RFC 3339 timestamp)                                                     |
| Tool binary                                                         | `registry.yaml:.tools[].binary`                                                           | `registry.yaml:.tools[].binary` (still input for regen `--command`)                                 |
| Audit profile                                                       | `scorecard.audit_profile` (display); `registry.yaml:.tools[].audit_profile` (regen input) | unchanged                                                                                           |
| Tool tier / language / creator / description / install / repo / url | `registry.yaml`                                                                           | unchanged                                                                                           |
| `anc` build that produced the scorecard                             | not visible to the site                                                                   | `scorecard.anc.{version,commit}`                                                                    |
| Run invocation, duration, platform                                  | not visible to the site                                                                   | `scorecard.run.{invocation,duration_ms,platform.{os,arch}}`                                         |
| Target kind / path / command                                        | not visible to the site                                                                   | `scorecard.target.{kind,path,command}`                                                              |

## Implementation Units

- [ ] **U1. Regenerate 95 scorecards to v0.4; grandfather anc-v0.1.3.json at v0.3 until CLI v0.2.0 ships**

**Goal:** Every file under `scorecards/*.json` carries `schema_version: "0.4"` *except* `scorecards/anc-v0.1.3.json`,
which stays at v0.3 (its current state) — the user-locked product position is "anc must always appear on the leaderboard
at the most-recent public version." Regenerating anc against the dev-branch binary would produce `anc-v0.1.0.json`
(false regression below the released 0.1.3); deleting it would remove the standard's reference implementation from its
own audit site. Both unacceptable. The grandfather is intentional and explicitly time-bound: when CLI v0.2.0 publishes
(central tracker step 2), a follow-up regen of `anc` against the v0.2.0 binary produces `anc-v0.2.0.json` at v0.4
schema; the new file replaces `anc-v0.1.3.json` and the grandfather exception drops out automatically. U2's schema-floor
invariant carries a per-file carve-out for this single file.

**Requirements:** R6.

**Dependencies:** None (the local CLI's `dev` branch already has PR #34 merged; build the binary, point the regen
pipeline at it, commit the resulting scorecards).

**Files:**

- Modify (95 in bulk): `scorecards/*.json` *excluding* `scorecards/anc-v0.1.3.json`.
- **Preserve** (not delete): `scorecards/anc-v0.1.3.json` stays exactly as-is at schema_version 0.3. Grandfathered by
  U2's invariant carve-out until CLI v0.2.0 ships and a follow-up regen replaces it with v0.4 shape.
- Modify: `registry.yaml` — temporarily remove the `anc` registry entry OR leave it in place (registry-without-
  scorecard becomes a build warning per Q4's softening, not a fatal error). Confirm at U4 implementation time.

**Approach:**

- **Preflight (refined from doc-review):**

1. `cd ~/dev/agentnative-cli && git status --short` — confirm clean working tree.
2. `git rev-parse HEAD` — confirm at PR #34's merge commit on `dev`.
3. `cargo build --release` — produce the local binary.
4. `cargo install --path . --force` — make the freshly-built `anc` the one `command -v anc` resolves to (the regen
   script reads `command -v anc` at line 76, so a stale `cargo install`'d release on `$PATH` would silently produce v0.3
   scorecards otherwise).
5. `anc check --command rg --output json | jaq -r .schema_version` — **hard gate**: must return `"0.4"` or abort.
6. **Lower the regen-script floor for this one-shot refresh** (refined from doc-review pass 2 — P0 blocker):
   `scripts/regen-scorecards.sh:42` hardcodes `MIN_ANC_VERSION="0.1.3"`, which rejects the dev-branch binary's `0.1.0`
   self-report and aborts the regen at the script's own preflight. Either edit line 42 to `"0.1.0"` for the duration of
   this regen, OR add a `--allow-dev-build` flag that bypasses the floor. Restore the floor (or raise it to `"0.2.0"`)
   in the same commit that regenerates the post-CLI-v0.2.0 corpus. **The script's preflight runs before U1's hard gate
   at step 5, so this step must execute first to even reach U1's verification.**
7. **Add an `--exclude` flag to `scripts/regen-scorecards.sh`** (refined from doc-review pass 2): mirror the existing
   `--only` flag shape (around lines 137-148). Required by the next step. The "move file aside" workaround the earlier
   draft suggested doesn't actually work — the iteration list comes from `yq` over `registry.yaml`, so the file move
   doesn't exclude `anc` from being scored.

- Run `scripts/regen-scorecards.sh --exclude anc`. The exclude is critical: the dev-branch binary self-reports `0.1.0`,
  which would create `scorecards/anc-v0.1.0.json` — a *lower* version than the released `0.1.3` already in the corpus.
- Spot-check 3-4 representative scorecards (one workhorse, one TUI tool with `audit_profile: human-tui`, one tool whose
  `--version` historically didn't parse) to confirm the new blocks landed correctly.

**Patterns to follow:**

- `docker/score/score-anc100.sh` is the canonical 96-tool regen path used during the launch-corpus build (PR #40, commit
  `d710ade`).

**Test scenarios:**

- Happy path: `find scorecards -name "*.json" -not -name 'anc-*.json' -exec jaq -r '.schema_version' {} \; | sort -u`
  returns exactly `"0.4"` (95 files). The `anc-v0.1.3.json` file remains at `"0.3"` by design.
- Happy path: `jaq -r '.tool.name' scorecards/eza-v0.23.4.json` returns `"eza"` (matches filename slug).
- Happy path: `jaq -r '.run.started_at' scorecards/eza-v0.23.4.json` parses as RFC 3339 and is within the past 24h.
- Edge case: tools with historically-unparseable `--version` (the ones declaring `version_extract` in registry) render
  `tool.version: null` — confirm the regen script still derives the filename version correctly via `version_extract` and
  writes the scorecard.
- Edge case: TUI tools (`audit_profile: human-tui`) preserve the suppression markers in `results[].evidence` — v0.4 is
  additive, so the existing `audit_profile` field at the top level should still be present.
- Test expectation: no automated tests for this unit — it's a one-time data refresh. Verification is the inspection
  steps above plus the build-time invariants in U2.

**Verification:**

- 95 scorecards have `schema_version: "0.4"`.
- All 95 have the four new top-level keys (`tool`, `anc`, `run`, `target`).
- `scorecards/anc-v0.1.3.json` is unchanged on disk (still `schema_version: "0.3"`); grandfathered by U2's invariant
  carve-out.
- Existing per-result fields (`results[]`, `summary`, `coverage_summary`, `audience`, `audit_profile`, `spec_version`)
  are preserved.
- `git diff --stat scorecards/` shows 95 files changed: 95 modified (the regenerated scorecards). No deletions, no
  additions. `anc-v0.1.3.json` is unchanged.

---

- [ ] **U2. Adopt schema 0.4 in the loader + add build-time invariants**

**Goal:** `src/build/scorecards.mjs` parses v0.4 metadata blocks, exposes them downstream, and the build refuses to ship
if any committed scorecard violates the v0.4 contract.

**Requirements:** R1, R5.

**Dependencies:** U1 (need real v0.4 scorecards on disk to run against).

**Files:**

- Modify: `src/build/scorecards.mjs` — extend `loadScorecards()` to attach the new metadata blocks to each entry's
  return shape; tighten validation to require `compareVersions(schema_version, "0.4") >= 0` (floor, not equality —
  auto-fix from doc-review: lets future v0.5+ scorecards ship without a stop-the-world site PR).
- Modify: `src/build/build.mjs` — extend `runInvariantChecks()` with the v1 corpus-level invariants (refined from
  doc-review): (a) schema-version floor (`compareVersions(schema_version, "0.4") >= 0`); (b) filename-derived slug
  exists in registry (the editorial join); (c) `scorecard.tool.name === registry[joined].binary` — validates the regen
  scored the right binary, accommodates name ≠ binary tools; (d) `run.started_at` parses as RFC 3339. Out: anc-version
  floor, target.command cross-check, future-date guard.
- Test: `tests/build.test.ts` — new describe block `loadScorecards — schema 0.4 metadata` covering the parse contract;
  new describe block `runInvariantChecks — v0.4 corpus invariants` covering each of the four invariants with both a
  valid and a violating fixture.

**Execution note:** Test-first. Each invariant should have a violating fixture that throws before the matching
production code is in place; the test failure is the "this is what the new invariant catches" signal.

**Approach:**

- Extend the per-tool object returned by `loadScorecards()` to surface `metadata: { tool, anc, run, target }`. Existing
  callers ignore the new field; renderers in U5 read it.
- Build-time invariants run during `runInvariantChecks()` (after rendering completes, same point where RFC-keyword leaks
  and locked-slug counts are validated). Each violation produces a clear `Error` with the offending filename and the
  specific contract that failed.
- The schema-version floor uses the existing `compareVersions()` helper in `src/build/scorecards.mjs` (already used for
  filename-version sorting). No new constant required; `"0.4"` is the literal floor.

**Patterns to follow:**

- `runInvariantChecks()` in `src/build/build.mjs:108-153` — fail-fast pattern, descriptive error messages naming the
  offending file.
- `loadRegistry()` in `src/build/scorecards.mjs:41-87` — validation pattern with named errors per failure mode.
- `compareVersions()` in `src/build/scorecards.mjs:113-134` — version comparison. **Currently module-private (not
  exported); auto-fix from doc-review:** export it so `runInvariantChecks()` in `build.mjs` can call it, or move it to
  `util.mjs`.

**Test scenarios:**

- Happy path: a fixture v0.4 scorecard with all four metadata blocks populated parses cleanly; `loadScorecards()`
  returns a per-tool object with `metadata.tool.name === "fixture"`, `metadata.anc.version === "0.2.0"`, etc.
- Edge case: `tool.version: null` parses successfully — null is a documented valid state.
- Edge case: `anc.commit: null` parses successfully (cargo-install builds outside a git checkout).
- Edge case: a fixture with `schema_version: "0.5"` parses successfully (floor admits future additive bumps — auto-fix
  from doc-review).
- Edge case: `target.path: null` for `kind: "command"` parses; `target.command: null` for `kind: "project"` parses.
- Error path: a fixture with `schema_version: "0.3"` (below floor) throws during invariant check with message naming the
  file and the schema contract.
- Error path: a fixture filename `eza-v0.23.4.json` whose slug `eza` is not present in `registry.tools[].name` throws
  with a missing-registry-entry error (the editorial join contract).
- Happy path (name ≠ binary): fixture `ripgrep-v14.1.0.json` where `tool.name: "rg"` and registry's `ripgrep` entry has
  `binary: rg` parses cleanly — invariant (c) compares `tool.name` to `registry.binary`, not to filename slug, so the 11
  known name-vs-binary tools validate correctly.
- Error path: fixture `ripgrep-v14.1.0.json` where `tool.name: "rgg"` (typo or wrong tool scored) but registry's
  `ripgrep` entry has `binary: rg` — invariant (c) throws with a tool.name-vs-registry.binary mismatch.
- Error path: a fixture where `run.started_at` is non-parseable throws.

**Verification:**

- `bun test tests/build.test.ts` passes with the new test blocks.
- `bun run build` against the regenerated corpus from U1 completes without invariant errors.
- Manually corrupting one scorecard (e.g., `jaq '.schema_version = "0.3"' ...`) makes the build fail with the expected
  error message.

---

- [ ] **U3. Switch the build to scorecard-driven discovery + registry editorial join**

**Goal:** Build iterates `scorecards/*.json` first; joins registry by name for editorial metadata. Symmetric warnings:
(i) scorecard without a registry entry → stderr warning with offending filename + missing name + scorecard excluded;
(ii) registry entry without a scorecard → stderr warning with the registry name + entry excluded. Both states surface in
the build summary count. Leaderboard hero renders an `N audited tools in the corpus` subhead (corpus-descriptor, not
view-descriptor); the redundant `(N)` drops from the `All` tier-filter button.

**Requirements:** R3.

**Dependencies:** U2 (the loader contract must already attach v0.4 metadata).

**Files:**

- Modify: `src/build/scorecards.mjs` — replace the registry-iterating `loadScorecards()` shape with a
  scorecard-iterating `loadScoredTools()` (or rename appropriately). Returns the joined shape: `{ tool: <registry
  editorial>, scorecard, version, metadata }`. Scorecards without a registry entry are excluded from the returned set
  (refined from doc-review per Q4: warning, not error). The orchestrator logs the warning to stdout and the build
  summary so the count and offending filenames are visible. Also delete `scorecardFilename(tool)` (lines 104-107) — the
  inverted flow reads filenames off disk directly, so the registry's `version`-to-filename construction has no remaining
  caller. **Preflight (auto-fix from doc-review):** before deletion, `rg "scorecardFilename" src/ tests/` to confirm
  zero remaining call sites; remove the export only after verifying.
- Modify: `src/build/build.mjs` — remove the `unscored` code path from the per-tool emit loop (registry entries without
  scorecards are no longer iterated). Update the leaderboard computation to handle the always-scored-only assumption.
- Modify: `src/build/scorecards-render.mjs` — `buildLeaderboardBody()` and `scoreCell()` / `principleCell()` no longer
  need the `if (!entry.scorecard)` em-dash branches (lines 76, 85, 528, 530); simplify accordingly. Add a `<p
  class="leaderboard-hero__meta">N audited tools in the corpus</p>` subhead inside `.leaderboard-hero`, immediately
  after the lede `<p class="leaderboard-hero__lede">` (refined from doc-review pass 2: corpus- descriptor framing reads
  correctly under client-side audience-filter; "showing N" would lie when filter hides rows). Drop the
  `(${leaderboard.length})` count from the `All` tier-filter button label — the new subhead carries it.
- Modify: `registry.yaml` header comment block — document the new contributor flow (refined from doc-review per Q4): "An
  editorial entry without a paired scorecard is silently excluded from the leaderboard until a scorecard lands. The
  build emits a warning naming any scorecard that lacks a registry entry. The two PRs may land in either order."
- Test: `tests/build.test.ts` — new describe block `scorecard-driven discovery` covering the inverted iteration, the
  missing-registry-entry warning + exclusion behavior, the missing-scorecard exclusion behavior, and the leaderboard
  subhead count. Existing tests that exercise `scorecardFilename()` directly come out alongside the function.

**Execution note:** Test-first for the new warning path (scorecard-without-registry emits the warning *and* excludes the
scorecard); characterization-first for the em-dash removal — capture the current "unscored row" rendering, confirm no
test depends on it before deleting the code.

**Approach:**

- Iterate `readdir('scorecards/')`, filter to `<name>-v<version>.json` shape (existing `indexScorecardsByName()` already
  does this — reuse).
- **Three-way naming clarity (refined from doc-review pass 2 — pre-existing narrative bug):** For each scorecard, the
  build deals with three distinct identifiers: (i) **filename slug** = the `<name>` part of `<name>-v<version>.json`,
  which mirrors `registry.tools[].name` (the editorial canonical name); (ii) **`scorecard.tool.name`** = what the CLI
  captured from the user-supplied `--command` argv at scoring time, which in the regen pipeline is `registry.binary`
  (the executable name, e.g. `rg`); (iii) **`registry.tools[].binary`** = the canonical executable name. For the 11
  name≠binary tools (ripgrep/rg, ast-grep/sg, bottom/btm, etc.) these identifiers diverge: filename slug is `ripgrep`,
  scorecard.tool.name is `rg`, registry.binary is `rg`. The build joins on (i) ↔ registry.name, and the invariant
  compares (ii) ↔ (iii). The earlier draft of this plan said "extract tool.name from filename" — that's incorrect; the
  filename gives the slug, not tool.name. Worked example: `ripgrep-v15.1.0.json` → filename slug `ripgrep` → join to
  `registry.tools[name=ripgrep]` (succeeds) → invariant: `scorecard.tool.name === "rg"` and `registry.binary === "rg"`
  (succeeds).
- For each scorecard's filename-derived slug, look up the registry entry by name. Missing entry = log a warning with
  filename + missing-name to stderr, accumulate the count for the build summary, and exclude the scorecard from the
  returned set.
- Registry entries without matching scorecards also emit a stderr warning naming the registry name + accumulate in the
  build summary count, then are excluded from the leaderboard (refined from doc-review pass 2: symmetric warnings — both
  directions surface the same way).
- The leaderboard hero gains an `<p class="leaderboard-hero__meta">N audited tools in the corpus</p>` subhead derived
  from the joined-set count (refined pass 2: corpus-descriptor framing, not view-descriptor).
- The `loadRegistry()` function stays for editorial validation; what changes is who iterates first.

**Patterns to follow:**

- `loadScorecards()` current implementation in `src/build/scorecards.mjs:170-209` — same I/O shape, inverted loop order.
- The `expectedNames` cleanup in `src/build/build.mjs:296-302` (drops stale per-tool `dist/score/<name>.html` files)
  shows the existing precedent for "scorecard-driven naming."

**Test scenarios:**

- Happy path: 95 scorecards (94 v0.4 + anc-v0.1.3 grandfathered) + 96 registry entries → 95 leaderboard rows
- `95 audited tools in the corpus` subhead + 1 stderr warning naming the missing-scorecard registry entry (since the
  96th registry entry has no matched scorecard; in steady-state this would be `anc` if its scorecard is regenerated
  mid-cycle).

- Happy path: 95 scorecards + 96 registry entries (anc registry entry retained, anc-v0.1.3.json grandfathered as the
  matched scorecard) → 95 leaderboard rows including anc + `95 audited tools in the corpus` subhead.
- Warning path symmetric (i): scorecard with no registry entry → stderr warning naming filename + missing registry name;
  scorecard excluded; leaderboard count drops by one; build summary increments scorecard-without-registry counter.
- Warning path symmetric (ii): registry entry with no matched scorecard → stderr warning naming registry name; entry
  excluded; leaderboard count unchanged from canonical (it would have been excluded anyway); build summary increments
  registry-without-scorecard counter.
- Edge case: scorecard filename slug normalization — confirm filename-derived name is compared case-sensitively against
  `registry.tools[].name` (both should be `[a-z0-9-]+` per existing convention).
- Integration: full `bun run build` run against the regenerated corpus emits the same number of `dist/score/<name>.html`
  files as included scorecards (not raw on-disk count), and `dist/scorecards.html` row count matches.

**Verification:**

- `bun run build` against U1's regenerated corpus produces 95 leaderboard rows + 95 per-tool pages + a `<p
  class="leaderboard-hero__meta">95 audited tools in the corpus</p>` subhead. The `All` tier-filter button no longer
  carries `(95)`.
- A synthetic test (rename one scorecard to a name not in registry) makes the build succeed with one fewer leaderboard
  row + a stderr warning naming the offending filename.
- Removing a registry entry (without removing its scorecard) makes the build emit the same shape of stderr warning
- the scorecard is excluded.

- Removing a scorecard (without removing its registry entry) makes the build succeed with one fewer leaderboard row + a
  stderr warning naming the registry entry whose scorecard is missing (refined pass 2: symmetric warnings).

---

- [ ] **U4. Drop `version` and `scored_at` from `registry.yaml`; refresh registry header docs**

**Goal:** The 96 registry entries no longer carry `version` or `scored_at`. Registry header comment block reflects the
new field set. Regen scripts no longer write `scored_at` back into the registry.

**Requirements:** R2.

**Dependencies:** U2 (the site reads version/date from the scorecard, not the registry); U3 (build no longer iterates
the registry as the primary source).

**Files:**

- Modify: `registry.yaml` — remove `version:` and `scored_at:` from every entry; update the header comment block to
  remove "Fields (scored tools only — omit for unscored)" subsection and document that filename + scorecard metadata now
  own those facts.
- Modify: `scripts/regen-scorecards.sh` — three coupled changes (auto-fix from doc-review):
- Replace the iteration filter at line 134 (`yq -r '.tools[] | select(.version != null) | .name'`) with a selector that
  no longer depends on the removed `version` field. Options: iterate every tool (`yq -r '.tools[].name'`), or drive the
  regen list from `scorecards/*.json` filenames since post-inversion the scorecard set is the source of truth. Decide at
  U4 implementation time.
- Remove the in-place writeback awk block at lines 209-225 (the entire `awk -v target="$name" -v new_scored_at="$today"
  -v new_version="$new_version" ...` invocation) — it rewrites `scored_at:` and `version:` lines inside each tool block,
  both of which are gone post-U4.
- Remove the `pinned` lookup at line 158 and the `drift_warnings` accumulation; both depend on the registry `version`
  field.
- Modify: `docker/score/score-anc100.sh` — review for any `select(.version != null)` filter or registry iteration that
  depends on the removed field; the docker variant does **not** writeback to the registry, so the awk-removal step from
  `regen-scorecards.sh` is not applicable here (auto-fix from doc-review: the original plan incorrectly listed parallel
  writeback removals).
- Modify: `content/scorecard-schema.md` — docs cross-references to "registry holds `scored_at` / `version`" need
  updating to point at the scorecard fields instead.
- Test: `tests/build.test.ts` — assert `loadRegistry()` accepts entries without `version` / `scored_at`. (The validation
  in `loadRegistry()` currently treats both as optional, so this is a regression test against future drift, not a
  behavior change.)

**Approach:**

- Use `yq` for the bulk removal: `yq -i '.tools[] |= del(.version, .scored_at)' registry.yaml`. Spot-check the diff to
  confirm only those two keys disappeared.
- The header comment block keeps "Fields (required)" and "Fields (regen-pipeline inputs)" subsections; the "Fields
  (scored tools only)" subsection comes out entirely.
- Regen-script edits remove the writeback awk blocks. Confirm a dry run still emits scorecards correctly afterward.

**Patterns to follow:**

- The header comment style in `registry.yaml:1-43` — direct, fields enumerated with brief descriptions.

**Test scenarios:**

- Happy path: `loadRegistry('registry.yaml')` returns 96 entries with no `version` or `scored_at` fields; existing
  required-field validation still passes.
- Happy path: `bash scripts/regen-scorecards.sh --dry-run --only rg` reports the action plan without referencing
  `scored_at` or trying to writeback to the registry.
- Edge case: registry header documentation mentions where `scored_at` / `version` now come from — readers arriving at
  `registry.yaml` know to look at the scorecard JSON or filename.

**Verification:**

- `git diff registry.yaml` shows N×96 line removals (one or two per entry, depending on which had `scored_at` populated)
  plus the header-comment update.
- `bun run build` continues to succeed.
- Per-tool pages still display version + date (now sourced from the scorecard).

---

- [ ] **U5. Surface the new metadata on per-tool pages, leaderboard, and reproduce-locally CTA**

**Goal:** Per-tool page renders `anc.version` + `anc.commit`, `run.started_at`, `run.duration_ms`,
`run.platform.{os,arch}`, `target.kind`, and uses `run.invocation` verbatim as the reproduce command for command-mode
scorecards.

**Requirements:** R4.

**Dependencies:** U2 (data reaches the renderer).

**Files:**

- Modify: `src/build/scorecards-render.mjs` — extend `buildScorecardBody()`'s "Details" `<dl>` block with new rows for
  the v0.4 metadata. Replace the `reproCommand` synthesis with a branch that uses `run.invocation` for command-mode and
  falls back to the synthesized form for project / binary modes.
- Modify: `src/build/scorecards-render.mjs` — extend `buildScorecardMarkdown()` to include the same metadata in the
  markdown twin (matches the triple-emit pattern). **Critical (refined from doc-review pass 2 — security):** the
  markdown twin MUST apply the same `target.kind === "command"` gate to `run.invocation` as the HTML branch. The
  markdown is consumed by `llms-full.txt` (publicly served) and content-negotiation `Accept: text/markdown` agents. A
  project-mode invocation embedding a local filesystem path would propagate to public endpoints if the gate is missed.
- Modify: `src/styles/site.css` — minor styling additions if the new metadata block warrants visual differentiation
  (probably just reuses the existing `.scorecard-meta` / `.meta-list` styles; confirm during impl).
- Test: `tests/build.test.ts` — extend `buildScorecardBody` describe block with v0.4 metadata rendering tests (presence
  of each field, command-mode-uses-run.invocation, project-mode-uses-synthesized).

**Approach:**

- "Details" block becomes a single `<dl>` with explicit row order (refined from doc-review pass 2 per finding #9): (1)
  `Version scored` — from filename (canonical anchor); (2) `Audit date` — from `run.started_at`, formatted; (3)
  `Duration` — humanized from `run.duration_ms`; (4) `Platform` — `${run.platform.os}/${run. platform.arch}`; (5) `Mode`
  — `target.kind`; (6) `Anc version` — `anc.version` with `commit` link (7-char abbrev) when `anc.commit` is non-null
  and matches the SHA regex; (7) `Install` — unchanged from registry. Tool-identity rows (1, 2) first, run-context
  middle (3, 4, 5), provenance (6) last, `Install` closes. Single `<dl>`; reuses existing `.meta-list` styles; no new
  CSS.
- Reproduce CTA: when `target.kind === "command"`, render `<pre><code>${escHtml(run.invocation)}</code></pre>` (refined
  from doc-review pass 2 — `escHtml` is mandatory per the existing convention in `scorecards-render.mjs:491`; the
  earlier draft said "directly" which would skip escaping). Otherwise, render the synthesized `anc check --command
  <tool.name>` form (today's behavior). The earlier draft of this plan added a discrepancy display for when
  `tool.version` and filename-version disagree — that's now an R5(e) build invariant instead (refined from doc-review
  pass 2 per user reasoning: drift only occurs via parser-asymmetry, which is a data error not a runtime UI state).
- **All new `<dd>` values pass through `escHtml()` before interpolation** (refined from doc-review pass 2 —
  `tool.version`, `anc.version`, `anc.commit`, `run.platform.os`, `run.platform.arch`, `target.kind` are all free-form
  strings the CLI captures and could contain HTML special characters). Matches the existing pattern at
  `scorecards-render.mjs:474-476`.
- **`anc.commit` SHA validation before href construction** (refined from doc-review pass 2 — security): when
  `anc.commit` is non-null, validate it matches `/^[0-9a-f]{40}$/` before interpolating into the href
  `https://github.com/brettdavies/agentnative-cli/commit/<commit>`. Render as a 7-char abbreviation in the link text. If
  the SHA fails the regex, render the version string with no link (same path as the null case). The anchor URL must use
  `escHtml(anc.commit)` defensively even after the regex check.
- `run.duration_ms` formatting: < 1000 → `Xms`; < 60_000 → `X.Xs`; >= 60_000 → `Xm Ys`. Trivial helper, single function
  in `scorecards-render.mjs`.

**Patterns to follow:**

- `buildScorecardBody()`'s existing "Details" `<dl>` block in `src/build/scorecards-render.mjs:467-477` — same shape,
  just more rows.
- The CTA's existing `reproCommand` construction in `src/build/scorecards-render.mjs:481-492` — replace with the branch
  on `target.kind`.
- Markdown-twin rendering in `buildScorecardMarkdown()` already mirrors the HTML — extend in lockstep.

**Test scenarios:**

- Happy path: a v0.4 scorecard renders with all six new metadata rows in the HTML page; markdown twin matches.
- Happy path: `target.kind === "command"` page renders `run.invocation` verbatim in the reproduce CTA.
- Happy path: `target.kind === "project"` page renders the synthesized `anc check --command <tool.name>` form.
- Edge case: `anc.commit: null` renders the version without a commit link (no broken link).
- Edge case: `tool.version: null` falls back to the filename version; the per-tool page renders only the filename
  version (no discrepancy display — drift is now an R5(e) invariant, not a UI surface).
- Error path: a fixture with non-null `tool.version: "0.5.0"` paired with filename version `0.5.1` (drift) throws at
  U2's R5(e) invariant — drift is a build-time data error, not a user-visible note (refined from doc-review pass 2).
- Edge case: `run.duration_ms: 12_345` renders as `12.3s`; `42` renders as `42ms`; `145_234` renders as `2m 25s`.
- Integration: a freshly-rendered per-tool page passes the existing scorecard regression tests (no broken selectors, no
  missing classes).

**Verification:**

- `bun run build && bun test` green.
- `dist/score/eza.html` shows the new metadata block with real v0.4 values.
- `dist/score/eza.md` mirrors the same metadata in markdown.
- **AGENTS.md § Visual fidelity gate (refined from doc-review per Q2 — the prior PR #50 dark-mode regression hit this
  exact `.meta-list` token family).** Mechanical, hard-required for U5 sign-off:

1. Run `bun run dev` (or browse staging) and open `/score/eza` in a browser.
2. Toggle to dark mode via the in-page toggle. Confirm `.meta-list dt` and `.meta-list dd` text is legible against the
   surface — this is where PR #50's regression landed.
3. (Discrepancy display removed per doc-review pass 2 — drift is an R5(e) invariant; no UI to verify.)
4. Toggle back to light mode; confirm parity.
5. Capture screenshots of the Details section in each mode (`.context/screenshots/` per the screenshots-location memory
   rule) and attach to the PR description.

- "Details" rows do not collapse / overflow at standard widths.

---

- [ ] **U6. Update v0.4 docs across schema page, CONTRIBUTING.md, and registry header**

**Goal:** Three doc surfaces updated together so contributors arriving from any angle (registry editor, PR reviewer,
schema-curious reader) see the new contract. The schema page describes the v0.4 fields with null-state semantics and PII
guidance; CONTRIBUTING.md documents the editorial-PR-can-land-first contributor flow; registry.yaml header carries the
same flow note (already covered in U3 Files; restated here for completeness).

**Requirements:** R7 + finding #10 (refined from doc-review pass 2: contributor-flow doc reach extended beyond just the
registry header).

**Dependencies:** U1 (need a real v0.4 scorecard to reference in examples).

**Files:**

- Modify: `content/scorecard-schema.md` — add sections describing `tool`, `anc`, `run`, `target`. Include a
  representative full-document example block (one of the regenerated scorecards, copy-pasted). **Critical (security):
  the example must be drawn from a command-mode scorecard — verify `target.kind: "command"` and `target.path: null`
  before commit; redact `run.invocation` if it embeds anything beyond the canonical `anc check --command <name>
  [--audit-profile X] [--output json]` shape.** Cross-link to the contributor-flow section in CONTRIBUTING.md.
- Modify: `CONTRIBUTING.md` — add (or extend) a "Adding a tool" section that documents the editorial-PR / scorecard-PR
  ordering: "Either order works. Editorial-only PR (registry entry without a scorecard) emits a build warning and the
  entry is excluded from the leaderboard until the scorecard PR lands. Scorecard-only PR (scorecard without a registry
  entry) emits the symmetric warning. Both warnings surface as PR-comment annotations per CI."
- Confirm (already in U3 Files): `registry.yaml` header documents the same contributor flow — restated here so U6's
  verification can grep all three surfaces and confirm they agree.
- Test: none — this is prose-only. Verification is reading + rendering.

**Approach:**

- Mirror the existing section structure (Filename → Top-level fields → `summary` → `coverage_summary` → `results`). Add
  `tool`, `anc`, `run`, `target` between `coverage_summary` and `results`.
- Each new section: type table (field, type, source, meaning), null-state explanation, security note where applicable
  (`run.invocation` and `target.path` may carry local filesystem layout when scoring in project mode; command-mode runs
  are safe).
- Cross-link the upstream CLI plan (`agentnative-cli/docs/plans/2026-04-29-001-feat-scorecard-schema-metadata-plan.md`)
  as the source-of-truth for the schema definition.

**Patterns to follow:**

- The existing `content/scorecard-schema.md` voice and structure — direct, type tables, examples inline.

**Test scenarios:**

- Test expectation: none — prose-only. Verification is human review + the rendered `/scorecard-schema` page displaying
  correctly.

**Verification:**

- `bun run build` produces `dist/scorecard-schema.html` without errors; the new sections render with proper heading
  hierarchy.
- A reader unfamiliar with v0.4 can answer "what does `tool.version: null` mean" and "is `run.invocation` safe to embed
  publicly" from the page alone.
- markdownlint passes.

---

- [ ] **U7. (P3) Binary-name → registry-name redirects on `/score/<binary>`** *(refined from doc-review per Q1)*

**Goal:** A reader who lands on `/score/rg`, `/score/sg`, `/score/btm` (or any of the other 8 binary-named slugs) gets
redirected to `/score/ripgrep`, `/score/ast-grep`, `/score/bottom`, etc. Closes the URL-fragmentation gap that falls out
of the 11 tools where registry name ≠ binary, without breaking existing public URLs that use the canonical registry
name.

**Requirements:** Q1 follow-on — the user explicitly proposed this as a P3 sub-feature when resolving the name-vs-binary
invariant question.

**Dependencies:** U3 (the build needs to know the joined editorial entries to derive the redirect map).

**Files:**

- Modify: `src/build/build.mjs` — at the per-tool emit site, when `registry.binary !== registry.name`, also write
  `dist/score/<binary>.html` as a meta-refresh / `<link rel="canonical">` page that points at `/score/<name>`. Same
  pattern for the markdown twin. **Critical (refined from doc-review pass 2 — P0):** the existing `expectedNames` reaper
  at `build.mjs:296-307` deletes any file in `dist/score/` whose slug is not in `leaderboard.map(e => e.tool.name)`
  (i.e., registry names only). Without modification, the reaper deletes the redirect files (whose slugs are binary
  names) on every build. Either: (a) extend the reaper's allowlist to include `registry[*].binary` for entries where
  `binary !== name`, OR (b) sequence the redirect emission AFTER the reaper runs. Pick (a); it composes more cleanly
  with future rename/retire flows.
- (Removed from this plan — refined from doc-review pass 2): the earlier draft listed `src/worker/index.ts` as an
  alternative implementation. Worker route is its own design; if it's the right call, file as a separate plan. U7 ships
  the static-asset emit path only.

**Approach:**

- Compute the redirect map at build time: `{ "rg": "ripgrep", "sg": "ast-grep", "btm": "bottom", ... }` for the 11 known
  cases (any future tool where name ≠ binary auto-joins).
- Emit `dist/score/<binary>.html` as a `<meta http-equiv="refresh" content="0; url=/score/<name>">` page with a `<link
  rel="canonical" href="/score/<name>">`, a `<title>Redirecting to /score/<name></title>`, and a visible `<p>If you are
  not redirected, <a href="/score/<name>">click here</a>.</p>` body fallback (refined from doc-review pass 2 — slow
  connections / disabled meta-refresh shouldn't see a blank page).
- Markdown twin: emit `dist/score/<binary>.md` with a single line `See [/score/<name>](/score/<name>)`.
- **Reaper allowlist extension** (refined from doc-review pass 2): extend the `expectedNames` set in `build.mjs:301` to
  also include `registry[*].binary` strings for the entries where `binary !== name`. Without this the redirect files get
  unlinked on every build.

**Patterns to follow:**

- The existing `expectedNames` cleanup in `src/build/build.mjs:296-307` shows the precedent for emit-and-clean static
  per-tool files. **Note (refined from doc-review pass 2):** the reaper is what U7 must extend — it is not the pattern
  to copy, it is the code to fix.

**Test scenarios:**

- Happy path: build emits `dist/score/rg.html` (redirect) + `dist/score/ripgrep.html` (canonical) for the ripgrep
  registry entry. The redirect HTML contains a `<meta http-equiv="refresh">` to `/score/ripgrep`.
- Happy path: a second build run does NOT delete the previously-emitted `dist/score/rg.html` (the reaper allowlist
  extension preserves it).
- Edge case: a tool where `binary === name` (the 85+ majority) does NOT emit a redirect file (no-op).
- Edge case: future renames — if a registry entry's binary changes, the now-stale binary slug's redirect file is not in
  the new allowlist and gets cleaned up by the reaper on the next build.
- Edge case: collision check — for each tool with `binary !== name`, the binary string must not appear as another tool's
  `name` in the registry. Add a one-line invariant in U2 to enforce this (refined from doc-review pass 2 — prevents a
  future registry addition silently overwriting a redirect with a canonical page).
- Integration: `curl -sI https://anc.dev/score/rg` returns 200 with the redirect HTML; a browser following it lands on
  `/score/ripgrep`.

**Verification:**

- All 11 known name-vs-binary tools have a redirect page emitted.
- `dist/score/` count grows by exactly the number of name-vs-binary mismatches.
- Manual smoke: visiting `/score/rg` in a browser auto-redirects to `/score/ripgrep`.

---

- [ ] **U8. CI surfaces the warning counts as a PR-comment annotation** *(refined from doc-review pass 2 per Q-CI)*

**Goal:** When U3's symmetric warnings fire (scorecard-without-registry or registry-without-scorecard), CI posts a
structured PR comment naming the offending entries so reviewers see the integrity drift without grepping logs. Build
still succeeds (per Q4's softening); the comment is the discoverability layer.

**Requirements:** R3 (warnings exist) + the user-locked "build summary line + PR-comment annotation" answer to finding
number 7 in doc-review pass 2.

**Dependencies:** U3 (warnings must be emitted in a parseable shape).

**Files:**

- Modify: `src/build/build.mjs` — extend the build summary structure to include `warnings: { scorecardOrphans:
  [...filenames], registryOrphans: [...names] }` (parseable JSON; not just a count). Print to stdout in a stable format
  (e.g., `WARNINGS_JSON: {...}` line) at the end of the build summary so CI can `grep` and parse.
- Create: `.github/workflows/post-warnings-comment.yml` (or extend `ci.yml`) — after `bun run build`, parse the
  `WARNINGS_JSON` line from the build output, and if non-empty, post a PR comment via `gh pr comment` listing the
  offending entries. Idempotent (overwrites prior comment from the same workflow run).
- Test: `tests/build.test.ts` — assert build summary's `warnings` object has the expected shape with both empty and
  non-empty cases.

**Approach:**

- Build summary's `warnings` object enumerates the orphans, not just counts. Comment template:

  ```text
  ⚠️ Scorecard / registry drift in this PR:
  - Scorecards missing a registry entry: foo-v1.0.0.json
  - Registry entries missing a scorecard: bar
  Both excluded from the leaderboard. Land the matching PR or remove the orphan to clear.
  ```

- The CI step is non-blocking: PR check stays green; comment is informational. Reviewer can choose to block on it during
  their review pass.
- For an empty warnings object, the workflow does NOT post a comment (no noise on clean PRs).

**Patterns to follow:**

- Existing `.github/workflows/ci.yml` shape; the post-warnings step lands as either a new workflow file or a job in the
  existing `ci.yml`. Decide at impl time based on whether the comment posting needs `pull_requests: write` permissions
  that other ci.yml jobs don't already have.

**Test scenarios:**

- Happy path (clean): build emits `WARNINGS_JSON: {"scorecardOrphans":[],"registryOrphans":[]}`; CI step parses it and
  posts no comment.
- Warning path: synthetic test renames a scorecard so its slug is missing from registry → build emits the filename in
  `scorecardOrphans` → CI step posts a comment naming it.
- Idempotent: re-running the workflow overwrites the prior comment instead of appending.

**Verification:**

- A test PR that intentionally introduces a scorecard-without-registry mismatch produces a visible PR-comment annotation
  within the CI run; no separate manual review of CI logs needed.
- Clean PRs receive no comment (no false-positive noise).

## System-Wide Impact

- **Interaction graph:** Build pipeline (`src/build/`), regen scripts (`scripts/regen-scorecards.sh`,
  `docker/score/score-anc100.sh`), site renderer (`scorecards-render.mjs`), public schema docs
  (`content/scorecard-schema.md`), every per-tool page (96), the leaderboard page, the markdown twins, and the
  `llms-full.txt` aggregation. The change is broad-shallow: many surfaces touched, no surface deeply altered.
- **Error propagation:** Build-time invariants in U2 + U3 are fail-fast. A corrupted scorecard, missing registry entry,
  or a sub-floor `schema_version` causes `bun run build` to throw before any output is written. CI catches it before
  merge. There is no runtime fallback path — by design.
- **State lifecycle risks:** The 96-scorecard regen in U1 is a one-shot data refresh. If it fails partway through, the
  existing `regen-scorecards.sh` halts on first failure (`set -euo pipefail`), leaving partial state on disk; rerun
  picks up where it stopped. Mid-corpus state (some v0.3, some v0.4) would fail the U2 invariants — that's the safety
  net.
- **API surface parity:** `dist/score/<name>.html`, `dist/score/<name>.md`, and the `llms-full.txt` aggregation all
  consume the same per-tool data — extending one without the other creates drift. U5 explicitly extends both HTML and
  markdown; the llms-full pipeline reads the per-page markdown source so it inherits automatically.
- **Integration coverage:** Unit tests with mocked scorecards prove the loader / renderer logic. The full-build
  integration in U2/U3 (running `bun run build` against the regenerated corpus) is the only place where every layer is
  exercised together — that's the deciding signal that the inversion didn't break end-to-end.
- **Unchanged invariants:** `dist/scorecards.html` row sort order (descending by score, then alphabetical), the `pass /
  (pass + warn + fail)` score formula, `met / total` principle counts, the audit-profile suppression rendering, and the
  audience banner — all out of scope and verified-by-existing-tests.

## Risks & Dependencies

| Risk                                                                                                                                                                                              | Mitigation                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scorecard-driven discovery silently drops registry entries that lacked scorecards (today they would render as em-dash rows from the live code at `src/build/scorecards-render.mjs:76,85,528,530`) | The unscored DATA situation was already retired by PR #40 (all 96/96 scored), so no rows actually render with em-dashes today, but the code path is still live and U3 is what removes it. After U3 ships with symmetric warnings, a registry entry without a scorecard emits a stderr warning + build-summary line + (per finding #7 fix) PR-comment annotation; the build still passes. |
| `tool.version` and filename version disagree on a real tool                                                                                                                                       | R5(e) invariant rejects the corpus at build time (refined from doc-review pass 2). Drift can only happen via parser-asymmetry between the regen script's `version_extract` snippet and the CLI's internal probe — that's a data error worth catching at build time, not a UI surface to maintain. The fix when it fires: align the two parsers; the build won't ship until they agree.   |
| Regen on launch-eve interferes with the launch wave                                                                                                                                               | Default timing is post-launch. The user can override by running U1 + U2 + U3 + U4 + U5 + U6 tonight, but the plan's safe path is "after the Show HN window closes." Sequenced explicitly in the Operational Notes below.                                                                                                                                                                 |
| Breaking change downstream — tools that fetch `https://anc.dev/scorecards/<name>-v<version>.json` directly may rely on v0.3 shape                                                                 | The scorecard JSON files are committed under `scorecards/` and served as static assets. Once regenerated, every fetch returns v0.4. v0.4 is additive (per upstream PR #34's design); v0.3 consumers feature-detect new keys rather than break. No downstream breakage expected, but worth flagging in the PR description for any external consumers.                                     |

## Documentation / Operational Notes

- **Sequencing relative to launch:** Default is post-launch. Concretely: after the Thu 2026-04-30 09:00 PT post lands
  and the launch retro is filed (per central tracker's Distribution Plan), schedule this work as the first v0.4-cycle
  PR.
- **Regen procedure:** Document in U1's commit body: `cargo build --release --manifest-path
  ~/dev/agentnative-cli/Cargo.toml` → confirm `anc --version` reports the dev-branch SHA → `bash
  scripts/regen-scorecards.sh` (or the docker variant). Spot-check before committing 96 files.
- **Changelog impact:** v0.4 schema adoption is a user-visible improvement (per-tool pages gain provenance + run
  metadata). Surfaces in the PR's `## Changelog` block as an `### Added` bullet, e.g. "Per-tool pages now show the `anc`
  build, run platform, and exact reproduce command sourced from the scorecard itself." The registry field removals are
  an `### Internal` note, not user-facing.
- **Cross-repo coordination:** No coordination required. Upstream CLI PR is merged. Local CLI build is the sole
  dependency. Re-regen post-v0.2.0 release happens organically (the next time someone runs the regen pipeline).

## Sources & References

- **Upstream PR:**
  [`agentnative-cli` PR #34 — feat(scorecard): schema 0.4 metadata + pre-push CI hardening](https://github.com/brettdavies/agentnative-cli/pull/34)
  (merged 2026-04-29).
- **Upstream plan:** `agentnative-cli/docs/plans/2026-04-29-001-feat-scorecard-schema-metadata-plan.md` — the
  field-by-field rationale.
- **Upstream binding contract:** `agentnative-cli/src/scorecard/mod.rs` on `dev` — `Scorecard`, `ToolInfo`, `AncInfo`,
  `RunInfo`, `PlatformInfo`, `TargetInfo` struct definitions.
- **Site current implementation:** `src/build/scorecards.mjs`, `src/build/scorecards-render.mjs`, `src/build/build.mjs`,
  `scripts/regen-scorecards.sh`, `docker/score/score-anc100.sh`.
- **Related solutions docs:**
  [cross-repo-artifact-sync-commit-over-fetch-20260420.md](../solutions/architecture-patterns/cross-repo-artifact-sync-commit-over-fetch-20260420.md),
  [triple-emit-content-negotiation-rename-safe-2026-04-29.md](../solutions/best-practices/triple-emit-content-negotiation-rename-safe-2026-04-29.md).
- **Related plans (this repo):**
  [2026-04-28-001-feat-show-hn-launch-readiness-plan.md](2026-04-28-001-feat-show-hn-launch-readiness-plan.md)
  (post-launch sequencing context).
