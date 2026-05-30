---
title: "feat: Split /install into /install (CLI) + /skill (skill bundle)"
type: feat
status: complete
date: 2026-04-28
completed: 2026-04-29
shipped_in:
  - "PR #44 (commit 8b20047) — merged 2026-04-29"
related_plans:
  - docs/plans/2026-04-24-001-feat-skill-distribution-endpoint-plan.md
  - docs/plans/2026-04-27-001-feat-skill-distribution-site-plan.md
---

# feat: Split `/install` into `/install` (CLI) + `/skill` (skill bundle)

## Outcome (2026-04-29)

Status: **complete**. Shipped as a single squash-merge — PR #44 (commit `8b20047`, `refactor(skill): split /install into
/install (CLI) + /skill (skill bundle)`), merged 2026-04-29 17:12 UTC. All ten acceptance requirements verified against
the post-merge tree on `dev`:

- **R1 ✓** `dist/install.html` rendered from a new content-driven `content/install.md`. Single canonical install copy:
  the brew/cargo command lines now live only in `content/install.md` (verified by `grep -rE 'brew install
  brettdavies/tap/agentnative|cargo install agentnative' src/ content/` returning that one file).
- **R2 ✓** `dist/install.md` twin emitted via the standard `subPages` pipeline.
- **R3 ✓** `dist/install.json` does NOT exist post-build. Asset-absent 404 contract upheld.
- **R4 ✓** `dist/skill.html` emitted; data-driven render unchanged from prior `/install` HTML.
- **R5 ✓** `dist/skill.json` emitted; `src/data/skill.json` carries `skill_page_html: "https://anc.dev/skill"` and
  `schema_version: 1`. Field rename landed.
- **R6 ✓** `dist/skill.md` emitted.
- **R7 ✓** Worker stays slug-agnostic. `src/worker/headers.ts` and `src/worker/index.ts` doc-comments updated; no
  branching on `/install` or `/skill` path prefix.
- **R8 ✓** Doc sweep landed across `README.md` (line 29), `RELEASES.md` (line 221), `docs/DESIGN.md` (line 480 carries
  `skill_page_html`; §3.9 + §3.10 carry the new vocabulary), and the workflow comments in
  `.github/workflows/skill-availability.yml`. The remaining `/install.json` references in `RELEASES.md:219` and
  `docs/DESIGN.md:524,527,529` are intentional cutover/contract documentation, not stale references.
- **R9 ✓** `bun run lint && bun run build && bun test` green on the post-merge tree (134 tests pass; build emits 110
  HTML pages + 110 MD pages + the skill triple + the new `install` twin). Pre-push hook gated each commit per repo
  policy.
- **R10 ✓** `tests/e2e/skill.e2e.ts` exists; `playwright.config.ts` carries the renamed `skill` project.

Three units merged in PR #44; all checkboxes ticked below.

**Follow-up filed** per the plan's "Deferred to Separate Tasks" callout: `/compound` entry covering both the original
triple-emit pattern and what made the split clean. Not yet written; track as a P3 chore.

## Overview

The current `/install` triple-emit (HTML + JSON + MD) serves the **skill distribution** surface — the agent-native-cli
skill bundle. The CLI tool itself has no dedicated install URL; its install commands live inside `/audit`'s prose. This
plan splits the surface so each artefact has a focused home:

- **`/install`** becomes the agentnative **CLI** install page. HTML + markdown twin only — no `/install.json`. Built
  from a new `content/install.md` extracted from the install section currently embedded in `content/audit.md`.
- **`/skill`** becomes the **skill** distribution endpoint. Direct migration of today's `/install` triple-emit:
  `/skill.html` + `/skill.json` + `/skill.md`. Same data, same renderer, new URL prefix.

This is a **hard cut, pre-launch.** No 301 redirects, no dual-serve window, no `Deprecation:` headers. Old
`/install.json` returns 404 (achieved by simply not emitting the asset; Cloudflare's `not_found_handling: "404-page"`
takes the rest). Skill consumers update to `/skill.json` in the same PR via the producer-repo docs cycle.

The previous skill-distribution plans ([`2026-04-24-001`](./2026-04-24-001-feat-skill-distribution-endpoint-plan.md),
[`2026-04-27-001`](./2026-04-27-001-feat-skill-distribution-site-plan.md)) deferred a `/skill/<name>` URL pattern to "v2
when N>1 skills." We are doing v2 now, but as **singular `/skill`** — the per-name pattern stays deferred.

## Problem Frame

Today `/install` does double duty: it's the public skill-distribution surface AND it's where humans land when they
google "install agentnative." The page reads as skill-only (its title, body, and JSON manifest all describe the skill
bundle), so a user searching for the CLI install command lands somewhere that talks about `git clone …
~/.claude/skills/…` — the wrong artefact.

Meanwhile the CLI's install copy is duplicated in three places:

