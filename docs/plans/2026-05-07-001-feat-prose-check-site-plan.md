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
(universal `brand` vendored from spec via a dedicated sync script + a fresh site-channel `site` pack) plus the
`write-good` and `proselint` baseline; integrates the orchestrator into the existing site pre-push hook; LanguageTool
runs over Tailscale when reachable, gracefully skipped when not.

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

- Stand up `scripts/sync-prose-tooling.sh` (parallel to `sync-spec.sh`) to vendor brand pack YAMLs + released README,
  brand vocab, orchestrator + generator scripts, and `BRAND.md` from spec at the latest v* tag. Separate sync clock from
  `sync-spec.sh` because prose tooling and the principles contract release on different cadences.
- Author a fresh `agentnative-site/styles/site/` channel pack derived from the existing site `.impeccable.md`, plus a
  site-additive vocab.
- Compose `agentnative-site/.vale.ini` parallel to spec's, swapping `spec` for `site` in `BasedOnStyles`.
- Author site-local `scripts/test-prose-check.mjs` and fixtures. Orchestrator + generator arrive vendored.
- Wire the prose-check stages into `agentnative-site/scripts/hooks/pre-push` after the existing pipeline (lint, build,
  test, wrangler dry-run).
- Strip visual-system literals from `agentnative-site/.impeccable.md` per the layered SoT pattern; point at vendored
  `BRAND.md` (universal) plus auto-generated `styles/site/README.md` (channel); resolve the existing TODO at the top of
  that file.

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
- R11-site. Brand pack, vocab, orchestrator, generator, and `BRAND.md` arrive verbatim via
  `scripts/sync-prose-tooling.sh` — a dedicated sync vehicle parallel to `sync-spec.sh`. Separate sync clock from the
  principles/contract sync because prose tooling and the contract release on different cadences.

## Scope boundaries

### Deferred to follow-up

- Re-promotion of the demoted LT categories (`PUNCTUATION | TYPOGRAPHY | CASING | COMPOUNDING`) to blocking. Pending the
  markdown preprocessor follow-up tracked in the spec voice-enforcement doc § Deferred follow-ups.
- `repository_dispatch:spec-release` consumer-side handler that auto-PRs a re-sync after each spec tag. Site contributor
  reruns `scripts/sync-prose-tooling.sh` manually for v1; auto-PR is the same deferred follow-up named in
  `sync-spec.sh`'s header comment.

### Outside this product's identity

- CI workflow firing on PR or release events for site prose-check (R2-site).
- LanguageTool running locally on the dev machine (LT runs on `pool`, full stop).

## Implementation Units

- U0. **Author `sync-prose-tooling.sh`; vendor brand pack + vocab + scripts + BRAND.md**

**Goal:** Stand up the consumer-side sync vehicle for the prose-tooling artifacts shipped on spec. Parallel script to
`sync-spec.sh` — separate sync clock, because prose tooling has a different release cadence from the principles/contract
that `anc` lints against. Run the script once to populate the site with the v1 manifest.

