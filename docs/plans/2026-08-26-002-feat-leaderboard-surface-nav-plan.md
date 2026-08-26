---
title: "feat: Leaderboard surface nav (CLI|Website preference)"
date: 2026-08-26
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# feat: Leaderboard surface nav (CLI|Website preference)

## Goal Capsule

Wire one shared CLI|Website surface preference so header **Leaderboards** and homepage **Full board →** resolve to the
same board (`/scorecards` vs `/web`), persist the choice in `localStorage`, and add a peer **CLI | Website** segment
(Probe A) on both full board pages. Keep the helper compact; do not stamp preference on mere board URL visits. Audit nav
and board-hero layout polish stay out.

**Authority:** session-settled design brief (this conversation) > this plan > existing theme/`install-cmd` client
patterns.

**Stop when:** Leaderboards href follows preference sitewide; homepage segment restores/writes preference; both boards
expose Probe A that writes preference and navigates; tests cover the preference helper and the nav rewrite; no Audit
changes; no stamp-on-visit.

---

## Product Contract

### Summary

Visitor surface preference (`cli` | `web`) drives two destinations that today disagree: static header **Leaderboards**
always goes to `/scorecards`, while homepage **Full board →** already flips via CSS dual panes. Persist the preference,
retarget Leaderboards, and add the same peer switch on `/scorecards` and `/web`.

### Requirements

- **R1.** Default surface is `cli` (Leaderboards → `/scorecards`) when no preference is stored.
- **R2.** When surface is `web`, Leaderboards → `/web`.
- **R3.** Persist preference in `localStorage`; survive reload and cross-page navigation.
- **R4.** Homepage `CLI | Website` segment **writes** preference on change and **restores** radios from storage on load
  (progressive enhancement; no-JS CSS toggle still works).
- **R5.** Probe A on `/scorecards` and `/web`: same `.seg` control; selecting the other surface **writes** preference
  and **navigates** to the peer board (full page, not in-place pane swap).
- **R6.** Do **not** write preference merely because the visitor landed on `/scorecards` or `/web` (bookmark, Full
  board, external link).
- **R7.** No-JS on `/`: Leaderboards follows the homepage segment via **dual header links** and existing
  `body:has(#s-web:checked)` — same parity model as Full board (CLI → `/scorecards`, Website → `/web`). No-JS off `/`:
  Leaderboards stays `/scorecards` (no `#s-web` on page).
- **R8.** Audit primary-nav asymmetry is out of this plan.

### Key Decisions

- **KD1.** One shared client helper for get/set/href mapping — not per-page copies. `(session-settled: user-directed —
  chosen over per-page wiring: keep it compact)`
- **KD2.** Persist in `localStorage`. `(session-settled: user-directed — chosen over homepage-only ephemeral radios)`
- **KD3.** Board cross-nav is Probe A (segment), not quiet link / both. `(session-settled: user-approved — chosen over
  B/C; layout polish may follow via /impeccable)`
- **KD4.** Do not stamp on board visit. `(session-settled: user-directed — chosen over stamp-on-visit: preference only
  from explicit surface controls)`
- **KD5.** Boards this pass; Audit later. `(session-settled: user-directed)`

### Scope Boundaries

**In:** shared preference module; shell Leaderboards hook + sitewide script; homepage bind; Probe A on both board
heroes; unit + e2e coverage.

**Out / deferred:** Audit nav parity; board-hero layout polish if A feels cramped next to Relative|Global / All|Curated;
markdown-twin changes beyond existing board links; changing Full board from dual-pane CSS to a single rewritten link.

### Acceptance Examples

- **AE1.** Cold visit, no storage → Leaderboards href is `/scorecards`.
- **AE2.** On `/`, select Website → storage is `web`, Leaderboards href becomes `/web`; Full board (visible) still
  points at `/web`.
- **AE3.** Reload any page with storage `web` → Leaderboards still `/web`; on `/`, Website radio is checked and web
  panes show.
