---
title: "feat: registry + leaderboard + scorecard pages"
type: feat
status: complete
date: 2026-04-17
origin: docs/brainstorms/anc-100-audit-requirements.md
---

# feat: registry + leaderboard + scorecard pages

## Overview

Add the "ANC 100" proof layer to anc.dev: a machine-readable tool registry, pre-computed scorecard JSON for ~100
CLI tools, a `/scorecards` leaderboard page, and per-tool scorecard pages at `/score/<tool-name>`. All pages follow the
existing build-time static generation pattern — no runtime data fetches, no Worker changes, no new bindings. The visual
design of the new pages will be finalized via the `/impeccable` skill during implementation.

This plan covers Plan 1 only (pre-computed leaderboard + scorecard pages). Plan 2 (live scoring via CF Sandbox) is a
separate plan.

## Problem Frame

The agentnative standard launches without empirical evidence. A reader can understand the 7 principles in the abstract
but has no way to see what "agent-native" looks like across real tools. The leaderboard provides that proof layer:
automated, reproducible scores for ~100 real CLI tools, published on the site. It also becomes the data backing for the
live scorer (Plan 2) — known tools are served from pre-computed cache. (see origin:
docs/brainstorms/anc-100-audit-requirements.md)

## Requirements Trace

- R1. Machine-readable registry of ~100 CLI tools with metadata
- R2. Three tiers: Workhorse (~60), Agent (~15), Notable (~25) with per-creator caps
- R3. Registry is the single source of truth
- R4. Pre-computed scorecards scored locally, committed to `scorecards/`
- R5. Behavioral + project as primary score; source checks as bonus column
- (R6–R9 are in the origin document under Live Scoring / Security — Plan 2 scope)
- R10. `/scorecards` leaderboard page, sortable/filterable
- R11. Per-tool pages at `/score/<tool-name>` with summary, top issues, principle links
- R12. Content negotiation: HTML default, markdown via `.md` suffix or Accept header
- R13. Scorecard data in `llms-full.txt`
- R14. Shareable URLs at `/score/<tool-name>`
- R15. Brett's tools (anc, bird, xr) scored identically (policy constraint — same `anc check` methodology, no code-level
  special-casing. Tier assignment is an editorial decision separate from scoring.)
- R16. Methodology section on leaderboard page
- R17. Check-to-principle links on scorecard pages
- R18. Constructive framing with fix guidance links

## Scope Boundaries

- **Not in scope:** Live scoring via CF Sandbox (Plan 2, separate plan)
- **Not in scope:** The actual scoring of 100 tools (manual process by Brett, not a code unit)
- **Not in scope:** Expanding `anc` source checks to Go/Node
- **Not in scope:** Version tracking / score diffs over time
- **Not in scope:** Community submission flow (GitHub issue template) and re-score request process — future enhancement
  (origin R19, R20)

### Deferred to Separate Tasks

- Live scorer container + Worker endpoint: Plan 2 (separate plan)
- Compiling the definitive 100-tool list: manual curation task, prerequisite to this plan
- Scoring all tools locally: manual `anc check` runs by Brett, prerequisite to this plan

## Context & Research

### Relevant Code and Patterns

- Build pipeline: `src/build/build.mjs` — 10-step sequential pipeline, markdown-to-HTML via unified/remark/rehype
- Page generation: `subPages` array in `build.mjs` (line ~167) for check/about — same pattern for new pages
- Per-item generation: principles loop (line ~78) generates `p1.html`/`p1.md` through `p7.html`/`p7.md` — same pattern
  for per-tool scorecard pages
- HTML shell: `src/build/shell.mjs` — `emitShell()` wraps all pages with head/nav/footer
- Content negotiation: Worker (`src/worker/index.ts`) rewrites paths to `.md` twins — path-agnostic, no changes needed
- llms.txt: `src/build/llms.mjs` — `buildLlmsIndex()` and `buildLlmsFull()` take sections arrays
- Sitemap: `src/build/sitemap.mjs` — `buildSitemap()` takes path arrays
- Design tokens: `docs/design/foundation.css` — oklch palette, type scale, tabular numerals (`--ff-tabular`)
- Static asset routing: `wrangler.jsonc` with `html_handling: auto-trailing-slash` resolves `/score/ripgrep` to
  `dist/score/ripgrep.html` automatically

