---
title: agentnative-site v0 scaffold — ordered milestone commits
type: feat
status: active
date: 2026-04-14
origin: /home/brett/.gstack/projects/brettdavies-agentnative-site/brett-main-build-plan-20260414-130000.md
---

# agentnative-site v0 scaffold — ordered milestone commits

## Overview

Translate the locked build plan into 8 ordered milestones, each a single reviewable commit that leaves the repo in a
working state. No re-planning, no re-opening decisions. After M8, `wrangler dev` runs locally and `wrangler deploy`
pushes a noindex staging build to `agentnative-site.<brett>.workers.dev`.

**Working directory:** `/home/brett/dev/agentnative-site`. All paths below are repo-relative.

**Authoritative inputs (already read, not restated):**

- `brett-main-build-plan-20260414-130000.md` — target tree, pipeline, wrangler.jsonc shape, five locked decisions.
- `brett-main-eng-review-20260414-123800.md` — A1–A12, C1–C7, §12 edit list, §9 parallelization lanes.
- `brett-main-eng-review-test-plan-20260414-123800.md` — Playwright coverage requirements.
- `DESIGN.md` (rev 2), `AGENT.md`, `VOICE.md`, `.impeccable.md`, `TODOS.md`, `content/**`.

## Consistency check across inputs

The three planning docs agree on all load-bearing decisions. One intentional supersession worth flagging so a fresh
agent does not re-litigate it:

- **Eng review §1 "new files" list** names `templates/shell.html` and `worker/worker.ts`. The build plan target tree
  supersedes: the shell lives as `src/build/shell.mjs` (a JS emitter, not a static template), and the Worker lives under
  `src/worker/{index,accept,headers}.ts`. Build plan wins; eng-review entries are early shorthand for the same surfaces.

No other contradictions surfaced. The eng review's §12 edit list to DESIGN.md has **not** been applied yet (verified
2026-04-14 — no "copied from repo-root" string and no shell.mjs reference present in DESIGN.md). §12 edits land in M1.

## Scope boundaries

- No content edits. `content/**` is drafted; voice/typography iteration happens post-launch via /impeccable, /typeset,
  /clarify.
- No production-domain attach. Staging-only until `agentnative` v0.1 on crates.io (AGENT.md §Tool-site sequencing).
  Brett-only task.
- No TODOS.md P1–P5 work.
- No Cloudflare Workers Builds setup. Deploy is GHA-only per locked decision #1.
- No re-generating `public/og-image.png`, `docs/design/foundation.css`, or `scripts/og/generate.py` — all committed
  artifacts.

## Pinned scaffolding choices (flag to Brett — recommended defaults, easy to flip)

These are the genuinely-ambiguous choices the prompt called out. Recommendations ship in the plan; any can be flipped
before M3/M4 land.

1. **`accepts` npm pin.** `accepts@^1.3.8` — latest stable, mature, the de-facto q-value parser. ~3 KB bundled. If you
   want to pin exact, `1.3.8`.
2. **Shiki API.** Use `shiki@^1` with the singular `createHighlighter` (not the legacy `getHighlighter`). Config:
   `themes: { light: 'github-light', dark: 'github-dark-dimmed' }`, `defaultColor: false`, plus the CSS bridge from eng
   review A7 living in `dist/css/site.css`.
3. **`rehype-autolink-headings` behavior.** `behavior: 'append'`, inline SVG anchor icon in `content`, class
   `['anchor']`, `properties: { ariaLabel: 'Permalink', tabIndex: -1 }`. The `#p<n>-<slug>` id itself is produced by
   `rehype-slug` and must match DESIGN.md §3.5 locked slugs (enforced by regression test M3).

If any of the three are wrong, flip before merging M3/M4. None are one-way doors.

## Three CRITICAL REGRESSION tests (must land in M3, not deferred)

1. **Anchor-slug snapshot** vs DESIGN.md §3.5's seven locked slugs — fails on drift.
2. **llms.txt shape snapshot** — H1 + summary + H2 "Principles" + 7 `.md` entries.
3. **Markdown byte-equivalence** — `sha256(dist/p<n>.md) == sha256(content/principles/p<n>-*.md)`.

---

## Milestones

### M1 — Repo scaffold + planning-surface alignment