- **AE4.** On `/scorecards`, select Website in Probe A → storage `web`, navigate to `/web`.
- **AE5.** Open `/web` via bookmark with empty storage → storage stays empty/default; Leaderboards remains `/scorecards`
  until an explicit control writes.
- **AE6.** JS disabled on `/` → CLI|Website CSS panes still swap; visible Leaderboards link follows segment
  (`/scorecards` or `/web`) via `:has`, matching Full board.

---

## Planning Contract

### Assumptions

- Homepage Leaderboards uses the same dual-link + `:has` pattern as Full board — no `href` rewrite needed on `/` when JS
  is off. Off-homepage persistence uses JS (`html[data-surface]`) to flip the same dual anchors.
- Homepage Full board stays dual-link CSS; segment, Full board, and Leaderboards stay in sync because one radio drives
  all three via `:has` (no-JS) and preference restore re-checks that radio (JS).

### Key Technical Decisions

- **KTD1.** Mirror `src/client/theme.ts` / `install-cmd.ts`: small exported helpers (`getSurface`, `setSurface`,
  `leaderboardsHref`), storage key e.g. `anc-surface`, values `cli` | `web`, silent catch if `localStorage` blocked.
  Absent/invalid key reads as `cli` — never treat “no choice” as an implicit `web`. `(session-settled: user-directed —
  chosen over a heavier store/event bus)`; tri-state transport per
  `docs/solutions/design-patterns/transport-a-cross-page-tri-state-field-as-boolean-or-null-omit-dont-false.md`
- **KTD2.** Emit **two** Leaderboards anchors in `shell.mjs` (Full-board parity): `data-s="cli"` → `/scorecards`,
  `data-s="web"` → `/web`, plus `data-leaderboards-nav` on both for tests/JS. Default visible: CLI. CSS:
  `body:has(#s-web:checked) .site-nav [data-leaderboards-nav][data-s="cli"] { display: none }` and matching show rule
  for the web anchor (nav-specific selectors — do not widen global `[data-s="web"]` beyond header). Extend toggle
  plumbing comment block in `site.css` alongside hero proof rules.
- **KTD2b.** Off-homepage JS reader: set `data-surface="cli"|"web"` on `<html>` from `localStorage` so dual nav links
  flip without `#s-web` present. On `/`, radio restore + `:has` is sufficient; avoid fighting `:has` with `data-surface`
  when both apply.
- **KTD3.** Load the surface client **sitewide** from `shell.mjs` (same as `theme.js`) so Worker-rendered `/web` (ASSETS
  shell template) gets it without duplicating a body script in `leaderboard-render.ts`.
- **KTD4.** Writers only: homepage radiogroup `change` + Probe A selection (before navigate). Readers: on `/`, restore
  homepage radios (drives `:has` for nav + panes); off `/`, set `html[data-surface]` from storage. Do not rewrite `href`
  on dual anchors. Board visit is render-only (checked state reflects URL, no `setSurface`) per
  `docs/solutions/design-patterns/flip-render-and-per-gesture-persistence-as-separate-briefs.md`
- **KTD5.** Probe A markup: reuse `.seg` in `.leaderboard-hero` above the h1 on both boards; CLI checked on
  `/scorecards`, Website checked on `/web`. Clicking the already-current option is a no-op (no navigation). Layout
  polish deferred.

### High-Level Technical Design

```mermaid
flowchart LR
  subgraph writers [Writers]
    HomeSeg[Homepage CLI|Website]
    ProbeA[Board Probe A]
  end
  Store[(localStorage anc-surface)]
  subgraph readers [Readers]
    NavHas[Homepage body:has nav flip]
    NavAttr[Off-home html data-surface]
    HomeRestore[Homepage radio restore]
  end
  HomeSeg -->|setSurface| Store
  ProbeA -->|setSurface then navigate| Store
  Store --> NavAttr
  Store --> HomeRestore
  HomeSeg -->|no-JS| NavHas
  HomeRestore --> NavHas
  Visit[Mere /web or /scorecards visit] -.->|no write| Store
```

