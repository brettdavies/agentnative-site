---
title: "feat: site-side prose-check enforcement (Vale + LanguageTool)"
type: feat
status: active
date: 2026-05-07
related:
  - ~/dev/agentnative-spec/docs/plans/2026-05-06-001-feat-prose-check-stack-plan.md
  - ~/dev/agentnative-spec/docs/plans/2026-05-06-002-feat-languagetool-pool-deployment-plan.md
  - ~/dev/agentnative-spec/docs/architecture/voice-enforcement.md
  - ~/dev/agentnative-spec/docs/architecture/languagetool-deployment.md
  - ~/dev/agentnative-spec/BRAND.md
  - ~/dev/agentnative-spec/.impeccable.md
  - .impeccable.md
---

# feat: site-side prose-check enforcement (Vale + LanguageTool)

Site-side parallel of the prose-check stack that shipped on `agentnative-spec/docs/v0.3.1`. Stands up Vale rule packs
(universal `brand` copied verbatim from spec + a fresh site-channel `site` pack) plus the `write-good` and `proselint`
baseline; integrates the orchestrator into the existing site pre-push hook; LanguageTool runs over Tailscale when
reachable, gracefully skipped when not.

## Spec-side context (already shipped)

The spec repo (`~/dev/agentnative-spec`) carries the canonical infrastructure. Read those first to understand the design
decisions this plan inherits without re-litigating:

- **Spec plan (origin of this plan's units):**
  `~/dev/agentnative-spec/docs/plans/2026-05-06-001-feat-prose-check-stack-plan.md` — full design (rule pack shape,
  severity overrides, LT category whitelist, per-rule denylist, README generator, pre-push wiring, BRAND.md restructure
  pattern). The work in this site plan was originally U9 + U10 of that plan; split out so the spec stack could ship
  independently.
- **Voice enforcement architecture:** `~/dev/agentnative-spec/docs/architecture/voice-enforcement.md` — layered SoT
  (BRAND.md narrative → per-pack README → YAML enforcement), orchestrator behavior, contributor flow, deferred
  follow-ups.
- **LanguageTool deployment:** `~/dev/agentnative-spec/docs/architecture/languagetool-deployment.md` — service contract
  (probe endpoint, check endpoint, healthcheck, FQDN guidance). LT runs on `pool` over Tailscale; both spec and site
  clients hit the same instance.

## Summary

Bring v1 prose-check enforcement to `agentnative-site`:

- Copy spec's `brand/` rule pack verbatim into `agentnative-site/styles/brand/` (one-time manual sync; consumer
  `sync-spec.sh` extension is the deferred follow-up tracked in the spec plan).
- Author a fresh `agentnative-site/styles/site/` channel pack derived from the existing site `.impeccable.md`.
- Compose `agentnative-site/.vale.ini` parallel to spec's, swapping `spec` for `site` in `BasedOnStyles`.
- Copy `scripts/prose-check.sh` and `scripts/generate-pack-readme.mjs` from spec; copy and adapt
  `scripts/test-prose-check.mjs`.
- Wire the prose-check stages into `agentnative-site/scripts/hooks/pre-push` after the existing pipeline (lint, build,
  test, wrangler dry-run).
- Strip visual-system literals from `agentnative-site/.impeccable.md` per the layered SoT pattern; resolve the existing
  TODO at the top of that file.

## Requirements

These mirror the spec plan's R-IDs where they apply site-side. Numbering carries forward from the spec plan to keep
cross-plan traceability.

- R1. Vale + LanguageTool form the two-tier deterministic check (inherited from spec).
- R2-site. Invocation surfaces are `agentnative-site/scripts/hooks/pre-push` and the manually-invoked
  `scripts/prose-check.sh`. No CI workflow.