- `content/audit.md` lines 6–13 (canonical authored copy).
- `src/build/build.mjs` lines 260–269 (inline HTML in the leaderboard's "reproduce a row locally" block).
- `src/build/scorecards-render.mjs` lines 412, 422 (per-tool scorecard repro command + cargo install hint).

Three copies of the same install commands violates STAR (Single Truth, Authoritative Record). The split fixes both
problems at once: `/install` becomes the canonical CLI install page, the duplications collapse to links, and the skill
manifest gets its own honest URL at `/skill`.

## Requirements Trace

- **R1.** `GET https://anc.dev/install` returns the CLI install page (HTML). The page sources its install commands from
  a single `content/install.md` (no duplication across files).
- **R2.** `GET https://anc.dev/install.md` returns the markdown twin of the CLI install page (content negotiation via
  `Accept: text/markdown` returns the same content).
- **R3.** `GET https://anc.dev/install.json` returns **404**. There is no CLI install manifest; the CLI is installable
  via the package manager commands documented on the HTML page.
- **R4.** `GET https://anc.dev/skill` returns the skill distribution HTML page (today's `/install` HTML, byte-shifted
  for URL changes only).
- **R5.** `GET https://anc.dev/skill.json` returns the canonical skill manifest (today's `/install.json` content with
  `install_page_html` flipped to `https://anc.dev/skill`, optionally renamed `skill_page_html`).
- **R6.** `GET https://anc.dev/skill.md` returns the markdown twin (today's `/install.md`).
- **R7.** Worker logic stays slug-agnostic: the JSON-extension predicate (`pathname.endsWith('.json')`) continues to
  drive header dispatch; no `if (pathname.startsWith('/install'))` branch is added.
- **R8.** All test assertions, sitemap entries, llms.txt sections, README/AGENTS.md/RELEASES.md/DESIGN.md/VOICE.md
  prose, and Worker doc-comments referencing `/install` for the skill flip to `/skill`. The new `/install` (CLI) is
  added to nav, sitemap, and llms.txt.
- **R9.** `bun run lint && bun run build && bun test` all pass on every implementation unit's tree (each unit
  squash-mergeable by itself), enforced by `scripts/hooks/pre-push`.
- **R10.** Multi-host live e2e (`tests/e2e/install.e2e.ts` → renamed `tests/e2e/skill.e2e.ts`) continues to pass against
  the new `/skill.json` against the four advertised hosts (claude_code, codex, cursor, opencode). The
  `skill-availability.yml` daily probe (which probes the producer repo on github.com, not anc.dev) stays green
  unchanged.

## Scope Boundaries

- **Not** introducing a `/skill/<name>` per-skill URL pattern. Singular `/skill` only; per-name deferred until N>1.
- **Not** introducing a CLI install **manifest** (no `/install.json`). The CLI is human-installable via brew/cargo
  commands; an agent-friendly manifest can come later as a separate decision.
- **Not** adding redirect rules to `wrangler.jsonc` or a `_redirects` file. The 404 contract is upheld by asset absence,
  not by a worker rewrite.
- **Not** adding D1, KV, R2, or other Worker bindings. Worker stays asset-only with content-negotiation.
- **Not** changing the skill data shape itself (`schema_version` stays at `1`; field renames are limited to
  `install_page_html` → `skill_page_html` for honesty).
- **Not** rewriting the historical skill-distribution plans (`2026-04-24-001`, `2026-04-27-001`, `2026-04-28-001`,
  `2026-04-28-002`). They are inert text; future readers see the URL evolution by reading this plan alongside them.

### Deferred to Separate Tasks

- **Per-skill `/skill/<name>` URLs**: deferred until N>1 skills. The current N=1 case ships as singular `/skill`. When
  the second skill lands, `/skill` becomes an index and per-skill content moves to `/skill/<name>`. The site's Worker
  JSON-extension dispatch is already shape-agnostic — no Worker code change anticipated.
- **CLI install manifest at `/install.json`**: explicitly out of scope. If/when an agent-installable CLI manifest
  becomes useful, it ships as a separate plan with its own JSON shape.
- **Compound docs/solutions entry for the triple-emit pattern**: the prior skill-distribution rollout never produced a
  `docs/solutions/` doc. The split is a natural prompt to write one combined entry covering both the original
  triple-emit and what made the split clean. File this as a follow-up `/compound` task after the split lands.

## Context & Research

### Relevant Code and Patterns

- **`src/build/install.mjs`** (full file, 282 lines) — current skill emitter. Exports `loadInstallData`,
  `emitInstallJson`, `buildInstallMarkdown`, `renderInstallPage`, `emitInstallMarkdown`. Internal markdown body
  references `/install.json` at lines 178, 234, 254. Renames + flips wholesale.
- **`src/data/install.json`** — canonical skill manifest. Field `install_page_html: "https://anc.dev/install"` at line
  27.
- **`src/build/build.mjs`** — orchestrator. Step 8c (lines 338–355) emits the skill triple. `subPages` registry (lines
  228–233) is where new content-driven HTML+MD pages slot in (Methodology + Scorecard schema both use this pattern).
  Step 8c currently bypasses `subPages` because the skill page is data-driven from `install.json`, not from
  `content/*.md`. The new CLI `/install` page can use the simpler `subPages` flow because it's content-driven.
- **`src/worker/headers.ts`** — JSON-extension branch (lines 73–77) is path-agnostic; no logic change. Doc-comment on
  line 22 references "`future /skill/<name>.json`" — update to drop `<name>` since v2 is singular.
- **`src/worker/index.ts`** — content-negotiation skip for `.json` paths (lines 36–41). Comment example references
  `/install.json`; flip to `/skill.json`.
- **`tests/regression.test.ts`** — `describe('regression #5 — /install.json (skill-distribution canonical surface)',
  ...)` at lines 124–240. Ten tests; all flip from `install.{json,html,md}` to `skill.{json,html,md}` plus add new
  assertions for `/install.html`/`.md` (CLI) existence and `/install.json` 404.
- **`tests/build.test.ts`** — `loadInstallData` validator suite at lines 863–963. Renames imports + factory.
- **`tests/worker.test.ts`** — JSON branch tests at 140–164 and end-to-end handler tests at 287–303. Path-flip only.
  Stale forward-compat comment about `/skill/<name>.json` at line 156 — drop the `<name>`.
- **`tests/e2e/install.e2e.ts`** + `playwright.config.ts` — Playwright project named `install` (line 53–58 in config)
  with `testMatch: /install\.e2e\.ts/`. Rename file → `skill.e2e.ts` and project → `skill`.
- **Subpage emission pattern**: `content/methodology.md` and `content/scorecard-schema.md` use `src/build/build.mjs`
  step 7's `subPages` array — same pattern the new `content/install.md` (CLI page) will use. Reference for the new
  `/install` is the section starting at `src/build/build.mjs:227`.
- **Inline-duplicated CLI install copy**:
- `src/build/build.mjs:260–269` — leaderboard "reproduce locally" block.
- `src/build/scorecards-render.mjs:412` — `reproCommand` for per-tool scorecard pages.
- `src/build/scorecards-render.mjs:422` — "Cargo install" hint.
- `content/audit.md:6–13` — canonical authored copy.

### Institutional Learnings

- **`docs/solutions/architecture-patterns/agent-native-documentation-surface-2026-04-13.md`** — `/install` and `/skill`
  are both instances of the same content-negotiated surface. Worker route logic should NOT branch on the path prefix.
  The split is two endpoints under one mechanism, not two mechanisms. Plan implication: keep `src/worker/headers.ts` and
  `src/worker/index.ts` slug-agnostic; only doc-comments change.
- **`docs/solutions/best-practices/cloudflare-workers-static-assets-custom-headers-2026-04-14.md`** — when the Worker
  mutates the response (this site does, for content-negotiation), `_headers` rules silently no-op for every path the
  Worker touched. All headers must live in Worker code. Plan implication: existing JSON-branch headers in
  `src/worker/headers.ts` already handle this correctly; do not move logic to `_headers` or `wrangler.jsonc` during the
  rename.
- **`docs/solutions/logic-errors/accept-header-q-value-parsing-content-negotiation-2026-04-14.md`** —
  `accepts.type([...])` with server-preference order is the load-bearing decision for which representation `Accept: */*`
  returns. After the split, `/skill` still has three representations (HTML/JSON/MD) and `/install` has two (HTML/MD).
  The existing preference list applies cleanly; no behavioral change. Plan implication: add Worker tests asserting that
  an agent fetching `/skill` with `Accept: */*` gets the JSON branch (today's behavior) and that `/install` with the
  same Accept gets HTML (new page has no JSON twin).
- **`docs/solutions/best-practices/byte-equivalence-regression-tests-for-copied-design-artifacts-2026-04-14.md`** — the
  `/skill.json` byte-stable hash assertion in `tests/regression.test.ts` is the same firewall pattern that caught
  principle-page anchor drift on first run. Plan implication: keep the byte-equivalence assertion when the test moves
  from `install.json` to `skill.json`. Add a new assertion that `dist/install.json` does NOT exist post-build (404
  contract via asset absence).
- **`docs/solutions/workflow-issues/ci-soft-fail-continue-on-error-reverts-gate-2026-04-14.md`** — every new e2e
  assertion (the `/install.json` 404 contract) MUST be a hard-fail gate. No `continue-on-error: true` while the endpoint
  stabilizes. Repo auto-memory `feedback_no_soft_fail_gates.md` reinforces this.
- **`docs/solutions/best-practices/sot-contract-for-spec-repos-with-downstream-consumers-2026-04-22.md`** —
  `/skill.json` is the JSON shape consumers will pin against. The plan should not change `schema_version` (stays at
  `1`); the field rename `install_page_html` → `skill_page_html` is a value-shape change, not a schema change. If
  external consumers exist beyond the producer-repo README, they update their fetch URL but not their parsing logic.

**Negative finding worth flagging:** no `docs/solutions/` doc exists for the original `/install` triple-emit rollout.
The split is a natural prompt to compound after — captured under "Deferred to Separate Tasks" above.

### External References

External research skipped (per Phase 1.2 decision). The `/install` triple-emit pattern is well-established in this repo
(PRs #36–#39 shipped 2026-04-27 to 2026-04-28); the pattern is the source of truth, not an external reference.

## Key Technical Decisions

- **Singular `/skill`, not `/skill/<name>`**: smallest blast radius. When N>1 ships later, `/skill` becomes an index and
  per-skill content moves to `/skill/<name>` — the Worker's JSON-extension dispatch is already shape-agnostic. Today,
  the rename is a 1:1 path swap.
- **`/install` is HTML + MD only — no JSON manifest**: the user explicitly chose this. The CLI is human-installable via
  brew/cargo; an agent-friendly install manifest is out of scope. `/install.json` returns 404 by simply not emitting the
  asset; no redirect, no manifest stub.
- **Hard cut at deploy, pre-launch**: no 301 redirects, no dual-serve, no `Deprecation:` headers. The skill manifest has
  been live for less than 48 hours; external consumers are zero or near-zero. If a consumer breaks, the fix is trivial
  (update the URL string). No deprecation infrastructure needed.
- **Slug-agnostic Worker logic**: per the agent-native documentation surface learnings, the Worker continues to dispatch
  on file extension, not path prefix. Only doc-comments change in `src/worker/headers.ts` and `src/worker/index.ts`.
- **Field rename `install_page_html` → `skill_page_html`** in `src/data/skill.json`: pre-launch hard cut, schema_version
  stays at `1`. Renames the field for honesty without burdening any consumer with a parsing change beyond the
  already-required URL flip.
- **STAR-compliant install copy via dedup**: harvest `content/audit.md:6–13` to a new `content/install.md`. Update
  `check.md` to link to `/install`. Refactor inline install HTML in `src/build/build.mjs:260–269` and
  `src/build/scorecards-render.mjs:412,422` to link to `/install` instead of repeating the brew/cargo lines. Three
  duplications collapse to one source.
- **Primary-nav entry for `/install`**: yes. The recent nav additions (Leaderboard, Methodology — see PR #42)
  established that launch-week pages get header surface area. `/install` is the CLI's launch hook; nav-worthy.
- **Atomic per-unit commits, single squash-PR**: per repo memory `feedback_dev_branch_squash_flow.md` and
  `feedback_auto_squash_merge.md`. Each unit must keep `bun run lint && bun run build && bun test` green so
  `scripts/hooks/pre-push` allows pushes between commits, but the full set ships as one squash-merge to `dev`.

## Open Questions

### Resolved During Planning

- **CLI shape (Q1 in interactive)**: HTML + MD only, no `/install.json`. → Locked.
- **Backward compat (Q2)**: hard cut, pre-launch, no communication needed. → Locked.
- **URL granularity (Q3)**: singular `/skill`, not `/skill/<name>`. → Locked.
- **Where does the CLI install copy live?**: a new `content/install.md` (Option 1 from research). The `## Install`
  section in `content/audit.md` shrinks to a one-line link to `/install`. Inline duplications in `src/build/build.mjs`
  and `src/build/scorecards-render.mjs` flip to links.
- **Field rename `install_page_html` → `skill_page_html`**: yes, take the rename — pre-launch, no consumer parsing
  beyond the producer-repo README which is co-edited.
- **Primary-nav entry for `/install`**: yes — match the launch posture of Leaderboard/Methodology.

### Deferred to Implementation

- **Exact wording of the new `content/install.md` body beyond the brew/cargo commands**: copy currently lives at
  `content/audit.md:6–13` and is six lines. The implementer may extend with a one-paragraph intro framing what
  `agentnative` is, mirroring the voice of `/audit`'s opening paragraph. The plan does not pre-write the prose.
- **Whether `content/audit.md` retains a one-line link to `/install` or removes the section entirely**: the implementer
  decides at the moment of edit based on whether the surrounding `## Run it` section reads naturally without the `##
  Install` predecessor. Both outcomes satisfy R1.
- **Whether to extract a small helper in `src/build/scorecards-render.mjs`** for the now-link-only repro hint: at most a
  2-line consolidation, not worth pre-specifying.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.
> The implementing agent should treat it as context, not code to reproduce.*

```text
                            BEFORE                                         AFTER
                            ──────                                         ─────

content/audit.md ──┬── /audit.html                       content/audit.md ── /audit.html
                   │                                                            │
                   └── (inline) brew + cargo                                    └── link → /install
                                                         content/install.md ── /install.html
src/data/install.json ── src/build/install.mjs ──┬── /install.html                              ── /install.md (twin)
                                                 ├── /install.json
                                                 └── /install.md
                                                         src/data/skill.json ── src/build/skill.mjs ──┬── /skill.html
                                                                                                       ├── /skill.json
                                                                                                       └── /skill.md
src/build/build.mjs:260–269 ── inline brew+cargo HTML
                                                         src/build/build.mjs:260–269 ── link → /install
src/build/scorecards-render.mjs:412,422 ── inline brew+cargo
                                                         src/build/scorecards-render.mjs:412,422 ── link → /install

Worker:
  pathname.endsWith('.json')  →  JSON branch (Content-Type, CORS, noindex, short cache)
                                 ───────────────────────────────────
                                 unchanged behavior; only the URL it serves changes from
                                 /install.json → /skill.json
  pathname.endsWith('.md') OR Accept: text/markdown  →  markdown twin
                                                         unchanged
  default                                              →  HTML
                                                         unchanged

  /install.json after the split: no asset exists → Cloudflare 404 page
  (per wrangler.jsonc not_found_handling: "404-page")
```

The migration is mechanical: rename two source files, flip URL strings in tests + docs, add one new content page, update
one nav array. The Worker is the most resilient surface because its dispatch is shape-agnostic.

## Implementation Units

The three units ship as ordered commits on a single feature branch (`feat/split-install-skill-endpoints`), squash-merged
to `dev` via auto-merge per repo memory. Each commit must keep `bun run lint && bun run build && bun test` green so the
pre-push hook (`scripts/hooks/pre-push`) admits pushes between commits.

- [x] **Unit 1: Rename skill distribution surface from `/install` to `/skill`**

**Goal:** Move the entire skill triple-emit (HTML + JSON + MD) from `/install` to `/skill`. Source files renamed, tests
flipped, Worker comments refreshed. End state: `/skill.{html,json,md}` serves the skill bundle exactly as today's
`/install.{html,json,md}` does; `/install*` returns 404 (asset-absent fallthrough to Cloudflare's 404 page).

**Requirements:** R4, R5, R6, R7, R10.

**Dependencies:** None (foundational rename).

**Files:**

- Rename: `src/build/install.mjs` → `src/build/skill.mjs`. Internal exports renamed: `loadInstallData` →
  `loadSkillData`, `emitInstallJson` → `emitSkillJson`, `buildInstallMarkdown` → `buildSkillMarkdown`,
  `renderInstallPage` → `renderSkillPage`, `emitInstallMarkdown` → `emitSkillMarkdown`. Internal markdown body URL
  references at lines 178, 234, 254 flip from `/install.json` to `/skill.json`. Header comment (lines 1–16) updated.
- Rename: `src/data/install.json` → `src/data/skill.json`. Field `install_page_html: "https://anc.dev/install"` →
  `skill_page_html: "https://anc.dev/skill"`.
- Modify: `src/build/build.mjs`. Import path on line 36 → `./skill.mjs` with renamed names; const `INSTALL_DATA_PATH`
  (line 57) → `SKILL_DATA_PATH` pointing at `src/data/skill.json`; step 8c (lines 338–355) emits
  `dist/skill.{json,html,md}` with `canonicalPath: '/skill'`; lines 367–370 (`installLinks` → `skillLinks`, paths to
  `/skill.md` + `/skill.json`); lines 401–406 (llms-full path flips to `/skill`); lines 411–415 (sitemap `extraPaths`
  swaps `/install` for `/skill`).
- Modify: `src/build/llms.mjs`. Rename param `installLinks` → `skillLinks`; heading `## Install` (line 83) → `## Skill`.
  **Decision deferred to implementation** whether `## Install` heading is replaced or kept alongside a new `## Skill`;
  default is replace (Unit 2 adds a new `## Install` for the CLI page).
- Modify: `src/worker/headers.ts`. Lines 15–22 doc-comment: drop the `<name>` segment from "future `/skill/<name>.json`
  reuses the branch" — replace with "any `/<slug>.json` endpoint reuses the branch."
- Modify: `src/worker/index.ts`. Lines 36–41 doc-comment example flips from `/install.json` to `/skill.json`.
- Modify: `tests/build.test.ts`. Lines 863–963 (`loadInstallData` validator suite): rename describe block, factory
  function `validManifest()`, and file path strings from `install.json` to `skill.json`. Field `install_page_html` at
  `tests/build.test.ts:889` renamed to `skill_page_html` with value `https://anc.dev/skill`.
- Modify: `tests/regression.test.ts`. Lines 124–240 (regression #5): describe heading flips to "regression #5 —
  /skill.json (skill-distribution canonical surface)"; every `install.{json,html,md}` reference flips to
  `skill.{json,html,md}`; sitemap assertion at line 219 (`expect(sitemap).toContain('/install</loc>')`) flips to
  `/skill`; **add new assertion** that the build produces no `dist/install.json` artifact (a build-time guard for the
  404 contract).
- Modify: `tests/worker.test.ts`. Lines 140–164 (JSON-branch tests) and 287–303 (handler tests): every `/install.json` →
  `/skill.json`. Line 156 stale forward-compat comment about `/skill/<name>.json` updates to drop `<name>`.
- Rename: `tests/e2e/install.e2e.ts` → `tests/e2e/skill.e2e.ts`. Line 37 fetches `/install.json` → `/skill.json`. Header
  comment (lines 1–20) and inline comment at line 117 flip URL refs.
- Modify: `playwright.config.ts`. Line 47 (`testIgnore: /install\.e2e\.ts/`) → `/skill\.e2e\.ts/`; lines 53–58
  (`install` project) renamed to `skill` with matching `testMatch` regex; comment on line 56 updated (`bun x playwright
  test --project=install` → `--project=skill`).

**Approach:**

- Atomic source rename + every consumer flips in one commit. Net diff per file is small (URL string substitution +
  identifier rename); the size of the unit comes from the count of files, not the depth of changes per file.
- The Worker is **not** reshaped — only doc-comments change. The JSON-extension predicate (`pathname.endsWith('.json')`)
  already serves the new path correctly.
- The 404 contract for `/install.json` is upheld by **asset absence**: build no longer emits `dist/install.json`,
  Cloudflare's `not_found_handling: "404-page"` (`wrangler.jsonc:14`) returns 404 with the standard 404 page. No
  redirect rules, no Worker-level path matching.

**Patterns to follow:**

- Pattern reference: `src/build/install.mjs` itself — the only changes are name + URL substitution. Nothing about the
  validator, emitter, or render pipeline shape changes.
- Pattern reference: `tests/regression.test.ts` lines 124–240 — keep the byte-equivalence + sitemap-presence +
  llms.txt-membership shape; only paths change.

**Test scenarios:**

- *Happy path* — `bun run build` emits `dist/skill.json` + `dist/skill.html` + `dist/skill.md`; their contents match
  what today's `dist/install.{json,html,md}` would produce, with the URL fields flipped.
- *Happy path* — `loadSkillData` validator accepts the renamed `src/data/skill.json` with the renamed `skill_page_html`
  field.
- *Edge case* — manifest with old field name `install_page_html` fails validation (validator now requires
  `skill_page_html`).
- *Error path* — `loadSkillData` fails fast on the same malformed inputs the previous suite covered (missing required
  fields, bad commit SHA, bad SemVer).
- *Integration* — `bun run build` then assert `dist/install.json` does **not** exist (404 contract via asset-absence).
- *Integration* — Worker handler test: `GET /skill.json` returns `Content-Type: application/json`, CORS `*`,
  `X-Robots-Tag: noindex`, short cache headers (today's `/install.json` behavior, new path).
- *Integration* — Worker handler test: `GET /skill.json` with `Accept: text/markdown` still returns the JSON unchanged
  (CN rewrite skipped for `.json` paths, per `src/worker/index.ts:36–41`).
- *Integration* (Playwright `skill` project) — for each of the four advertised hosts (claude_code, codex, cursor,
  opencode), fetch `/skill.json`, extract the host's clone command, run `git clone --depth 1` against the producer repo,
  assert the resulting directory matches `verify.expected` SHA.
- *Regression* — sitemap contains `/skill` and does NOT contain `/install` (yet — Unit 2 adds the new CLI `/install`).
  No sitemap entry for `/skill.json` or `/install.json`.
- *Regression* — llms.txt contains a `## Skill` section pointing at `/skill.md` and `/skill.json`.
- *Regression* — llms-full.txt contains a "skill" section with `Source: https://anc.dev/skill` and `Canonical-Markdown:
  https://anc.dev/skill.md`.

**Verification:**

- `bun run lint && bun run build && bun test` green.
- `bun x playwright test --project=skill` green against the live Worker (or staging).
- After deploy: `curl -sI https://anc.dev/install.json` returns 404; `curl -s https://anc.dev/skill.json | jaq -e
  '.schema_version == 1 and .name == "agent-native-cli"'` succeeds.

---

- [x] **Unit 2: New `/install` (CLI) page; collapse three duplicate install copies**

**Goal:** Stand up the CLI install page at `/install` (HTML + MD only — no JSON). Harvest the install copy from
`content/audit.md` to a new `content/install.md` source. Refactor the two inline-duplicated install blocks (in
`src/build/build.mjs` and `src/build/scorecards-render.mjs`) to link to `/install` instead of restating the commands.
Add `/install` to primary nav, sitemap, and llms.txt.

**Requirements:** R1, R2.

**Dependencies:** Unit 1 (the build orchestrator's import lines and `installLinks` / `skillLinks` rename land together;
building Unit 2 on top of Unit 1's tree avoids merge conflicts in `src/build/build.mjs`).

**Files:**

- Create: `content/install.md`. Body harvested from `content/audit.md:6–13` (the `## Install` section). Add a short
  intro paragraph framing what `agentnative` is and why a user would install it. Link out to the principles spec (`/`)
  and to `/audit` ("once installed, here's how to use it").
- Modify: `content/audit.md`. Lines 6–13 (`## Install` section) shrink to a single sentence + link to `/install` (or are
  removed entirely if the surrounding `## Run it` reads naturally without the predecessor — implementer's call). Keep
  the canonical authored copy in one place: `content/install.md`.
- Modify: `src/build/build.mjs`. Add `{ name: 'install', path: join(CONTENT_DIR, 'install.md') }` to the `subPages`
  array (lines 228–233). The subPages renderer already produces HTML + MD twins via the same pipeline used by
  `methodology` and `scorecard-schema` — no new emitter needed.
- Modify: `src/build/build.mjs`. Lines 260–269 (the leaderboard's "reproduce locally" inline HTML block): replace the
  `<pre><code>brew install …</code></pre>` and the `cargo install` paragraph with a one-line link: "To reproduce any row
  locally, install `anc` ([see /install](/install)) and run `anc audit <binary>`."
- Modify: `src/build/scorecards-render.mjs`. Lines 412 (`reproCommand` template literal) and 422 (Cargo install hint):
  replace the inline command construction with text that points readers to `/install`. The reproduction hint becomes
  "Install `anc` (see [/install](/install)) and run `anc audit <binary>` (with `--audit-profile <category>` if
  applicable)." Same change applied to the markdown-twin equivalent at line 506.
- Modify: `src/build/build.mjs`. Sitemap `extraPaths` (line 415) adds `/install` alongside `/skill`. Both are
  human-indexable; both belong in the sitemap.
- Modify: `src/build/build.mjs`. `installLinks` / `skillLinks` parameter passed to `buildLlmsIndex` (lines 367–370): add
  a new entry for the CLI install page (`{ name: 'Install (HTML)', path: '/install.md' }`). `skillLinks` keeps its
  existing entries pointing at `/skill.md` + `/skill.json`.
- Modify: `src/build/llms.mjs`. Add a `## Install` section heading (CLI install page) alongside the `## Skill` heading
  from Unit 1. The existing `installLinks` parameter from Unit 1 has already been renamed `skillLinks`; this unit
  re-introduces an `installLinks` (or equivalent) for the CLI surface — see "Decision deferred to implementation" note
  below.
- Modify: `src/build/shell.mjs`. Lines 146–152 (primary nav): add `<a href="/install">Install</a>` between `<a
  href="/scorecards">Leaderboard</a>` and `<a href="/check">Audit your CLI</a>`. Order rationale: launch flow is "see
  the leaderboard → install the CLI → check your own."
- Modify: `content/_intro.md`. Add a short callout paragraph linking to `/install` for readers who want to install
  agentnative locally (parallel to the existing skill bundle reference, which points to `/skill` after Unit 1).

**Approach:**

- Keep the new page minimal. The `subPages` pattern already builds HTML + MD with the unified+rehype pipeline; no new
  emitter needed. The CLI install page is content-driven from `content/install.md`, parallel to `methodology.md` and
  `scorecard-schema.md`.
- The dedup is the primary win: three places that today restate the brew/cargo commands collapse to one canonical source
  (`content/install.md`) plus three links.
- **Decision deferred to implementation**: how the `## Install` heading in llms.txt is structured. Two options: (a) keep
  `## Skill` (Unit 1) and add a new `## Install` heading for the CLI page; (b) rename the section to `## Surfaces` and
  list both `/install` (CLI) and `/skill` (skill bundle) as sub-bullets. Option (a) is the default; the implementer may
  choose (b) if it reads more naturally in the rendered llms.txt.

**Patterns to follow:**

- Pattern reference: `content/methodology.md` and `content/scorecard-schema.md` for the `subPages`-driven content page
  pattern. New `content/install.md` should structurally mirror these (H1 title, intro paragraph, content sections, no
  frontmatter).
- Pattern reference: PR #42 (`feat(nav): expose leaderboard + methodology + scorecard-schema in nav and body`) for the
  primary-nav addition pattern. Follow the same ordering rationale (launch-relevance leads).
- Pattern reference: `content/audit.md:6–13` for the canonical authored install copy that becomes the seed for
  `content/install.md`.

**Test scenarios:**

- *Happy path* — `bun run build` produces `dist/install.html` and `dist/install.md`. The HTML page renders the brew +
  cargo commands; the markdown twin matches the source content.
- *Happy path* — `dist/install.json` does NOT exist (CLI install page has no JSON manifest).
- *Edge case* — `dist/install.html` includes the standard site shell (header nav with `Install`, footer with `Scorecard
  schema` link, etc.).
- *Integration* — `dist/sitemap.xml` contains both `<loc>/install</loc>` and `<loc>/skill</loc>`. Neither
  `/install.json` nor `/skill.json` appears (noindex per existing rules).
- *Integration* — `dist/llms.txt` references `/install.md` (CLI page) under an Install heading and references
  `/skill.md` + `/skill.json` under the Skill heading.
- *Integration* — every dist HTML page rendered by the build (every principle page, every sub-page, every per-tool
  scorecard, the leaderboard) shows `Install` in the primary nav.
- *Regression* — `src/build/scorecards-render.mjs:412,422,506` no longer hard-codes `brew install
  brettdavies/tap/agentnative`. The repro hint is a link to `/install`. Same for `src/build/build.mjs:260–269`.
- *Regression* — `content/audit.md` no longer contains the brew/cargo command lines (or contains only a single link to
  `/install`). The canonical copy lives in one place.
- *Worker handler test* — `GET /install` returns HTML; `GET /install.md` returns markdown twin; `GET /install.json`
  returns 404.
- *Playwright* (extend `tests/e2e/agents.e2e.ts` if a quick check is cheap) — `Accept: */*` against `/install` returns
  HTML (server preference); `Accept: text/markdown` against `/install` returns the markdown twin.

**Verification:**

- `bun run lint && bun run build && bun test` green.
- Visual: load `/install` in the dev server (`bun run dev` or staging deploy), confirm the page renders with brew/cargo
  commands and standard nav.
- Inline-link audit: `grep -rE 'brew install brettdavies/tap/agentnative|cargo install agentnative' src/ content/`
  returns only `content/install.md` (no other source-tree duplicates).

---

- [x] **Unit 3: Doc sweep + CI workflow comment refresh**

**Goal:** Flip every prose reference to `/install` (skill) over to `/skill` across README, AGENTS.md, RELEASES.md,
docs/DESIGN.md, docs/VOICE.md, content/_intro.md, and CI workflow comments. Add new prose for the `/install` (CLI) page
where the doc had no equivalent before.

**Requirements:** R8.

**Dependencies:** Units 1 and 2 (docs reference both surfaces; complete after the renames so URLs in the docs match the
live site).

**Files:**

- Modify: `README.md`. Line 29 link `[anc.dev/install](https://anc.dev/install)` →
  `[anc.dev/skill](https://anc.dev/skill)`.
- Modify: `AGENTS.md`. Lines 38–42 ("Structure" list): flip the two skill bullets from `/install` + `/install.json` →
  `/skill` + `/skill.json`. Update path reference from `src/data/install.json` → `src/data/skill.json`. **Add** a new
  bullet for `/install` (CLI install page) referencing `content/install.md`.
- Modify: `RELEASES.md`. Lines 196–219 ("Skill releases" section): flip every URL and data-file path. Cache-purge target
  list (line 216) becomes `/skill`, `/skill.json`, `/skill.md`. Verification curl (line 219) becomes
  `https://anc.dev/skill.json`. The section heading "Skill releases" already correct.
- Modify: `docs/DESIGN.md`. §3.9 (lines 442–513): heading "Skill distribution — `/install` and `/install.json`" → "Skill
  distribution — `/skill` and `/skill.json`". Every URL and file path in tables and prose flips. The v2-deferred
  forward-comp notes (lines 449, 488) update to "`v1` ships singular `/skill`; per-skill `/skill/<name>` URLs remain
  deferred until N>1." Manifest field `install_page_html` (line 478) renamed to `skill_page_html` to match Unit 1's
  data-file change. **Add §3.10 (or sibling section)** "CLI install — `/install`" describing the new CLI install page,
  its content source (`content/install.md`), and its non-JSON shape (HTML + MD only).
- Modify: `docs/VOICE.md`. Lines 126–134 (Surface-Specific Notes): heading `### /install and /install.json` → `###
  /skill and /skill.json`. Update body to reflect new URL. **Add a new register entry** for `/install` (CLI install
  page) — register: imperative voice, parallel to `/audit`. The new entry can be brief.
- Modify: `content/_intro.md`. Replace any reference to `anc.dev/install` (skill installer) with `anc.dev/skill`.
  Already partly done in Unit 2 (the new CLI `/install` callout) — Unit 3 finishes the skill-side flip if the intro
  currently mentions the skill bundle install URL.
- Modify: `.github/workflows/skill-availability.yml`. Header comment (lines 3–5) and inline comment (line 48): flip
  every `/install.json` reference to `/skill.json`. **No code change** — line 52 probes `git ls-remote --exit-code
  https://github.com/brettdavies/agentnative-skill.git HEAD` against the producer repo, not anc.dev; that URL is
  unaffected by the site-side rename.

**Approach:**

- Pure prose + URL-substitution sweep. No code changes; no test changes (Units 1 and 2 already covered tests).
- The DESIGN.md changes are the heaviest — §3.9 has multiple tables and forward-compat references that need consistent
  updating. Implementer should re-read the section end-to-end after substitutions to catch any leftover `<name>`
  references or stale forward-compat phrasing.
- VOICE.md gains a new register entry for `/install` (CLI). Implementer should keep it short — three to five sentences,
  mirroring the conciseness of the existing entries.

**Patterns to follow:**

- Pattern reference: PR #41's `content/methodology.md` updates and the new `content/scorecard-schema.md` for the voice +
  structure of additive doc entries.
- Pattern reference: `RELEASES.md` lines 196–219 — preserve the existing "what to do at release" runbook formatting;
  only paths flip.

**Test scenarios:**

- *Documentation regression* — `grep -rn '/install' README.md AGENTS.md RELEASES.md docs/ content/` returns only
  references to the new CLI `/install` page (no skill-bundle references via `/install`). Skill references appear as
  `/skill` only.
- *Documentation integrity* — DESIGN.md §3.9 and §3.10 (new CLI section) read end-to-end without contradicting each
  other. The "v2 deferred" forward-comp note correctly describes per-skill paths as still deferred (since v1 is singular
  `/skill`).
- *CI workflow* — `.github/workflows/skill-availability.yml` still passes its scheduled probe (the workflow probes
  github.com, not anc.dev; URL flip is comment-only).

**Verification:**

- `bun run lint` green (markdownlint catches any broken references in the docs).
- `bun run build` green (no broken internal links from doc updates if the build does link-checking; if not, manual
  audit).
- `grep -rn 'anc.dev/install\b' .` returns only references in this plan and historical plan documents in `docs/plans/`
  (intentional — historical plans are inert text).
- `grep -rn '/install\.json' .` returns only references in this plan, historical plans, and Unit 1's regression test
  that asserts the 404 contract.

## System-Wide Impact

- **Interaction graph:** `src/build/build.mjs` orchestrates all changes — its `subPages` array, step 8c, llms builder,
  and sitemap caller all participate in the rename. Worker (`src/worker/headers.ts`, `src/worker/index.ts`) is touched
  only at the doc-comment level.
- **Error propagation:** `loadSkillData` fail-fast validation continues to apply on the renamed `skill.json`. Build-time
  failures surface in `bun run build` exit codes as today; CI catches them.
- **State lifecycle risks:** Cloudflare cache. Production cache for `/install`, `/install.json`, `/install.md` must be
  purged on deploy or end-users will see stale skill content under the new CLI URL. Cache-purge step is already in
  `RELEASES.md` (Unit 3 updates the URL list to include both old and new paths during the cutover).
- **API surface parity:** the JSON-extension Worker branch (`src/worker/headers.ts:73–77`) is unchanged. Whatever works
  for `/skill.json` will also work for any future `.json` endpoint — no parity gap.
- **Integration coverage:** the Playwright `skill` project (renamed from `install`) is the single live-network e2e gate
  covering all four advertised hosts. Unit 1's test changes preserve this gate's coverage; Unit 2 adds a small handler
  test for the new `/install` CLI page.
- **Unchanged invariants:** `schema_version: 1` in `src/data/skill.json` does NOT change. Worker logic does not change.
  The agent-native documentation surface mechanism (HTML/MD/JSON content negotiation) does not change. Footer + nav
  structure beyond the new `Install` entry does not change.

## Risks & Dependencies

| Risk                                                                                                                                                             | Mitigation                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External consumer hit `/install.json` after the cutover and gets 404                                                                                             | Hard-cut decision is explicit and pre-launch. The skill manifest has been live <48h; consumers are zero or near-zero. The post-deploy verification curl in Unit 1 (R3 contract test) confirms the 404 reaches the edge correctly.                                            |
| Cloudflare edge cache serves stale `/install.json` (old skill content) for hours after deploy                                                                    | Cache-purge step is enumerated in `RELEASES.md` (updated in Unit 3). Cutover runbook: deploy → purge `/install`, `/install.json`, `/install.md`, `/skill`, `/skill.json`, `/skill.md` → verify with `curl -sI` against each.                                                 |
| Inline install-copy refactor in `src/build/scorecards-render.mjs` accidentally breaks per-tool repro hints across 96 scorecards                                  | Unit 2's regression assertion + a manual spot-check on 2-3 scorecards (e.g., `dist/score/ripgrep.html`, `dist/score/atuin.html`) before merge. Build is fast (~5s); iterate locally.                                                                                         |
| Renaming Playwright project `install` → `skill` breaks an unstated downstream invocation (someone runs `bun x playwright test --project=install` from a runbook) | Update RELEASES.md (Unit 3) to mention the project rename. The only known external invocation is in `playwright.config.ts` line 56 comment, which Unit 1 updates.                                                                                                            |
| llms.txt structural change (renamed/added headings) breaks an unstated downstream `llms.txt` consumer                                                            | `llms.txt` is structured but the heading vocabulary is per-site. Unit 1's regression test (`tests/regression.test.ts` lines 124–240) covers the structural assertions; an external `llms.txt` consumer parsing by heading name would already be brittle. Risk is acceptable. |
| Doc sweep misses a reference, leaving stale `/install` text in shipped docs                                                                                      | `grep -rn` audits in Unit 3's verification block + `bun run lint` (markdownlint) catch broken internal links. The dist/ artifact's HTML link-check (if run) catches HTML-side breakage.                                                                                      |

## Documentation / Operational Notes

- **Cutover runbook update** (Unit 3 modifies `RELEASES.md`): cache-purge after deploy must include both the old paths
  (`/install`, `/install.json`, `/install.md` — to evict stale skill content) and the new paths (`/skill`,
  `/skill.json`, `/skill.md`, `/install` (CLI)) for the first deploy after the split.
- **Producer-repo docs** (in `~/dev/agentnative-skill/`): the skill repo's README and any host-specific install copy
  that mentions `anc.dev/install.json` will be stale after this PR ships. Out of scope for this plan (it's a separate
  repo) but should be filed as a follow-up. Recommended: open a same-day PR on `agentnative-skill` to flip its README
  and install verification commands to `/skill.json` once this plan's PR merges to `main`.
- **Compound-after-shipping**: write a `docs/solutions/` entry for the original triple-emit pattern AND what made this
  split clean. The prior plans (`2026-04-24-001`, `2026-04-27-001`) never produced a compound doc; the split is the
  natural prompt.

## Sources & References

- **Related plans:**
-

[`docs/plans/2026-04-24-001-feat-skill-distribution-endpoint-plan.md`](./2026-04-24-001-feat-skill-distribution-endpoint-plan.md)
— original master plan; deferred `/skill/<name>` to v2. -
[`docs/plans/2026-04-27-001-feat-skill-distribution-site-plan.md`](./2026-04-27-001-feat-skill-distribution-site-plan.md)
— Units 2–5 execution plan that shipped via PRs #36–#39.

- **Related code:**
- `src/build/install.mjs`, `src/data/install.json`, `src/build/build.mjs` (step 8c), `src/build/llms.mjs`,
  `src/worker/headers.ts`, `src/worker/index.ts`, `tests/regression.test.ts`, `tests/build.test.ts`,
  `tests/worker.test.ts`, `tests/e2e/install.e2e.ts`, `playwright.config.ts`.
- **Related docs:** `README.md`, `AGENTS.md`, `RELEASES.md`, `docs/DESIGN.md` §3.9, `docs/VOICE.md`, `content/audit.md`,
  `content/_intro.md`, `.github/workflows/skill-availability.yml`.
- **Institutional learnings:**
- `docs/solutions/architecture-patterns/agent-native-documentation-surface-2026-04-13.md`
- `docs/solutions/best-practices/cloudflare-workers-static-assets-custom-headers-2026-04-14.md`
- `docs/solutions/logic-errors/accept-header-q-value-parsing-content-negotiation-2026-04-14.md`
- `docs/solutions/best-practices/byte-equivalence-regression-tests-for-copied-design-artifacts-2026-04-14.md`
- `docs/solutions/workflow-issues/ci-soft-fail-continue-on-error-reverts-gate-2026-04-14.md`
- `docs/solutions/best-practices/sot-contract-for-spec-repos-with-downstream-consumers-2026-04-22.md`
- **Related PRs/issues:** PRs #36, #37, #38, #39 (skill distribution rollout); PR #42 (nav additions for Leaderboard /
  Methodology / Scorecard schema — direct precedent for the `/install` nav entry in Unit 2); PR #43 (auto-discovery +
  pre-push hook — establishes the green-pre-push contract Unit 1's atomic-commit strategy depends on).