### Product Contract preservation

Product Contract from ce-plan-bootstrap (session brief); no separate brainstorm file.

---

## Implementation Units

### U1. Shared surface module + dual Leaderboards shell/CSS

**Goal:** Compact preference helper, dual Leaderboards anchors, `:has` homepage parity, off-home `data-surface` reader.

**Requirements:** R1–R3, R7; KD1–KD2; KTD1–KTD3, KTD2b

**Dependencies:** none

**Files:**
- create `src/client/surface.ts`
- modify `src/build/01-assets.mjs` (bundle → `dist/js/surface.js`)
- modify `src/build/shell.mjs` (dual Leaderboards anchors; defer `/js/surface.js`)
- modify `src/styles/site.css` (`.site-nav` `:has` + `html[data-surface]` flip rules)
- create `tests/surface.test.ts`
- modify `tests/build.test.ts` or `tests/regression.test.ts` (both anchors in dist shell)

**Approach:**
1. Export get/set + surface→href map; default `cli` when missing/invalid.
2. Shell: special-case Leaderboards in nav — two `<a>` tags with `data-s` + `data-leaderboards-nav`; `aria-current` on
   the visible matching board when on `/scorecards` / `/web` / `/score/*`.
3. CSS: homepage `body:has(#s-web:checked)` toggles which Leaderboards anchor shows; `html[data-surface="web"]` toggles
   off-homepage (mirror pattern for cli default).
4. JS on load: if not homepage (no `#s-cli`), set `document.documentElement.dataset.surface` from storage.
5. Bundle and emit like `theme.js`; include in every shell.

**Patterns to follow:** homepage Full board dual links + `body:has(#s-web:checked)` in `site.css`; `theme.ts` storage
guards

**Test scenarios:**
- Missing key → `cli`, `leaderboardsHref()` → `/scorecards`
- Stored `web` → `/web`; invalid → `cli`
- Built `index.html`: two `[data-leaderboards-nav]` anchors with distinct hrefs
- CSS presence: nav-scoped `:has` rules (structural grep or snapshot comment in test)

**Verification:** unit tests green; dist homepage HTML has dual Leaderboards links + `/js/surface.js`

---

### U2. Homepage bind (restore + write)

**Goal:** Homepage segment is a preference writer/reader without breaking no-JS CSS.

**Requirements:** R4, R7; AE2, AE3, AE6

**Dependencies:** U1

**Files:**
- modify `src/client/surface.ts` (homepage bind when `#s-cli` / `#s-web` present)
- optionally touch `src/build/06-homepage.mjs` only if a data attribute helps discovery (prefer existing ids)
- modify `tests/e2e/flows.e2e.ts` (extend homepage surface toggle / nav href assertions)

**Approach:**
1. On load: if radios exist, check the radio matching stored preference (triggers existing `:has` for panes **and**
   Leaderboards nav — no separate nav rewrite).
2. On `change` of the radiogroup: `setSurface` + set `html[data-surface]` (keeps nav consistent if JS also runs).
3. Do not change Full board dual links; Leaderboards now mirrors that pattern in the header.

**Patterns to follow:** existing `.seg` / `#s-cli` / `#s-web` in `06-homepage.mjs`; e2e “homepage surface toggle”

**Test scenarios:**
- Covers AE2 / AE3: assert **relative transition** after selecting Website (href becomes `/web`, web pane visible) — do
  not hard-code pre-gesture ambient state (CI hosts may seed storage)
- Reload after write → radio + href persist
- Covers AE6: with JS disabled on `/`, select Website → **visible** header Leaderboards href is `/web` (assert the
  non-hidden anchor in `.site-nav`, not body Full board links)
- Leaderboards href assertions scoped to `.site-header` / `[data-leaderboards-nav]`, not whole-document link scans

**Verification:** e2e homepage + nav href checks pass under `bun run dev` Worker preview

---

