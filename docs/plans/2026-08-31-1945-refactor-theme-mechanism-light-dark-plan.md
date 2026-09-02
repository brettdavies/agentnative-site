---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
title: "Theme mechanism collapse to light-dark() - Plan"
type: refactor
date: 2026-08-31
topic: theme-mechanism-light-dark
---

# Theme mechanism collapse to light-dark() - Plan

## Goal Capsule

- **Objective:** A contributor reading the theme layer sees two palettes declared once each, and the documented
  verification procedure describes what the stylesheets actually do. Today the same reader finds four selector blocks, a
  `:not()` precedence trick, and an `AGENTS.md` procedure that exercises half the routes.
- **Means:** Collapse the generated palette to `light-dark()`, retire `data-theme`, declare a browser floor, and correct
  the documentation (KTD1, KTD2).
- **Authority:** R-IDs win on required behavior. KTDs win on mechanism. Units override neither.
- **Execution profile:** **Do not start before 2026-11-13.** See "Hold condition" below — this plan is deliberately
  parked, and the hold is the single most important thing in it.
- **Stop conditions:** Stop and ask if any of the 31 tokens computes to a different value after the collapse; if the
  explicit-light-over-OS-dark route regresses; or if `bun run og` produces a different PNG hash.
- **Tail ownership:** Ends at a merged PR on `dev`.

---

## Hold condition

**This plan is on hold until `light-dark()` reaches Baseline Widely available on 2026-11-13.** Do not begin
implementation before that date. Re-read this section when picking the work up; if the schedule moved, the date moves
with it.

The work is elective. It fixes no defect, and the duplication it removes costs nothing today — so there is no reason to
accept the interim risk described below.

### Why the wait, in full

**Baseline status.**

|                           |            |
| ------------------------- | ---------- |
| Baseline Newly available  | 2024-05-13 |
| Baseline Widely available | 2026-11-13 |
| Plan authored             | 2026-08-31 |

Baseline is the W3C WebDX interop standard surfaced on MDN and caniuse. *Newly available* means the feature works in the
current version of Chrome, Edge, Firefox, and Safari as of the date the last engine shipped it. *Widely available* means
30 months have passed since that date — the bar at which users on older-but-not-ancient devices are covered.

**Browser support.**

| Engine        | Shipped in                           | Does not support |
| ------------- | ------------------------------------ | ---------------- |
| Firefox       | 120 (Nov 2023) — first to ship       | 119 and earlier  |
| Chrome / Edge | 123 (Mar 2024)                       | 122 and earlier  |
| Safari        | 17.5 (May 2024) — completed Baseline | 17.4 and earlier |

Global usage is roughly 83%, so about one visitor in six cannot render it as of this writing.

**Safari is the binding constraint.** Chrome and Firefox self-update, so their old versions drain quickly. Safari's
version is tied to the OS: 17.5 requires macOS Sonoma (14) or iOS 17. A visitor on macOS Ventura or iOS 16 cannot
install it, and hardware too old for Sonoma never will. That population shrinks slowly and has a floor. Samsung Internet
and mobile Safari also lag the desktop numbers.

**The failure mode is total, not graceful.** This is the reason the hold exists rather than a "ship it and accept 17%"
decision. In a non-supporting browser, `light-dark()` is invalid at computed value time and colors revert to their
initial values — documented on caniuse as risking severe visual breakage. It is the same mechanism behind the `--fg`
defect in the integrity plan, except that one affected a single declaration on one button. Here it would hit all 31
color tokens at once: every background, foreground, and border. The site would not lose a nicety; it would lose its
color system.

Contrast this with what the site already ships without guards — `oklch()` (160 uses), `:has()` (22), `color-mix()` (6),
`@container` (1), and `text-wrap: pretty` (3), the last of which Firefox does not support at all. Every one of those
degrades invisibly: the declaration is ignored and the page renders normally. None of them is load-bearing for the
entire palette. The site's tolerance for unguarded modern CSS does not transfer to this feature, because the blast
radius is categorically different.

**Guarding it now would defeat the purpose.** The safe interim pattern is a plain fallback before the `light-dark()`
declaration, or an `@supports` block:

```css
.el {
  color: #111;                 /* fallback */
  color: light-dark(#111, #eee);
}
```

That reintroduces the duplication this plan exists to remove, at per-declaration granularity rather than per-block. Four
blocks would become two, not one, and the repo would gain an `@supports` layer it currently has none of. Waiting ten
weeks yields the clean collapse instead.

