---
title: "Handoff 6 of 6: v0.1.3 ANC 100 leaderboard launch (site)"
type: handoff
order: 6
phase: v0.1.3
depends_on: [1, 2, 3, 4, 5]
prerequisites: ["CLI handoff 5 (v0.1.3) shipped", "100-tool registry baseline complete with committed scorecards"]
blocks: []
---

# Handoff 6: v0.1.3 ANC 100 leaderboard launch (site)

**Status (2026-04-22):** Renderer Units 1+, methodology page, registry growth, Unit 0.5 (audience kebab-case flip), Unit
0 pre-staging, and a follow-up that makes the scorecard filename trustworthy (extracts the actual installed binary
version per tool, audit_profile vocabulary validation, lazygit pre-staged for the DoD) have all shipped on
`feat/v013-leaderboard-launch` (5 commits, 99 tests pass, build green). **Unit 0 is now unblocked** — `anc` v0.1.3 was
released on 2026-04-22 ([crates.io](https://crates.io/crates/agentnative/0.1.3),
[GitHub Release](https://github.com/brettdavies/agentnative-cli/releases/tag/v0.1.3), Homebrew bottles uploaded). Unit 0
collapses to `bash scripts/regen-scorecards.sh`. See the Implementation Log below for the full as-shipped record.

**Written for**: the session that turns the pre-GA project into a public leaderboard. Happens only after CLI handoff 5
has shipped `anc` v0.1.3 AND the 100-tool registry has baseline scores. This is the launch-facing release. CLI-side
v0.1.3 work (audience classifier, `audit_profile` suppression, `p1-env-hints` pattern 2) is **not owned by this plan** —
see "Split from original combined H5" below.

## Split from original combined H5

This plan was originally a combined H5 covering both CLI and site work. Per the agentnative project convention ("each
repo's `docs/plans/` owns the work that happens in that repo"), the CLI-side scope was split into a separate handoff
living in its own repo:

- **CLI H5 (v0.1.3)** — source of truth in `agentnative` repo at
  `docs/plans/2026-04-21-v013-handoff-5-cli-audience-classifier.md`. Delivers the audience classifier, the
  `--audit-profile` flag + suppression, and `p1-env-hints` Pattern 2.
- **Site H6 (v0.1.3)** — this document. Delivers the banner, leaderboard filters, `/scorecards` go-live, and methodology
  note.

Release ordering is strict: CLI H5 ships first (as `anc` v0.1.3 on crates.io + Homebrew), then the site's
committed scorecards are regenerated against the new binary, then this handoff executes. Do not start this work until
the CLI half has shipped and the 10 committed scorecards have been refreshed.

The original filename and handoff number were renamed (H5 → H6) to reflect the post-split sequence; the content below
has been scoped down to site-only work.

## Implementation log

The plan as originally written assumed strict sequencing: CLI v0.1.3 ships → Unit 0 regenerates the 10 scorecards →
Units 1+ then build renderers against real `audience` / `audit_profile` values. Reality diverged when the CLI v0.1.3
release got delayed and the user asked what site work could ship in advance. The renderers were built defensively
against synthetic v0.1.3-shaped fixtures (see the test file `tests/build.test.ts` for the fixture shapes), so they ship
green against the existing `audience: null` scorecards and will light up automatically once Unit 0 lands.

As-shipped order on `feat/v013-leaderboard-launch` is the inverse of the plan's strict sequence: the renderer Units 1+,
Unit 0.5, and the registry growth all landed first against the synthetic-fixture path; Unit 0 will be the final commit
once `anc` v0.1.3 is installable.

| Commit  | Date       | What                                                                                                                | Plan unit              |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| b0fb782 | 2026-04-22 | Audience banner v2, suppressed-check rendering, agent-optimized filter, `/methodology`                              | Units 1, 2, 3, 5       |
| c355cf8 | 2026-04-22 | Registry 96 → 100 (`gemini-cli`, `opencode`, `qmd`, `mcp-agent-mail`)                                               | Hard prereq #2 (R1/R2) |
| f65fef0 | 2026-04-22 | Audience kebab-case flip + suppression-prefix contract pin (with trailing space)                                    | Unit 0.5               |
| 7f9f64a | 2026-04-22 | Pre-staging: `fd → file-traversal` annotation, `scripts/regen-scorecards.sh`, snake_case guard                      | Unit 0 prep            |
| 2afe5bc | 2026-04-22 | Scorecard filename = actually-installed binary version + `audit_profile` build-time validation + lazygit pre-staged | Unit 0 prep follow-up  |

What changed vs. the plan as written:

- **Renderers ship before Unit 0 regen.** Because `renderAudienceBanner()` returns `''` for `audience: null` and
  `renderCheckRows()` only branches on the suppression evidence prefix, every committed v1.1/v1.2 scorecard renders
  identically to its pre-H6 output. The new code paths exercise only when `audience` and `audit_profile` carry real
  values — i.e. after Unit 0.
- **Unit 0.5 was discovered late, mid-execution.** The plan's original "renderer robustness" line listed snake_case
  audience values; CLI H5's `/ce:review` pass flipped them to kebab-case (2026-04-22, post-merge of the CLI plan). The
  user surfaced the gap during this session ("there should be additional work to be done regarding updating the
  casing"). Unit 0.5 was added to this plan and shipped in a single commit alongside a contract-pin fix for the
  suppression evidence prefix (mirrored exactly from `SUPPRESSION_EVIDENCE_PREFIX` in
  `agentnative/src/principles/registry.rs`, including the trailing space).
- **Suppression copy / methodology table rewritten from the actual `SUPPRESSION_TABLE`.** Initial drafts of
  `AUDIT_PROFILE_COPY` and the methodology table guessed at what each profile suppresses (e.g., `human-tui` was
  documented as suppressing P7 quiet, `posix-utility` as suppressing P2/P3). The CLI source disagrees; the f65fef0
  commit aligns both site surfaces with the table that ships with `anc` v0.1.3.
- **Registry growth landed inside this branch instead of as a separate prerequisite.** R1/R2 of the brainstorm asked for
  ≥100 entries before launch; the plan deferred that to "registry growth is its own track." In practice four additions
  (two agent-tier, two notable-tier) were small enough to bundle into this PR. Tier balance after: 70 workhorse / 12
  agent / 18 notable.
- **Scorecard filename = actually-installed binary version, not the registry's pinned value.** The original regen-script
  design (and its docstring) trusted `registry.yaml`'s `version` field to name the output file. That meant a tool
  upgraded outside the registry could land scorecard JSON for v3 inside `<name>-v2.json`, silently lying about what was
  tested. Per user MUST in 2afe5bc: extract the actually-installed version per tool (default: first SemVer token from
  `<binary> --version`; per-tool override via `version_extract` for cases like lazygit where the line embeds a second
  version), use that for the filename, and auto-bump `registry.yaml`'s `version` field on drift with a warning to
  `trash` the orphaned old file. Pre-corrected two real drifts surfaced during dev: gh 2.89.0 → 2.91.0 and claude-code
  2.1.116 → 2.1.117. Platform identification deferred — `anc` doesn't currently emit it; logged as a future-CLI
  enhancement (would need a sidecar metadata file or a CLI-side `--target-platform` field).
- **`audit_profile` vocabulary is build-time validated.** `loadRegistry` now rejects unknown values against
  `KNOWN_AUDIT_PROFILES = ['human-tui', 'file-traversal', 'posix-utility', 'diagnostic-only']`, mirroring
  `ExceptionCategory::to_kebab_str()` in the CLI. A typo like `audit_profile: tui-by-design` (the brainstorm's old
  shorthand) would previously sail through `bun run build` and fail mid-loop in the regen script; it now fails at the CI
  gate.
- **lazygit pre-staged for the DoD lazygit-banner sanity check.** Added `version: "0.61.1"`, `scored_at`,
  `audit_profile: human-tui`, plus an explicit `version_extract` snippet (lazygit's --version line embeds the git
  version too — leaving the default extractor in place would silently shift to whichever version comes first).

What's still pending:

- **Unit 0** — **ready to execute as of 2026-04-22.** `anc` v0.1.3 is live on crates.io and Homebrew (GitHub release
  published 2026-04-23 00:50 UTC, marked `make_latest: true` after manual `finalize-release` dispatch to work around a
  separate homebrew-tap bug tracked in `brettdavies/.github` todo 006). Run `bash scripts/regen-scorecards.sh` (added
  7f9f64a, hardened 2afe5bc) — version-gated, idempotent, extracts the actual binary version per tool, applies
  `audit_profile` flags from the registry, writes scorecards, bumps `scored_at`. The two pre-staged `audit_profile`
  annotations in the current 11 (`fd → file-traversal`, `lazygit → human-tui`) are already in the registry.
- **DoD manual sanity checks** — depend on Unit 0 outputs. `gh` no banner, `lazygit` human-tui banner, `ripgrep` no
  banner (Pattern 2 fix), `fd` file-traversal banner.
- **Platform identification in scorecards** — current `anc check --output json` doesn't emit a platform field
  (`linux/x86_64`, `darwin/arm64`, etc.). Adding it site-side would mean injecting fields into the CLI's JSON output,
  which forks the schema. Better as a future `anc` enhancement (sidecar metadata or a `--target-platform` field). Not
  blocking launch; logged here so the gap doesn't get forgotten.

## Sibling handoffs

| # | Phase  | Repo               | Doc                                                                              |
| - | ------ | ------------------ | -------------------------------------------------------------------------------- |
| 1 | v0.1.1 | `agentnative`      | `docs/plans/2026-04-20-v011-handoff-1-agentnative-impl.md`                       |
| 2 | v0.1.1 | `agentnative-site` | `docs/plans/2026-04-20-v011-handoff-2-site-spec-coverage.md` (+ session brief)   |
| 3 | v0.1.1 | `agentnative-site` | `docs/plans/2026-04-20-v011-handoff-3-scorecard-regen.md`                        |
| 4 | v0.1.2 | `agentnative`      | `docs/plans/2026-04-20-v012-handoff-4-behavioral-checks.md`                      |
| 5 | v0.1.3 | `agentnative`      | `docs/plans/2026-04-21-v013-handoff-5-cli-audience-classifier.md` *(CLI, ships first)* |
| 6 | v0.1.3 | `agentnative-site` | `docs/plans/2026-04-21-v013-handoff-6-site-leaderboard-launch.md` *(this doc)*   |

## The job, in one sentence

Surface the CLI-emitted `audience` and `audit_profile` fields in the per-tool page, ship the ANC 100 leaderboard with
filters and sorting, and publish the methodology note that frames audience classification as informational signal rather
than authoritative verdict.

## Hard prerequisites: DO NOT launch without these

1. **CLI v0.1.3 shipped** with the audience classifier, `audit_profile` suppression, and the Pattern 2 env-hints fix.
   Verify via `anc --version` and `anc check <tool> --output json | jaq '.audience, .audit_profile'` returning string
   values (not `null`) when the inputs warrant it. **Note the casing of the emitted `audience` values:** v0.1.3 emits
   **kebab-case** (`"agent-optimized"`, `"mixed"`, `"human-primary"`), NOT the snake_case shape previously sketched in
   the original combined H5 plan. See Unit 0.5 below and the CLI H5 Implementation Log entry ("Audience values flipped
   from snake_case to kebab-case") for rationale. Status (2026-04-23): **MET.** CLI H5 merged in `agentnative` (PR #26,
   dc5d741; PR #27, db11e97 added audience_reason and kebab-case unification). `v0.1.3` released on 2026-04-22 — live on
   [crates.io](https://crates.io/crates/agentnative/0.1.3), the
   [GitHub Release](https://github.com/brettdavies/agentnative-cli/releases/tag/v0.1.3) is marked latest, and Homebrew
   bottles are uploaded. Local install upgrade is the last user-side step before Unit 0 runs.
1. **`registry.yaml` has ≥100 tools AND every tool has a baseline scorecard committed.** **Launching before this is met
   makes the leaderboard look punitive** — 5 of 10 current tools would drop under new checks, producing the HN narrative
   "new linter rates famous tools badly based on rules written last week" (per the CEO review's outside voice Finding
   #7). Status (2026-04-23): registry-count side **MET** (100 entries; commit c355cf8 added `gemini-cli`, `opencode`,
   `qmd`, `mcp-agent-mail`); baseline-scorecard side **READY TO EXECUTE** (10 committed scorecards, all v0.1.1/v0.1.2
   outputs with `audience: null`, now unblocked — `anc` v0.1.3 released 2026-04-22). Unit 0 regenerates the 10 against
   v0.1.3; growth past 10 is post-launch / R19 community submissions.

If either prerequisite isn't ready, do not start this handoff. Registry growth + initial scoring is its own
track; it's not covered here.

## Read these first

1. `~/.gstack/projects/brettdavies-agentnative/ceo-plans/2026-04-20-p1-doctrine-spec-coverage.md` — "Accepted Scope
   (v0.1.3)" section.
2. `docs/brainstorms/anc-100-audit-requirements.md` — the original leaderboard spec (R1-R20) in this repo. Skip
   requirements already met by v0.1.1 + v0.1.2.
3. `~/dev/agentnative/docs/plans/2026-04-21-v013-handoff-5-cli-audience-classifier.md` — the CLI-side plan this site
   work consumes. Read the "Key Technical Decisions" and "System-Wide Impact" sections in particular to understand the
   shape of `audience` and `audit_profile` values emitted in the scorecard JSON.

Do NOT re-read doctrine transcripts.

## Scope

### Unit 0: Scorecard regeneration bridge (blocker for every other unit)

**Status: READY (unblocked 2026-04-22 by `anc` v0.1.3 release).** Latest tag on `brettdavies/agentnative-cli` is
`v0.1.3` (2026-04-22, marked `make_latest: true`). Local install still needs to be bumped from 0.1.2 to 0.1.3 before
running the regen script. Per the Implementation Log, the renderer work in Units 1+ shipped first against synthetic
fixtures and the null-feature-detect path; Unit 0 is the final commit on this branch now that the binary is installable.

Before any renderer work in this plan begins, every committed scorecard must be regenerated against `anc` v0.1.3 so that
`audience` and `audit_profile` carry real (non-null) values and `p1-env-hints` verdicts reflect Pattern
2. Until that ships, there is nothing for the banner, filters, or methodology note to read — they would fall through to
the null/pre-v1.3 rendering path on every tool.

This is bridge work: not a CLI change (CLI H5 already shipped by the time this runs) and not a site renderer change
(that's Units 1+ below). It's a one-PR data refresh. Called out as Unit 0 so the dependency is explicit in the plan
rather than implied in the prerequisites.

**Goal:** Refresh every committed scorecard on this repo to v1.3 output, so H6 renderer work has real inputs to read
against.

**Prerequisite:** CLI H5 shipped — `anc` v0.1.3 installable from crates.io and/or Homebrew.

**Files:**

- Modify: `scorecards/*.json` (all 10 committed tools — `ripgrep`, `fd`, `jq`, `bat`, `dust`, `gh`, `claude-code`,
  `aider`, `llm`, `anc`).
- Modify: `scorecards/registry.yaml` (bump `scored_at: 2026-MM-DD` for each tool; add `audit_profile: <category>`
  entries for tools that belong in an exception category — at minimum `lazygit → human-tui`, `fd → file-traversal` if
  they're in the 10; `nvidia-smi → diagnostic-only` if applicable; use judgment for the rest).
- Modify: `src/data/coverage-matrix.json` via `scripts/sync-coverage-matrix.sh` (pulls the updated matrix from the CLI
  repo — picks up any registry changes from CLI H5, though that plan promises no new registry entries).

**Approach (as-shipped, post 2afe5bc):**

1. Install `anc` v0.1.3: `brew upgrade brettdavies/tap/agentnative` or `cargo install --version 0.1.3 agentnative`.
   Verify `anc --version` prints `0.1.3`.
2. Run `bash scripts/regen-scorecards.sh`. For each of the 11 tools with a `version` field in `registry.yaml`, the
   script extracts the actually-installed binary version (default: first SemVer token from `<binary> --version`;
   per-tool override via `version_extract`), names the output file from that extracted version (so the filename never
   lies about what was tested), runs `anc check --command <binary> [--audit-profile <cat>] --output json`, bumps
   `scored_at` and — on drift between registry and reality — auto-bumps the registry's `version` field. Pre-staged
   audit_profiles: `fd → file-traversal`, `lazygit → human-tui`.
3. If the script's drift summary lists orphaned `<name>-v<old>.json` files (registry was bumped, old scorecards
   superseded), `trash` them.
4. Run `scripts/sync-coverage-matrix.sh` to refresh `src/data/coverage-matrix.json` from the CLI repo.
5. Run `bun test && bun run build`. The snake_case audience guard (7f9f64a) and the `audit_profile` vocabulary validator
   (2afe5bc) both run as part of `bun test` / `loadRegistry`.
6. Commit as the final commit on `feat/v013-leaderboard-launch`; ship the whole branch as one PR to `dev`.

**Verification:**

- `jaq '.schema_version' scorecards/<tool>-*.json` returns `"1.1"` on every file (schema unchanged).
- `jaq '.audience' scorecards/<tool>-*.json` returns a string (not `null`) on every tool where the 4 signal checks could
  all run.
- `jaq '.audit_profile' scorecards/lazygit-*.json` returns `"human-tui"` (assuming lazygit is in the 10 and was
  annotated).
- `jaq '.results[] | select(.id == "p1-env-hints") | .status' scorecards/ripgrep-*.json` returns `"pass"` (Pattern 2 fix
  flipped it from `"warn"`).
- CI regression tests on the site continue to pass against the refreshed scorecards (renderers feature-detect any new
  shape).

**Handoff to Units 1+:** once this PR merges, the renderer work below has real `audience` / `audit_profile`
values to branch on. Don't start banner / filter / methodology work before this lands.

### Unit 0.5: Absorb the audience kebab-case unification (pre-renderer work)

**Status: SHIPPED (commit f65fef0, 2026-04-22).** The flip + suppression-prefix contract pin landed together. The plan
text below is preserved as written; the as-shipped notes are in the Implementation Log above.

**Must complete before the regen in Unit 0 runs.** Otherwise v0.1.3 scorecards populate `audience` fields with
kebab-case strings (`"agent-optimized"` / `"mixed"` / `"human-primary"`) and the site's existing leaderboard filter +
banner renderer — currently hardcoded to `"agent_optimized"` / `"human_primary"` — silently excludes every row from the
"Agent-optimized only" toggle and renders the generic fallback copy instead of the audience-specific headline.

**Why this exists:** v0.1.3 CLI was going to emit snake_case `audience` values to match the existing `CheckGroup` /
`CheckLayer` / `Confidence` enum conventions. Mid-release, a `/ce:review` pass flagged the resulting mix (snake_case
`audience` + kebab-case `audit_profile` inside one JSON document) as a design asymmetry. `audit_profile` must stay
kebab-case because it echoes the CLI flag value (`--audit-profile human-tui`). `audience` adopted the same convention so
consumers don't juggle two casings in one document. Per-result enum values in `results[].group` / `layer` / `confidence`
stay snake_case — those are a different contract with broader history. Window rationale: v0.1.2 always emitted
`audience: null` and site H6 hasn't shipped, so no live consumer had pinned on the snake_case values.

See the CLI H5 Implementation Log entry titled *"Audience values flipped from snake_case to kebab-case
(post-code-review, 2026-04-22)"* in the sibling handoff for the full decision record.

**Goal:** the site's rendering, filtering, and test paths all accept kebab-case `audience` values BEFORE Unit 0 regen
runs.

**Files to change** (exact surface, verified 2026-04-22 against main):

- Modify: `src/build/scorecards-render.mjs` — `renderAudienceBanner()`, `AUDIENCE_COPY` object keys (`human_primary` →
  `human-primary`, `agent_optimized` → `agent-optimized` inside the copy table and banner suppression check), and
  JSDoc/code comments referencing the old spelling. ~7 sites to update.
- Modify: `src/client/leaderboard.ts` — the `isAgentOptimized(row)` function at line 98 compares `row.dataset.audience
  === 'agent_optimized'`; update to `'agent-optimized'`. Plus two code comments on lines 94 and 96.
- Modify: `tests/build.test.ts` — ~12 references across `renderAudienceBanner` cases, leaderboard fixture entries, and
  the `data-audience=` dataset assertion. Update every snake_case literal to the kebab-case equivalent.
- Modify: `content/methodology.md` — 4 user-visible references (lines around 38, 41, 44, 45, 48). These render verbatim
  on the methodology page, so the edit is user-visible.
- Modify: this plan doc (already done as part of the handoff prep — references on lines 136, 206, 209 flipped to
  kebab-case; Implementation Log / this unit added).

**Approach:**

1. Grep the repo to confirm the surface hasn't changed since handoff:

   ```bash
   rg -n 'agent_optimized|human_primary' --type ts --type js --type md
   ```

   Expected: the five files above. If additional files appear, include them in the change set.
2. Replace every occurrence. The safe substitutions are `agent_optimized` → `agent-optimized` and `human_primary` →
   `human-primary`. `mixed` is unchanged — noted explicitly because the substitution list looks asymmetric otherwise.
3. Update the JSDoc in `src/build/scorecards-render.mjs::renderAudienceBanner` to describe the new enum values.
4. Run `bun test` and fix any assertion strings that still expect snake_case. All test failures under
   `renderAudienceBanner` and the leaderboard fixture tests should now match the new values.
5. Regression sweep: load `/score/<tool>` + `/scorecards` locally against the existing v0.1.1/v0.1.2 committed
   scorecards (which emit `audience: null`). Nothing should regress — the null-case rendering path is untouched.
6. Land as a single atomic PR to `dev`. **Do not** start Unit 0 regen until this merges.

**Verification:**

- `rg 'agent_optimized|human_primary' src/ tests/ content/` returns zero matches.
- `bun test` passes.
- `/score/anc` (pre-regen) renders the generic leaderboard footer (no banner) — null-case path still works.
- `/scorecards` (pre-regen) renders with the "Agent-optimized only" toggle disabled (no rows match the current
  `audience: null` state regardless of casing) — filter renders without throwing.

**Why this must land before Unit 0:** the scorecard regen in Unit 0 produces v0.1.3 scorecards with kebab-case
`audience` values. If site code still expects snake_case, the "Agent-optimized only" toggle silently filters every
agent-optimized row out of the leaderboard, and the audience banner renders the fallback copy on every non-null
scorecard. Both failures are silent — no exception, no test failure if committed scorecards don't yet exist — so a
reviewer inspecting the merge won't see the regression until users do.

### Units 1+: In `agentnative-site` (site) — everything below is this plan's scope

**Status: SHIPPED (commit b0fb782, 2026-04-22).** All five bullets below landed in one cohesive renderer commit. They
ship green against the existing `audience: null` scorecards (the renderers null-feature-detect) and will activate
automatically once Unit 0 regenerates the committed scorecards. Per-bullet detail in the Implementation Log; the prose
below is preserved as the original spec.

- **Audience banner on `/score/<tool>`** — render when `audience != "agent-optimized"` OR `audit_profile` is present
  (non-null). Copy stance: informational, not shaming. Example: "This tool appears optimized for humans, not agents.
  P1/P2/P7 warnings below reflect that audience choice rather than defects." When `audit_profile` is present, the banner
  cites the applied profile and links to the methodology note explaining the suppression category.
- **Suppressed-check rendering on `/score/<tool>`** — checks with evidence matching `suppressed by audit_profile:
  <category>` get a distinct visual treatment (muted, tagged "N/A by category") separate from genuine Skip results. The
  per-check row still shows what was excluded and why.
- **Leaderboard filters on `/scorecards`** — "Agent-optimized only" toggle. TUI-by-design (`audit_profile: human-tui`)
  and file-traversal (`audit_profile: file-traversal`) tools hidden by default; visible when toggled on. Additional
  filter axes from the anc-100 brainstorm (R10-R14) as scope allows.
- **Go-live on `/scorecards`** — whatever R10-R14 of the ANC 100 audit brainstorm hasn't shipped already:
  sortable/filterable leaderboard, tier filters, install-CTA per scorecard, `llms-full.txt` inclusion.
- **Methodology note** — explicit sentence about audience classification being aggregate and informational, not
  authoritative. The per-check evidence is the ground truth. Link from the audience banner and from the `/scorecards`
  page header.

### Not in this plan (see CLI H5)

- Audience classifier logic (the 4-signal-check rule). Lives in `agentnative/src/scorecard/audience.rs`.
- `ExceptionCategory` → suppressed check IDs mapping. Lives in `agentnative/src/principles/registry.rs`.
- `--audit-profile` CLI flag. Lives in `agentnative/src/cli.rs`.
- Drift test for the 4 signal check IDs.
- `p1-env-hints` Pattern 2 (bash-style `$FOO` detection).

## Out of scope

- PTY probes — deferred to post-v0.1.x.
- `CheckStatus::Coverage` variant — still deferred. TODOS.md item.
- `--fix` track — parallel track, different release cycle.
- GitHub Action integration — strategic track, not this release.
- Any principle restructuring — deferred; revisit with leaderboard data.
- Audience classifier tuning (e.g., weighting signal checks, adding a fifth signal). If a tool is mislabeled, the fix
  lives in the CLI registry (`audit_profile` addition) or in the MUST set (new check in a future CLI release), NOT in
  site-side rendering.

## Branch + workflow

- Branch: `feat/v013-leaderboard-launch`.
- PR target: `dev`.
- After merge: follow the site's usual release flow; the leaderboard goes live on the next site deploy. There's no
  `agentnative-site` tag to coordinate with `agentnative`'s `v0.1.3` tag — the CLI version is immutable on crates.io;
  site deploys are continuous.
- Announcement coordination (Show HN, Tweet, etc.) is NOT part of this handoff. That's a product-launch track.

## Definition of done

- [x] Unit 0.5 landed: `rg 'agent_optimized|human_primary' src/ tests/ content/` returns zero matches; `bun test` passes
  (95/95) against the pre-regen `audience: null` scorecards. (commit f65fef0)
- [x] Per-tool `/score/<tool>` page renders the audience banner when applicable, with copy that matches the methodology
  stance. Code path shipped; will visibly activate after Unit 0 regen. (commit b0fb782)
- [x] Suppressed checks on `/score/<tool>` show the distinct "N/A by category" treatment separate from genuine Skips.
  Code path shipped; will visibly activate after Unit 0 regen. (commit b0fb782)
- [x] `/scorecards` leaderboard renders ≥100 tools; sorting and filtering work; the "Agent-optimized only" toggle hides
  TUI-by-design and file-traversal tools by default. Registry now has 100 entries; toggle wired and tested. The
  TUI-by-design / file-traversal hide behavior depends on Unit 0 populating `audit_profile` on those rows. (commits
  c355cf8, b0fb782)
- [x] Methodology note published; linked from the audience banner and from the `/scorecards` header. (commit b0fb782)
- [ ] Manual sanity check (fixtures known from the CLI side): `gh` renders without a banner (agent-optimized); `lazygit`
  renders with a `human-tui` banner; `ripgrep` renders without a banner after the Pattern 2 env-hint fix; `fd` renders
  with a `file-traversal` banner. **Pending Unit 0.**
- [ ] Regression sweep against the 10 committed scorecards: every page loads, no renderer throws on an unknown
  `audit_profile` string or unexpected `audience` value. **Pending Unit 0** — feature-detect path is exercised by tests;
  full sweep requires v0.1.3 outputs.
- [x] `llms-full.txt` includes the new leaderboard surface and links to per-tool pages. (already wired by H2; verified
  intact after this branch's changes)

## Known gotchas

- The audience classifier is **informational, not authoritative**. The banner is a hint; the per-check evidence list
  below it is the truth. Never collapse the scorecard list into "tool passes/fails" based on audience alone. Per the CEO
  review's outside voice Finding #3: aggregate signal is strictly weaker than per-check evidence.
- `audit_profile` suppression does NOT delete check results from the scorecard JSON. The CLI emits suppressed checks as
  `CheckStatus::Skip` with evidence `"suppressed by audit_profile: <category>"`. Render them in the page, tagged as
  N/A-by-category — don't filter them out. Readers get to see what was excluded and why.
- Schema-compat: v1.1 scorecards never populated `audience` or `audit_profile` (both `null`). v1.3+ will. The site's
  `renderCoverageSummary()` + `renderAudienceBanner()` already feature-detect missing keys (from H2) — verify the
  detection still works when the keys are present but the banner logic branches on values rather than presence.
- Renderer robustness: `audience` can be any of `"agent-optimized"`, `"mixed"`, `"human-primary"`, or `null` (all
  kebab-case per the v0.1.3 CLI decision; see Unit 0.5). `audit_profile` can be any of `"human-tui"`,
  `"file-traversal"`, `"posix-utility"`, `"diagnostic-only"`, or `null`. Render defensively — an unknown string should
  fall through to a safe "unknown category" treatment rather than crash.
- When classifier disagrees with intuition (e.g., a tool you consider agent-hostile gets `audience: "agent-optimized"`),
  do NOT patch the site's rendering to override. File a registry `audit_profile` update on
  `agentnative-site/scorecards/registry.yaml` (if the tool fits an exception category) or escalate to the CLI side as a
  potential new check. The site renders what the CLI emits.

## After this PR merges

The ANC 100 leaderboard is live. Future work:

- Community registry submissions (R19).
- PTY probe principle revision (separate doctrine call).
- `--fix` track starts (parallel to spec work, CLI-side).
- GitHub Action integration (strategic track).
- Post-launch tuning based on real user feedback on the scorecard.
- Per-tool audience-banner copy iteration if the initial stance reads as scolding — the banner is one of the most
  visible pieces of prose on the site.
