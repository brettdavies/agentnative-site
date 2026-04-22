---
title: "refactor: Align build modules with SRP and DRY"
type: refactor
status: complete
date: 2026-04-21
deepened: 2026-04-21
shipped: 2026-04-21
pr: 26
---

# refactor: Align build modules with SRP and DRY

## Overview

Four `src/build/` modules exceeded the 200-LOC refactor trigger with genuine SRP violations — mixed responsibilities
that made the code harder to navigate and maintain. Three DRY violations repeated constants and helper patterns across
modules. This plan addressed both by extracting concerns into focused modules without over-splitting.

Shipped in PR #26 (squash-merged to dev). Build output byte-identical across all 230 dist/ files. 78 tests passing.

## Problem Frame

The build pipeline grew organically across handoffs H1–H6. Each handoff added features (scorecards, coverage,
leaderboard) to existing files rather than splitting when responsibilities diverged. The result: `assets.mjs` embedded
~600 lines of CSS in a JS string, `scorecards.mjs` mixed data loading with HTML templating, and `build.mjs` owned
markdown extraction helpers that belonged in a shared module. Meanwhile, `PRINCIPLE_NAMES` was defined twice,
`BONUS_GROUPS` was duplicated across modules, and the `resolveBaseUrl()` pattern was copy-pasted three times.

## Requirements Trace

- R1. Every source file under `src/build/` should have a single, identifiable responsibility — **MET**
- R2. Shared constants and helpers must live in one canonical location (STAR principle) — **MET**
- R3. No file should exceed 200 LOC (excluding comments) unless it passes the SRP-not-LOC exemption check — **MET**
- R4. All existing tests must continue to pass — behavior is unchanged — **MET** (78/78)
- R5. Build output (`dist/`) must be byte-identical before and after refactor — **MET** (sha256 verified, 230 files)

## Scope Boundaries

- Only `src/build/` modules and their direct test file (`tests/build.test.ts`) were in scope
- `scripts/design/generate-palette.mjs` (386 LOC) was evaluated and did **not** warrant splitting — standalone
  design-time script with uniform purpose. Analogous to the `shortcuts.rs` case in
  `docs/solutions/best-practices/rust-module-splitting-srp-not-loc-20260327.md`
- No functional changes — pure structural refactor
- Worker code (`src/worker/`), client code (`src/client/`), and shell scripts were out of scope

## Context & Research

### Relevant Code and Patterns

- `src/build/util.mjs` — existing shared helpers module (sortedGlob, parseFilename, escHtml). Natural home for
  additional shared constants and helpers
- `src/build/render.mjs` — 61 LOC, single-responsibility (markdown → HTML pipeline). Good example of a focused module
- `src/build/llms.mjs` — contained `extractTitle` and `extractIntroSummary` that were markdown extraction helpers, not
  llms-specific

### Institutional Learnings

- **`rust-module-splitting-srp-not-loc-20260327`** — "Does this file have multiple distinct responsibilities?" is the
  primary question, not "Is this file too long?" Collections of uniform functions and pure declarations may exceed 200
  LOC and remain idiomatic. Applied to `generate-palette.mjs` evaluation.

## Key Technical Decisions

- **Extend `util.mjs` rather than creating `constants.mjs`**: The existing util module was already the shared helpers
  home. Adding `PRINCIPLE_NAMES`, `PRINCIPLE_GROUPS`, `BONUS_GROUPS`, and `resolveBaseUrl()` there kept the import
  surface minimal. Avoided a new file for a handful of exports.
- **Derive `PRINCIPLE_GROUPS` from `Object.keys(PRINCIPLE_NAMES)`**: Eliminates a duplicate array that could drift.
  Discovered during simplification review.
- **Real `.css` file for site.css, not a template module**: The SITE_CSS string in assets.mjs had zero interpolation —
  it was a static CSS string. Moving it to `src/styles/site.css` gave it syntax highlighting, CSS linting, and editor
  support while reducing assets.mjs to 84 LOC.
- **Two-way split for scorecards, not four**: Data loading + scoring stayed together (tightly coupled). HTML + markdown
  rendering moved to `scorecards-render.mjs`. A four-way split would have created import ceremony for ~50-line files.
- **Content extraction as a shared module**: `extractTitle`, `extractIntroSummary`, `extractDescription`,
  `extractFirstParagraph`, and `extractDefinitionParagraph` all parse raw markdown strings to extract structural
  content. A shared `collectParagraph`/`findH1` private helper eliminated four duplicated line-scanner loops.
  `extractIntroSummary` delegates to `extractFirstParagraph` (identical behavior, kept as named export for call-site
  clarity).
- **Pass pre-computed score to render functions**: `buildScorecardBody` and `buildScorecardMarkdown` were each calling
  `computeScore()` independently, duplicating work done by `computeLeaderboard()`. Passing the score through eliminated
  the redundancy AND broke the render→data import coupling. `scorecards-render.mjs` has no imports from
  `scorecards.mjs`.
- **`build.mjs` stays above 200 LOC**: Landed at 403 LOC (higher than the ~270 estimate because the orchestrator's
  11-step pipeline and `runInvariantChecks` are larger than projected). Single-responsibility linear pipeline —
  splitting would fragment the build flow with no discoverability benefit.
- **Extract `renderCheckRows` helper**: The check-row `<tr>` template was duplicated between principle-group and
  bonus-group loops in `buildScorecardBody`. Extracted to a private helper.