- R3-site. Scope: all `*.md` except `docs/brainstorms/`, `docs/plans/`, `docs/research/`, `AGENTS.md`, `CHANGELOG.md`,
  vendored `content/principles/` (sync'd verbatim from spec — its own pre-push catches drift).
- R4-site. v1 enforces in `agentnative-site`. Pairs with `agentnative-spec` v1 to complete origin R4.
- R7-site. Vale uses three layers: copied `brand` pack (universal), fresh `site` channel pack, plus `write-good` +
  `proselint` baseline.
- R10-site. Vale error-tier and category-whitelisted LT findings block; warning-tier annotates but does not block.
  Inherits the orchestrator's category whitelist (`TYPOS|GRAMMAR|CONFUSED_WORDS`) and per-rule denylist.
- R11-site. Brand pack is committed verbatim from spec at v1 (manual sync). Consumer `sync-spec.sh` extension is the
  deferred follow-up tracked in the spec plan.

## Scope boundaries

### Deferred to follow-up

- Consumer `sync-spec.sh` extension to auto-pull `styles/brand/` from spec at vendoring time. Tracked in the spec plan's
  deferred-follow-up list. Until that lands, the manual copy in U1 is the contract.
- Re-promotion of the demoted LT categories (`PUNCTUATION | TYPOGRAPHY | CASING | COMPOUNDING`) to blocking. Pending the
  markdown preprocessor follow-up tracked in the spec voice-enforcement doc § Deferred follow-ups.

### Outside this product's identity

- CI workflow firing on PR or release events for site prose-check (R2-site).
- LanguageTool running locally on the dev machine (LT runs on `pool`, full stop).

## Implementation Units

- U1. **Vale config + brand-pack copy + site channel pack**

**Goal:** Stand up Vale enforcement in the site repo: pack composition, vocabulary scaffold, gitignore additions.

**Dependencies:** None. (The spec rev to copy from is captured in the U1 commit message for traceability.)

**Files (all under `agentnative-site/`):**

- Create: `.vale.ini` — composes `Vale, brand, site, write-good, proselint`; same severity overrides as spec (`brand.*`
  and `site.*` rules at `error`; `write-good.Passive` and `write-good.TooWordy` at `warning`; `write-good.E-Prime`,
  `write-good.ThereIs`, `proselint.But`, `proselint.Annotations`, `proselint.Typography`, `Vale.Terms` disabled); same
  exclusion blocks (`docs/{brainstorms,plans,research}/`, `AGENTS.md`, `CHANGELOG.md`); `Vocab = brand` activates the
  accept-list. Pin the same `Packages` URLs as spec (`write-good@v0.4.1`, `proselint@v0.3.4`).
- Create: `styles/brand/{MarketingRegister,HedgeWords,FillerAdjectives}.yml` — verbatim from spec.
- Create: `styles/site/*.yml` — channel-specific rules derived from `.impeccable.md` (final list decided at
  implementation time; likely candidates below).
- Create: `styles/config/vocabularies/brand/{accept,reject}.txt` — copy from spec to start; site adds its own technical
  terms as Vale.Spelling fires during the U3 dry run.
- Modify: `.gitignore` — add `styles/proselint/`, `styles/write-good/`, `styles/.vale-config/`.

**Approach:**

- Manual copy via `git -C ../agentnative-spec show HEAD:<path> > <local>`. Capture the spec rev (HEAD SHA) in the U1
  commit message for future drift detection. Do not modify the spec checkout's working tree.
- Likely site channel rules to consider (full list decided at implementation time by reading current `.impeccable.md`
  against the rule-extension catalog in
  [`~/dev/agentnative-spec/docs/architecture/voice-enforcement.md`](~/dev/agentnative-spec/docs/architecture/voice-enforcement.md)):
- **Banned font names:** `Inter`, `Plex`, `Fraunces`, `Lora`, `DM Sans`, `Space Grotesk`, `Instrument Serif`, `Outfit`,
    `Plus Jakarta Sans` (per the existing "second-favorite font reflex" ban).
- **Banned aesthetic terms:** `hero section`, `glassmorphism`, `card grid`, `sparkline` (context-bounded; some appear
    legitimately in code or research notes).
- **Required terms / preferred forms:** `OKLCH` preferred over hex when discussing palette values.
- After authoring: `mkdir -p styles && vale sync` materializes the gitignored baseline packs.

**Verification:**

- `vale ls-config` shows the expected `BasedOnStyles` cascade with per-rule severity reflected.
- `vale sync` succeeds and populates `styles/proselint/` + `styles/write-good/`.
- Each new `styles/site/*.yml` rule fires on a contrived bad input.

---

- U2. **Copy orchestrator + generator from spec; install fixtures and test runner**

**Goal:** Bring the executable scripts that wrap Vale and LT and the fixture test runner.

**Dependencies:** U1 (`.vale.ini` and rule packs must exist for Vale to invoke meaningfully).

**Files (all under `agentnative-site/`):**

- Create: `scripts/prose-check.sh` — verbatim from `~/dev/agentnative-spec/scripts/prose-check.sh` at the spec rev
  captured in the U1 commit message. The script's behavior is repo-agnostic (file enumeration via `find`, Vale
  invocation, LT probe + parallelization, severity split, exit code).