**Goal:** Land the inert foundation: config files, tsconfig, lint, gitignore, and apply the DESIGN.md §12 edit list.
No code runs yet. One reviewable commit.

**Files touched (create unless noted):**

- `package.json` (bun workspace root, scripts, shared deps)
- `bun.lock` (produced by `bun install`)
- `tsconfig.json`
- `wrangler.jsonc` (shape from build plan §Distribution; `account_id: REDACTED`)
- `biome.json`
- `.editorconfig`
- `.gitignore` (modify: append `dist/`, `node_modules/`, `.wrangler/`, `*.tsbuildinfo`)
- `DESIGN.md` (modify: apply every §12 bullet verbatim — A1 satori fix, A3 accepts wording, A8 header values, A12
  env.ASSETS pin, A2 CSS/font/JS sub-table, A4 flat-layout + Asset resolution sub-section, A5 llms-full delimiter, A7
  Shiki config + CSS bridge, A6/C2 remark plugin spec, A11/C4 font supply chain, C1 §4.8.1 perf budget, C6 no-JS
  pattern, P4 cache headers, A10 404 policy)
- `AGENT.md` (modify: add two rows to §Cross-repo table — `brett-main-build-plan-20260414-130000.md` and
  `brett-main-eng-review-20260414-123800.md`)
- `.github/workflows/guard-main-docs.yml` — **do not touch** (already gating main per prompt).

**Acceptance criteria:**

- `bun install` exits 0 and produces `bun.lock`.
- `bun run lint` exits 0 (no targets yet; Biome + markdownlint pass trivially).
- `rg "satori" DESIGN.md` returns zero hits after the A1 edit.
- `rg "env.ASSETS" DESIGN.md` returns ≥1 hit (A12 pin present).
- `git diff AGENT.md` shows the two new cross-repo rows.

**Parallel-with:** none. Foundation; M2–M7 build on top.

**Rollback:** `git revert` the commit. Repo returns to 27d53c2-or-later state.

---

### M2 — Font supply chain

**Goal:** One-shot pull of Uncut Sans + Monaspace Xenon variable woff2 from vendors, verified hashes committed.

**Files touched:**