### Institutional Learnings

- Agent-native documentation surface pattern: new pages must have `.md` twin, CN, llms.txt inclusion, JSON-LD (see
  origin: `docs/solutions/architecture-patterns/agent-native-documentation-surface-2026-04-13.md`)
- Regression test #2 asserts exactly 7 principle `.md` links in `llms.txt` — will break when scorecard pages are added.
  Intentional guard; update the assertion.
- All custom headers must live in Worker code, not `_headers` file (Workers Static Assets limitation)
- Byte-equivalence tests enforce source-to-dist fidelity for markdown files

### External References

Not needed — the codebase has strong local patterns for every aspect of this plan.

## Key Technical Decisions

- **Build-time static generation, not runtime rendering:** Scorecard pages are generated during `bun run build` from
  committed JSON files. The Worker stays edge-thin with no data-fetching bindings. This matches the existing site
  architecture and keeps `placement` unset for edge proximity.
- **Registry format: YAML not TOML:** YAML is more readable for large lists with nested fields (install commands,
  multiple binaries). `js-yaml` must be added as a direct dependency (`bun add js-yaml`) — it is currently only a
  transitive devDependency of markdownlint-cli2. The registry is a build-time input only.
- **Tool name format:** Registry `name` field must match `/^[a-z0-9-]+$/` (lowercase, alphanumeric and hyphens only).
  Names are used as URL path segments (`/score/<name>`) and filenames (`scorecards/<name>.json`). `loadRegistry()`
  validates format and uniqueness at build time. Example: "Claude Code" becomes `claude-code`.
- **Score denominator:** `pass / (pass + warn + fail)` — skip and error are excluded from the denominator. If
  denominator is 0, score is 0 (sorts to bottom). Documented in the methodology section (R16).
- **CheckGroup serialization:** The `anc` JSON serializes CheckGroup variants as their Rust enum names: `"P1"` through
  `"P7"`, `"CodeQuality"`, `"ProjectStructure"` (PascalCase, no serde rename). The build module must match these exact
  strings. `CodeQuality` and `ProjectStructure` groups are excluded from the N/7 principle score and rendered as a
  separate "Code Quality" section below the principle summary on scorecard pages (per R5).
- **escHtml extraction:** Move the duplicated HTML-escape function from `build.mjs` and `shell.mjs` into
  `src/build/util.mjs` as a shared export. `scorecards.mjs` imports it from there.
- **Scorecard JSON schema matches `anc check --output json`:** The JSON files committed to `scorecards/` are the raw
  output of `anc check`. No transformation or custom schema — what `anc` produces is what the build reads. This means
  the scorecard format is governed by the `anc` tool, not the site.
- **Leaderboard is a hand-built HTML builder, not markdown-rendered:** The sortable/filterable table needs structured
  HTML (data attributes for sorting, tier/language filters). This follows the `buildHomepageBody()` pattern — a JS
  function that returns HTML strings, not the unified markdown pipeline.
- **Per-tool scorecard pages use a hybrid:** The summary section (score badge, top issues) is hand-built HTML. The
  methodology section is markdown-rendered. This lets the structured data render precisely while the prose sections
  benefit from the unified pipeline.
- **Visual design via `/impeccable`:** The CSS/HTML design for the leaderboard table and scorecard pages will be
  finalized by invoking the `/impeccable` skill during implementation. This includes responsive/mobile strategy, table
  layout, and any shell-level overrides (e.g., wider `max-width` for the leaderboard page). Build a basic HTML table
  first; `/impeccable` may restructure it. Accept the rework risk — it's cheaper than designing blind.
- **Nested output directory `dist/score/`:** Per-tool pages emit to `dist/score/<tool-name>.html` and
  `dist/score/<tool-name>.md`. The CF static asset fetcher resolves these automatically via `html_handling:
  auto-trailing-slash`.