- Create: `scripts/generate-pack-readme.mjs` — verbatim from `~/dev/agentnative-spec/scripts/generate-pack-readme.mjs`.
  The generator iterates `DEFAULT_PACKS = ["brand", "spec"]` by default; site invocation uses `bun
  scripts/generate-pack-readme.mjs brand site` to target the right packs.
- Create: `scripts/test-prose-check.mjs` — copy from spec and adapt the `CASES` array to match the site's rule names
  (the brand cases stay; the spec.*cases get replaced with site.* cases for whatever rules U1 lands).
- Create: `scripts/__fixtures__/prose-check/<case>/case.md` — one fixture per site rule.

**Approach:**

- `git -C ../agentnative-spec show HEAD:<path>` to read out of the spec checkout. Same spec rev as U1.
- Generator targets: site invocation list is `brand site` rather than `brand spec`. Either pass it explicitly or amend
  `DEFAULT_PACKS` in the site's copy. (Recommend explicit args at invocation; keeps the script verbatim.)
- The orchestrator's `find` exclude list may need a site-specific addition for `content/principles/` (vendored from spec
  — its own pre-push catches drift; double-checking is wasted work). Decision deferred to U2 implementation time after
  surveying the site's `*.md` corpus.

**Verification:**

- `bun scripts/test-prose-check.mjs` reports OK on all site fixtures.
- `bash scripts/prose-check.sh --vale-only` exits with a finite blocking count (cleanup is U3's job).
- `bash scripts/prose-check.sh` (full run with LT) completes in <10s on a typical site working tree.

---

- U3. **Strip site `.impeccable.md` literals; clean site corpus prose**

**Goal:** Resolve the existing TODO at the top of `agentnative-site/.impeccable.md` ("trim to inherit shared identity
from agentnative-spec/BRAND.md"). Restructure to keep site-channel-only content (visual system, palette, fonts) local
and inherit universal voice from spec's BRAND.md by reference. Clean any pre-existing prose drift the orchestrator
surfaces.

**Dependencies:** U1, U2 (rule packs and orchestrator must be running for verification).

**Files (under `agentnative-site/`):**

- Modify: `.impeccable.md` — strip literal banned-phrase enumerations from any inherited universal bullets; restructure
  to point at `styles/brand/README.md` (universal) and `styles/site/README.md` (site channel). Mirror the pattern from
  spec's U3 — keep section headers, remove literal lists, add link to per-pack README. Visual-system content (palette,
  typography, code-block treatment, OG image) stays site-local.
- Modify: site corpus markdown files (`README.md`, `content/*`, `docs/*`, others) for any blocking findings the
  orchestrator surfaces. Mostly: lowercase RFC keywords → uppercase or rephrase, banned font names → category
  descriptions, marketing register → spec voice. Mirrors the pattern from spec's U3 prose cleanup.

**Approach:**

- Mirror spec's U3 approach: separate the narrative identity (rationale, voice anchors) from the literal contract (rule
  pack YAML). Keep section headers; remove literal enumerations; add link to per-pack README.
- For site-specific concerns (visual-system terminology, palette, fonts): keep in `agentnative-site/.impeccable.md`
  rather than promoting to spec BRAND.md. Visual system is site-channel-only.
- Run `bash scripts/prose-check.sh --vale-only` first to scope Vale-tier cleanup. Then full `bash
  scripts/prose-check.sh` once Vale is clean to surface LT findings.

**Verification:**

- `bash scripts/prose-check.sh` reports `0 blocking` against the cleaned site working tree.
- `agentnative-site/.impeccable.md` no longer contains the inherited literal phrase lists; the TODO at the top is
  resolved.
- `bun scripts/generate-pack-readme.mjs brand site --check` exits 0 (no drift between rule packs and READMEs).

---

- U4. **Wire prose-check stages into the existing pre-push hook**

**Goal:** Slot the two new prose-check stages into `agentnative-site/scripts/hooks/pre-push` after the existing pipeline
(lint, build, test, wrangler dry-run).

**Dependencies:** U1, U2, U3 (all infra in place; corpus clean — pre-push activation must not block on pre-existing
drift).

**Files (under `agentnative-site/`):**

