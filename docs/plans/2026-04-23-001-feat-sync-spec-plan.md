---
title: "feat: sync-spec.sh — commit-a-copy vendoring of principles + VERSION + CHANGELOG"
type: feat
status: active
date: 2026-04-23
last-revised: 2026-04-30
parents:
  - https://github.com/brettdavies/agentnative/blob/dev/docs/plans/2026-04-22-002-post-frontmatter-roadmap.md
roadmap-item: 5 (spec-repo roadmap 002, item 4)
---

> **Status update (2026-04-30):** Plan is still **active** — none of U1, U2, or U3 have shipped on the site side.
> The Show HN launch (2026-04-30 09:00 PT) cleared without this script in place, confirming the work is not
> launch-critical. Current state of affairs:
>
> - **Site stubs that this plan replaces are still in place:**
>   - `src/build/util.mjs:91` exports `SPEC_VERSION = '0.3.0'` as a hardcoded constant. The inline comment
>     explicitly references this plan as the eventual replacement.
>   - The footer carries a separate stub (per the `project_spec_version_coupling` memory rule). Both should
>     converge to a single build-time read from `src/data/spec/VERSION` once U1 ships.
> - **Reference implementation now exists upstream:** `agentnative-cli` shipped its own sync-spec.sh in commit
>   `fff3f13` ("chore(sync-spec): modernize — remote-first, drop SPEC_REF", PR #33). When this plan executes, the
>   site script should mirror that remote-first shape rather than the original `SPEC_ROOT` env var design from
>   2026-04-23 — the cli implementation has already de-risked the pattern.
> - **Initial pin target moved:** R4 originally specified pinning the first vendored state against v0.2.0
>   (commit `83bf0fd`). The spec repo is now at v0.3.0 (`gh api repos/brettdavies/agentnative/contents/VERSION`
>   confirms). When U2 lands, pin against v0.3.0 (or whatever is the current tagged release at that moment) —
>   the intent of R4 ("pin against a tagged release, not a transient SHA") is unchanged; only the specific tag
>   moved as time passed.
> - **No drift cost while the stub matches reality:** the hardcoded `'0.3.0'` happens to match upstream today.
>   When the spec next bumps a minor and the badge label / `/badge` page need to cite the new version, that's
>   the natural moment to pull this plan off the shelf — bumping the stub by hand will start to bite, and U1+U2
>   become the cheap fix.
>
> No frontmatter `shipped_in` line because nothing shipped. Status stays `active` until U1+U2+U3 land.

# feat: sync-spec.sh — commit-a-copy vendoring of principles + VERSION + CHANGELOG

## Overview

Add `scripts/sync-spec.sh`, mirroring the existing `scripts/sync-coverage-matrix.sh` pattern. The script vendors three
artifacts from `brettdavies/agentnative` at a pinned SHA / tag:

1. `principles/p*-<slug>.md` (7 files, structured frontmatter + RFC-voice prose)
2. `VERSION` (single line, canonical spec version)
3. `CHANGELOG.md` (Keep-a-Changelog format)

Destination lives under `src/data/spec/` — the site's established home for vendored machine-readable artifacts — **not**
under `content/principles/`. The site's `content/principles/` copy is manually written and explicitly kept independent
of the spec's canonical text per `AGENTS.md`. This plan preserves that separation.

Tracked upstream as item 4 of
[agentnative-spec roadmap 002](https://github.com/brettdavies/agentnative/blob/dev/docs/plans/2026-04-22-002-post-frontmatter-roadmap.md).

## Problem Frame

The spec repo now ships structured frontmatter (requirement IDs, levels, applicability, summaries) and tagged versions
as of v0.2.0. Two site-side capabilities are blocked until vendored copies of those artifacts land:

- **Version-aware site rendering** (footer, `/about`, `/llms.txt` preamble) — needs `VERSION` to cite without
  hand-copying.
- **Generated spec derivatives** (`/llms-full.txt` concatenation, future coverage/scorecard cross-references) — needs
  structured `principles/*.md` to read from at build time.

The existing pattern for this is already proven: `src/data/coverage-matrix.json` is vendored from
`brettdavies/agentnative` via `scripts/sync-coverage-matrix.sh`. This plan is a direct re-application, with three inputs
instead of one.

The doctrine call is already made:
[`docs/solutions/best-practices/cross-repo-artifact-consumption-static-sites-2026-04-21.md`](../../docs/solutions/best-practices/cross-repo-artifact-consumption-static-sites-2026-04-21.md)
settled commit-a-copy over build-time fetch over cross-repo symlinks. No design debate here; just execution.

## Requirements Trace

- R1. A single script `scripts/sync-spec.sh` copies the three artifacts from a configurable `SPEC_ROOT` into this repo.
- R2. Destination is `src/data/spec/` (parallel to `src/data/coverage-matrix.json`); vendored files are committed.
- R3. `content/principles/` is untouched — the site's human-written principle copy remains the SoT for rendered pages.
- R4. The initial commit pins against the v0.2.0 tag (commit `83bf0fd`) so the first vendored state is a real release,
  not a transient SHA.
- R5. Operational guidance is documented alongside the existing `sync-coverage-matrix.sh` — same voice, same header
  comment pattern, same `SPEC_ROOT` env var with sensible default.
- R6. No CI enforcement of freshness on the site side — the spec repo's own `scripts/hooks/pre-push` already keeps the
  vendored sources honest; consumer-side drift is inspected via `git diff` after `sync-spec.sh` runs (matches the
  existing `sync-coverage-matrix.sh` operational model).

## Scope Boundaries

- No rendering changes. The vendored artifacts land at `src/data/spec/` but this plan doesn't wire them into any page or
  endpoint. Consuming them (in `/about`, `/llms.txt`, `/llms-full.txt`, or elsewhere) is separate follow-up work.
- No change to `content/principles/*.md` — still human-written, still authoritative for the rendered principle pages.
- No CI automation / GitHub Actions workflow to auto-run the sync. Manual invocation matches `sync-coverage-matrix.sh`.
- No migration of `/changelog` page away from its current hand-written `content/changelog.md`. Whether to replace that
  with a vendored read of `src/data/spec/CHANGELOG.md` is a separate design decision.

### Deferred to Follow-Up Work

- Wiring the vendored `VERSION` into the site footer / `/about` / `/llms.txt`: separate follow-up.
- Regenerating `/llms-full.txt` from `src/data/spec/principles/*.md` at build time: separate follow-up.
- Replacing `content/changelog.md` with a vendored read of `src/data/spec/CHANGELOG.md`: separate follow-up if ever
  chosen; current manual approach is not blocked.
- A GitHub Action that opens a PR when the spec publishes a new release (drift-detection automation): only if manual
  sync proves insufficient.

---

## Context & Research

### Relevant Code and Patterns

- `scripts/sync-coverage-matrix.sh` — the canonical template. Copy its structure verbatim: `set -euo pipefail`,
  `ANC_ROOT`/`SPEC_ROOT` env var with default, one `cp` per artifact, echo the source → dest mapping on success, hard
  error if source is missing.
- `src/data/coverage-matrix.json` — the output-shape precedent: one file per vendored artifact, committed to the repo,
  consumed by build.
- `AGENTS.md` — explicit rule: "site's principle copy in `content/principles/` is written **manually** from these files
  — no build-time import, no live link." This plan inherits that rule and keeps the vendored copy out of `content/`.

### Institutional Learnings

-

[`cross-repo-artifact-consumption-static-sites-2026-04-21.md`](../../docs/solutions/best-practices/cross-repo-artifact-consumption-static-sites-2026-04-21.md)
— settles the three-way design choice (build-time fetch vs symlink vs commit-a-copy) in favor of commit-a-copy. Also
prescribes feature-detection over version gating for reading the artifacts.

- `sot_contract.md` (spec-repo session memory) — IDs are the contract; versions are decoupled per-repo. Site can vendor
  v0.2.0 today and update when it cares.

### External References

- **`agentnative-cli` sibling `sync-spec.sh`** —
  [`~/dev/agentnative-cli/scripts/sync-spec.sh`](https://github.com/brettdavies/agentnative-cli/blob/dev/scripts/sync-spec.sh).
  A working sibling implementation of this exact problem (vendor principles + VERSION + CHANGELOG from the spec repo
  into a downstream consumer). Diverges from `sync-coverage-matrix.sh` in three ways worth adopting:
- **Extracts via `git show "$SPEC_REF:<path>" >dest`**, not `cp`. The operator's spec-repo working tree is never
  perturbed — no `git checkout` of a tag, no risk of leaving the spec clone on a detached HEAD after a sync.
- **Accepts `SPEC_REF` env var** (default `v0.2.0`). The script itself names the ref it's vendoring; commit messages can
  cite it directly. `SPEC_REF=v0.2.1 ./scripts/sync-spec.sh` is the standard operator gesture for a version bump.
- **Enumerates principle files via `git ls-tree --name-only "$SPEC_REF" principles/`**, not a working-tree glob. Sees
  what's at the ref, not what's lying around in the user's checkout.
- **Validation gates are explicit**: SPEC_ROOT is a git repo, SPEC_REF resolves to a commit, `principles/` exists at the
  ref. Each gate has a one-line error message that tells the operator what to do (`try git fetch --tags`, etc.).
- **Echoes the resolved short SHA** of the ref before extracting, so the operator sees exactly what was vendored.
- **`agentnative-cli` build-time consumer** —
  [`~/dev/agentnative-cli/build.rs`](https://github.com/brettdavies/agentnative-cli/blob/dev/build.rs). Demonstrates the
  consumer-side pattern: read vendored `src/principles/spec/`, parse frontmatter at build time, fail-fast with file +
  field cited on parse error. Site-side analog (whenever follow-up consumers land — `/llms-full.txt`, footer version,
  scorecard cross-refs) belongs in `src/build/*.mjs` and should mirror the same fail-fast posture.
- **`agentnative-cli` plan for the same work** —
  [`docs/plans/2026-04-23-001-feat-spec-vendor-plan.md`](https://github.com/brettdavies/agentnative-cli/blob/dev/docs/plans/2026-04-23-001-feat-spec-vendor-plan.md)
  in the CLI repo. Already cross-linked in Sources & References below; named here so the executor reaches for the
  sibling implementation first, the local `sync-coverage-matrix.sh` second.

---

## Key Technical Decisions

- **Destination is `src/data/spec/`, not `content/`.** Matches existing `src/data/coverage-matrix.json` precedent and
  honors `content/principles/`'s manual-authorship rule.
- **Three artifacts, one script.** Separate scripts (`sync-principles.sh`, `sync-version.sh`, `sync-changelog.sh`) would
  be YAGNI — the three always sync together because they all reflect the same spec release. One script, three `cp`
  commands, one echo per.
- **Env var is `SPEC_ROOT` with default `$HOME/dev/agentnative-spec`.** Matches the `ANC_ROOT=$HOME/dev/agentnative-cli`
  convention in `sync-coverage-matrix.sh`. Keeps per-machine path config out of the repo.
- **Initial commit pins v0.2.0 tag's content.** Run the script against a clean checkout of spec repo at tag `v0.2.0`
  (commit `83bf0fd`) before committing. Commit message cites the tag; future syncs cite the tag or SHA they pulled from.

## Open Questions

### Resolved During Planning

- **Can `principles/*.md` land under `content/` somewhere to drive `/llms-full.txt`?** — **No, not in this plan.**
  Destination is `src/data/spec/principles/`. Any consumption wiring is follow-up work.
- **Does the script need a `--check` mode to fail CI on drift?** — **No.** The spec repo's pre-push hook enforces
  source-side correctness. Consumer-side drift is deliberate (consumer chooses when to resync).
  `sync-coverage-matrix.sh` has no `--check` mode and that's worked fine.
- **Should the script pull from a git tag or a local checkout?** — **`git show <ref>:<path>` against a local checkout.**
  The original resolution favored "user checks out the tag, then `cp`," matching the pre-existing
  `sync-coverage-matrix.sh` pattern. The `agentnative-cli` sibling has since proven a better approach: extract via `git
  show "$SPEC_REF:<path>" >dest` so the operator's working tree is not perturbed, and accept `SPEC_REF` as an env var
  (default `v0.2.0`) so the script itself names the ref. **Adopt this for `sync-spec.sh`** — it's offline-capable (works
  against the local object store), reproducible (same ref → same vendored bytes regardless of working-tree state), and
  ergonomic for the operator (no `git checkout v0.2.0 && cp && git checkout dev` dance). See External References above
  for the concrete patterns. `sync-coverage-matrix.sh` may be retrofitted later or left as-is — that decision is not
  blocked by this plan.

### Deferred to Implementation

- **Should `src/data/spec/CHANGELOG.md` rename to `spec-changelog.md` to avoid filename collision risk in downstream
  tooling?** Decide in U1; leaning toward preserving the filename for clarity (destination folder disambiguates).
- **File-mode bits on the copied `VERSION` + `CHANGELOG.md`.** `cp` preserves mode by default; confirm that's fine on
  this repo (it should be — these are data files, not executables).

---

## Output Structure

```text
agentnative-site/
├── scripts/
│   ├── sync-coverage-matrix.sh     (existing, unchanged)
│   └── sync-spec.sh                (NEW — this plan)
└── src/
    └── data/
        ├── coverage-matrix.json    (existing, unchanged)
        └── spec/                   (NEW — this plan)
            ├── VERSION
            ├── CHANGELOG.md
            └── principles/
                ├── p1-non-interactive-by-default.md
                ├── p2-structured-parseable-output.md
                ├── p3-progressive-help-discovery.md
                ├── p4-fail-fast-actionable-errors.md
                ├── p5-safe-retries-mutation-boundaries.md
                ├── p6-composable-predictable-command-structure.md
                └── p7-bounded-high-signal-responses.md
```

---

## Implementation Units

- [ ] U1. **Author `scripts/sync-spec.sh`**

**Goal:** Write the script that vendors three artifacts from the spec repo into this repo.

**Requirements:** R1, R2, R5

**Dependencies:** None

**Files:**

- Create: `scripts/sync-spec.sh`

**Approach:**

**Primary reference: `~/dev/agentnative-cli/scripts/sync-spec.sh`.** Adopt its shape directly — it solves the same
problem one step downstream and has been run in anger. Treat `sync-coverage-matrix.sh` as the secondary reference for
this repo's local stylistic conventions (header comment voice, repo-root resolution).

- Env vars: `SPEC_ROOT` (default `$HOME/dev/agentnative-spec`) and `SPEC_REF` (default `v0.2.0`). The default for
  `SPEC_REF` is the same v0.2.0 tag this plan pins against; future syncs override it: `SPEC_REF=v0.2.1 ./sync-spec.sh`.
- Validation gates (mirror the CLI script):
- `SPEC_ROOT` is a git repo (else: print path + remediation, exit 1).
- `SPEC_REF` resolves to a commit (else: suggest `git fetch --tags`, exit 1).
- `principles/` exists at `SPEC_REF` (else: error citing the ref, exit 1).
- Resolved-SHA echo: `git -C "$SPEC_ROOT" rev-parse --short=7 "$SPEC_REF^{commit}"` printed before extraction so the
  operator sees the exact vendored content.
- Extraction (three artifacts, all via `git show`):
- `git show "$SPEC_REF:VERSION" >src/data/spec/VERSION`
- `git show "$SPEC_REF:CHANGELOG.md" >src/data/spec/CHANGELOG.md`
- Enumerate principle files at the ref via `git -C "$SPEC_ROOT" ls-tree --name-only "$SPEC_REF" principles/`, then `git
  show "$SPEC_REF:<path>" >src/data/spec/principles/<basename>` per match.
- `mkdir -p src/data/spec/principles` before extraction so first-run works.
- `set -euo pipefail`, SCRIPT_DIR + SITE_ROOT resolution per local convention.
- `chmod +x scripts/sync-spec.sh` after creation.
- Closing line mirrors the CLI script: `echo "next: review \`git diff\` for unexpected changes, then commit."`

**Patterns to follow:**

- `scripts/sync-coverage-matrix.sh` — structure, voice, header comment style.

**Test scenarios:**

- Happy path: with `SPEC_ROOT=$HOME/dev/agentnative-spec` at tag `v0.2.0`, running the script creates
  `src/data/spec/VERSION` containing `0.2.0`, `src/data/spec/CHANGELOG.md` matching the spec repo's file byte-for-byte,
  and seven `src/data/spec/principles/p*.md` files matching the spec principles byte-for-byte.
- Edge case: if `src/data/spec/principles/` already exists with stale files (e.g., from a prior sync), the script
  overwrites them with `cp` — no stale files should linger. Verified by: creating a dummy file there, running the
  script, confirming only the real principles files remain (or accepting that `cp` won't clean up orphans — see below).
- Error path: if `SPEC_ROOT` is unset and the default path doesn't exist, the script errors out clearly. Mirrors
  `sync-coverage-matrix.sh`'s behavior.
- Error path: if `$SPEC_ROOT/VERSION` or `$SPEC_ROOT/CHANGELOG.md` is missing, the script errors with a clear message
  citing the missing file.
- Edge case (stale cleanup): `cp` overwrites files at their path but does NOT remove orphan files. If a principle is
  renamed or removed upstream, a stale copy would linger locally. Decision: accept this — the spec's 7-principle shape
  is stable and any future rename is rare enough to handle by hand (`git diff` after sync will show the orphan). Not
  worth adding a rsync `--delete`-style flag to a simple script.

**Verification:**

- `./scripts/sync-spec.sh` runs clean on a machine with the spec repo checked out at v0.2.0; produces the expected file
  tree under `src/data/spec/`.
- `git diff src/data/spec/` after sync shows only the initial addition (no unrelated changes).
- `shellcheck scripts/sync-spec.sh` passes (matching whatever shellcheck discipline this repo applies to
  `sync-coverage-matrix.sh`).

---

- [ ] U2. **Initial commit of vendored artifacts at v0.2.0**

**Goal:** Run the script against the v0.2.0 checkout of the spec repo and commit the resulting vendored state.

**Requirements:** R4

**Dependencies:** U1

**Files:**

- Create: `src/data/spec/VERSION`
- Create: `src/data/spec/CHANGELOG.md`
- Create: `src/data/spec/principles/p1-non-interactive-by-default.md`
- Create: `src/data/spec/principles/p2-structured-parseable-output.md`
- Create: `src/data/spec/principles/p3-progressive-help-discovery.md`
- Create: `src/data/spec/principles/p4-fail-fast-actionable-errors.md`
- Create: `src/data/spec/principles/p5-safe-retries-mutation-boundaries.md`
- Create: `src/data/spec/principles/p6-composable-predictable-command-structure.md`
- Create: `src/data/spec/principles/p7-bounded-high-signal-responses.md`

**Approach:**

- In a clean `~/dev/agentnative-spec` clone, `git checkout v0.2.0`.
- From this repo, run `./scripts/sync-spec.sh`.
- Commit the resulting tree with message citing the tag + commit SHA: `feat: vendor spec v0.2.0 via sync-spec.sh
  (spec@83bf0fd)`.
- PR body's `## Changelog` section notes: "Added: `src/data/spec/` — vendored spec artifacts from agentnative-spec
  v0.2.0. See `scripts/sync-spec.sh` for resync instructions."

**Patterns to follow:**

- `CHANGELOG convention` from global CLAUDE.md: user-facing changes in `## Changelog` body section; refactors/internal
  go elsewhere.

**Test scenarios:**

- Happy path: `VERSION` reads `0.2.0`, `CHANGELOG.md`'s latest entry is `## [0.2.0] - 2026-04-23`, principles
  frontmatter matches the spec repo byte-for-byte.
- Integration: markdown-linting pre-push hook in this repo (if any exists) passes on the vendored files. If this repo's
  markdownlint config is stricter than the spec repo's, vendored files could fail; in that case, add an exclusion rather
  than editing vendored content.

**Verification:**

- `git log --oneline src/data/spec/` shows a single initial commit.
- `cat src/data/spec/VERSION` outputs `0.2.0`.
- `diff -r src/data/spec/principles/ ~/dev/agentnative-spec/principles/` (with spec repo at v0.2.0) reports no
  differences.

---

- [ ] U3. **Document the sync workflow**

**Goal:** Readers of this repo know when and how to resync.

**Requirements:** R5

**Dependencies:** U1

**Files:**

- Modify: `scripts/sync-spec.sh` header comment — expand the "when to run" block beyond the one-liner pattern from
  `sync-coverage-matrix.sh` to explicitly call out the three artifacts and the spec-side release-notification workflow.
- Modify: `AGENTS.md` — the existing block about `content/principles/` being manually-authored gets a sibling paragraph
  pointing at `src/data/spec/` as the vendored, machine-readable mirror used for build-time derivatives. Clarifies that
  the two paths coexist intentionally.

**Approach:**

- Header comment template (mirrors `sync-coverage-matrix.sh`'s):

  ```bash
  # Sync the spec artifacts (principles + VERSION + CHANGELOG) from the agentnative-spec repo.
  #
  # Source of truth: brettdavies/agentnative
  # Generated by:   human authorship (principles/*.md frontmatter + prose), spec repo's release
  #                 workflow (VERSION bump + CHANGELOG regeneration via cliff.toml).
  #
  # Run this after agentnative-spec cuts a new tag. The spec repo's scripts/hooks/pre-push
  # enforces source-side correctness (frontmatter schema, ID uniqueness, relative link integrity).
  ```

- AGENTS.md paragraph: short. 3-4 sentences. "As of 2026-04-23 the site vendors three spec artifacts at `src/data/spec/`
  via `scripts/sync-spec.sh`. This is a build-time data mirror, not a content mirror — `content/principles/` is still
  human-written site copy, and the two evolve independently. When the spec cuts a new tag, rerun `sync-spec.sh` and open
  a PR. See `docs/solutions/best-practices/cross-repo-artifact-consumption-static-sites-2026-04-21.md` for the governing
  pattern."

**Patterns to follow:**

- Existing AGENTS.md voice: direct, named paths, cross-references to authoritative docs.
- Spec repo's CONTRIBUTING.md structure (header comment → prose → examples) for the header comment.

**Test scenarios:**

- Happy path: a reader opening this repo cold can find `sync-spec.sh`, read its header, and understand what it vendors
  and when to rerun it. Secondary confirmation: the AGENTS.md paragraph resolves the "why is there both
  `content/principles/` and `src/data/spec/principles/`" question without requiring further reading.
- Test expectation: none (prose-only unit). Verification is a readability pass.

**Verification:**

- Another agent or collaborator opening this repo fresh can answer "what does `sync-spec.sh` do, why does it exist, and
  when do I run it?" without asking.

---

## System-Wide Impact

- **Interaction graph:** None at ship time. Future consumers of `src/data/spec/` (build scripts, `/llms-full.txt`
  generation, footer rendering) will form the interaction graph when they land as follow-up work.
- **API surface parity:** The shields.io badge endpoint (spec roadmap 002, item 2) and the coupled-release protocol in
  `brettdavies/agentnative:CONTRIBUTING.md` both assume the site can cite a spec version. This plan makes that citation
  mechanical rather than manual.
- **Integration coverage:** No automated integration test — this is a one-off script, not a live integration.
  `sync-coverage-matrix.sh` doesn't have tests either; the operational model is "run, diff, PR, review."
- **Unchanged invariants:**
- `content/principles/*.md` — still human-written, still the SoT for rendered principle pages.
- `content/changelog.md` — still hand-written (replacement is follow-up work, out of scope here).
- `scripts/sync-coverage-matrix.sh` — untouched.
- Cloudflare Worker routing, CommonMark rendering, llms.txt endpoints — untouched.

---

## Risks & Dependencies

| Risk                                                                                     | Mitigation                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sync-spec.sh` overwrites locally-modified vendored files with no warning                | Accept — `cp` has this property; resync is a deliberate action. Reviewers catch unintended changes in the PR diff.                                     |
| Vendored `CHANGELOG.md` markdownlint differs from site's stricter config                 | Add a per-path markdownlint exclusion for `src/data/spec/` rather than editing vendored content. Decide during U2.                                     |
| Stale orphan file left in `src/data/spec/principles/` if a principle is renamed upstream | Accept — the 7-principle shape is stable; `git diff` surfaces any orphan at the next sync. Not worth `rsync --delete` complexity.                      |
| Someone edits `src/data/spec/*` directly instead of editing the spec repo                | AGENTS.md paragraph in U3 explicitly names `src/data/spec/` as vendored; header comment in the files' dir could reinforce, but YAGNI until it happens. |

---

## Documentation / Operational Notes

- When this plan lands, strike item 4 in
  [agentnative-spec roadmap 002](https://github.com/brettdavies/agentnative/blob/dev/docs/plans/2026-04-22-002-post-frontmatter-roadmap.md)
  (mark shipped with PR link + vendored spec version).
- Any future follow-up that consumes `src/data/spec/` (footer, llms-full.txt regen, etc.) files its own plan here and
  cross-references this one.
- If the spec repo ever changes `principles/` layout (sub-folders, additional files), reconsider U1's simple glob —
  that's a revisit trigger, not a failure to anticipate now.

## Sources & References

- **Parent roadmap (spec repo):**
  [`2026-04-22-002-post-frontmatter-roadmap.md`](https://github.com/brettdavies/agentnative/blob/dev/docs/plans/2026-04-22-002-post-frontmatter-roadmap.md),
  item 4
- Pattern source (cross-repo):
  [`docs/solutions/best-practices/cross-repo-artifact-consumption-static-sites-2026-04-21.md`](../../docs/solutions/best-practices/cross-repo-artifact-consumption-static-sites-2026-04-21.md)
- Pattern source (this repo): `scripts/sync-coverage-matrix.sh`, `src/data/coverage-matrix.json`, `AGENTS.md`
- Target tag: `v0.2.0` (commit `83bf0fd`) in `brettdavies/agentnative`
- Related repos: `brettdavies/agentnative` (upstream), `brettdavies/agentnative-cli` (sibling commit-a-copy consumer —
  see its own plan at
  [`agentnative-cli/docs/plans/2026-04-23-001-feat-spec-vendor-plan.md`](https://github.com/brettdavies/agentnative-cli/blob/dev/docs/plans/2026-04-23-001-feat-spec-vendor-plan.md))