- **Default sort: score descending, unscored at bottom.** Scored tools ranked by primary score (pass rate). Unscored
  tools appear below all scored tools with "—" in the score column. Filter: tier toggle (all/workhorse/agent/notable).
  No language filter at launch.
- **Nav link deferred to Plan 2.** Pages are deployed to production and accessible via direct URL, but not discoverable
  from site navigation until the live scorer ships. This prevents launching the "supporting evidence" without the "Show
  HN hook."
- **Client-side sort/filter JS:** A new script in `src/client/` (e.g., `src/client/leaderboard.ts`) handles column
  sorting and tier filtering via data attributes. Bundled by `Bun.build()` alongside theme.ts and clipboard.ts. Loaded
  only on the `/scorecards` page via a conditional in `emitShell()`.

## Open Questions

### Resolved During Planning

- **How does the Worker handle nested routes like `/score/ripgrep`?** Resolved: CF `html_handling: auto-trailing-slash`
  resolves `/score/ripgrep` to `dist/score/ripgrep.html` automatically. No Worker changes needed.
- **Does the markdown CN rewrite work for nested paths?** Resolved: `rewriteToMarkdown()` in `src/worker/accept.ts`
  appends `.md` to any path after stripping trailing slash. `/score/ripgrep` becomes `/score/ripgrep.md`. No changes
  needed.

- **Score denominator and group handling:** Resolved in review. Score = `pass / (pass + warn + fail)`, skip/error
  excluded. Groups `"P1"`-`"P7"` map to principles; `"CodeQuality"`/`"ProjectStructure"` are bonus. See Key Technical
  Decisions.
- **escHtml extraction:** Resolved in review. Move to `util.mjs` as shared export. See Unit 3.
- **`anc check` invocation for pre-installed binaries:** Verified. `anc check --command gh --output json` resolves from
  PATH and runs 8 behavioral checks. `anc check <dir> --source --output json` runs 22 source+project checks. Groups
  serialize as `"P1"`-`"P7"`, `"CodeQuality"`, `"ProjectStructure"` (confirmed). For the scoring pipeline: use
  `--command <binary>` for behavioral, `--source` on the cloned repo for source+project, or default mode for all.

### Deferred to Implementation

- CSS class naming for leaderboard/scorecard components — deferred to `/impeccable`.
- Whether the leaderboard page needs a wider `max-width` override on `<main>` — deferred to `/impeccable`.
- `scorecards` is a reserved name — `loadRegistry()` must reject it to prevent slug collision with the leaderboard page
  at `dist/scorecards.html`.

## Output Structure

```text
registry.yaml                     # Tool registry (build-time input)
scorecards/                       # Pre-computed scorecard JSON (committed)
  gh.json
  ripgrep.json
  ...
src/build/
  scorecards.mjs                  # New module: registry + JSON → HTML/MD
dist/
  scorecards.html                 # Leaderboard page
  scorecards.md                   # Leaderboard markdown twin
  score/
    gh.html                       # Per-tool scorecard page
    gh.md                         # Per-tool markdown twin
    ripgrep.html
    ripgrep.md
    ...
```

## Implementation Units

- [x] **Unit 1: Tool registry YAML schema + seed file**

**Goal:** Create the registry file that maps tool names to metadata. Seed with 5-10 representative tools across all
three tiers for build pipeline development.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**

- Create: `registry.yaml`

**Approach:**

- Define the schema: `name` (must match `/^[a-z0-9-]+$/`), `repo` (GitHub owner/repo), `binary` (executable name),
  `language`, `tier` (workhorse/agent/notable), `creator` (person or org attribution), `install` (package manager
  command), `description` (one-line), `version` (version string scored), `scored_at` (ISO 8601 date of last scoring)
- Seed with a representative sample: gh (Go, workhorse), ripgrep (Rust, workhorse), llm (Python, notable/simonw),
  claude-code (TS, agent), anc (Rust, notable/brett), plus 3-5 more across tiers
- The full 100-tool list is a manual curation task outside this plan. The seed file proves the schema and unblocks
  pipeline development.