- Modify: `scripts/hooks/pre-push` — append two stages after the existing pipeline:

  ```bash
  bold '==> Pack-README drift check'
  bun scripts/generate-pack-readme.mjs brand site --check </dev/null

  bold '==> prose-check'
  bash scripts/prose-check.sh </dev/null
  ```

- Both stages redirect child stdin to `</dev/null` because the existing branch-deletion short-circuit at the top of the
  hook consumes the push protocol from stdin (`while read -r local_ref local_sha …`). Children that read stdin would
  either swallow protocol bytes or fight for them.
- Header comment block updated to document the two new stages and the stdin-redirect rationale (mirrors spec's hook).

**Approach:**

- The site hook already has the branch-deletion short-circuit (`deleting_only=true`) and the `bold()` helper — reuse, do
  not duplicate.
- Activation is unchanged: contributors who already ran `git config core.hooksPath scripts/hooks` need only `brew
  install vale jaq` (assuming `bun` is already present from existing tooling) and `vale sync` once.

**Verification:**

- `echo "refs/heads/dev $(git rev-parse HEAD) refs/heads/dev $(git rev-parse origin/dev)" | bash scripts/hooks/pre-push`
  exits 0 against a clean working tree.
- Introducing "we believe" into `README.md` causes pre-push exit 1 at the prose-check stage.
- AE3 site-side: `rg -i 'vale|prose-check|languagetool' .github/workflows/` returns zero matches.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| - | - | - | - |
| Site brand pack drifts from spec because manual copy at v1 has no integrity check | Med | Med | Capture spec HEAD SHA in U1's commit message. Future fix: `sync-spec.sh` extension (deferred follow-up in spec plan). v1 mitigation: short delta-window between this site PR and the spec ship. |
| Site channel rules over- or under-fit current `.impeccable.md` | Med | Low | First-pass dry run informs the rule list. Iterate via `.vale.ini` comments and pack updates after observation. The spec voice-enforcement doc names this as expected v1 behavior. |
| Site corpus has more pre-existing prose drift than spec did | Med | Low | Expected; the first-run pass IS the cleanup. Spec saw 80 Vale-tier blockers + 18 LT blockers initially; site may differ. Rewriting is the loop. |
| Pre-push throughput regresses for site (heavier corpus including Astro content) | Low | Med | Default to full scope; rely on `--changed-only` for fast iteration. If pre-push exceeds a usable budget, narrow scope or short-circuit `--changed-only` by default in the hook. |
| `content/principles/` (vendored from spec) duplicates spec's prose-check work | Low | Low | Either exclude from site's orchestrator scope or accept the redundancy. Decision in U2. Vendored content already passes spec's pre-push — no new findings expected. |

## Verification

End-to-end success criteria (acceptance examples carried from spec plan):

- AE1 site-side: introducing a banned phrase in `agentnative-site/README.md` causes pre-push to fail at the prose-check
  stage.
- AE2 site-side: with `pool` unreachable, the orchestrator prints the skip notice annotated with the curl exit code and
  proceeds on Vale's verdict alone.
- AE3 site-side: `rg -i 'vale|prose-check|languagetool' .github/workflows/` returns zero matches in the site repo.
- AE4 site-side: a file under `agentnative-site/docs/brainstorms/` (or `docs/plans/`, `docs/research/`) with a banned
  phrase is excluded by the orchestrator's `find` and does not flag.
- AE5 (manual-copy level for v1): `styles/brand/*.yml` is byte-identical to the spec rev recorded in U1's commit
  message. Re-verified at the automated level once the consumer `sync-spec.sh` extension lands.

## Sources & References

- **Spec plan (origin):** `~/dev/agentnative-spec/docs/plans/2026-05-06-001-feat-prose-check-stack-plan.md`
- **Voice enforcement architecture:** `~/dev/agentnative-spec/docs/architecture/voice-enforcement.md`
- **LanguageTool deployment:** `~/dev/agentnative-spec/docs/architecture/languagetool-deployment.md`
- **Brand identity SoT:** `~/dev/agentnative-spec/BRAND.md`, `~/dev/agentnative-spec/.impeccable.md`
- **Existing site pre-push hook:** `agentnative-site/scripts/hooks/pre-push`
- **Existing site sync pattern:** `agentnative-site/scripts/sync-spec.sh`
- **Site channel narrative:** `agentnative-site/.impeccable.md` (carries the visual-system contract that
  `styles/site/*.yml` will encode)
