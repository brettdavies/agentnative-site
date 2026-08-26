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

**Stop when:** Leaderboards destination follows preference (dual-anchor visibility flip, not href rewrite); homepage
segment restores/writes preference; both boards expose Probe A that writes preference and navigates; post-nav focus on
`#main`; CONCEPTS documents preference + no-JS board gap; tests cover the preference helper and nav flip; no Audit
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
  Leaderboards stays `/scorecards` (no `#s-web` on page). Board pages: Probe A is JS-only; document the gap (see R9).
- **R8.** Audit primary-nav asymmetry is out of this plan.
- **R9.** Header **Leaderboards** always reflects **stored preference**, not the board currently displayed. A visitor on
  `/web` with empty storage still sees Leaderboards → `/scorecards` until an explicit control writes preference (AE5).
  Same when stored `web` but viewing `/scorecards`: nav shows `/web`. No pathname-based nav override.
- **R10.** After Probe A full-page navigation, move focus to `#main` (skip-link target) on the destination board so
  keyboard users land in content, not at document start.

### Key Decisions

- **KD1.** One shared client helper for get/set/href mapping — not per-page copies. `(session-settled: user-directed —
  chosen over per-page wiring: keep it compact)`
- **KD2.** Persist in `localStorage`. `(session-settled: user-directed — chosen over homepage-only ephemeral radios)`
- **KD3.** Board cross-nav is Probe A (segment), not quiet link / both. `(session-settled: user-approved — chosen over
  B/C; layout polish may follow via /impeccable)`
- **KD4.** Do not stamp on board visit. `(session-settled: user-directed — chosen over stamp-on-visit: preference only
  from explicit surface controls)`
- **KD5.** Boards this pass; Audit later. `(session-settled: user-directed)`
- **KD6.** Preference drives Leaderboards destination even when it disagrees with the current board URL — not a bug.
  `(session-settled: user-directed — chosen over pathname-reflects-current-board for nav display)`
- **KD7.** Board no-JS: homepage `:has` parity is the bar; board Probe A is JS-enhanced. Document the gap in-plan and in
  CONCEPTS. `(session-settled: user-directed — chosen over plain peer links in hero)`

### Scope Boundaries

**In:** shared preference module; shell Leaderboards hook + sitewide script; homepage bind; Probe A on both board
heroes; post-nav focus management; CONCEPTS entry; unit + e2e coverage.

**Out / deferred:** Audit nav parity; board-hero layout polish if A feels cramped next to Relative|Global / All|Curated;
plain peer links for no-JS board cross-nav; markdown-twin changes beyond existing board links; changing Full board from
dual-pane CSS to a single rewritten link.

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
- **AE7.** JS disabled on `/scorecards` or `/web` → board segment radios render but do not navigate; visitor uses footer
  or in-page links to switch boards. Documented limitation, not a failure.
- **AE8.** Probe A CLI → Website (or reverse) → destination `#main` receives focus; one-shot flag cleared.

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
  Absent/invalid key reads as `cli` — never treat “no choice” as an implicit `web`. `leaderboardsHref` is read-only
  (tests/diagnostics); production nav uses static dual anchors + CSS flip only. `(session-settled: user-directed —
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
  `/scorecards`, Website checked on `/web`. **Board segments use distinct radio ids** (e.g. `board-s-cli` /
  `board-s-web`) — never reuse homepage `#s-cli` / `#s-web` on board pages (global `body:has(#s-web:checked)` nav rules
  would fire on render-only checked state and violate AE5). Homepage `:has` nav rules stay scoped to homepage radios
  only. Clicking the already-current option is a no-op (no navigation). Layout polish deferred.
- **KTD6.** Post-nav focus (AE8): before `location.assign`, set one-shot `sessionStorage` flag (e.g.
  `anc-surface-nav-focus=1`); on board load in `surface.ts`, if flag present focus `#main` with `preventScroll: false`
  (natural scroll), then remove flag. Do not focus on cold bookmark/direct visits. Prefer `#main` over `h1` — matches
  skip-link landmark. `document.referrer` alone is insufficient (privacy stripping).

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

**Requirements:** R1–R3, R7; AE1, AE3 (off-home); KD1–KD2; KTD1–KTD4, KTD2b

**Dependencies:** none

**Files:**
- create `src/client/surface.ts`
- modify `src/build/01-assets.mjs` (bundle → `dist/js/surface.js`)
- modify `src/build/shell.mjs` (dual Leaderboards anchors; defer `/js/surface.js`)
- modify `src/styles/site.css` (`.site-nav` `:has` + scoped `html[data-surface]` flip rules; override global
  `[data-s="web"] { display: none }` inside `.site-nav` only)