**Dependencies:** None. (Spec's prose-tooling stack already shipped at v0.3.1; this unit consumes it.)

**Files (under `agentnative-site/`):**

- Create: `scripts/sync-prose-tooling.sh` — mirrors `sync-spec.sh`'s tag-resolution + remote-first + local-fallback
  pattern. Vendors the manifest below from spec's latest v* tag. Reports the resolved tag + short SHA on stdout.
- After running the script, the working tree gains:
- `BRAND.md` — universal voice/identity SoT, link target from the trimmed `.impeccable.md` (U3).
- `styles/brand/{MarketingRegister,HedgeWords,FillerAdjectives}.yml` — universal rule pack YAMLs.
- `styles/brand/README.md` — released companion README. Already-generated artifact; not regenerated downstream
  (downstream regeneration would invite tooling-version drift across consumers).
- `styles/config/vocabularies/brand/{accept,reject}.txt` — universal vocab.
- `scripts/prose-check.sh` — repo-agnostic orchestrator.
- `scripts/generate-pack-readme.mjs` — repo-agnostic generator (used to produce site's own `styles/site/README.md` from
  site-authored YAMLs; brand README is vendored, not regenerated).
- Modify: `scripts/SYNCS.md` — document the new sync script alongside the existing `sync-spec.sh` entry.

**Approach:**

- Mirror `sync-spec.sh`'s structure: `SPEC_REMOTE_URL` / `SPEC_ROOT` env vars, remote `git ls-remote --tags` first,
  local fallback, atomic `git show $TAG:<path>` extraction. No working-tree perturbation on either side.
- Vendor brand `*.yml` AND its `README.md` from the same tag — sync-script atomicity is the integrity guarantee, no
  downstream re-generation needed (matches the `principles/` + `VERSION` + `CHANGELOG.md` pattern in `sync-spec.sh`).
- `git show` does not preserve the executable bit; `chmod +x scripts/prose-check.sh` after extracting the orchestrator.

**Verification:**

- `bash scripts/sync-prose-tooling.sh` exits 0 and reports the resolved spec tag.
- Re-running produces no `git diff` (idempotent at a fixed spec tag).
- `git status` shows only the vendored files; nothing in `src/data/spec/` is touched (`sync-spec.sh`'s territory).

---

- U1. **Vale config + site channel pack + site vocabulary**

**Goal:** Compose Vale for the site channel using the brand pack vendored in U0 plus a fresh site channel pack and a
site-additive vocabulary.

**Dependencies:** U0 (brand pack + vocab vendored).

**Files (all under `agentnative-site/`):**

- Create: `.vale.ini` — composes `Vale, brand, site, write-good, proselint`; same severity overrides as spec (`brand.*`
  and `site.*` rules at `error`; `write-good.Passive` and `write-good.TooWordy` at `warning`; `write-good.E-Prime`,
  `write-good.ThereIs`, `proselint.But`, `proselint.Annotations`, `proselint.Typography`, `Vale.Terms` disabled); same
  exclusion blocks (`docs/{brainstorms,plans,research}/`, `AGENTS.md`, `CHANGELOG.md`); `Vocab = brand, site` activates
  both accept-lists. Pin the same `Packages` URLs as spec (`write-good@v0.4.1`, `proselint@v0.3.4`).
- Create: `styles/site/*.yml` — channel-specific rules derived from `.impeccable.md` (final list decided at
  implementation time; likely candidates below).
- Create: `styles/config/vocabularies/site/{accept,reject}.txt` — site-additive vocab. Brand vocab arrives via U0
  vendoring; the site vocab carries site-only technical terms (font names actually used in the design, code-block
  language tags, etc.) as Vale.Spelling fires during the U3 dry run.
- Modify: `.gitignore` — add `styles/proselint/`, `styles/write-good/`, `styles/.vale-config/`.

**Approach:**

- Author the site channel pack iteratively against `.impeccable.md` and the rule-extension catalog in
  [`~/dev/agentnative-spec/docs/architecture/voice-enforcement.md`](~/dev/agentnative-spec/docs/architecture/voice-enforcement.md).
- Likely site channel rules to consider:
- **Banned font names:** `Inter`, `Plex`, `Fraunces`, `Lora`, `DM Sans`, `Space Grotesk`, `Instrument Serif`, `Outfit`,
  `Plus Jakarta Sans` (per the existing "second-favorite font reflex" ban).
- **Banned aesthetic terms:** `hero section`, `glassmorphism`, `card grid`, `sparkline` (context-bounded; some appear
  legitimately in code or research notes).
- **Required terms / preferred forms:** `OKLCH` preferred over hex when discussing palette values.
- After authoring: `vale sync` materializes the gitignored baseline packs.

**Verification:**

- `vale ls-config` shows the expected `BasedOnStyles` cascade with per-rule severity reflected.
- `vale sync` succeeds and populates `styles/proselint/` + `styles/write-good/`.
- Each new `styles/site/*.yml` rule fires on a contrived bad input.

---

- U2. **Site test runner + fixtures**

**Goal:** Author the site's prose-check fixture tests. Orchestrator + generator arrive vendored via U0.

**Dependencies:** U0 (orchestrator + generator vendored), U1 (rule packs in place for Vale to invoke).

**Files (all under `agentnative-site/`):**

- Create: `scripts/test-prose-check.mjs` — adapted from `agentnative-spec/scripts/test-prose-check.mjs`. The `CASES`
  array carries the brand cases (still meaningful — site lints against the same brand pack) and replaces `spec.*` cases
  with `site.*` cases for whatever rules U1 lands.
- Create: `scripts/__fixtures__/prose-check/<case>/case.md` — one fixture per site rule.

**Approach:**

- Read the spec's runner verbatim to understand the contract; copy + adapt only the `CASES` array.
- Generator invocation in pre-push (U4) targets `site` only — brand README is vendored, not regenerated, so passing
  `brand` to `--check` would either no-op or false-fail depending on the generator's tolerance for vendored output.
- The orchestrator's `find` exclude list lives in the vendored `prose-check.sh`. Site-specific exclusions (e.g.,
  `content/principles/`, vendored from spec — its own pre-push catches drift) get raised as upstream additions to spec
  rather than forking the vendored script. Decision deferred to U2 implementation time after surveying the site's `*.md`
  corpus.

**Verification:**

- `bun scripts/test-prose-check.mjs` reports OK on all site fixtures.
- `bash scripts/prose-check.sh --vale-only` exits with a finite blocking count (cleanup is U3's job).
- `bash scripts/prose-check.sh` (full run with LT) completes in <10s on a typical site working tree.

---

- U3. **Strip site `.impeccable.md` literals; clean site corpus prose**

**Goal:** Resolve the existing TODO at the top of `agentnative-site/.impeccable.md` ("trim to inherit shared identity
from agentnative-spec/BRAND.md"). Restructure to keep site-channel-only content (visual system, palette, fonts) local
and inherit universal voice from the vendored `BRAND.md` by reference. Clean any pre-existing prose drift the
orchestrator surfaces.

**Dependencies:** U0 (BRAND.md vendored), U1, U2 (rule packs + orchestrator + fixture runner must be in place for
verification).

**Files (under `agentnative-site/`):**

- Modify: `.impeccable.md` — strip literal banned-phrase enumerations from any inherited universal bullets; restructure
  to point at `BRAND.md` (universal voice, vendored from spec in U0) and `styles/site/README.md` (site-channel rules,
  generated from `styles/site/*.yml`). Mirror the pattern from spec's trimmed `.impeccable.md` — keep section headers,
  remove literal lists, link to BRAND.md plus the per-pack README. Visual-system content (palette, typography,
  code-block treatment, OG image) stays site-local.
- Modify: site corpus markdown files (`README.md`, `content/*`, `docs/*`, others) for any blocking findings the
  orchestrator surfaces. Mostly: lowercase RFC keywords → uppercase or rephrase, banned font names → category
  descriptions, marketing register → spec voice. Mirrors the pattern from spec's U3 prose cleanup.

**Approach:**

- Mirror spec's `.impeccable.md` trim: open with "Channel-specific design context for the **site channel** of
  agentnative. Inherits the shared identity, voice anchor, audiences, and universal anti-patterns from
  [`BRAND.md`](BRAND.md). Read that first." Visual-system sections follow.
- For site-specific concerns (visual-system terminology, palette, fonts): keep in `agentnative-site/.impeccable.md`
  rather than promoting to spec BRAND.md. Visual system is site-channel-only.
- Run `bash scripts/prose-check.sh --vale-only` first to scope Vale-tier cleanup. Then full `bash
  scripts/prose-check.sh` once Vale is clean to surface LT findings.

**Verification:**

- `bash scripts/prose-check.sh` reports `0 blocking` against the cleaned site working tree.
- `agentnative-site/.impeccable.md` no longer contains the inherited literal phrase lists; the TODO at the top is
  resolved.
- `bun scripts/generate-pack-readme.mjs site --check` exits 0 (no drift between site rule pack and its README; brand
  pack is vendored, not regenerated).

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
  bun scripts/generate-pack-readme.mjs site --check </dev/null

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
| Vendored prose-tooling artifacts go stale relative to spec because consumer-side auto-PR on `repository_dispatch:spec-release` is not yet wired | Med | Low | `scripts/sync-prose-tooling.sh` is idempotent and self-reports the resolved spec tag; maintainer reruns after each spec release. Tracked as a deferred follow-up alongside the same handler for `sync-spec.sh`. |
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
- AE5 (sync-script integrity): `bash scripts/sync-prose-tooling.sh` is idempotent — running it twice in a row produces
  no `git diff` against a fixed spec tag. Vendored artifacts (`BRAND.md`, `styles/brand/*.yml`,
  `styles/brand/README.md`, `styles/config/vocabularies/brand/{accept,reject}.txt`, `scripts/prose-check.sh`,
  `scripts/generate-pack-readme.mjs`) are byte-identical to the spec tag the script resolved.

## Sources & References

- **Spec plan (origin):** `~/dev/agentnative-spec/docs/plans/2026-05-06-001-feat-prose-check-stack-plan.md`
- **Voice enforcement architecture:** `~/dev/agentnative-spec/docs/architecture/voice-enforcement.md`
- **LanguageTool deployment:** `~/dev/agentnative-spec/docs/architecture/languagetool-deployment.md`
- **Brand identity SoT:** `~/dev/agentnative-spec/BRAND.md`, `~/dev/agentnative-spec/.impeccable.md`
- **Existing site pre-push hook:** `agentnative-site/scripts/hooks/pre-push`
- **Existing site sync pattern:** `agentnative-site/scripts/sync-spec.sh`
- **Site channel narrative:** `agentnative-site/.impeccable.md` (carries the visual-system contract that
  `styles/site/*.yml` will encode)