### U3. Probe A on `/scorecards` and `/web`

**Goal:** Peer board switch that writes preference and navigates.

**Requirements:** R5–R6; AE4–AE5; KTD5

**Dependencies:** U1

**Files:**
- modify `src/build/scorecards-render.mjs` (hero segment)
- modify `src/worker/audit-web/leaderboard-render.ts` (hero segment; do **not** add a second surface script tag)
- modify `src/client/surface.ts` (bind Probe A segments via a shared selector, e.g. `[data-surface-board-seg]`)
- light CSS only if spacing in `.leaderboard-hero` is broken (reuse `.seg`; no layout redesign)
- modify `tests/web-audit-leaderboard-route.test.ts` and/or `tests/regression.test.ts` / e2e for segment presence +
  navigation

**Approach:**
1. Insert `.seg` above h1; mark with `data-surface-board-seg`; set checked state to current board.
2. On change to the other value: `setSurface` then `location.assign` peer URL.
3. Confirm load path does not call `setSurface` (AE5).

**Patterns to follow:** homepage `.seg` markup; web board’s existing filter row stays below hero

**Test scenarios:**
- Covers AE4: from `/scorecards`, choose Website → lands on `/web`, storage `web`
- Covers AE5: cold `/web` with empty storage → no write
- Built `/scorecards` HTML and Worker `/web` HTML both contain the board segment

**Verification:** unit/route tests see markup; e2e click switches boards and updates Leaderboards href

---

### U4. CONCEPTS + smoke (optional thin)

**Goal:** Name the preference in the glossary if useful; otherwise skip.

**Requirements:** none product-facing beyond discoverability

**Dependencies:** U1–U3

**Files:**
- optionally modify `CONCEPTS.md` (one short entry for visitor surface preference — distinct from “Content surface” /
  markdown twin)

**Test expectation:** none — glossary only

**Verification:** term matches shipped behavior if added

---

## Verification Contract

- `bun run build` then `bun test` (repo gate order: build before test)
- Targeted: `tests/surface.test.ts`, theme/install-cmd style unit patterns, `tests/e2e/flows.e2e.ts` surface +
  Leaderboards href, `tests/web-audit-leaderboard-route.test.ts` for `/web` hero segment
- E2e: assert post-gesture transitions (cli→web), not absolute initial theme/storage state
- Structural href checks: slice header chrome before asserting Leaderboards destination (body Full board links differ)
- Browser-verify: `/`, `/scorecards`, `/web` — toggle Website on homepage, confirm Leaderboards; Probe A both
  directions; cold `/web` does not flip nav until an explicit control

## Definition of Done

- [ ] R1–R8 satisfied; AE1–AE6 covered by tests or explicit browser check
- [ ] Shared helper used by homepage, boards, and shell — no duplicated storage keys/logic
- [ ] No stamp-on-visit; Audit nav untouched
- [ ] Build + unit + relevant e2e green; visual check of Probe A placement acceptable (polish deferred)

---

## Risks & Dependencies

| Risk                                                             | Mitigation                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| Probe A crowded next to web filters                              | Ship minimal hero placement; defer `/impeccable layout`   |
| Worker `/web` misses script if only on scorecards `extraScripts` | Sitewide shell script (KTD3)                              |
| Dual Leaderboards anchors confuse `aria-current` or nav layout   | Nav-scoped CSS; one visible at a time; test active states |
| Label-only query for Leaderboards link breaks                    | `data-leaderboards-nav` on both anchors                   |

## Sources & Research

- Repo patterns: `theme.ts`, `install-cmd.ts`, `shell.mjs`, homepage `:has` segment (`06-homepage.mjs`)
- Learnings (qmd): per-gesture persistence vs render flip; tri-state omit-don’t-false; header-scoped href tests;
  relative-transition e2e — see paths cited under KTD1/KTD4 and Verification Contract
- Gaps to capture post-ship if useful: no prior doc for `:has` segment on board heroes or dynamic Leaderboards href