- create `tests/surface.test.ts`
- modify `tests/build.test.ts` or `tests/regression.test.ts` (both anchors in dist shell)
- modify `tests/e2e/flows.e2e.ts` (nav link count: 7 total, 6 visible; one visible `[data-leaderboards-nav]`)

**Approach:**
1. Export get/set + surface→href map; default `cli` when missing/invalid.
2. Shell: special-case Leaderboards in nav — two `<a>` tags with `data-s` + `data-leaderboards-nav`;
   `aria-current="page"` only on the anchor whose href matches the current pathname (never on the hidden sibling).
3. CSS: homepage `body:has(#s-web:checked)` toggles which Leaderboards anchor shows (homepage `#s-cli`/`#s-web` only);
   `html:not(:has(#s-cli)) [data-surface="web"]` toggles off-homepage. Nav-scoped rules must override global
   `[data-s="web"] { display: none }`.
4. JS on load: if not homepage (no `#s-cli`), set `document.documentElement.dataset.surface` from storage.
5. Bundle and emit like `theme.js`; include in every shell.

**Patterns to follow:** homepage Full board dual links + `body:has(#s-web:checked)` in `site.css`; `theme.ts` storage
guards

**Test scenarios:**
- Missing key → `cli`, `leaderboardsHref()` → `/scorecards`
- Stored `web` → `/web`; invalid → `cli`
- Built `index.html`: two `[data-leaderboards-nav]` anchors with distinct hrefs
- AE1: cold visit, empty storage → visible CLI Leaderboards anchor href `/scorecards`
- AE3 (off-home): seed `web`, load `/about` (or post-Probe-A destination) → visible web anchor href `/web`
- AE5 (nav half): cold load `/web`, empty storage → visible CLI anchor href `/scorecards`; storage unchanged
- CSS presence: nav-scoped `:has` and `[data-surface]` rules (structural grep or snapshot comment in test)

**Verification:** unit tests green; dist homepage HTML has dual Leaderboards links + `/js/surface.js`

---

### U2. Homepage bind (restore + write)

**Goal:** Homepage segment is a preference writer/reader without breaking no-JS CSS.

**Requirements:** R4, R7; AE2, AE3 (homepage half); KTD4 (homepage writer/reader)

**Dependencies:** U1

**Files:**
- modify `src/client/surface.ts` (homepage bind when `#s-cli` / `#s-web` present)
- optionally touch `src/build/06-homepage.mjs` only if a data attribute helps discovery (prefer existing ids)
- modify `tests/e2e/flows.e2e.ts` (extend homepage surface toggle / nav href assertions; visible nav link count)

**Approach:**
1. On load: if radios exist, check the radio matching stored preference (triggers existing `:has` for panes **and**
   Leaderboards nav — no separate nav rewrite).
2. On `change` of the radiogroup: `setSurface` only. Do **not** set `html[data-surface]` when `#s-cli`/`#s-web` exist
   (KTD2b: homepage nav is `:has`-only).
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

**Requirements:** R5–R6; AE4–AE5; KTD4 (board render-only, no stamp-on-visit); KTD5

**Dependencies:** U1

**Files:**
- modify `src/build/scorecards-render.mjs` (hero segment with `board-s-cli` / `board-s-web` ids)
- modify `src/worker/audit-web/leaderboard-render.ts` (hero segment in **both** populated and empty branches; do **not**
  add a second surface script tag)
- modify `src/client/surface.ts` (bind Probe A segments via `[data-surface-board-seg]`)
- light CSS only if `.leaderboard-hero` `.seg` margin/padding is illegible (no filter-row or grid redesign)
- modify `tests/web-audit-leaderboard-route.test.ts` and/or `tests/regression.test.ts` / e2e for segment presence +
  navigation

**Approach:**
1. Extract shared hero prefix (Probe A + h1 + lede) for web board populated **and** empty paths. Use distinct board
   radio ids; `role="radiogroup"` `aria-label="Leaderboard surface"`.
2. On change to the other value: set focus flag (KTD6), `setSurface`, then `location.assign` peer URL.
3. On board load: run focus-restoration reader when flag set (KTD6).
4. Confirm load path does not call `setSurface` (AE5 on both `/web` and cold `/scorecards`).

**Patterns to follow:** homepage `.seg` markup (semantics only — not ids); web board’s existing filter row stays below
hero