- `scripts/fonts/download.sh` (pulls from Pangram Pangram and GitHub Next per eng review A11/C4)
- `scripts/fonts/hashes.txt` (sha256 of the two woff2 files)
- `public/fonts/uncut-sans-variable.woff2` (binary, committed)
- `public/fonts/monaspace-xenon-variable.woff2` (binary, committed)
- `public/robots.txt` (permissive baseline; staging noindex lives in Worker code per locked decision #4)

**Acceptance criteria:**

- `bash scripts/fonts/download.sh --verify` exits 0 (re-downloads to a tmp dir and sha-checks against `hashes.txt`).
- Both woff2 files exist under `public/fonts/` with non-zero size.
- `file public/fonts/*.woff2` identifies them as WOFF2 Font data.

**Parallel-with:** M3, M4, M7 (disjoint files). Gates M5 (CSS pipeline needs fonts on disk).

**Rollback:** `git revert`. No runtime effect.

---

### M3 — Build core + rfc-keyword plugin + three REGRESSION tests

**Goal:** A runnable build that emits `dist/` with 9 HTML pages, 9 markdown twins, and the three critical regression
snapshots green from day one. No CSS or assets yet — that is M5.

**Files touched:**

- `src/build/build.mjs` (orchestrator; pipeline steps 1–9 from build plan §Pipeline order)
- `src/build/render.mjs` (unified + remark-parse + remark-gfm + rehype-slug + rehype-autolink-headings + shiki with
  pinned config from "Pinned scaffolding choices" above)
- `src/build/plugins/rfc-keywords.mjs` (regex `/\b(MUST(?: NOT)?|SHOULD(?: NOT)?|MAY)\b/g`, ancestor exclusions
  `code`/`inlineCode`/`link`, nested-`<strong>` annotation per A6)
- `src/build/llms.mjs` (llms.txt + llms-full.txt with per-section `Source:` / `Canonical-Markdown:` headers per A5)
- `src/build/sitemap.mjs` (9 canonical URLs, extension-less, no trailing slash)
- `tests/build.test.ts` (sortedGlob numeric order, parseFilename, rfc-keyword regex cases from eng review C2 + §3
  diagram: MUST NOT, MUSTARD, inlineCode exclusion, link exclusion, `**MUST:**` nested case, lowercase `must`)
- `tests/regression.test.ts` (the three critical snapshots: anchor-slug set, llms.txt shape, md byte-equivalence)

**Acceptance criteria:**

- `bun run build` exits 0.
- `ls dist/{index,p1,p2,p3,p4,p5,p6,p7,check,about}.html dist/{index,p1,p2,p3,p4,p5,p6,p7,check,about}.md
  dist/{llms.txt,llms-full.txt,sitemap.xml}` lists 22 files, all non-empty.
- `bun test` passes, including all three regression snapshots.
- `rg -c "id=\"p1-non-interactive-by-default\"" dist/index.html` returns 1 (and analogously for p2–p7).

**Parallel-with:** M4 (Worker) — disjoint modules (`src/build/**` vs `src/worker/**`). M7 (CI) — independent file.

**Rollback:** `git revert`. `dist/` is gitignored; no committed artifacts affected.

---

### M4 — Worker + CN + headers + worker tests

**Goal:** `src/worker/` implements content-negotiation with proper q-value parsing, emits the pinned response headers,
and applies the staging-noindex guard. Tests cover the CN decision table.

**Files touched:**

- `src/worker/index.ts` (~80 lines; fetch handler; CN branching; URL rewrite for markdown branch; env.ASSETS.fetch)
- `src/worker/accept.ts` (thin wrapper around `accepts` npm; returns `'html' | 'markdown'`)
- `src/worker/headers.ts` (Link rel=alternate, X-Llms-Txt, X-Robots-Tag on .md, Cache-Control per asset class,
  three-line `.workers.dev` host guard)
- `tests/worker.test.ts` (full decision table from eng review §3 diagram: `/p3` no Accept → HTML; `/p3.md` any → md;
  `/p3` `Accept: text/markdown` → md; `/p3` `text/html,text/markdown;q=0.9` → HTML; `/p3` `*/*` → HTML; malformed →
  HTML; `text/markdown,text/html;q=0.9` → md. Header assertions: Link, X-Llms-Txt, X-Robots-Tag, Cache-Control.
  Staging-host guard: `.workers.dev` host ⇒ X-Robots-Tag on all responses.)

**Acceptance criteria:**

- `bun test tests/worker.test.ts` passes every row of the CN decision table.
- `bun x wrangler deploy --dry-run` exits 0 (validates `wrangler.jsonc` + bundles the Worker).
- `bun x wrangler types` emits `@cloudflare/workers-types`-compatible bindings for `env.ASSETS`.

**Parallel-with:** M3 (disjoint `src/build/**` vs `src/worker/**`). M7.

**Rollback:** `git revert`. Worker is not yet deployed; no production effect.

---

### M5 — CSS pipeline + HTML shell + client JS + asset copy

**Goal:** Make `bun run dev` serve a themed, styled, interactive local site. Combines the remaining build modules,
shell emitter, client JS bundles, and asset copy. Depends on M2 (fonts) and M3 (build core).

**Files touched:**

- `src/build/shell.mjs` (HTML shell emitter: head with JSON-LD, OG tags, inlined theme-init script, preload font links,
  `<link>` to foundation.css + site.css; body with skip-link, header/footer, `<main>` slot; mini-TOC only on `/`)
- `src/build/assets.mjs` (copy `docs/design/foundation.css` → `dist/css/foundation.css` byte-equivalent; copy
  `public/fonts/*` → `dist/fonts/`; copy `public/og-image.png` → `dist/og-image.png`; copy `public/robots.txt` →
  `dist/robots.txt`; emit `dist/css/site.css` from a `src/build/templates/site.css.tmpl` or inline string with
  `@font-face` + layout + Shiki CSS bridge + code-block/copy-button/toggle rules from DESIGN.md §4)
- `src/client/theme-init.ts` (~15 lines; inline-head script per DESIGN.md §4.9; reads localStorage; adds `.js` class to
  root for C6 progressive enhancement)
- `src/client/theme.ts` (~40 lines; 3-button toggle; aria-pressed; matchMedia listener for `system` state)
- `src/client/clipboard.ts` (~40 lines; `<pre>` copy + anchor-copy; Clipboard API with execCommand fallback)
- `src/build/build.mjs` (modify: wire in shell.mjs, assets.mjs, client JS builds as pipeline steps 10–16; add invariant
  check step 17 — no MUST/SHOULD/MAY inside `<code>`/`<pre>`/`<a>`, all 7 locked slugs present, md byte-equivalence
  re-checked)

**Acceptance criteria:**

- `bun run build` emits full file set matching the canonical `dist/` layout from the prompt.
- `diff <(cat docs/design/foundation.css) <(cat dist/css/foundation.css)` is empty (byte-equivalent copy — C3 DRY).
- `bun run dev` (runs build then `wrangler dev --local`) serves `http://localhost:8787/` showing `/` with theme toggle
  visible and functional. Manual: click dark → page is dark; reload → still dark (localStorage persists).
- `curl -s http://localhost:8787/p3 | rg "font-family"` returns non-empty (site.css loaded).
- `curl -sH 'Accept: text/markdown' http://localhost:8787/p3 | sha256sum` matches `sha256sum
  content/principles/p3-progressive-help-discovery.md`.
- `curl -sI http://localhost:8787/p3 | rg "^Link: </p3.md>; rel=\"alternate\""` matches.
- `curl -sI http://localhost:8787/p3 | rg "^X-Robots-Tag: noindex"` matches (host is `localhost` — but dev passes
  `workers.dev`-equivalent? actually `localhost` so noindex does NOT fire. The check fires only against `.workers.dev`
  hosts; dev server smoke only verifies the non-noindex path.)

**Parallel-with:** sequential — depends on M2 + M3 + M4 merged. M7 can still run in parallel.

**Rollback:** `git revert`. M3 build still works (emits HTML/md twins minus styling + client JS).

---

### M6 — Playwright + Lighthouse + axe

**Goal:** End-to-end coverage of the test plan's Critical Paths and Key Interactions against a live `wrangler dev`.
Lighthouse budget enforcement at the 400 KB first-page ceiling.

**Files touched:**

- `tests/playwright/flows.spec.ts` (human critical paths: HN cold-land → scroll `#p3` → copy code → theme dark → reload
  → still dark + anchored; keyboard-only nav; skip-link; copy-anchor-link; mini-TOC clicks; mobile 375px layout shift)
- `tests/playwright/agents.spec.ts` (curl flows from test plan §Critical Paths: `/p3` vs `/p3.md`; Accept variants incl.
  q-aware; `/llms.txt` shape; `/llms-full.txt` single-fetch; HEAD `/p3` Link header)
- `tests/playwright/og.spec.ts` (parse OG + Twitter card meta from `/`; validate og:image 1200×630; opengraph.xyz smoke
  via network-idempotent assertion on meta tags present)
- `.lighthouserc.json` (perf ≥95 desktop + mobile; a11y ≥95; resource-size total ≤400 KB gz on `/p1`;
  `collect.startServerCommand: "bun run dev"`, `collect.url: ["http://localhost:8787/p1"]`)
- `package.json` (modify: add `"test:e2e": "playwright test"`, ensure `@lhci/cli`, `axe-playwright`, `playwright` in
  `devDependencies`)

**Acceptance criteria:**

- `bun x playwright install --with-deps chromium` completes.
- `bun run test:e2e` passes against a local `wrangler dev`.
- `bun x @lhci/cli autorun` passes the four budget assertions.
- `axe` finds zero serious/critical accessibility violations on `/` and `/p1`.

**Parallel-with:** M7 (disjoint files). Sequential on M5.

**Rollback:** `git revert`. Nothing in `src/` depends on the test files.

---

### M7 — CI workflow

**Goal:** `.github/workflows/ci.yml` gates every PR. Required check.

**Files touched:**

- `.github/workflows/ci.yml` (on pull_request: bun install --frozen-lockfile → `bun run lint` → `bun run build` → `bun
  test` → `bun x playwright install --with-deps chromium` → `bun run test:e2e` → `bun x @lhci/cli autorun` → `bun x
  wrangler deploy --dry-run`). Uses `oven-sh/setup-bun@v2`, `actions/checkout@v4`. Concurrency group per PR to cancel
  superseded runs.

**Acceptance criteria:**

- `actionlint .github/workflows/ci.yml` exits 0 (no syntax or action-version errors).
- After push to a PR branch, the CI workflow runs all steps and exits green on a trivial no-op commit on top of M6.
- Required-status-check configured on `main` branch protection (Brett task; outside agent scope).

**Parallel-with:** M1–M6 — entirely independent file. Can start as soon as M1 lands (needs `package.json` scripts to
exist).

**Rollback:** delete the workflow file and `git commit`. Branch protection can be relaxed on dashboard if needed.

---

### M8 — Deploy workflow + first staging deploy

**Goal:** `.github/workflows/deploy.yml` pushes to `agentnative-site.<brett-subdomain>.workers.dev` on merge to main.
First manual staging smoke before relying on push-to-main.

**Files touched:**

- `.github/workflows/deploy.yml` (on push to main: checkout → setup-bun → `bun install --frozen-lockfile` → `bun run
  build` → `cloudflare/wrangler-action@v3` with `apiToken: ${{ secrets.CF_API_TOKEN }}` and `accountId: ${{
  secrets.CF_ACCOUNT_ID }}`). Concurrency group `deploy-main` with `cancel-in-progress: false` so a slow deploy is not
  killed mid-flight.

**Prerequisite (Brett, outside agent scope):**

- `CF_API_TOKEN` created with `Workers Scripts:Edit` + `Account:Read` scope, added as repo secret.
- `CF_ACCOUNT_ID` added as repo secret (`REDACTED`).

**Acceptance criteria:**

- `actionlint .github/workflows/deploy.yml` exits 0.
- First successful run of `deploy.yml` publishes the Worker. `wrangler deployments list --name agentnative-site` shows
  one deployment.
- `curl -sI https://agentnative-site.<brett-subdomain>.workers.dev/p3 | rg "^X-Robots-Tag: noindex"` matches (host ends
  with `.workers.dev` → staging noindex fires).
- `curl -s https://<...>.workers.dev/llms.txt | head -5` shows valid llmstxt.org shape.
- `curl -sH 'Accept: text/markdown' https://<...>.workers.dev/p3 | sha256sum` matches `sha256sum
  content/principles/p3-progressive-help-discovery.md`.
- Workers Observability (via cloudflare-observability MCP) shows request logs — sanity-check post-deploy.

**Parallel-with:** none — last milestone.

**Rollback:**

1. `bun x wrangler rollback` (reverts to prior deployment if one exists).
2. Failing that, `bun x wrangler delete agentnative-site` to remove the Worker entirely. Repo stays intact.
3. If token leaks: `CF_API_TOKEN` rotate via Cloudflare dash → update GHA secret.

---

## Parallelization map

```text
M1 (scaffold) ──► M2 (fonts)   ─┐
              └─► M3 (build)   ─┤
              └─► M4 (Worker)  ─┼──► M5 (CSS + shell + client) ──► M6 (E2E) ─┐
              └─► M7 (CI)       ┘                                             ├─► M8 (deploy)
                                                                             ─┘
```

**Lanes after M1:**

- **Lane A (build):** M3.
- **Lane B (Worker):** M4.
- **Lane C (assets):** M2.
- **Lane D (CI):** M7.
- All four are file-disjoint; safe to run in parallel worktrees.
- **M5** joins A + C once both land.
- **M6** sequential after M5.
- **M8** after M6 + M7 (so first deploy is gated by the same CI that future PRs use).

## Sources & References

- Origin (build plan):
  `/home/brett/.gstack/projects/brettdavies-agentnative-site/brett-main-build-plan-20260414-130000.md`
- Eng review: `/home/brett/.gstack/projects/brettdavies-agentnative-site/brett-main-eng-review-20260414-123800.md`
- Test plan:
  `/home/brett/.gstack/projects/brettdavies-agentnative-site/brett-main-eng-review-test-plan-20260414-123800.md`
- CEO plan: `/home/brett/.gstack/projects/brettdavies-agentnative-site/ceo-plans/2026-04-13-spec-site.md`
- Architectural pattern: `docs/solutions/architecture-patterns/agent-native-documentation-surface-2026-04-13.md`
- DESIGN.md rev 2 (this repo) — §3.4.1 build contract, §3.5 locked slugs, §4 visual system.
- AGENT.md (this repo) — tool-site sequencing, domain ownership gate.

## Handoff

Run `/ce-work` against this plan. Start at M1 and proceed sequentially until M2/M3/M4/M7 can fan out; merge back for
M5, then M6, then M8. Each milestone is one commit.

Do NOT start /ce-work from this file — Brett reviews the milestone list first.