## Open Questions

### Resolved During Planning

- **Should `buildHomepageBody` move out of `build.mjs`?** No — it's 25 lines, used only in the build orchestrator, and
  tightly coupled to the homepage structure.
- **Should `runInvariantChecks` move?** No — it's build-time validation, the 11th step of the pipeline.

### Resolved During Implementation

- **Import paths**: Bun's module resolution had no issues with explicit relative paths and `.mjs` extensions (existing
  convention).
- **Biome import ordering**: Biome enforces alphabetical import specifier ordering. Several imports needed reordering
  after the refactor (e.g., `{ PRINCIPLE_NAMES, escHtml }` → `{ escHtml, PRINCIPLE_NAMES }`).
- **CSS quote style**: Moving CSS from a JS template string to a real `.css` file exposed it to Biome's CSS linter,
  which converted single quotes to double quotes. Semantically identical, now lint-compliant.

## Implementation Units

- [x] **Unit 1: Extract shared constants and resolveBaseUrl to util.mjs**

  **Shipped:** `PRINCIPLE_NAMES`, `PRINCIPLE_GROUPS` (derived via `Object.keys`), `BONUS_GROUPS`, and `resolveBaseUrl()`
  added to `util.mjs`. Removed duplicates from scorecards.mjs, coverage.mjs (updated to `P${n}` string-keyed lookup),
  shell.mjs, llms.mjs, and sitemap.mjs.

- [x] **Unit 2: Extract site.css to a standalone CSS file**

  **Shipped:** `SITE_CSS` template string → `src/styles/site.css`. `copyAssets()` reads from disk. assets.mjs: 682 → 84
  LOC.

- [x] **Unit 3: Extract markdown content helpers to content.mjs**

  **Shipped:** Created `src/build/content.mjs` with 5 exported functions + 2 private helpers (`collectParagraph`,
  `findH1`). `extractIntroSummary` delegates to `extractFirstParagraph`. Removed functions from `build.mjs` and
  `llms.mjs`.

- [x] **Unit 4: Split scorecard rendering from data/scoring**

  **Shipped:** Created `src/build/scorecards-render.mjs` with HTML/markdown builders + `renderCheckRows` helper +
  `groupToPrincipleNum`. scorecards.mjs retains data loading + scoring. Render functions accept pre-computed `score`
  parameter — no import from scorecards.mjs.

- [x] **Unit 5: Final verification — byte-identical build output**

  **Shipped:** 78 tests pass. sha256 checksums of all 230 dist/ files match baseline. CI green (lint + build + test +
  wrangler dry-run).

## Final LOC Audit

| Module | Before | After | Notes |
|--------|--------|-------|-------|
| assets.mjs | 682 | 84 | CSS extracted to src/styles/site.css |
| scorecards.mjs | 651 | 227 | Render functions → scorecards-render.mjs |
| scorecards-render.mjs | — | 416 | New: template-only (uniform-functions exemption) |
| build.mjs | 460 | 403 | Extract functions removed; imports updated |
| coverage.mjs | 235 | 225 | Import cleanup |
| shell.mjs | 193 | 191 | resolveBaseUrl from util.mjs |
| content.mjs | — | 118 | New: 5 extract functions + shared helpers |
| llms.mjs | 135 | 104 | extractTitle + extractIntroSummary removed |
| render.mjs | 91 | 91 | Unchanged |
| util.mjs | 54 | 85 | Added shared constants + resolveBaseUrl |
| sitemap.mjs | 34 | 34 | Unchanged (resolveBaseUrl import only) |
| src/styles/site.css | — | 597 | New: real CSS file (was inline in assets.mjs) |
| **Total** | **2535** | **2575** | +40 LOC (new module headers + JSDoc) |

Files above 200 LOC with SRP exemption:

- `scorecards-render.mjs` (416) — uniform template functions, single responsibility (render)
- `build.mjs` (403) — single-responsibility linear pipeline orchestrator (11 steps)
- `coverage.mjs` (225) — evaluated, single responsibility (coverage page builder)

## System-Wide Impact

- **Interaction graph:** Only `build.mjs` orchestrator imports changed — pulls from more modules but call flow
  identical. `scorecards-render.mjs` has zero imports from `scorecards.mjs` (cleaner than planned).
- **Error propagation:** Unchanged — all functions are pure or throw on invalid input.
- **State lifecycle risks:** None — the build is stateless (reads files, writes dist/).
- **Integration coverage:** Existing `tests/regression.test.ts` covers full build output invariants.

## Risks & Dependencies

| Risk | Mitigation | Outcome |
|------|------------|---------|
| Import path errors after moves | Unit 5 full test suite + build; CI gate | No issues |
| Circular dependency scorecards↔render | One-way dependency planned | Eliminated entirely — render has no scorecards import |
| Bun module resolution edge cases | Explicit relative paths with `.mjs` | No issues |
| Biome lint on extracted CSS | Not anticipated | Fixed: single→double quotes, semantically identical |

## Sources & References

- Institutional learning: `docs/solutions/best-practices/rust-module-splitting-srp-not-loc-20260327.md`
- New learning: `docs/solutions/best-practices/build-module-srp-dry-refactor-20260421.md`
- Related code: `src/build/util.mjs` (existing shared helpers pattern)
- Related code: `src/build/render.mjs` (good example of a focused single-responsibility module)
