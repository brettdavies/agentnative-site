---
title: "feat: Adopt scorecard schema 0.4 + invert build pipeline to scorecard-driven display"
type: feat
status: active
date: 2026-04-29
---

# feat: Adopt scorecard schema 0.4 + invert build pipeline to scorecard-driven display

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
cadence isn't a blocker) and the site-side consumption changes (read v0.4, invert the build, drop redundant registry
fields, surface new metadata).

### What v0.4 unlocks beyond the user's stated wins

The user named two specific gains: drop `version` and `scored_at` from the registry. The full unlock surface is broader.
Each item below is either landed in this plan or explicitly deferred:

| Unlock                                                                          | What it enables                                                                                                                                                                                                                                                   | Status in this plan                                                    |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `tool.version` self-reported                                                    | Removes the registry's `version` pin; filename remains the canonical version anchor (`<name>-v<X>.json`); display shows self-reported when present, filename version as fallback                                                                                  | Landed (U2 + U4)                                                       |
| `run.started_at` (RFC 3339)                                                     | Removes the registry's `scored_at` (date-only) field; display gets a real timestamp; sortable                                                                                                                                                                     | Landed (U2 + U4)                                                       |
| `anc.version` + `anc.commit`                                                    | Provenance per scorecard ("scored with `anc v0.2.0` commit `abc1234`"); enables a build-time invariant that every scorecard was produced by `anc ≥ floor`                                                                                                         | Landed (U2 + U5)                                                       |
| `run.invocation`                                                                | Literal argv that produced the score; the per-tool "Reproduce locally" CTA can show the verbatim command instead of constructing one                                                                                                                              | Landed (U5)                                                            |
| `run.duration_ms`                                                               | How long the run took; surface on per-tool page; potential future: median across the corpus as a friction signal                                                                                                                                                  | Landed (U5)                                                            |
| `run.platform.os` / `run.platform.arch`                                         | Where the scorecard was produced; visibility for platform-specific behavior                                                                                                                                                                                       | Landed (U5)                                                            |
| `target.kind`                                                                   | Disambiguates `command` vs `binary` vs `project` mode runs; future-proofs source-layer scorecards                                                                                                                                                                 | Landed (U5) — just the kind label; no per-mode rendering yet           |
| Pipeline inversion                                                              | Build iterates `scorecards/*.json`; joins to registry for editorial fields; scorecard without registry entry = build warning + excluded from leaderboard; registry entry without scorecard = also excluded; leaderboard renders `Showing N audited tools` subhead | Landed (U3)                                                            |
| Build-time integrity invariants                                                 | Assert `tool.name` matches filename slug, `target.command` matches `tool.name` for command-mode, `anc.version ≥` floor, `schema_version` is `0.4`+, `run.started_at` not in the future                                                                            | Landed (U2 + U3)                                                       |
| `audit_profile` derivable from scorecard                                        | Already in scorecard since v0.2; not a v0.4 unlock                                                                                                                                                                                                                | No-op — the registry's `audit_profile` stays as a regen-pipeline input |
| `version_extract` removable from registry                                       | Not actually replaceable: the regen script needs an external probe to derive the filename version for tools whose `--version` output doesn't yield to the default regex, BEFORE the scorecard exists                                                              | No-op — `version_extract` stays as a regen-pipeline input              |
| Editorial fields (tier, language, creator, description, install) into scorecard | Would let the registry shrink to a name list; requires upstream CLI schema change                                                                                                                                                                                 | Out of scope — flagged for future v0.5+ consideration                  |
| Source-layer scorecard rendering (`*-src-YYYYMMDD-branch-commit7.json`)         | Future capability; v0.4's `target.kind: "project"` is the placeholder                                                                                                                                                                                             | Out of scope; this plan doesn't render source-layer scorecards         |
| RSS / "recently scored" feed                                                    | `run.started_at` makes a chronological feed trivially possible                                                                                                                                                                                                    | Out of scope; potentially future work                                  |

## Problem Frame