**Patterns to follow:**

- ACFS `acfs.manifest.yaml` structure for install/verify fields (see origin: docs/brainstorms/live-scoring-spike.md §
  Prior Art)

**Test expectation:** none — data file, no behavioral change. Schema validation is implicit in the build step
(Unit 3) that reads it.

**Verification:**

- `registry.yaml` parses without error via `js-yaml`
- All three tiers are represented in the seed data

---

- [x] **Unit 2: Seed scorecard JSON files**

**Goal:** Commit sample scorecard JSON files matching the `anc check --output json` format. These are the build-time
data inputs for the leaderboard and scorecard pages.

**Requirements:** R4, R5

**Dependencies:** Unit 1 (registry defines which tools have scorecards)

**Files:**

- Create: `scorecards/gh.json`, `scorecards/ripgrep.json`, `scorecards/llm.json` (and others matching the seed registry)

**Approach:**

- Run `anc check` against each seed tool locally and capture the JSON output
- If `anc` is not yet ready, create representative sample JSON matching the `Scorecard` struct from
  `~/dev/agentnative/src/scorecard.rs`: `{ results: [...], summary: { total, pass, warn, fail, skip, error } }`
- Each result has: `id`, `label`, `group` (P1-P7/CodeQuality/ProjectStructure), `layer` (behavioral/source/project),
  `status` (pass/warn/fail/skip/error), `evidence` (nullable string)
- File naming: `scorecards/<tool-name>.json` where `<tool-name>` matches the registry `name` field

**Test expectation:** none — data files. Validated by the build step that reads them.

**Verification:**

- Each JSON file parses without error
- Each JSON file has `results` array and `summary` object

---

- [x] **Unit 3: Build module — `src/build/scorecards.mjs`**

**Goal:** New build module that reads the registry + scorecard JSON and produces data structures and HTML builders for
page generation. Pure functions for data loading/scoring; HTML builder functions for leaderboard and scorecard pages.

**Requirements:** R1, R3, R4, R5

**Dependencies:** Unit 1, Unit 2

**Files:**

- Create: `src/build/scorecards.mjs`
- Modify: `src/build/util.mjs` (add exported `escHtml()`, imported by scorecards.mjs, build.mjs, shell.mjs)
- Test: `tests/build.test.ts` (extend existing build test file)

**Approach:**

- `loadRegistry(registryPath)` — parse YAML, validate required fields and name format (`/^[a-z0-9-]+$/`), enforce
  uniqueness, return array of tool entries. Throws on invalid names or duplicates.
- `loadScorecards(scorecardsDir, registry)` — for each registry entry, read `scorecards/<name>.json` if it exists. Tools
  without a scorecard file are included in the registry but marked as "not yet scored"
- `computeLeaderboard(tools)` — sort by primary score descending. Score = `pass / (pass + warn + fail)` (skip and error
  excluded from denominator). If denominator is 0, score is 0 (sorts to bottom). Attach tier, language, and rank.
- `extractTopIssues(scorecard, limit = 3)` — return the top N failing/warning checks sorted by severity (FAIL > WARN),
  with group name and evidence string