### What the duplication is, and is not

Four blocks for two themes is the **standard pre-2024 pattern**, not a defect. CSS cannot OR a media query with a
selector — `@media (prefers-color-scheme: dark), :root[data-theme="dark"] { … }` is not expressible — so supporting an
OS preference *and* a manual toggle requires writing each palette twice. Two themes × two selection routes = four
blocks. Every site with an OS-aware theme toggle has this shape.

It is also not a drift hazard. `scripts/design/generate-palette.mjs:611-617` emits all four blocks from one `light`
object and one `dark` object, so a token is authored once and cannot disagree with itself. Only a hand-edit of the
generated `foundation.css` could break that, and that file is generated output.

So this plan buys legibility: four blocks become one, the `:not()` precedence trick disappears, and the verification
procedure stops needing a caveat. It does not buy correctness.

---

## Product Contract

### Summary

Collapse the generated light and dark palettes into a single `:root` block using `light-dark()`, retire `data-theme` as
the theme-selection mechanism in favour of `color-scheme`, declare the browser floor the change implies, and correct
`AGENTS.md` to describe the result.

### Problem Frame

`src/styles/foundation.css` declares 31 color tokens four times: light on bare `:root`, dark inside `@media
(prefers-color-scheme: dark) :root:not([data-theme="light"])`, dark again on `:root[data-theme="dark"]`, and light again
on `:root[data-theme="light"]`. The `:not()` exists so a user who picks light beats an OS preference of dark.

`AGENTS.md:221` tells a verifier to "toggle through both themes (light + dark) using the in-page toggle." That reaches
both themes but only the two `[data-theme]` blocks; the two OS-preference paths are never exercised by the documented
procedure.

`data-theme` also spreads past the palette: 12 selectors and 4 `prefers-color-scheme` blocks of hand-written component
overrides in `src/styles/site.css`, the toggle in `src/client/theme.ts` and `theme-init.ts`, `src/build/shell.mjs`,
`scripts/og/og.html`, and `tests/e2e/flows.e2e.ts`.

### Key Decisions

- **Collapse to `light-dark()` and retire `data-theme` entirely** (session-settled: user-directed — chosen over a
  generator-only change that kept `data-theme` for component overrides, and over leaving the duplication alone). Governs
  R1, R2.
- **Hold until Baseline Widely available** (session-settled: user-directed — chosen over shipping now behind an
  `@supports` guard). The work is elective and the interim failure mode is total. Governs the Execution profile.
- **`browserslist` is the floor of record; `AGENTS.md` restates it** (session-settled: user-directed — chosen over prose
  alone). Governs R3.

### Requirements

- R1. One light palette and one dark palette are declared once each. No palette is emitted more than once.
- R2. Theme selection runs through `color-scheme`. `data-theme` is absent from stylesheets, client scripts, emitted
  markup, and tests.
- R3. The supported-browser floor is declared as machine-readable config, and `AGENTS.md` states it in prose.
- R4. `AGENTS.md`'s browser-verify procedure describes what the stylesheets implement.

### Success Criteria

- All 31 tokens compute to identical values before and after, measured in a browser under both OS schemes.
- `public/og-image.png` is byte-identical.
- No `@supports` guard and no per-declaration fallback is needed — if one turns out to be, the hold condition was
  released too early.

### Scope Boundaries

- Not a visual redesign. Every computed color is expected to be unchanged; a color that shifts is a bug, not an
  improvement.
- Not a change to the toggle's UX. It keeps its two-stop cycle, its `localStorage` key, and its `aria-label` sync.

### Sources