The scorecard artifact and the registry currently overlap on three fields — `version`, `scored_at`, and (implicitly)
`audit_profile`. That overlap is a contract risk: the regen script writes `scored_at` back into the registry on every
run, the per-tool page reads `version` from the registry but displays the filename-derived version when the registry pin
is missing, and a reader who fetches a scorecard JSON in isolation cannot answer "which `anc` build produced this, on
what platform, when, with what argv" — they have to cross-reference the registry to even know what tool the scorecard
belongs to.

`agentnative-cli` PR #34 closes that gap upstream by making the scorecard self-describing. The site is the largest
downstream consumer; this plan is the corresponding consumption change. It also takes the opportunity to invert the
build pipeline so the site renders what scorecards actually exist on disk, rather than what the registry says should be
scored — eliminating the "unscored row with em-dash" failure mode and turning scorecard-without-registry into a loud
build warning (with scorecard excluded from the leaderboard) instead of a silent skip.

## Requirements Trace

- **R1.** Site consumes `schema_version: "0.4"` scorecards correctly: the four new metadata blocks (`tool`, `anc`,
  `run`, `target`) are read, validated, and either surfaced in the UI or used for build-time invariants.
- **R2.** `version` and `scored_at` are removed from `registry.yaml`. Display sources move to the scorecard
  (filename-as-canonical for version; `run.started_at` for date).
- **R3.** Build pipeline inverts: `scorecards/*.json` is the iteration source. `registry.yaml` is joined for editorial
  fields (tier, language, creator, description, install, repo/url). A scorecard without a registry entry is a build
  **warning** with the scorecard excluded from the leaderboard (refined from doc-review: softened from hard error to
  warning + exclusion, decouples regen + editorial flows, supports rename/retire workflows). A registry entry without a
  scorecard is also excluded from the leaderboard (no fallback-row rendering). The leaderboard renders a `Showing N
  audited tools` subhead so the new contract — "every visible row is a real audit" — is explicit to readers, and
  `registry.yaml`'s header documents the contributor flow (editorial PR can land before scorecard PR; build emits a
  warning until the scorecard arrives).
- **R4.** Per-tool page surfaces the new metadata: `anc.version` + `anc.commit`, `run.started_at`, `run.duration_ms`,
  `run.platform.os` / `arch`, `target.kind`, and `run.invocation` as the verbatim "reproduce locally" command for
  command-mode runs.
- **R5.** Build-time invariants protect the corpus (refined from doc-review): (a) every committed scorecard has
  `schema_version` at-or-above `"0.4"` (compared via the existing `compareVersions()` helper); (b) every scorecard's
  filename-derived slug exists as a `registry.tools[].name` (the editorial join); (c) for the joined registry entry,
  `scorecard.tool.name === registry.binary` — validates the regen pipeline scored the right binary, accommodates the 11
  tools where registry name ≠ binary (ripgrep→rg, ast-grep→sg, bottom→btm, etc.); (d) every `run.started_at` parses as
  RFC 3339. Anc-version floor, `target.command` cross-check, and future-date guard are out of scope for v1 — speculative
  hardening per scope-guardian; the anc-version floor is non-falsifiable until v0.2.0 ships and a re-regen tightens it.
  Future-work plan owns those if desired.
- **R6.** 95 of 96 scorecards in `scorecards/` are regenerated to v0.4 shape (anc itself is deleted, see U1) using a
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
  filename. Display shows `tool.version` when present and the filename version otherwise; if they disagree, both
  surfaces show the discrepancy (the page footer notes it as `version: 0.5.0 (self-reported); 0.5.1 (filename)` so a
  reader can spot drift).
- **Invariants enforce schema floor + corpus consistency.** Build-time invariants (in the existing
  `runInvariantChecks()` mechanism) refuse to ship if any committed scorecard is below `schema_version: "0.4"`, produced
  by an `anc.version` below the floor, has a `tool.name` that doesn't match its filename, has a non-RFC-3339
  `run.started_at`, or has a `target.command` that disagrees with `tool.name` for command-mode runs. Fail-fast is the
  convention here (precedent: `runInvariantChecks()` already throws on RFC-keyword leaks and missing locked slugs).