- `computePrincipleScore(scorecard)` — filter results to groups matching `"P1"` through `"P7"` (exact PascalCase strings
  from anc's serde serialization). Map each to pass/partial/fail. Return "N/7 principles met" summary. `"CodeQuality"`
  and `"ProjectStructure"` groups are excluded from the N/7 count.
- `computeLayerScore(scorecard)` — filter results by `layer` field: primary = `"behavioral"` + `"project"`, source =
  `"source"`. Return `{ primary: ratio, source: ratio | null }`. Source is null for tools with no source-layer checks.
  Used for the R5 bonus column on the leaderboard.
- `buildLeaderboardBody(leaderboard, methodology)` — hand-built HTML table from leaderboard data. Returns HTML string.
- `buildScorecardBody(tool, scorecard, topIssues, principleScore)` — hand-built HTML for per-tool page. Returns HTML
  string.

**Patterns to follow:**

- `src/build/llms.mjs` — pure functions, no side effects, data-in data-out
- `src/build/util.mjs` — utility function conventions
- `buildHomepageBody()` in `build.mjs` — HTML builder pattern (returns string, uses `escHtml()`)

**Test scenarios:**

- Happy path: `loadRegistry` parses valid YAML with all required fields and returns typed array
- Happy path: `loadScorecards` reads JSON files, matches to registry entries by name
- Happy path: `computeLeaderboard` sorts tools by descending pass rate
- Happy path: `computePrincipleScore` maps `"P1"`-`"P7"` groups correctly, excludes `"CodeQuality"`/`"ProjectStructure"`
- Happy path: `computeLayerScore` separates behavioral+project from source checks
- Edge case: tool in registry but no scorecard file → marked as "not yet scored", not an error
- Edge case: scorecard JSON with all checks skipped → score is 0/(0) = 0, sorts to bottom (no NaN)
- Edge case: empty registry → returns empty leaderboard, no crash
- Error path: `loadRegistry` throws on name with spaces or uppercase (`"Claude Code"` → error)
- Error path: `loadRegistry` throws on duplicate names
- Happy path: `extractTopIssues` returns FAIL checks before WARN checks, limited to N

**Verification:**

- All functions are pure and testable in isolation
- `bun test` passes with new test cases

---

- [x] **Unit 4: Build pipeline — leaderboard page generation**

**Goal:** Integrate the scorecards module into `build.mjs` to generate the `/scorecards` leaderboard page (HTML + MD
twin).

**Requirements:** R10, R12, R14, R16

**Dependencies:** Unit 3

**Files:**

- Modify: `src/build/build.mjs` (add scorecard build step after sub-pages, before llms.txt)

**Approach:**

- Add a new build step after sub-pages generation and before llms.txt generation
- Methodology prose is inline in `buildLeaderboardBody()` (same pattern as `buildHomepageBody()` — no separate content
  file needed)
- Call `loadRegistry()` + `loadScorecards()` + `computeLeaderboard()`
- Build leaderboard HTML via a `buildLeaderboardBody()` function (similar to `buildHomepageBody()`) — hand-built HTML
  table with data attributes for client-side sorting/filtering
- Include methodology section (what checks are run, how scoring works, how to re-test locally)
- Wrap in `emitShell()` with title "ANC 100 — Agent-Native CLI Leaderboard"
- Emit `dist/scorecards.html` and `dist/scorecards.md` (markdown twin is a markdown table)
- The visual design of the table (column layout, filter UI, responsive behavior) is deferred to `/impeccable` during
  implementation

**Patterns to follow:**

- `buildHomepageBody()` in `build.mjs` — hand-built HTML from data, returns string
- `emitShell()` in `shell.mjs` — wraps content in full HTML document

**Test scenarios:**

- Happy path: build produces `dist/scorecards.html` with a table containing one row per scored tool
- Happy path: build produces `dist/scorecards.md` with a readable markdown table
- Integration: leaderboard HTML contains links to `/score/<tool-name>` for each tool
- Integration: leaderboard HTML contains methodology section with `cargo install agentnative` CTA
- Edge case: tool with no scorecard → appears in table as "not yet scored"

**Files:**

- Test: `tests/regression.test.ts` (extend with leaderboard assertions)

**Verification:**

- `bun run build` completes without error
- `dist/scorecards.html` exists and contains the leaderboard table
- `dist/scorecards.md` exists and is a valid markdown table

---

- [x] **Unit 5: Build pipeline — per-tool scorecard page generation**

**Goal:** Generate individual scorecard pages at `/score/<tool-name>` for every scored tool in the registry.

**Requirements:** R11, R12, R14, R17, R18

**Dependencies:** Unit 3 (data layer + HTML builders are both in `scorecards.mjs`). Unit 4 is a sequencing
dependency — both extend the same build step in `build.mjs` and must not conflict.

**Files:**

- Modify: `src/build/build.mjs` (extend the scorecard build step to generate per-tool pages)

**Approach:**

- For each scored tool, generate `dist/score/<tool-name>.html` and `dist/score/<tool-name>.md`
- The HTML page contains: score badge ("N/7 principles met"), top 3 issues with severity and links to principle pages
  (`/p<N>`), full check results grouped by principle, tool metadata (repo link, language, version scored, audit date),
  CTA ("Run `anc check .` locally for the full report")
- Each failing check links to the relevant principle page: check group P3 → `/p3`
- Constructive framing: "current state" language, fix guidance via principle links
- Wrap in `emitShell()` per-tool
- Ensure `dist/score/` directory is created during build
- The markdown twin uses the A5 format matching `llms-full.txt`: H1 tool name, summary score, markdown table of check
  results grouped by principle, metadata, CTA. Tool name, summary score, and at least one check result line must appear
  for CN parity with the HTML page
- For tools with all checks passing: the "top issues" section is replaced with a brief confirmation ("All 7 principles
  met — no issues found"). Full check results table still renders with all PASS entries. CTA copy adjusts to "Run `anc
  check .` in CI to keep it that way."
- Each scorecard page includes a breadcrumb link back to `/scorecards` for direct-link arrivals

**Patterns to follow:**

- Principle page generation loop (line ~78 of `build.mjs`) — iterates over data, generates HTML + MD twin per item

**Test scenarios:**

- Happy path: build produces `dist/score/gh.html` and `dist/score/gh.md` for a scored tool
- Happy path: scorecard HTML links to principle pages (`/p1` through `/p7`) for each check group
- Happy path: top issues section shows FAIL checks before WARN checks
- Happy path: CTA contains `cargo install agentnative && anc check .`
- Integration: `/score/gh.md` is valid markdown with structured scorecard data
- Edge case: tool with all checks passing → "7/7 principles met", no issues section

**Files:**

- Test: `tests/regression.test.ts` (extend with per-tool page assertions)

**Verification:**

- `dist/score/` directory contains one `.html` + one `.md` per scored tool
- Content negotiation works: Worker serves `dist/score/ripgrep.html` for `/score/ripgrep` and `dist/score/ripgrep.md`
  for `/score/ripgrep.md`

---

- [x] **Unit 6: Extend llms.txt, llms-full.txt, and sitemap**

**Goal:** Include scorecard data in the agent-discoverable surfaces (llms.txt, llms-full.txt, sitemap.xml).

**Requirements:** R13

**Dependencies:** Unit 4, Unit 5

**Files:**

- Modify: `src/build/build.mjs` (pass scorecard sections to llms and sitemap builders)
- Modify: `src/build/llms.mjs` (add `## Scorecards` section support to `buildLlmsIndex`)
- Modify: `src/build/sitemap.mjs` (accept arbitrary extra paths)

**Approach:**

- `llms.txt`: add a `## Scorecards` section after `## Pages` with `- [Leaderboard](/scorecards.md)` and optionally
  per-tool links (or just the leaderboard if 100 tool links is too noisy)
- `llms-full.txt`: append the leaderboard markdown as a new section via the existing `sections` array. Per-tool
  scorecards may be too verbose — include just the leaderboard summary.
- `sitemap.xml`: add `/scorecards` plus all `/score/<tool-name>` paths. Extend `buildSitemap()` to accept an optional
  `extraPaths` array alongside `principleNumbers`.

**Patterns to follow:**

- Existing `buildLlmsIndex()` section structure (H2 + bullet list)
- Existing `buildSitemap()` path array construction

**Test scenarios:**

- Happy path: `llms.txt` contains `## Scorecards` section with leaderboard link
- Happy path: `llms-full.txt` contains a section with the leaderboard content
- Happy path: `sitemap.xml` contains `/scorecards` URL
- Happy path: `sitemap.xml` contains `/score/<tool-name>` URLs for each scored tool

**Files:**

- Test: `tests/regression.test.ts` (update llms.txt shape assertion, add sitemap assertions)

**Verification:**

- Regression test #2 passes with updated assertion counts
- `llms.txt` has the new section
- `sitemap.xml` includes scorecard paths

---

- [x] **Unit 7: Update nav + add leaderboard to site navigation**

**Goal:** Add the leaderboard page to the site's primary navigation so visitors can discover it.

**Requirements:** R10

**Dependencies:** Unit 4

**Files:**

- Modify: `src/build/shell.mjs` (add nav link)

**Approach:**

- **Do NOT add the nav link yet.** Plan 1 ships pages to production but hides them from navigation. The nav link is
  added when Plan 2 (live scorer) ships, completing the Show HN launch surface. Pages are accessible via direct URL
  (`/scorecards`, `/score/<tool-name>`) for testing and sharing, but not discoverable from site navigation.
- Sitemap and llms.txt DO include the scorecard paths (they are public, just not nav-linked).
- The nav link text and placement will be decided when Plan 2 is ready.

**Test expectation:** none — Unit deferred to Plan 2.

**Verification:**

- Nav does NOT include a scorecards link
- `/scorecards` URL still resolves (via direct access, not nav)

---

- [x] **Unit 8: Update regression tests**

**Goal:** Update locked regression assertions to account for the new scorecard pages.

**Requirements:** (testing infrastructure, not a product requirement)

**Dependencies:** Units 4, 5, 6

**Files:**

- Modify: `tests/regression.test.ts`
- Modify: `tests/e2e/agents.e2e.ts` (add `## Scorecards` assertion to live-server llms.txt shape test)

**Approach:**

- Regression #2 (llms.txt shape): update the assertion to expect `## Scorecards` section in addition to `## Principles`
  and `## Pages`. Assert at least 1 bullet under `## Scorecards` matching `/scorecards.md` (not just section presence).
- Add new regression: `dist/scorecards.html` exists and contains a `<table>` element (matching the
  `buildLeaderboardBody` decision — no `<ol>` alternative)
- Add new regression: at least one `dist/score/*.html` file exists
- Add new regression: `sitemap.xml` contains `/scorecards`
- Update `build()` return value in `build.mjs` to include scorecard page counts in `htmlPages` and `mdPages`
- Update `agents.e2e.ts` llms.txt shape test to assert `## Scorecards` section exists in the live-server response

**Test scenarios:**

- Happy path: updated llms.txt shape assertion passes with `## Scorecards` section and at least 1 link
- Happy path: `dist/scorecards.html` contains a `<table>` element
- Happy path: `dist/score/` directory is non-empty after build

**Verification:**

- `bun test` passes with all updated assertions
- CI gate (`ci.yml`) passes: lint → build → test → wrangler dry-run

---

- [x] **Unit 9: Visual design via `/impeccable`**

**Goal:** Finalize the visual design of the leaderboard table and per-tool scorecard pages using the `/impeccable`
skill.

**Requirements:** R10, R11 (visual quality)

**Dependencies:** Units 4, 5, 7 (pages must render before design polish)

**Files:**

- Modify: `src/build/assets.mjs` (CSS additions for scorecard components)
- Modify: `src/build/scorecards.mjs` (HTML structure adjustments per design feedback)
- Possibly modify: `src/build/shell.mjs` (if design requires shell-level changes)

**Approach:**

- Invoke `/impeccable` with the built leaderboard and scorecard pages
- The skill will audit the visual design against the existing site aesthetic (foundation.css tokens, type scale, color
  palette) and propose CSS/HTML refinements
- Key design considerations: responsive table layout, tier badge styling, score badge visual treatment, pass/warn/fail
  color coding (accessible contrast), dark mode support, mobile behavior
- Design tokens already available: `--ff-tabular` for numeric alignment, `--accent` for highlights, `--g-*` gray scale,
  `--bg-raised` for card backgrounds

**Execution note:** Run `/impeccable` after the functional pages are rendering correctly. Design polish is the last
step, not the first.

**Test expectation:** none — visual design, verified by visual QA and `/impeccable` audit.

**Verification:**

- Leaderboard renders cleanly on desktop and mobile
- Dark mode works correctly
- Color contrast meets WCAG 2.1 AA (>= 4.5:1)

## System-Wide Impact

- **Interaction graph:** The build pipeline gains a new step (between sub-pages and llms.txt). The scorecard module
  reads from `registry.yaml` + `scorecards/*.json` and feeds into the llms and sitemap builders. No runtime interactions
  — the Worker is unchanged.
- **Error propagation:** Build failures in the scorecard step should fail the entire build (same as invariant checks). A
  missing scorecard JSON for a registry entry is a warning, not an error (tool is "not yet scored").
- **State lifecycle risks:** None — all data is static and committed to git. No caching, no stale data. Re-scoring
  requires re-running `anc check` locally and committing updated JSON.
- **API surface parity:** The content negotiation contract extends automatically to new pages — no changes needed. The
  `Link: rel="alternate"` header and `X-Llms-Txt` header are already applied to all responses by the Worker.
- **Integration coverage:** E2E tests should verify that `/scorecards` and `/score/<tool-name>` serve both HTML and
  markdown via CN. This is covered by the existing agent E2E test pattern in `tests/e2e/agents.e2e.ts`.
- **Unchanged invariants:** The 7 locked principle anchor slugs, the principle page byte-equivalence contract, and the
  homepage principle links are all unaffected. The Worker routing logic is unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `anc check --output json` format changes before launch | Pin to the schema from the `Scorecard` struct in `anc` v0.1. If format changes, the build module adapts — no site-wide impact. |
| 100 tools × 2 files each = 200 new files in dist/ | CF static assets handles this fine. Sitemap stays under the 50,000 URL limit. Build time increase is negligible (JSON reads, string concatenation). |
| Leaderboard table performance with 100 rows | 100 rows is trivial for any browser. Client-side sort/filter is fine without virtualization. |
| llms-full.txt gets very large with 100 scorecard summaries | Include only the leaderboard summary in llms-full.txt, not all 100 individual scorecards. Keep the file focused. |

## Sources & References

- **Origin document:** [docs/brainstorms/anc-100-audit-requirements.md](docs/brainstorms/anc-100-audit-requirements.md)
- **Architecture spike:** [docs/brainstorms/live-scoring-spike.md](docs/brainstorms/live-scoring-spike.md)
- **Design doc:** `~/.gstack/projects/brettdavies-agentnative-site/brett-dev-design-20260417-145305.md`
- Build pipeline: `src/build/build.mjs`
- HTML shell: `src/build/shell.mjs`
- llms generation: `src/build/llms.mjs`
- Sitemap: `src/build/sitemap.mjs`
- Regression tests: `tests/regression.test.ts`
- `anc` scorecard schema: `~/dev/agentnative/src/scorecard.rs`
- Institutional learning: `docs/solutions/architecture-patterns/agent-native-documentation-surface-2026-04-13.md`

---

## Completion Notes (2026-04-20)

All 9 implementation units shipped across commits `49d3376` through `391e734` on `feat/registry-schema-and-expansion`
(PR #21 into `dev`).

**Final state:**

- 96 tools in `registry.yaml` across three tiers (Workhorse/Agent/Notable)
- 10 tools scored with committed JSON in `scorecards/`; remaining 86 listed as "not yet scored"
- Leaderboard at `/scorecards` with client-side tier filtering and column sorting
- Per-tool scorecard pages at `/score/<tool-name>` (96 tools × HTML + MD = 192 files)
- `llms.txt`, `llms-full.txt`, and `sitemap.xml` extended with scorecard data
- Regression tests updated (78 tests, 243 assertions, all passing)
- Visual design pass completed via `/impeccable`

**Deviations from plan:**

- Registry expanded well beyond the initial "~100 tools" target — 96 tools in the seed, with versioned scorecard
  filenames and expanded schema fields (`repo`, `url`, `version`, `scored_at`)
- Unit 7 (nav link) correctly deferred to Plan 2 as specified
- `agentnative.dev` references in build code replaced with `anc.dev` (`cc3cc57`) — the plan predates the domain
  decision

**What Plan 2 inherits:**

- The static leaderboard and per-tool pages as the pre-computed cache layer
- The registry schema as the tool metadata source of truth
- The `scorecards.mjs` build module as the data loading and rendering layer
- Nav link addition (Unit 7, deferred)