**Test scenarios:**
- Covers AE4: from `/scorecards`, choose Website → lands on `/web`, storage `web`
- Covers AE4 reverse: from `/web`, choose CLI → lands on `/scorecards`, storage `cli`
- Covers AE5: cold `/web` and cold `/scorecards` with empty storage → no write; Leaderboards stays CLI default
- Covers AE8: after Probe A navigate, `#main` is focused (e2e `document.activeElement` or Playwright focus check)
- Built `/scorecards` HTML and Worker `/web` HTML (including empty board) both contain the board segment

**Verification:** unit/route tests see markup; e2e click switches boards both directions; post-nav Leaderboards on
destination page via U1 `data-surface` load reader; focus lands on `#main`

---

### U4. CONCEPTS entry + no-JS board gap

**Goal:** Glossary term for visitor surface preference; explicit no-JS limitation on board cross-nav.

**Requirements:** R9; KD7; AE7

**Dependencies:** U1–U3

**Files:**
- modify `CONCEPTS.md` (entry **Visitor surface preference** — `cli` | `web`, `localStorage` key, drives Leaderboards +
  homepage segment; distinct from “Content surface” / markdown twin)
- add short **No-JS board cross-nav** note under Scope Boundaries or Risks in this plan if not already sufficient

**Approach:**
1. One glossary entry: writers (homepage segment, Probe A), readers (dual nav + `:has` on `/`), no stamp-on-visit,
   preference-wins nav policy (R9).
2. State board Probe A requires JS; homepage has full no-JS parity (AE6 vs AE7).

**Test expectation:** none — glossary only

**Verification:** CONCEPTS entry matches shipped behavior; AE7 limitation documented

---

## Verification Contract

- `bun run build` then `bun test` (repo gate order: build before test)
- Targeted: `tests/surface.test.ts`, theme/install-cmd style unit patterns, `tests/e2e/flows.e2e.ts` surface +
  Leaderboards href, `tests/web-audit-leaderboard-route.test.ts` for `/web` hero segment
- E2e: assert post-gesture transitions (cli→web), not absolute initial theme/storage state
- Structural href checks: slice header chrome before asserting Leaderboards destination (body Full board links differ)
- Browser-verify: `/`, `/scorecards`, `/web` — toggle Website on homepage, confirm Leaderboards; Probe A both
  directions; cold `/web` does not flip nav until an explicit control; Probe A lands focus in `#main`
- Keyboard: Tab after Probe A → focus in main content, not re-trapped in header

## Definition of Done

- [ ] R1–R10 satisfied; AE1–AE8 covered by tests or explicit browser check
- [ ] Shared helper used by homepage, boards, and shell — no duplicated storage keys/logic
- [ ] Dual Leaderboards anchors keep fixed hrefs (visibility flip only; no JS href rewrite); `surface.js` on all pages
  including Worker `/web`
- [ ] No stamp-on-visit on `/web` or `/scorecards`; Audit nav untouched
- [ ] Build + unit + relevant e2e green
- [ ] Browser-verify: `/`, `/scorecards`, `/web` — homepage toggle, Probe A both directions, cold `/web` no stamp,
  post-nav focus in `#main`
- [ ] Probe A placement acceptable (layout polish deferred); U4 CONCEPTS entry + no-JS board gap documented

---

## Risks & Dependencies

| Risk                                                             | Mitigation                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Probe A crowded next to web filters                              | Ship minimal hero placement; defer `/impeccable layout`                                                            |
| Worker `/web` misses script if only on scorecards `extraScripts` | Sitewide shell script (KTD3)                                                                                       |
| Dual Leaderboards anchors confuse `aria-current` or nav layout   | Nav-scoped CSS; one visible at a time; `aria-current` on href-matching anchor only (R9: may differ from board URL) |
| Nav preference ≠ current board confuses visitors                 | Intentional (R9/KD6); CONCEPTS explains preference-wins policy                                                     |
| Board no-JS cannot use Probe A                                   | Documented (R7/AE7/KD7); homepage has full no-JS parity                                                            |
| Post-nav focus fires on bookmark visit                           | One-shot sessionStorage flag only (KTD6), not referrer                                                             |
| Label-only query for Leaderboards link breaks                    | `data-leaderboards-nav` on both anchors                                                                            |

## Sources & Research

- Repo patterns: `theme.ts`, `install-cmd.ts`, `shell.mjs`, homepage `:has` segment (`06-homepage.mjs`)
- Learnings (qmd): per-gesture persistence vs render flip; tri-state omit-don’t-false; header-scoped href tests;
  relative-transition e2e — see paths cited under KTD1/KTD4 and Verification Contract
- Gaps to capture post-ship if useful: no prior doc for `:has` segment on board heroes or dynamic Leaderboards href
