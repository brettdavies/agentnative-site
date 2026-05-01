---
title: "feat: sync-spec.sh — commit-a-copy vendoring of principles + VERSION + CHANGELOG"
type: feat
status: completed
date: 2026-04-23
last-revised: 2026-05-01
shipped_in: PR #64 squash-merged to `dev` 2026-05-01 06:58 UTC as commit `bdf0c91`. NOT YET on `main`/anc.dev — pending the next `release/<YYYY-MM-DD>-<slug>` cut.
parents:
  - https://github.com/brettdavies/agentnative/blob/dev/docs/plans/2026-04-22-002-post-frontmatter-roadmap.md
roadmap-item: 5 (spec-repo roadmap 002, item 4)
---

# feat: sync-spec.sh — commit-a-copy vendoring of principles + VERSION + CHANGELOG

> **Implementation status (2026-05-01): SHIPPED to `dev` via PR #64 (`bdf0c91`).** All four units landed; the design
> shifted mid-execution from "one SPEC_VERSION feeding all surfaces" to a **three-source spec-version model** that
> separates vendoring (we got a snapshot) from scoring (anc was compiled against this spec) from site reconciliation
> (the prose has been updated to match). The shipped surface map:
>
> | Surface             | Source                                                 | Constant / file                                                              |
> | ------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
> | Site footer         | site reconciliation marker                             | `SITE_SPEC_VERSION` ← `content/principles/VERSION` (manual bump)             |
> | Per-tool badge SVGs | scoring context                                        | each scorecard's own `spec_version` field (passed to `renderBadgeSvg`)       |
> | OG card             | anc's compiled-in spec                                 | `scripts/og/generate.ts` reads `anc-v*.json`'s `spec_version`                |
> | (no surface)        | vendored snapshot — reference / diff target only       | `SPEC_VERSION` ← `src/data/spec/VERSION` (auto-bumped by `sync-spec.sh`)     |
>
> Units shipped (commits on `feat/sync-spec` before squash):
>
> - **U1 + U2** (commit `51021f2`) — `scripts/sync-spec.sh` (cli reference impl mirror; remote-first; AGENTS.md
>   filter; shellcheck-clean) + initial vendored `src/data/spec/{VERSION=0.3.0, CHANGELOG.md, principles/p1..p7.md}`
>   - `src/data/spec/README.md` + lint exclusion + regression-test fix.
> - **U3** (commit `11eca00`) — AGENTS.md paragraph + `scripts/SYNCS.md` (mermaid map; docker-image scoring as the
>   canonical source-of-truth; runtime-distribution section dropped per scope decision).
> - **U4** (commit `7e5765d`) — `util.mjs` exports `SPEC_VERSION` + `SITE_SPEC_VERSION`; `shell.mjs:190` footer reads
>   `SITE_SPEC_VERSION`; `build.mjs:377` passes `scorecard.spec_version` per badge call; `scripts/og/generate.ts`
>   reads anc's self-scorecard's `spec_version` (drops the regex-from-shell.mjs hack); `content/principles/VERSION`
>   created at `0.3.0`; `tests/build.test.ts` footer-renders-vendored-version assertion; OG image regenerated.
>
> Cross-repo doc updates landed in parallel: `solutions-docs/best-practices/agentnative-version-model-2026-05-01.md`
> (commits `bf83c71` initial, `47c84b2` mermaid, `7201181` three-source refresh). Sibling SYNCS docs in
> `agentnative-{spec,cli,skill}` got mermaid additions but stay locally untracked per the do-not-commit directive.
>
> **Promotion to `anc.dev`** is pending the next `release/<YYYY-MM-DD>-<slug>` cut per RELEASES.md. Until then,
> `bdf0c91` is on dev / staging Worker only.
>
> **Follow-up captured**: P0 todo `019-pending-p0-remove-skill-sha-pinning.md` (gitignored under
> `.context/compound-engineering/todos/`) — agentnative-skill PR #11 (commit `3c3ebb6`, 2026-04-29) deprecated
> SHA-pinning across the skill repo's shipping content; this site repo is the lagging consumer (still validates
> `source.commit` in `src/build/skill.mjs`).

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