- [MDN — light-dark()](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark)
- [Can I use — light-dark()](https://caniuse.com/mdn-css_types_color_light-dark)
- [web-features explorer — light-dark](https://web-platform-dx.github.io/web-features-explorer/features/light-dark/)
- [WebKit — text-wrap: pretty](https://webkit.org/blog/16547/better-typography-with-text-wrap-pretty/) (the contrast
  case for graceful degradation)
- `scripts/design/generate-palette.mjs:601-633` (the four-block emitter and its README string)
- `AGENTS.md` § "Browser-verify before declaring done"

---

## Planning Contract

### Key Technical Decisions

- KTD1. **All 31 theme tokens are colors, so `light-dark()` expresses every one.** Verified against the current
  `:root[data-theme="dark"]` block: every entry is a color (`--bg*`, `--fg*`, `--border*`, `--accent*`, `--band-*`,
  `--must`/`--should`/`--may`, `--meter-track`). No non-color token blocks the collapse. Governs R1.
- KTD2. **`color-scheme: light dark` on `:root` is a hard dependency, not a nicety.** A fully-supporting browser with a
  missing or overridden `color-scheme` behaves exactly as if it lacked `light-dark()` — a documented source of false bug
  reports. The collapse therefore concentrates risk on one declaration, and anything that resets `color-scheme` on a
  subtree kills the palette there. U1 asserts its presence. Governs R1, R2.
- KTD3. **`browserslist` declares intent; it does not enforce downleveling.** Bun's CSS minifier does not read it today.
  Say so where it is added rather than implying the build enforces the floor. Governs R3.

### Assumptions

- The hold condition holds. If `light-dark()`'s Widely-available date moves, this plan's start date moves with it.
- No visitor analytics existed when this plan was written, so the 83% global-usage figure is the only reach data
  available. If analytics are in place by the time this is picked up, re-check the real audience distribution before
  starting — it may justify starting earlier or later than the Baseline date alone suggests.

### Sequencing

U1 → U2 → U3 → U4, one PR. U4 is the final commit so the documentation is written against the merged mechanism.

### Risks & Dependencies

- **Starting before the hold date** reintroduces the total-failure exposure. The hold is the mitigation; there is no
  cheaper one that preserves the plan's purpose.
- **`color-scheme` regression** takes the whole palette down in every browser, not just old ones (KTD2). U2's four-route
  walk is the gate.
- **The explicit-light-over-OS-dark route** is what the `:not()` trick served. It is the likeliest regression and gets
  its own verification step.

---

## Implementation Units

### U1. Collapse the generated palette to `light-dark()`

- **Goal:** Each palette is declared once.
- **Requirements:** R1 (KTD1, KTD2)
- **Files:** `scripts/design/generate-palette.mjs` (emitter at lines 601-620, header comment, and the README string at
  630-633), `src/styles/foundation.css` (regenerated, never hand-edited).
- **Approach:** Replace the four `cssTokenBlock` calls with one `:root` block that sets `color-scheme: light dark` and
  emits each of the 31 tokens as `light-dark(<light>, <dark>)`, paired from the same `light` and `dark` objects the
  emitter already holds. Delete the media wrapper, both `[data-theme]` blocks, and the `:not()` precedence note. Update
  the header comment and the emitted README string, both of which describe the four-block strategy.
- **Test scenarios:**
  - Happy path: `foundation.css` has one `:root` block, 31 `light-dark()` declarations, `color-scheme: light dark`, and
    no theme selector.
  - Error path — **must be observed:** remove the `color-scheme` declaration and confirm the palette stops resolving in
    a supporting browser. This pins KTD2 rather than trusting it.
  - Integration — **browser-verified:** capture `getComputedStyle(document.documentElement)` for all 31 tokens before
    and after, under OS-light and OS-dark; the sets must be identical.
  - Edge case: regenerating overwrites a hand-edit, pinning `foundation.css` as generated output.
- **Verification:** `bun run build && bun test`, then the computed-value diff under both OS schemes.

### U2. Move theme selection from `data-theme` to `color-scheme`

- **Goal:** One theme mechanism across stylesheets, scripts, markup, and tests.
- **Requirements:** R2 (KTD2)
- **Files:** `src/styles/site.css` (12 `data-theme` selectors, 4 `prefers-color-scheme` blocks), `src/client/theme.ts`
  (48, 51), `src/client/theme-init.ts` (19), `src/build/shell.mjs`, `scripts/og/og.html` (line 2),
  `tests/e2e/flows.e2e.ts`.
- **Approach:** Convert `site.css`'s component overrides to `light-dark()` values, which removes both the `[data-theme]`
  selectors and their paired media blocks. Change the toggle to write `color-scheme` on the root element, keeping the
  two-stop cycle and the `localStorage` key; `theme-init.ts` keeps setting it pre-paint to avoid a flash.
  `scripts/og/og.html` pins the card with `color-scheme: dark` instead of `data-theme="dark"`, preserving the
  deterministic dark render. Update `flows.e2e.ts` to assert on `color-scheme`. Keep `data-theme-cycle` and
  `data-theme-choice` — those are test and assistive-tech affordances, not the mechanism.
- **Test scenarios:**
  - Happy path: the toggle cycles light and dark; the choice survives a reload.
  - Integration: `rg -n "data-theme" src/ scripts/ tests/` returns only `-cycle` and `-choice`.
  - Integration — **browser-verified, all four routes:** OS-light with no stored choice; OS-dark with no stored choice;
    explicit light over an OS-dark preference; explicit dark over an OS-light preference. The third is what the `:not()`
    trick existed for and is the likeliest regression.
  - Integration: `bun run og` renders the dark card and the PNG hash is unchanged.
  - Error path: clear `localStorage`, set the OS to dark, load the page — dark on first paint, no light flash.
  - Edge case: the no-JS render still gets a theme, since `color-scheme: light dark` is CSS-only.
- **Verification:** `bun run build && bun test && bun run test:e2e`, then the four-route walk and the OG hash.

### U3. Declare the supported-browser floor

- **Goal:** The floor is a recorded decision.
- **Requirements:** R3 (KTD3)
- **Files:** `package.json` (`browserslist`).
- **Approach:** Add a `browserslist` field naming the floor `light-dark()` implies — Chrome/Edge 123+, Firefox 120+,
  Safari 17.5+. Note alongside it that Bun's CSS minifier does not consume the field today, so it declares intent for
  future tooling rather than driving downleveling.
- **Test scenarios:**
  - Happy path: `bun run lint` and `bun run build` are unaffected — the field changes no output.
  - Edge case: `knip` does not report it as an unused dependency; it is a config field, not a package.
- **Verification:** `bun run build && bun run lint`, and confirm `dist/css/foundation.css` still ships `light-dark(`
  rather than a downleveled expansion.

### U4. Correct the AGENTS.md theme and browser documentation

- **Goal:** The documented procedure matches what the stylesheets implement.
- **Requirements:** R4
- **Files:** `AGENTS.md` (§ "Browser-verify before declaring done", line 221; plus the browser-floor note).
- **Approach:** Rewrite the verify step for the merged mechanism: two themes reached through `color-scheme`, verified
  with the in-page toggle and with the OS preference, with no `data-theme` route to caveat. Add the U3 floor in prose so
  a contributor sees the bar without opening `package.json`.
- **Execution note:** **Last commit on the PR**, so the documentation describes the mechanism as merged rather than as
  planned.
- **Test scenarios:**
  - Test expectation: none — documentation only, no behavior to assert.
- **Verification:** `bun run lint`, plus a read-through confirming no sentence describes `data-theme` or a four-block
  palette.

---

## Verification Contract

| Gate                       | Command                                                               | Applies to |
| -------------------------- | --------------------------------------------------------------------- | ---------- |
| Build                      | `bun run build`                                                       | all        |
| Unit and regression tests  | `bun test`                                                            | U1, U2     |
| Browser e2e                | `bun run test:e2e`                                                    | U2         |
| Lint                       | `bun run lint`                                                        | U3, U4     |
| Computed-token equivalence | `getComputedStyle` diff over all 31 tokens, both OS schemes           | U1         |
| Four-route theme walk      | manual, per `AGENTS.md`                                               | U2         |
| Theme-mechanism sweep      | `rg -n "data-theme" src/ scripts/ tests/` → only `-cycle` / `-choice` | U2         |
| OG card determinism        | `sha256sum public/og-image.png` before and after                      | U2         |

---

## Definition of Done

**Global**

- The hold condition was satisfied before work began: the start date is on or after 2026-11-13, and `light-dark()` is
  Baseline Widely available.
- Every requirement R1–R4 is satisfied by a merged unit.
- No `@supports` guard or per-declaration color fallback was needed.
- `AGENTS.md` (U4) is the final commit on the PR.

**Per unit**

| Unit | Done when                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1   | `foundation.css` has one `:root` block and no theme selector; all 31 computed token values unchanged in both OS schemes; the missing-`color-scheme` failure was observed. |
| U2   | `data-theme` survives only as `-cycle` / `-choice`; all four routes verified in a browser; OG hash matches.                                                               |
| U3   | `browserslist` declares the floor; `dist/css/foundation.css` still ships `light-dark(`.                                                                                   |
| U4   | `AGENTS.md` describes the merged mechanism, names the floor, and is the PR's last commit.                                                                                 |
