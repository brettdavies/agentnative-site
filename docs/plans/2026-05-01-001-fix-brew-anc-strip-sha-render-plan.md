---
title: Brew-install anc in scoring image and strip commit-SHA render
type: fix
status: completed
date: 2026-05-01
---

# Brew-install anc in scoring image and strip commit-SHA render

## Summary

Replace the `cargo build --release` + `COPY` path for `anc` in the scoring image with `brew install
brettdavies/tap/agentnative`, and strip the abbreviated commit-SHA link from per-tool scorecard render (HTML and
markdown twin). Existing scorecards stay as-is — the wrong-SHA link surface disappears at the render layer.

---

## Problem Frame

`docker/score/build.sh` currently builds `anc` from the operator's local `agentnative-cli` checkout via `cargo build
--release`, then stages the binary into the docker build context. Whatever branch the local checkout was on is what
`build.rs` bakes into `ANC_COMMIT` — so the last scoring run produced 96 scorecards whose `anc.commit = '06a307c'`
points to a `dev`-branch docs commit on the CLI repo, not the v0.2.0 release tag (`01b3552`). The per-tool scorecard
pages render that wrong SHA as a clickable link to a misleading commit page.

Two corrections in one branch: align the docker image with how every other registry tool installs (brew, prebuilt-only,
release-derived), and stop rendering the SHA link entirely so today's bad data and any future build-time drift never
surface to a viewer. The JSON-schema field stays for now; a future scorecard schema revision drops it.

---

## Requirements

- R1. The scoring image installs `anc` from a published release artifact, not from a working-tree compile of the
  operator's local CLI checkout.
- R2. Per-tool scorecard pages (HTML and markdown twin) render `anc.version` only — no abbreviated commit link.
- R3. The 96 existing scorecards in `scorecards/` are not regenerated as part of this change. Their incorrect
  `anc.commit` values stay in the JSON; the render layer ignores them.
- R4. The `anc.commit` field remains in the scorecard JSON schema (`content/scorecard-schema.md`); its removal is
  explicitly deferred to a future schema revision.
- R5. No changes to `agentnative-cli` (build.rs, registry, or tap formula) ship as part of this branch.

---

## Scope Boundaries

- Regenerating any of the 96 existing scorecards (per user's "no need to regen at this point").
- Removing the `anc.commit` field from the JSON schema or `build.rs`.
- Cross-repo coordination — single-repo PR.
- Anc CLI version detection / version pinning logic in `build.rs`.
- Site footer, OG card, badge SVG, or skill surface changes.

### Deferred to Follow-Up Work

- Removing `anc.commit` from the scorecard JSON schema entirely — folded into a future scorecard-schema revision (e.g.,
  schema 0.5 → 0.6 cycle), where the field is dropped from emit + invariant + schema doc together.

---

## Context & Research

### Relevant Code and Patterns

- `docker/score/Dockerfile` lines 79-99 — Linuxbrew bootstrap + brew installs of `uv`, `cargo-binstall`, `bun`, `yq`,
  `jaq`. New brew install for `anc` slots into this section using the same pattern as `oven-sh/bun/bun` (taps the
  external formula via fully-qualified `tap/formula` spec, no manual `brew tap` required).
- `docker/score/Dockerfile` lines 102-109 — current `COPY docker/score/anc` + `chmod +x` block that disappears.
- `docker/score/build.sh` lines 33-44 — `cargo build --release` + binary-stage steps that disappear.
- `src/build/scorecards-render.mjs` lines 31-83 — `renderAncBuildHtml` and `renderAncBuildMarkdown` are the two render
  paths. Both gate the link on `ANC_COMMIT_SHA_RE` (regex line 36). The version-only return path is already the
  fallback; this change makes it the only path.
- `src/build/scorecards-render.mjs` lines 543, 699 — call sites that consume the render functions and emit the `<dt>Anc
  build</dt><dd>...</dd>` row + the markdown `**Anc build:**` line.
- `tests/build.test.ts` lines 1933-1964 — three render tests: link-on-hex, skip-on-null, skip-on-bad-SHA. Two get
  deleted, one gets reframed.
- `content/install.md` line 10 — canonical `brew install brettdavies/tap/agentnative` command, mirrored into the
  Dockerfile.
- `.gitignore` line 28 — `/docker/score/anc` is already ignored, so removing the staging step means the binary file
  stops getting created locally. No `git rm` needed.

### Institutional Learnings

- `docs/solutions/best-practices/agentnative-version-model-2026-05-01.md` — cross-repo version model. Notes that
  per-scorecard `spec_version` "tracks the `anc` binary's compiled-in spec at score time." Brewing `anc` shifts the
  source of truth from the operator's local checkout to the published release; this is the correct direction per the
  document's framing of release-derived artifacts.
- Prior commit on this branch's predecessor (`chore/remove-skill-sha-pinning`, merged earlier today): the broader theme
  of removing dead SHA-pin ceremony is established. This plan continues the pattern in the scorecard surface.

### External References

- `brettdavies/homebrew-tap` Formula/agentnative.rb — verified Linux x86_64 bottle published for v0.2.0 (`x86_64_linux:
  "4cf8b6dd..."`); satisfies the Dockerfile's "NO COMPILING — prebuilt installs only" constraint.

---

## Key Technical Decisions

- **Use `brew install` for `anc` (not `gh release download` or another tarball path).** Linuxbrew is already the
  heaviest layer in the image (lines 79-83) and every other registry tool already installs via brew. Adding `anc` reuses
  an existing layer instead of introducing a new install mechanism, and matches what users actually run (`brew install
  brettdavies/tap/agentnative` is the canonical install per `content/install.md`).
- **Don't regenerate the 96 existing scorecards in this PR.** The render-layer scrub is sufficient to fix the
  user-visible bug. Future scorecards (when `docker/score/build.sh --run` is next invoked against the brewed image) will
  have `anc.commit: null` automatically because the brew cellar is not a git checkout — `build.rs` already handles that
  path (`released-from-tarball case`). No CLI-side change required.
- **Keep `anc.commit` in the schema doc with a "captured but not surfaced" note.** Schema-doc accuracy survives the
  divergence between captured-field and rendered-surface, and future readers see why the field is dormant rather than
  inferring a bug.
- **Drop the SHA-shape regex and XSS-defense test alongside the link path.** `ANC_COMMIT_SHA_RE` and `ANC_REPO_URL`
  exist solely to gate the link's URL construction. Once the link is gone, both go with it. The
  `<script>alert(1)</script>` defense test is checking a URL-construction path that no longer exists; keeping it would
  assert behavior of dead code.

---

## Open Questions

### Resolved During Planning

- "Drop the orphaned regex / constants?" — Yes. `ANC_COMMIT_SHA_RE`, `ANC_REPO_URL`, and the `.anc-build__commit` class
  attribute have no consumer once the link is gone. (CSS check confirmed no stylesheet rule references the class.)
- "Update the scorecard-schema doc?" — Yes, single-sentence note in the `commit` row to prevent docs drift.
- "Delete `docker/score/build.sh` or simplify it?" — Simplify, don't delete. The script still has value as the canonical
  "build the image" + optional `--run` wrapper that creates `docker/score/out/` before mounting. The cargo-build
  preamble disappears, but the `docker compose build` + `--run` paths stay.

### Deferred to Implementation

- Whether to keep the `ANC_CLI_ROOT` env var as an unused vestige in `build.sh` for backward compatibility with anyone
  who might be invoking the script with that env set, or remove it. (Implementer's call — leans toward removal since the
  script no longer reads any CLI checkout.)

---

## Implementation Units

- U1. **Brew-install `anc` in the scoring image**

**Goal:** Replace the `cargo build --release` + `COPY docker/score/anc` path with `brew install
brettdavies/tap/agentnative` in the Dockerfile, simplify `build.sh` accordingly. Brings `anc` to install parity with
every other tool already brewed in the image.

**Requirements:** R1, R5

**Dependencies:** None (Linuxbrew bottle for `agentnative` v0.2.0 is already published per the tap formula).

**Files:**

- Modify: `docker/score/Dockerfile`
- Modify: `docker/score/build.sh`

**Approach:**

- In `Dockerfile`, add `brew install brettdavies/tap/agentnative` to the brew-installs section (alongside `uv`,
  `cargo-binstall`, `bun`, etc.) using the same `--mount=type=cache` pattern. Use the fully-qualified `tap/formula` spec
  so brew auto-taps `brettdavies/tap` without a separate `brew tap` step (mirrors the `oven-sh/bun/bun` line).
- Remove the `COPY --chown=runner:runner docker/score/anc /home/runner/.local/bin/anc` line and the immediately
  following `chmod +x` + `--version` smoke check. The brew install handles all three.
- Remove `/home/runner/.local/bin` from the `ENV PATH` line if it's only there for `anc` — verify by reading the current
  PATH set; uv tool install also drops binaries there, so the path stays.
- In `build.sh`, drop the `cargo build --release` invocation, the `ANC_BIN` resolution, and the `cp` staging line. Drop
  the `CLI_ROOT` resolution and the existence-check guard. The script collapses to: `docker compose -f
  docker/score/compose.yml build` plus the optional `--run` branch.
- Update the script's header comment to reflect the new shape (no longer "build anc from local CLI dev checkout").

**Patterns to follow:**

- The `brew install oven-sh/bun/bun` line in the Dockerfile (line 89) — fully-qualified tap/formula spec, cache mount on
  `/home/runner/.cache/Homebrew`, no separate `brew tap` step.

**Test scenarios:**

Test expectation: none — build-environment changes have no automated test surface in this repo. Manual verification via
the docker build + smoke-test below.

**Verification:**

- `docker compose -f docker/score/compose.yml build` completes successfully.
- Inside the container, `anc --version` resolves to a brewed binary path (e.g., `/home/linuxbrew/.linuxbrew/bin/anc`)
  rather than `/home/runner/.local/bin/anc`, and prints the released version.
- `docker/score/anc` is no longer created in the build context after running `build.sh` (the file is gitignored, but may
  exist locally from prior runs — confirm `build.sh` does not recreate it).
- A subsequent `docker/score/build.sh --run` produces scorecards with `anc.commit: null` (validation that the brew
  cellar's lack of `.git/` exercises the `released-from-tarball case` path in `build.rs`). This is observational, not a
  required acceptance step in this branch since R3 says we are not regenerating scorecards.

---

- U2. **Strip the commit-SHA link from per-tool scorecard render**

**Goal:** Simplify `renderAncBuildHtml` and `renderAncBuildMarkdown` to emit version-only. Remove orphaned helpers
(`ANC_COMMIT_SHA_RE`, `ANC_REPO_URL`) and the no-longer-needed XSS-defense test.

**Requirements:** R2

**Dependencies:** None — pure render-layer change, no coupling to U1.

**Files:**

- Modify: `src/build/scorecards-render.mjs`
- Modify: `tests/build.test.ts`

**Approach:**

- In `scorecards-render.mjs`, simplify `renderAncBuildHtml` to: return `null` when `anc?.version` is missing; otherwise
  return `escHtml(anc.version)`. Equivalent simplification for `renderAncBuildMarkdown`. The existing `<dt>Anc
  build</dt><dd>${ancBuild}</dd>` and `**Anc build:** ${ancBuildMd}` call sites at lines 543 and 699 need no change —
  they consume whatever the render function returns.
- Delete `ANC_COMMIT_SHA_RE`, `ANC_REPO_URL`, and the surrounding comment block (lines 31-37) — no remaining consumer.
- Delete the `anc-build__commit` class attribute occurrence (it lived in the link template; with the link gone, the
  class disappears). Verified no stylesheet rule references it.
- In `tests/build.test.ts`:
- Delete the `'Anc build links the commit when SHA is hex-shaped (7-40 chars)'` test (line 1933).
- Reframe the `'Anc build skips the commit link when commit is null'` test as `'Anc build renders version-only
  regardless of commit field shape'`. Cover happy + null + bad-shape inputs in a single concise test, asserting `<dt>Anc
  build</dt><dd>0.1.0</dd>` and the absence of `agentnative-cli/commit/`.
- Delete the standalone `'Anc build skips the commit link when SHA fails the hex allowlist (security)'` test (line 1952)
  — its assertions are absorbed into the reframed test above.

**Patterns to follow:**

- Existing `escHtml`-everywhere convention in this module (preserve `escHtml(anc.version)` even though the version field
  is producer-controlled — same posture as the rest of the file).
- Existing null-returning behavior when `anc` or `anc.version` is missing.

**Test scenarios:**

- Happy path: `anc: { version: '0.2.0', commit: 'abcdef0' }` renders `<dt>Anc build</dt><dd>0.2.0</dd>` with no
  `agentnative-cli/commit/` substring in the output. Markdown twin renders `**Anc build:** 0.2.0` with no parenthetical.
- Edge case: `anc: { version: '0.2.0', commit: null }` renders identical output to the happy path (no link, no
  parenthetical) — proves the function ignores the commit field entirely rather than special-casing null.
- Edge case: `anc: { version: '0.2.0', commit: '<script>alert(1)</script>' }` renders the same version-only output and
  contains no `<script>` substring — proves the field is never interpolated into HTML, regardless of shape.
- Error path: `anc: undefined` and `anc: { version: undefined }` both return null (or skip the row) — preserves the
  caller's gating behavior at lines 544 and 700 where `if (ancBuild)` decides whether to push the row.

**Verification:**

- `bun test` passes 100%.
- `bun run build` succeeds.
- `rg 'agentnative-cli/commit/' dist/` returns zero results (no scorecard page renders a commit link).
- `rg 'anc-build__commit' src/ dist/` returns zero results.
- Visual spot-check: open `dist/score/rg.html` in a browser; the "Anc build" row reads `0.1.0` (or whatever version was
  current when scorecards were last generated) with no link.

---

- U3. **Note the `anc.commit` field's render status in the scorecard-schema doc**

**Goal:** Update `content/scorecard-schema.md`'s description of the `anc.commit` field to note it is captured but not
currently surfaced on the rendered scorecard page, deferring removal to a future schema revision. Prevents documentation
drift between the JSON schema and the visible page.

**Requirements:** R4

**Dependencies:** U2 (so the doc note matches reality on the rendered surface).

**Files:**

- Modify: `content/scorecard-schema.md`

**Approach:**

- One-sentence addition to the `commit` row's Notes column (line 94) along the lines of: "Currently captured by
  `build.rs` but no longer surfaced on the rendered scorecard page; planned for removal in a future schema revision."
- Keep the existing description of capture mechanics intact — the note is additive, not replacement.

**Patterns to follow:**

- Existing in-line annotation style in the same table (e.g., the `null for cargo install-style builds` note).

**Test scenarios:**

Test expectation: none — pure documentation, no behavioral change.

**Verification:**

- `bun run build` succeeds (the page is content-driven; build emits `dist/scorecard-schema.html`).
- Manual review of the rendered `/scorecard-schema` page confirms the row reads correctly and the note is visible
  alongside the existing description.

---

## System-Wide Impact

- **Interaction graph:** None. The render functions are pure helpers, called only from `buildScorecardBody` (HTML) and
  the markdown twin builder. No callbacks, middleware, or event handlers fire.
- **Error propagation:** Unchanged. Both render functions preserve their `null`-on-missing-input behavior; callers
  continue to gate on `if (ancBuild)`.
- **State lifecycle risks:** None. No persistent state, no caches, no external services.
- **API surface parity:** None. The scorecard JSON schema is untouched (R4); the rendered HTML/markdown change is a
  display-only simplification.
- **Integration coverage:** Existing scorecards in `scorecards/` continue to validate against the same JSON-schema
  invariants in `tests/build.test.ts` (line 850, line 1094) — those tests cover the field's existence and null-ability,
  not its rendered surface, and require no change.
- **Unchanged invariants:** The `<dt>Anc build</dt><dd>...</dd>` row stays. The `**Anc build:**` markdown line stays.
  Both continue to render whenever `anc.version` is a string. Only the trailing link suffix is removed.

---

## Risks & Dependencies

| Risk                                                                                                     | Mitigation                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brew bottle for the latest `anc` release lags a tag publish; image build picks up an older anc.          | Acceptable — the bottle pipeline runs minutes after release. If a fresh image is needed before the bottle lands, the operator can wait or temporarily revert the Dockerfile change. Not a release-blocker. |
| `brettdavies/tap` is not auto-tapped in some brew configurations.                                        | Using the fully-qualified `brettdavies/tap/agentnative` spec triggers the auto-tap (same pattern as `oven-sh/bun/bun` at line 89). No separate `brew tap` step required.                                   |
| Existing scorecards' incorrect `anc.commit` value gets visually exposed via some other surface I missed. | U2's verification step `rg 'agentnative-cli/commit/' dist/` is the catch-all — any rendered surface that links the wrong SHA must produce a match in `dist/`, and the verification asserts zero matches.   |
| Future scorecard regen produces `anc.commit: null` and a downstream consumer assumes non-null.           | Existing schema invariant (`tests/build.test.ts:1094`) explicitly admits `null` for the commit field; no consumer in this repo assumes non-null. Cross-repo: agentnative-cli does not consume scorecards.  |

---

## Documentation / Operational Notes

- No CHANGELOG-worthy user-facing change (the wrong-SHA link surface was never advertised; its disappearance is a silent
  fix). The PR `## Changelog` section may stay empty or note "Fixed: per-tool scorecard pages no longer link to an
  incorrect commit SHA on the agentnative-cli repo."
- `RELEASES.md` and `scripts/SYNCS.md` already reference `docker/score/build.sh --run` as the scoring trigger — no doc
  updates needed there since the script's external interface (`bash docker/score/build.sh [--run]`) is unchanged.
- Operator note: after this PR merges, the next person to run `docker/score/build.sh --run` will produce scorecards with
  `anc.commit: null`. This is expected and matches the documentation note added by U3.

---

## Sources & References

- Origin todo: `.context/compound-engineering/todos/019-pending-p0-remove-skill-sha-pinning.md` (the broader SHA-pin
  scrub thread; this plan is the scorecard-render follow-up surfaced during that work).
- Predecessor branch: `chore/remove-skill-sha-pinning` (skill SHA-pin removal, merged earlier today).
- Related code: `src/build/scorecards-render.mjs:31-83`, `docker/score/Dockerfile:79-109`, `docker/score/build.sh`.
- Related institutional learning: `docs/solutions/best-practices/agentnative-version-model-2026-05-01.md` — cross-repo
  version model framing.
- Brew formula: `brettdavies/homebrew-tap` `Formula/agentnative.rb` (Linux x86_64 bottle published for v0.2.0).
- Canonical install reference: `content/install.md` line 10.