- R1. A single script `scripts/sync-spec.sh` copies the three artifacts from `agentnative-spec` into this repo.
  Remote-first with local-checkout fallback (mirrors cli's reference impl); accepts `SPEC_REMOTE_URL` and `SPEC_ROOT`
  env vars.
- R2. Destination is `src/data/spec/` (parallel to `src/data/coverage-matrix.json`); vendored files are committed.
- R3. `content/principles/` is untouched — the site's human-written principle copy remains the SoT for rendered pages.
- R4. The initial commit pins against the **v0.3.0 tag (spec commit `5cea8bf`)** so the first vendored state is a real
  release, not a transient SHA. (Was v0.2.0 / `83bf0fd` when the plan was filed; spec has shipped two minor releases
  since.)
- R5. Operational guidance is documented alongside the existing `sync-coverage-matrix.sh` — same voice, same header
  comment pattern, env vars (`SPEC_REMOTE_URL`, `SPEC_ROOT`, `SPEC_REF`) with sensible defaults. Integrates with the
  existing `scripts/SYNCS.md` (untracked from the 2026-05-01 cross-repo sync-doc audit) by adding a row to the upstream
  table; doesn't create a parallel doc.
- R6. No CI enforcement of freshness on the site side — the spec repo's own `scripts/hooks/pre-push` already keeps the
  vendored sources honest; consumer-side drift is inspected via `git diff` after `sync-spec.sh` runs (matches the
  existing `sync-coverage-matrix.sh` operational model).
- **R7 (NEW 2026-05-01).** `src/build/util.mjs` reads `SPEC_VERSION` from vendored `src/data/spec/VERSION` at module
  load (replaces the hardcoded `'0.3.0'`). Site footer (`src/build/shell.mjs:190`) renders `v${SPEC_VERSION}` (replaces
  hardcoded `<span>v0.1.0</span>`). OG generator (`scripts/og/generate.ts`) imports `SPEC_VERSION` from util.mjs
  (replaces the regex-grep-from-shell.mjs pattern). Net effect: prod footer + OG card auto-track the vendored spec
  version; the only place the spec version literal still lives in source is `src/data/spec/VERSION` itself.

## Scope Boundaries

- **In scope as of 2026-05-01**: footer + OG card wiring (U4) — the visible-on-prod symptom that motivates picking up
  this plan. Originally deferred when the plan was filed; promoted in because shipping the data without wiring the
  most-visible consumer leaves a launch-day footer drift unfixed.
- No change to `content/principles/*.md` — still human-written, still authoritative for the rendered principle pages.
  The site's manual principle copy and the vendored spec copy coexist intentionally per the plan's original design.
- No change to `/about` page or `/llms.txt` preamble — those have other version surfaces that may benefit from the
  vendored read but aren't blocking and aren't visible-on-prod stale.
- No CI automation / GitHub Actions workflow to auto-run the sync. Spec's `repository_dispatch:spec-release` event
  already fires (verified in spec's `.github/workflows/publish.yml` 2026-05-01); wiring a consumer-side handler that
  auto-PRs the re-vendor is separate follow-up work.
- No migration of `/changelog` page away from its current hand-written `content/changelog.md`. Whether to replace that
  with a vendored read of `src/data/spec/CHANGELOG.md` is a separate design decision.

### Deferred to Follow-Up Work

- Regenerating `/llms-full.txt` from `src/data/spec/principles/*.md` at build time: separate follow-up.
- Wiring `/about` page version display to vendored `SPEC_VERSION`: separate follow-up if `/about` ever surfaces a spec
  version (currently doesn't).
- Replacing `content/changelog.md` with a vendored read of `src/data/spec/CHANGELOG.md`: separate follow-up if ever
  chosen; current manual approach is not blocked.
- **Consumer-side `spec-release` handler** that opens a PR when spec publishes a new tag: source-side dispatch is
  already firing (per spec's `publish.yml`); a `.github/workflows/spec-release-handler.yml` in this repo would
  `repository_dispatch`-listen, run `sync-spec.sh`, and open a PR with the vendored diff. Worth doing once manual
  re-vendor friction shows up; not worth doing pre-emptively.

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
├── AGENTS.md                         (MODIFIED — U3 paragraph)
├── scripts/
│   ├── sync-coverage-matrix.sh       (existing, unchanged)
│   ├── sync-spec.sh                  (NEW — U1)
│   └── SYNCS.md                      (TRACKED — was untracked from 2026-05-01 audit; U3 adds sync-spec row)
├── src/
│   ├── build/
│   │   ├── util.mjs                  (MODIFIED — U4: SPEC_VERSION reads vendored file)
│   │   └── shell.mjs                 (MODIFIED — U4: footer renders v${SPEC_VERSION})
│   └── data/
│       ├── coverage-matrix.json      (existing, unchanged)
│       └── spec/                     (NEW — U2)
│           ├── VERSION
│           ├── CHANGELOG.md
│           └── principles/
│               ├── p1-non-interactive-by-default.md
│               ├── p2-structured-parseable-output.md
│               ├── p3-progressive-help-discovery.md
│               ├── p4-fail-fast-actionable-errors.md
│               ├── p5-safe-retries-mutation-boundaries.md
│               ├── p6-composable-predictable-command-structure.md
│               └── p7-bounded-high-signal-responses.md
├── scripts/og/generate.ts            (MODIFIED — U4: imports SPEC_VERSION from util.mjs, drops shell.mjs regex)
└── public/og-image.png               (REGENERATED — U4: card now shows v0.3.0)
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

- Env vars (mirrors cli's reference impl):
- `SPEC_REMOTE_URL` (default `https://github.com/brettdavies/agentnative.git`) — remote URL queried first. Lets the
  script work on a machine without a local spec checkout.
- `SPEC_ROOT` (default `$HOME/dev/agentnative-spec`) — local checkout used as fallback when the remote is unreachable.
- `SPEC_REF` (default `v0.3.0`) — tag or SHA to vendor. Future syncs override: `SPEC_REF=v0.3.1 ./scripts/sync-spec.sh`.
- Resolution flow (remote-first with offline fallback):
- Try `git ls-remote --tags "$SPEC_REMOTE_URL" "$SPEC_REF"`; if reachable, shallow-clone into a temp dir at that ref and
  run extraction from there.
- If the remote is unreachable, fall back to `SPEC_ROOT` and run extraction from the local object store via `git show`.
- Cleanup hook (`trap`) removes the temp clone on exit.
- Validation gates:
- (Remote mode) `git ls-remote` succeeds, ref exists.
- (Local mode) `SPEC_ROOT` is a git repo (else: print path + remediation, exit 1).
- (Both) `SPEC_REF` resolves to a commit (else: suggest `git fetch --tags`, exit 1).
- (Both) `principles/` exists at `SPEC_REF` (else: error citing the ref, exit 1).
- Resolved-SHA echo: `git rev-parse --short=7 "$SPEC_REF^{commit}"` printed before extraction so the operator sees the
  exact vendored content. Mode (remote vs local) printed alongside.
- Extraction (three artifacts, all via `git show`):
- `git show "$SPEC_REF:VERSION" >src/data/spec/VERSION`
- `git show "$SPEC_REF:CHANGELOG.md" >src/data/spec/CHANGELOG.md`
- Enumerate principle files at the ref via `git ls-tree --name-only "$SPEC_REF" principles/`, **filter to `p*.md` only**
  (skips `principles/AGENTS.md` which is spec-side design context, not consumed by the site), then `git show
  "$SPEC_REF:<path>" >src/data/spec/principles/<basename>` per match.
- `mkdir -p src/data/spec/principles` before extraction so first-run works.
- `set -euo pipefail`, SCRIPT_DIR + SITE_ROOT resolution per local convention.
- `chmod +x scripts/sync-spec.sh` after creation.
- Closing line mirrors the CLI script: `echo "next: review \`git diff\` for unexpected changes, then commit."`

**Patterns to follow:**

- `scripts/sync-coverage-matrix.sh` — structure, voice, header comment style.

**Test scenarios:**

- Happy path (remote-first): with default `SPEC_REMOTE_URL` reachable, running the script with `SPEC_REF=v0.3.0` creates
  `src/data/spec/VERSION` containing `0.3.0`, `src/data/spec/CHANGELOG.md` matching the spec repo's file byte-for-byte
  at v0.3.0, and seven `src/data/spec/principles/p*.md` files matching the spec principles byte-for-byte.
  `principles/AGENTS.md` from the spec repo is NOT vendored (filter applies).
- Happy path (local fallback): with `SPEC_REMOTE_URL=http://0.0.0.0:1` (unreachable) and
  `SPEC_ROOT=$HOME/dev/agentnative-spec` at tag `v0.3.0`, the script falls back to the local checkout and produces the
  same output tree.
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

- `./scripts/sync-spec.sh` runs clean against the default remote at `SPEC_REF=v0.3.0`; produces the expected file tree
  under `src/data/spec/`.
- `./scripts/sync-spec.sh` also runs clean in offline mode (remote unreachable) when `SPEC_ROOT` points at a local
  checkout with v0.3.0 fetched.
- `git diff src/data/spec/` after sync shows only the initial addition (no unrelated changes).
- `shellcheck scripts/sync-spec.sh` passes (matching whatever shellcheck discipline this repo applies to
  `sync-coverage-matrix.sh`).

---

- [ ] U2. **Initial commit of vendored artifacts at v0.3.0**

**Goal:** Run the script against the v0.3.0 spec ref and commit the resulting vendored state.

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

- From this repo, run `./scripts/sync-spec.sh` with default `SPEC_REF=v0.3.0`. The script handles ref resolution itself;
  no need to pre-checkout the spec repo to a tag.
- Commit the resulting tree with message: `feat(spec): vendor spec v0.3.0 via sync-spec.sh (spec@5cea8bf)`.
- PR body's `## Changelog` section notes: "Added: `src/data/spec/` — vendored spec artifacts from agentnative-spec
  v0.3.0 (`spec@5cea8bf`). See `scripts/sync-spec.sh` for resync instructions."

**Patterns to follow:**

- `CHANGELOG convention` from global CLAUDE.md: user-facing changes in `## Changelog` body section; refactors/internal
  go elsewhere.

**Test scenarios:**

- Happy path: `VERSION` reads `0.3.0`, `CHANGELOG.md`'s latest entry corresponds to v0.3.0, principles frontmatter
  matches the spec repo byte-for-byte at v0.3.0.
- Integration: `bun run lint` (markdownlint-cli2) passes on the vendored files. If this repo's markdownlint config is
  stricter than the spec repo's, vendored files could fail; in that case, add an exclusion for `src/data/spec/` rather
  than editing vendored content. (Same pattern as `docs/research/` and `docs/plans/` exclusions in `package.json`.)

**Verification:**

- `git log --oneline src/data/spec/` shows a single initial commit.
- `cat src/data/spec/VERSION` outputs `0.3.0`.
- `diff -r src/data/spec/principles/ <(ls ~/dev/agentnative-spec/principles/p*.md)` accounting for the
  `principles/AGENTS.md` filter — vendored set is exactly the 7 `p*.md` files, nothing else.

---

- [ ] U3. **Document the sync workflow**

**Goal:** Readers of this repo know when and how to resync; cross-repo version model is discoverable.

**Requirements:** R5

**Dependencies:** U1

**Files:**

- Modify: `scripts/sync-spec.sh` header comment — same shape as cli's reference impl; explicitly call out the three
  artifacts and the spec-side release-notification workflow.
- Modify: `scripts/SYNCS.md` (currently untracked from the 2026-05-01 cross-repo sync-doc audit; to be committed as part
  of this PR) — add a row for `sync-spec.sh` in the Upstream table; update the SPEC_VERSION drift-check column now that
  the hardcode is gone; cross-link the version-model solution doc.
- Modify: `AGENTS.md` — the existing block about `content/principles/` being manually-authored gets a sibling paragraph
  pointing at `src/data/spec/` as the vendored, machine-readable mirror used for build-time derivatives. Clarifies that
  the two paths coexist intentionally and points at the version-model doc.

**Approach:**

- Header comment template (mirrors cli's `sync-spec.sh`):

  ```bash
  # Sync the spec artifacts (principles + VERSION + CHANGELOG) from the agentnative-spec repo.
  #
  # Source of truth: brettdavies/agentnative
  # Generated by:   human authorship (principles/*.md frontmatter + prose), spec repo's release
  #                 workflow (VERSION bump + CHANGELOG regeneration via cliff.toml).
  #
  # Resolves SPEC_REF (default v0.3.0) against SPEC_REMOTE_URL first, then falls back to a
  # local checkout at SPEC_ROOT. Extracts via `git show <ref>:<path>` so neither the remote
  # nor the local checkout's working tree is perturbed.
  #
  # Resync cadence: rerun after every new agentnative-spec tag. The spec repo's
  # repository_dispatch:spec-release event already fires to this repo on tag publish — a
  # consumer-side handler that auto-PRs the resync is tracked as follow-up work.
  ```

- `scripts/SYNCS.md` row addition (Upstream table):

  ```markdown
  | brettdavies/agentnative-spec @ pinned tag | `scripts/sync-spec.sh` (manual; remote-first with local fallback) | `principles/p*-*.md` + `VERSION` + `CHANGELOG.md` → `src/data/spec/` | On spec release; consumed by `src/build/util.mjs` (SPEC_VERSION) and the footer/OG card | Site fails fast at build time if `src/data/spec/VERSION` is missing |
  ```

  Also: update the existing row that mentions hardcoded SPEC_VERSION (Upstream `agentnative-spec PLANNED` → flip to
  shipped, point at the new vendored read).

- AGENTS.md paragraph: short. 3-4 sentences. "As of 2026-05-01 the site vendors three spec artifacts at `src/data/spec/`
  via `scripts/sync-spec.sh`. This is a build-time data mirror, not a content mirror — `content/principles/` is still
  human-written site copy, and the two evolve independently. When the spec cuts a new tag, rerun `sync-spec.sh` and open
  a PR. See
  [`docs/solutions/best-practices/agentnative-version-model-2026-05-01.md`](https://github.com/brettdavies/solutions-docs/blob/main/best-practices/agentnative-version-model-2026-05-01.md)
  for the cross-repo version model and
  [`cross-repo-artifact-consumption-static-sites-2026-04-21.md`](https://github.com/brettdavies/solutions-docs/blob/main/best-practices/cross-repo-artifact-consumption-static-sites-2026-04-21.md)
  for the governing vendoring pattern."

**Patterns to follow:**

- Existing AGENTS.md voice: direct, named paths, cross-references to authoritative docs.
- cli's `scripts/sync-spec.sh` header comment shape (already serves as the working reference).
- Existing `scripts/SYNCS.md` table format (don't reinvent — add a row, don't reshape the doc).

**Test scenarios:**

- Happy path: a reader opening this repo cold can find `sync-spec.sh`, read its header, and understand what it vendors
  and when to rerun it.
- Secondary: the AGENTS.md paragraph resolves the "why is there both `content/principles/` and
  `src/data/spec/principles/`" question without requiring further reading; pointer to the version-model doc resolves "is
  the site versioned?" before it gets asked.
- `scripts/SYNCS.md` is the single map a reviewer reaches for to see what flows in and out of this repo.

**Verification:**

- Another agent or collaborator opening this repo fresh can answer "what does `sync-spec.sh` do, why does it exist, and
  when do I run it?" without asking.
- Same agent can answer "does the site have its own version?" by following the AGENTS.md → version-model-doc link chain.

---

- [ ] U4. **Wire `SPEC_VERSION` to vendored read; fix footer + OG card staleness**

**Goal:** Eliminate the v0.1.0-on-prod footer drift by making `SPEC_VERSION` read from the vendored `VERSION` file and
threading it through the footer + OG card. Source-of-truth for the site's spec version is now exactly one file:
`src/data/spec/VERSION`.

**Requirements:** R7

**Dependencies:** U2 (vendored file must exist before util.mjs reads it)

**Files:**

- Modify: `src/build/util.mjs:81` — replace hardcoded `export const SPEC_VERSION = '0.3.0';` with a build-time read of
  `src/data/spec/VERSION` (fail-fast if the file is missing — surface a clear error pointing at `sync-spec.sh`).
- Modify: `src/build/shell.mjs` — import `SPEC_VERSION` from util.mjs; replace `<span>v0.1.0</span>` at line 190 with
  `<span>v${SPEC_VERSION}</span>`.
- Modify: `scripts/og/generate.ts` — replace the `readVersion()` regex-from-shell.mjs pattern (lines 38-51) with a
  direct `import { SPEC_VERSION } from '../../src/build/util.mjs'`. Removes a brittle regex that breaks the moment
  shell.mjs's literal becomes a template.
- Regenerate: `public/og-image.png` — the version literal on the card changes from `v0.1.0` to `v0.3.0`. Run `bun run
  og` after the wiring lands; commit the new PNG.

**Approach:**

- **util.mjs read pattern**: at module load (top-level), read `src/data/spec/VERSION` synchronously via `readFileSync`.
  Throw a clear error if the file is missing — directs the operator to run `./scripts/sync-spec.sh`. Trim whitespace.
  Export `SPEC_VERSION` as a string constant exactly as the previous hardcode did, so existing consumers
  (`src/build/badge.mjs:13`) need no change.

  ```js
  // src/build/util.mjs (replaces line 81)
  import { readFileSync } from 'node:fs';
  import { join, dirname } from 'node:path';
  import { fileURLToPath } from 'node:url';

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const SPEC_VERSION_PATH = join(__dirname, '..', 'data', 'spec', 'VERSION');
  let _specVersion;
  try {
    _specVersion = readFileSync(SPEC_VERSION_PATH, 'utf8').trim();
  } catch (err) {
    throw new Error(
      `Could not read ${SPEC_VERSION_PATH}: ${err.message}\n` +
      `Run ./scripts/sync-spec.sh to vendor the spec, then retry.`
    );
  }
  export const SPEC_VERSION = _specVersion;
  ```

- **shell.mjs footer change**: import `SPEC_VERSION` at the top of the module (alongside other imports). Replace the
  literal in the footer template string. No other shell.mjs changes — the OG card alt text and JSON-LD don't reference
  the version.

- **OG generator refactor**: `scripts/og/generate.ts` currently reads shell.mjs source via `readFile` + regex match.
  Replace with a direct import of `SPEC_VERSION` from util.mjs. Drop the `readVersion()` function and `SHELL_MJS`
  constant entirely. The OG HTML's `data-version` injection still happens (Playwright `page.evaluate`); only the source
  of the version string changes.

  Note: util.mjs is `.mjs` — TypeScript can import it via `.mjs` extension; ensure `tsconfig.json`'s
  `allowImportingTsExtensions` / `moduleResolution` settings tolerate this. If they don't, fall back to reading
  `src/data/spec/VERSION` directly from the OG generator (same source, separate read — acceptable since both code
  paths fail fast on missing file).

- **OG image regen**: after the wiring change, the rendered card displays `v0.3.0`. Run `bun run og` and commit the new
  `public/og-image.png`. The build's deterministic-output guarantee means re-running the generator on the same vendored
  VERSION yields byte-identical output.

**Patterns to follow:**

- `src/build/badge.mjs:13` — already imports `SPEC_VERSION` from util.mjs and consumes it for badge URLs. Same pattern,
  applied to two more consumers.
- `src/build/assets.mjs` — fail-fast file-read pattern with operator-friendly error message (the foundation.css
  byte-equivalence check is the closest precedent).

**Test scenarios:**

- Happy path: `bun run build` succeeds; emitted homepage HTML contains `<span>v0.3.0</span>` in the footer (not
  `v0.1.0`); emitted OG card shows `v0.3.0`; `tests/build.test.ts` updated to assert footer renders the vendored
  version.
- Error path: if `src/data/spec/VERSION` is deleted, `bun run build` fails fast with the operator-friendly error
  pointing at `sync-spec.sh`. Add a regression test that mocks the missing file and asserts the error message.
- Integration: `bun run og` produces a card containing `v0.3.0`; sha256 of the resulting PNG is recorded in the commit
  so future regressions are visible.
- Update existing tests that may have asserted `v0.1.0` literally — search `tests/` for the string.

**Verification:**

- `curl -s https://anc.dev/ | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+'` returns `v0.3.0` (post-deploy).
- `curl -s -o /tmp/og.png https://anc.dev/og-image.png && file /tmp/og.png` shows expected PNG; visual inspection shows
  v0.3.0.
- Bumping `src/data/spec/VERSION` to a hypothetical `0.3.1` (without re-running sync-spec.sh) and rebuilding shows the
  footer flips to `v0.3.1` — confirms the file is the source of truth, not any cached constant.

---

## System-Wide Impact

- **Interaction graph (after U4):** `src/data/spec/VERSION` → `src/build/util.mjs` (read at module load) →
  `src/build/badge.mjs` (badge URLs, already wired) + `src/build/shell.mjs` (footer, NEW) + `scripts/og/generate.ts` (OG
  card injection, NEW). Future consumers (`/llms-full.txt` regen, `/about` version display) will extend this graph
  through the same util.mjs entry point.
- **API surface parity:** The shields.io badge endpoint (spec roadmap 002, item 2) and the coupled-release protocol in
  `brettdavies/agentnative:CONTRIBUTING.md` both assume the site can cite a spec version. This plan makes that citation
  mechanical rather than manual; after U4, the citation is also visible-on-prod (footer + OG card).
- **Integration coverage:** No automated integration test for the script itself — this is a one-off vendoring tool, not
  a live integration. `sync-coverage-matrix.sh` doesn't have tests either; operational model is "run, diff, PR, review."
  U4's wiring DOES get test coverage in `tests/build.test.ts` (footer renders vendored version) and
  `tests/regression.test.ts` (missing-VERSION-file fail-fast).
- **Unchanged invariants:**
- `content/principles/*.md` — still human-written, still the SoT for rendered principle pages.
- `content/changelog.md` — still hand-written (replacement is follow-up work, out of scope here).
- `scripts/sync-coverage-matrix.sh` — untouched.
- Cloudflare Worker routing, CommonMark rendering, llms.txt endpoints — untouched.
- `SUPPORTED_SCHEMA_VERSION` in `src/build/scorecards.mjs:21` — untouched. That's a separate version concept (CLI's
  scorecard schema) and lives at its own cadence.

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
  (mark shipped with PR link + vendored spec version `0.3.0`).
- The spec repo's `repository_dispatch:spec-release` event already fires to this repo on tag publish (verified
  2026-05-01 in spec's `.github/workflows/publish.yml`). Follow-up work to add a consumer-side handler that auto-PRs the
  resync is tracked under "Deferred to Follow-Up Work" above.
- Any future follow-up that consumes `src/data/spec/` (e.g., `/llms-full.txt` regen, `/about` version surface) files its
  own plan here and cross-references this one.
- If the spec repo ever changes `principles/` layout (sub-folders, additional non-`p*.md` files), reconsider U1's
  `p*.md`-only filter — that's a revisit trigger, not a failure to anticipate now.

## Sources & References

- **Parent roadmap (spec repo):**
  [`2026-04-22-002-post-frontmatter-roadmap.md`](https://github.com/brettdavies/agentnative/blob/dev/docs/plans/2026-04-22-002-post-frontmatter-roadmap.md),
  item 4
- **Cross-repo version model (canonical, single source of truth):**
  [`docs/solutions/best-practices/agentnative-version-model-2026-05-01.md`](../../docs/solutions/best-practices/agentnative-version-model-2026-05-01.md)
  — what version means in each of the four agentnative repos, why the site has no own version, where each version is
  read or displayed.
- Pattern source (cross-repo):
  [`docs/solutions/best-practices/cross-repo-artifact-consumption-static-sites-2026-04-21.md`](../../docs/solutions/best-practices/cross-repo-artifact-consumption-static-sites-2026-04-21.md)
- Pattern source (this repo): `scripts/sync-coverage-matrix.sh`, `src/data/coverage-matrix.json`, `AGENTS.md`,
  `scripts/SYNCS.md` (untracked from 2026-05-01 sync-doc audit; commits as part of this PR via U3).
- **Target tag**: `v0.3.0` (spec commit `5cea8bf`, released 2026-04-29) in `brettdavies/agentnative`. Was v0.2.0 /
  `83bf0fd` when this plan was filed; spec has shipped two minor releases since.
- **Reference impl (cli, shipped)**: `~/dev/agentnative-cli/scripts/sync-spec.sh` plus its plan at
  [`agentnative-cli/docs/plans/2026-04-23-001-feat-spec-vendor-plan.md`](https://github.com/brettdavies/agentnative-cli/blob/dev/docs/plans/2026-04-23-001-feat-spec-vendor-plan.md)
  (status: completed). Site's sync-spec.sh adopts cli's shape directly.
- **Reference impl (skill, shipped)**: `~/dev/agentnative-skill/scripts/sync-spec.sh` — near-identical mirror of cli's,
  only `DEST_DIR` differs.
- **Cross-repo SYNCS docs (written 2026-05-01, untracked)**:
- `~/dev/agentnative-spec/docs/syncs.md`
- `~/dev/agentnative-cli/scripts/SYNCS.md`
- `~/dev/agentnative-skill/docs/SYNCS.md`
- `~/dev/agentnative-site/scripts/SYNCS.md`
- Related repos: `brettdavies/agentnative` (upstream spec), `brettdavies/agentnative-cli` (sibling vendoring consumer),
  `brettdavies/agentnative-skill` (sibling vendoring consumer).