- **Hybrid pipeline — scorecard discovery first, registry join for editorial.** Build iterates `readdir('scorecards/')`
  and parses `<name>-v<version>.json`. For each name, it joins to `registry.yaml`. Missing registry entry = build
  **warning** with the scorecard excluded from the leaderboard (refined from doc-review per Q4: softened from hard error
  to warning + exclusion; decouples regen + editorial flows; supports rename/retire workflows). Registry entry without a
  scorecard = also excluded from the leaderboard. The current "unscored row with em-dash" code path is removed. The
  leaderboard renders a `Showing N audited tools` subhead so readers see the explicit count and understand the contract.
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
- **Should the build still emit unscored rows?** No. With pipeline inversion, only tools with a real scorecard appear on
  the leaderboard. (Auto-fix from doc-review: clarifying — launch-readiness U3 confirmed the unscored DATA situation was
  retired by PR #40, all 96/96 scored. The em-dash CODE PATH itself is still live in
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
                       │   2. Extract tool.name from filename │
                       │   3. Lookup registry[tool.name]      │
                       │      ├─ found    → join + render     │
                       │      └─ missing  → BUILD ERROR       │
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

- [ ] **U1. Regenerate 95 scorecards to v0.4; delete the `anc` scorecard pending a v0.2.0 regen**

**Goal:** Every file under `scorecards/*.json` carries `schema_version: "0.4"` and the four new metadata blocks. The
existing `scorecards/anc-v0.1.3.json` (v0.3 shape) is **deleted** as part of this unit; `anc` will not appear on the
leaderboard until a fresh v0.4 scorecard is committed after CLI v0.2.0 ships (see Risks). Deleting rather than
regenerating against the dev-branch binary avoids advertising `anc 0.1.0` (a *lower* version than the last released
`0.1.3`) as a false regression on the public site.

**Requirements:** R6.

**Dependencies:** None (the local CLI's `dev` branch already has PR #34 merged; build the binary, point the regen
pipeline at it, commit the resulting scorecards).

**Files:**

- Modify (95 in bulk): `scorecards/*.json` *excluding* `scorecards/anc-v0.1.3.json`.
- Delete: `scorecards/anc-v0.1.3.json` (`trash scorecards/anc-v0.1.3.json` per the project's no-`rm` convention).
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

- Run `scripts/regen-scorecards.sh --exclude anc` (add an `--exclude` flag if the script doesn't have one yet, or
  temporarily move `scorecards/anc-v0.1.3.json` aside, regen, restore). The exclude is critical: the dev-branch binary
  self-reports `0.1.0`, which would create `scorecards/anc-v0.1.0.json` — a *lower* version than the released `0.1.3`
  already in the corpus.
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
- `scorecards/anc-v0.1.3.json` is no longer present on disk.
- Existing per-result fields (`results[]`, `summary`, `coverage_summary`, `audience`, `audit_profile`, `spec_version`)
  are preserved.
- `git diff --stat scorecards/` shows 96 files changed; no files added or removed.

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

- [ ] **U3. Invert the build pipeline — scorecard-driven discovery, registry editorial join**

**Goal:** Build iterates `scorecards/*.json` first; joins registry by name for editorial metadata. Scorecard without a
registry entry is a build **warning** (logged with offending filename + missing name; scorecard excluded from the
leaderboard). Registry entry without a scorecard is also excluded from the leaderboard. Leaderboard renders a `Showing N
audited tools` subhead.

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
  need the `if (!entry.scorecard)` em-dash branches (lines 76, 85, 528, 530); simplify accordingly. Add a `Showing N
  audited tools` subhead near the leaderboard's existing intro paragraph (refined from doc-review per Q4: surfaces the
  new "every visible row is a real audit" contract to readers).
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
- For each scorecard's filename-derived name, look up the registry entry by name. Missing entry = log a warning with
  filename + missing-name to stderr, accumulate the count for the build summary, and exclude the scorecard from the
  returned set.
- Registry entries without matching scorecards do NOT appear in the leaderboard. The build summary reports both
  exclusion counts (scorecards-without-registry + registry-without-scorecards), so `bun run build` output makes the
  asymmetry visible.
- The leaderboard's intro paragraph gains a `Showing N audited tools` subhead derived from the joined-set count.
- The `loadRegistry()` function stays for editorial validation; what changes is who iterates first.

**Patterns to follow:**

- `loadScorecards()` current implementation in `src/build/scorecards.mjs:170-209` — same I/O shape, inverted loop order.
- The `expectedNames` cleanup in `src/build/build.mjs:296-302` (drops stale per-tool `dist/score/<name>.html` files)
  shows the existing precedent for "scorecard-driven naming."

**Test scenarios:**

- Happy path: 95 scorecards on disk + 95+ registry entries (anc kept editorial, scorecard pending) → 95 leaderboard rows
- `Showing 95 audited tools` subhead. Build summary reports the registry-without-scorecard exclusion count.
- Happy path: 95 scorecards + 96 registry entries (one extra editorial-only entry) → 95 leaderboard rows; the extra
  registry entry is silently excluded; build summary reports it.
- Warning path: 95 scorecards + 94 registry entries (one scorecard's name absent from registry) → build succeeds with 94
  leaderboard rows; stderr carries a warning naming the offending filename + missing registry name; build summary
  includes the warning count.
- Edge case: scorecard filename slug normalization — confirm filename-derived name is compared case-sensitively against
  `registry.tools[].name` (both should be `[a-z0-9-]+` per existing convention).
- Integration: full `bun run build` run against the regenerated corpus emits the same number of `dist/score/<name>.html`
  files as included scorecards (not raw on-disk count), and `dist/scorecards.html` row count matches.

**Verification:**

- `bun run build` against U1's regenerated corpus produces 95 leaderboard rows + 95 per-tool pages + a `Showing 95
  audited tools` subhead.
- A synthetic test (rename one scorecard to a name not in registry) makes the build succeed with one fewer leaderboard
  row + a stderr warning naming the offending filename.
- Removing a registry entry (without removing its scorecard) makes the build emit the same stderr warning + the
  scorecard is excluded.
- Removing a scorecard (without removing its registry entry) makes the build succeed but the leaderboard drops by one
  row + the build summary reports the registry-without-scorecard exclusion.

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
  markdown twin (matches the triple-emit pattern).
- Modify: `src/styles/site.css` — minor styling additions if the new metadata block warrants visual differentiation
  (probably just reuses the existing `.scorecard-meta` / `.meta-list` styles; confirm during impl).
- Test: `tests/build.test.ts` — extend `buildScorecardBody` describe block with v0.4 metadata rendering tests (presence
  of each field, command-mode-uses-run.invocation, project-mode-uses-synthesized).

**Approach:**

- "Details" block grows to show: `Anc version` (with `commit` link to the upstream commit if non-null), `Audit date`
  (now from `run.started_at`, formatted), `Duration` (humanized), `Platform` (os/arch), `Mode` (target.kind), `Install`
  (unchanged).
- Reproduce CTA: when `target.kind === "command"`, render `<pre><code>${run.invocation}</code></pre>` directly.
  Otherwise, render the synthesized `anc check --command <tool.name>` form (today's behavior). When the scorecard's
  `tool.version` and the filename version disagree, render both with a one-line note explaining the discrepancy.
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
- Edge case: `tool.version: null` falls back to the filename version; the per-tool page does NOT render a discrepancy
  note.
- Edge case: `tool.version: "0.5.0"` and filename version `0.5.1` (drift) renders both with the discrepancy note.
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
3. Confirm the discrepancy note (when present) is visually distinct from normal `dd` values in both modes.
4. Toggle back to light mode; confirm parity.
5. Capture screenshots of the Details section in each mode (`.context/screenshots/` per the screenshots-location memory
   rule) and attach to the PR description.

- "Details" rows do not collapse / overflow at standard widths.

---

- [ ] **U6. Update `content/scorecard-schema.md` to document v0.4 fields**

**Goal:** The public `/scorecard-schema` docs page describes the v0.4 schema accurately, including the four new metadata
blocks, null-state semantics, and the publishing-PII review reminder for `run.invocation` / `target.path`.

**Requirements:** R7.

**Dependencies:** U1 (need a real v0.4 scorecard to reference in examples).

**Files:**

- Modify: `content/scorecard-schema.md` — add sections describing `tool`, `anc`, `run`, `target`. Include a
  representative full-document example block (one of the regenerated scorecards, copy-pasted).
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
  pattern for the markdown twin.
- Modify: `src/worker/index.ts` — alternative implementation: the Worker handles `/score/<unknown>` lookups by
  consulting a build-emitted `dist/score/_redirects.json` map. Decide between static-asset emit vs Worker route at U7
  implementation time.

**Approach:**

- Compute the redirect map at build time: `{ "rg": "ripgrep", "sg": "ast-grep", "btm": "bottom", ... }` for the 11 known
  cases (any future tool where name ≠ binary auto-joins).
- Cheapest implementation: emit `dist/score/<binary>.html` as a `<meta http-equiv="refresh" content="0;
  url=/score/<name>">` page with a `<link rel="canonical" href="/score/<name>">` — search engines correctly attribute,
  browsers immediately redirect.
- Markdown twin: emit `dist/score/<binary>.md` with a single line `See [/score/<name>](/score/<name>)`.

**Patterns to follow:**

- The existing `expectedNames` cleanup in `src/build/build.mjs:296-302` shows the pattern for emit-and-clean static
  per-tool files.

**Test scenarios:**

- Happy path: build emits `dist/score/rg.html` (redirect) + `dist/score/ripgrep.html` (canonical) for the ripgrep
  registry entry. The redirect HTML contains a `<meta http-equiv="refresh">` to `/score/ripgrep`.
- Edge case: a tool where `binary === name` (the 85+ majority) does NOT emit a redirect file (no-op).
- Edge case: future renames — if a registry entry's binary changes, the old binary slug's redirect file is cleaned up by
  the `expectedNames` reaper.
- Integration: `curl -sI https://anc.dev/score/rg` returns 200 with the redirect HTML; a browser following it lands on
  `/score/ripgrep`.

**Verification:**

- All 11 known name-vs-binary tools have a redirect page emitted.
- `dist/score/` count grows by exactly the number of name-vs-binary mismatches.
- Manual smoke: visiting `/score/rg` in a browser auto-redirects to `/score/ripgrep`.

## System-Wide Impact

- **Interaction graph:** Build pipeline (`src/build/`), regen scripts (`scripts/regen-scorecards.sh`,
  `docker/score/score-anc100.sh`), site renderer (`scorecards-render.mjs`), public schema docs
  (`content/scorecard-schema.md`), every per-tool page (96), the leaderboard page, the markdown twins, and the
  `llms-full.txt` aggregation. The change is broad-shallow: many surfaces touched, no surface deeply altered.
- **Error propagation:** Build-time invariants in U2 + U3 are fail-fast. A corrupted scorecard, missing registry entry,
  or sub-floor `anc.version` causes `bun run build` to throw before any output is written. CI catches it before merge.
  There is no runtime fallback path — by design.
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

| Risk                                                                                                                                                                                      | Mitigation                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline inversion silently drops registry entries that lacked scorecards (today they would render as em-dash rows from the live code at `src/build/scorecards-render.mjs:76,85,528,530`) | The unscored DATA situation was already retired by PR #40 (all 96/96 scored), so no rows actually render with em-dashes today, but the code path is still live and U3 is what removes it. If a registry entry without a scorecard is reintroduced post-inversion, the new behavior (exclusion from leaderboard) is the documented intent — the build summary makes the absence visible. |
| `tool.version` and filename version disagree on a real tool, confusing readers                                                                                                            | U5 renders both with a one-line discrepancy note. Discrepancy is itself signal — the regen pipeline used `version_extract` to derive the filename, but the binary's own `--version` may have changed format between regens. Surfacing the drift is more honest than silently picking one.                                                                                               |
| Regen on launch-eve interferes with the launch wave                                                                                                                                       | Default timing is post-launch. The user can override by running U1 + U2 + U3 + U4 + U5 + U6 tonight, but the plan's safe path is "after the Show HN window closes." Sequenced explicitly in the Operational Notes below.                                                                                                                                                                |
| Breaking change downstream — tools that fetch `https://anc.dev/scorecards/<name>-v<version>.json` directly may rely on v0.3 shape                                                         | The scorecard JSON files are committed under `scorecards/` and served as static assets. Once regenerated, every fetch returns v0.4. v0.4 is additive (per upstream PR #34's design); v0.3 consumers feature-detect new keys rather than break. No downstream breakage expected, but worth flagging in the PR description for any external consumers.                                    |

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
