---
title: 'feat: /score/live parity with /score/<slug> + curated-tool redirect'
type: feat
status: shipped
date: 2026-06-01
shipped: 2026-06-01
origin: 'pre-release polish session, 2026-06-01 — review of the live-scored share-URL surface found it rendered a thin summary while the static path rendered the full scorecard. Documented retroactively for the historical record of the release-readiness work.'
pr: 'brettdavies/agentnative-site#139 (squash merge `3e886c8`)'
---

# feat: /score/live parity with /score/&lt;slug&gt; + curated-tool redirect

> **Retrospective plan.** This document was written after the work shipped (PR #139, merged 2026-06-01 to `dev`).
> The Implementation Units below describe the change as it landed, not as a forward-looking proposal. Each unit
> cites the specific commit on the merged branch and the files actually touched. The intent is to preserve the
> reasoning behind the change alongside the other plans in `docs/plans/` so future scorecard-surface work has the
> same shared context that brainstorm-sourced plans carry.

---

## Summary

Pre-release review of the `/score/live/<binary>` route (the live-scored share-URL surface) surfaced that it rendered a
thin summary — header, score badge, top-3 issues, install-anc CTA — while the static `/score/<slug>` route rendered the
full scorecard (coverage table, audience banner, full audit groups, details, embed snippet, reproduce CTA). Same
underlying JSON shape; two divergent renderers.

Three changes shipped under one squash-merged PR:

1. Collapse the two renderers into one body builder and one markdown builder in `src/shared/scorecard-format.mjs`. Both
   `/score/<slug>` (build-emitted static page) and `/score/live/<binary>` (Worker route) now call the same function. The
   `live` URL segment is informational about where the scorecard came from (R2 cache vs committed
   `scorecards/<slug>.json`), not a different render shape.
2. Split the live header so the binary/anc/spec/freshness line renders as a small meta paragraph below the h1 instead of
   being inlined into the h1 (where it inherited h1 typography in the first draft).
3. Refuse to render registry-curated tools at `/score/live/<binary>`. Any binary matching a registry entry (by name or
   by binary-alias such as `rg` for `ripgrep`) 301-redirects to `/score/<slug>`.

---

## Problem Frame

The live-scored route was originally scoped as a "paste-and-share summary" — a deliberately reduced surface so that the
curated `/score/<slug>` pages stayed the canonical deep-dive view. Over time, three forces eroded that boundary:

- The Worker now receives the same JSON shape the build pipeline writes to `scorecards/<slug>.json` (both invoke `anc
  audit --command <binary> --output json`), so there is no data-shape reason for the two surfaces to render differently.
- The pre-release review found that a live-scored binary scored 92% with one failing check rendered as "no context for
  what passed, no reproduce command, no embed snippet". Users on the share URL had less information than users on the
  curated leaderboard for an equivalent scorecard, with no way to escape to a richer view.
- The two renderers had already drifted on small details (issue heading levels, classnames, footer copy) and would
  continue to drift without a shared source of truth.

A secondary problem: the route lookup at `/score/live/<binary>` had no registry awareness. A directly-constructed URL
for a curated tool (`/score/live/anc`), or a stale R2 cache entry written before that binary was added to the registry,
would render the curated scorecard at the live path. The homepage POST flow already short-circuited via the registry
fast-path, but the share-URL GET path did not.

---

## Requirements

- **R1.** `/score/live/<binary>` HTML renders the same section structure as `/score/<slug>` HTML: breadcrumb, header,
  score + principles badges, coverage table (when present), audience banner (when present), top issues, full audit
  groups P1 through P8 plus Code Quality, details block, embed-or-below-floor block, reproduce CTA. The class names and
  section ordering match so the existing site CSS applies without changes.
- **R2.** `/score/live/<binary>.md` (and `Accept: text/markdown` on the no-suffix path) renders the same markdown shape
  as `/score/<slug>.md`. Principle links are absolute (`https://anc.dev/p3`) because this surface is consumed
  cross-origin via Accept negotiation and does not get the build's `absolutifyMarkdownLinks` post-pass.
- **R3.** Editorial fields (tier badge, description, language, repo/url link, install row) appear only on the static
  path. They are absent for live-scored binaries because no registry entry exists.
- **R4.** Live-only signals (freshness marker "cached" / "just scored", "Score another" breadcrumb back-link) appear
  only on the live path.
- **R5.** A registry-curated binary at `/score/live/<binary>` returns 301 to `/score/<slug>`. Coverage: binary ===
  entry.name (anc, bat, fd) AND binary === entry.binary (alias entries: ripgrep/rg, ast-grep/sg, bottom/btm). The `.md`
  suffix and `Accept: text/markdown` header propagate through the redirect.
- **R6.** When `registry-index.json` is unavailable (asset fetch failure), the redirect check is skipped and the live
  path proceeds rather than 5xx-ing the surface. A future request retries.
- **R7.** Public function signatures on the build side (`buildScorecardBody`, `buildScorecardMarkdown` in
  `src/build/scorecards-render.mjs`) are preserved via positional wrappers. Existing callers and tests work unchanged.

Success criteria:

- Visual parity between `/score/anc` and `/score/live/anc` (seeded against a real-shape scorecard).
- All 760 pre-existing tests pass plus the 7 new redirect tests added in `tests/score-live-page.test.ts`.
- `bun run build` emits the same scorecard page count and badge SVG count as before (no static-side regression).
- `wrangler dev --env staging --local` confirms the redirect fires for `anc` and `rg`, returns 200 for a seeded
  non-registry binary, and preserves the `.md` suffix through both the explicit and Accept-header paths.

---

## Key Technical Decisions

- **One renderer, optional editorial fields.** The shared `buildScorecardBody(tool, scorecard, opts)` accepts a minimal
  `tool` (`{ name, binary }`) and emits only the sections that have data. Header description, tier badge, language tag,
  repo link, install row, and badge SVG preview are gated on the corresponding `tool.*` field being present. The static
  path passes the full registry-editorial tool; the live path passes the minimal scorecard-derived tool. No `if
  (isLive)` branches in the renderer.
- **`titleSuffix` and `headerSubline` opts replace the original inline-into-h1 freshness marker.** A first draft packed
  the binary/anc/spec/freshness line into the h1 via a `freshnessMarker` opt, which caused h1 typography inflation on
  the rendered page (caught during cowsay verification). The fix split into two opts: `titleSuffix` trails the h1 text
  (live: version pill), `headerSubline` renders as a small meta paragraph below (live: binary, anc, spec, freshness).
  The static path passes neither opt and its header is byte-identical to before.
- **Shared registry-index loader.** `loadRegistryIndex` moved from `src/worker/score/handler.ts` to
  `src/worker/score/registry-lookup.ts` (co-located with `RegistryIndex`). The module-scope promise cache is a singleton
  across the Worker isolate, so `/api/score` and `/score/live/<binary>` read the same in-memory copy. `handler.ts`'s
  `_resetIndexCache` delegates to `_resetRegistryIndexCache` for the registry slice; hint-index loading stays in
  handler.ts (no second consumer yet).
- **`resolveCuratedSlug(binary, registryIndex)` covers both match modes.** Fast path is `by_slug[binary]` (catches
  name-match: most tools). Fallback is an O(n) scan for entries where `entry.binary === binary` (catches alias entries).
  The corpus is ~100 entries; iteration cost is negligible. Returns the canonical registry name (the tool's `name`, not
  `binary`) so the redirect always lands on the canonical slug.
- **Redirect honors content negotiation.** `Accept: text/markdown` on the no-suffix path resolves to a 301 with
  `Location: /score/<slug>.md`, mirroring the rest of the site's redirect policy. A `.md` suffix on the live path
  preserves to `.md` on the static path.
- **Asset-fetch failure on the registry-index check is a soft fail.** Rather than 5xx-ing the live page when the asset
  fetch fails, the redirect step is skipped and the live cache lookup proceeds. A future request retries the asset
  fetch. Reasoning: the registry-curated set rarely includes the binaries that organically land at
  `/score/live/<binary>` (the homepage POST flow already short-circuits curated tools), so a transient asset miss during
  this defense-in-depth check should not block the live path.
- **No new CSS.** All sections render with existing `.scorecard-*`, `.audit-*`, `.coverage-level-table`,
  `.scorecard-embed--*` rules from `src/styles/site.css`. The live page picks up the same visual treatment as the static
  page for free.

---

## Scope Boundaries

### In scope

- Single shared `buildScorecardBody` / `buildScorecardMarkdown` in `src/shared/scorecard-format.mjs`.
- Single set of shared helpers (`computePrincipleScore`, `renderAuditRows`, `renderCoverageSummary`,
  `renderAudienceBanner`, `formatDuration`, `formatStartedAt`, `getAncBuildVersion`, `BADGE_ELIGIBILITY_FLOOR_PCT`) in
  shared, with back-compat re-exports from their original modules.
- Worker live route thin-wraps the shared renderer; handler.ts uses the shared registry-index loader.
- `resolveCuratedSlug` + the 301 redirect in `handleLiveScorePage`.
- Test parity assertions + a new `curated-tool redirect` describe block.

### Deferred to follow-up work

- Per-scorecard `spec_version` rendering. Today the live page reads `scorecard.spec_version ?? SPEC_VERSION` and
  surfaces whichever value is set. A future cleanup could lift the spec version into the cached envelope alongside
  `anc_version` and `tool_version` for explicit reads.
- Badge SVG generation for non-registry binaries. The live page suppresses the `scorecard-embed__preview` image because
  no `/badge/<binary>.svg` is emitted by the build for non-curated tools. Generating these on the fly (or serving a
  default SVG) would close the visual parity gap completely; out of scope for the pre-release polish.
- Telemetry for the curated-redirect path. A future operational follow-up could log the 301 redirect as its own tier so
  operators can observe how often the defense-in-depth check fires.

### Outside the change's scope

- Schema migration. The cache envelope shape is unchanged.
- Spec or CLI changes. The same `anc audit --command <binary> --output json` invocation produces the data on both paths.
- Registry editorial. No tools were added or removed.

---

## Implementation Units

Each unit cites repo-relative file paths and the squash-merged commit `3e886c8` on `dev`. The original three commits on
the feature branch were `53783a7` (parity + shared renderer), `0073545` (header subline fix), and `e6f95c3`
(curated-tool redirect); the squash merge collapsed them.

### U1. Extract shared scorecard renderer

**Goal:** One body builder and one markdown builder for both `/score/<slug>` and `/score/live/<binary>`.

**Requirements:** R1, R2, R3, R7.

**Dependencies:** none.

**Files:**

- `src/shared/scorecard-format.mjs` (extended) — `buildScorecardBody(tool, scorecard, opts)`,
  `buildScorecardMarkdown(tool, scorecard, opts)`, plus the helpers they need: `computePrincipleScore`,
  `renderAuditRows`, `renderCoverageSummary`, `renderAudienceBanner`, `formatDuration`, `formatStartedAt`,
  `getAncBuildVersion`, `BADGE_ELIGIBILITY_FLOOR_PCT`, the embed-eligible / below-floor helpers, the audience-copy and
  audit-profile-copy maps, and the audit-profile suppression prefix.
- `src/build/scorecards-render.mjs` (reduced) — `buildScorecardBody` and `buildScorecardMarkdown` become thin positional
  wrappers that translate the build's existing positional arguments into the shared opts shape.
- `src/build/scorecards.mjs` (re-export) — `computePrincipleScore` re-exported from shared.
- `src/build/badge.mjs` (re-export) — `BADGE_ELIGIBILITY_FLOOR_PCT` re-exported from shared.

**Approach:** The static path's `buildScorecardBody` was already the deeper renderer; move its body to shared and make
registry-editorial fields optional. The build wrapper preserves the legacy positional signature so existing callers in
`src/build/08-scorecards-emit.mjs` and `tests/build.test.ts` work unchanged. The badge SVG preview lives behind a new
`showBadgePreview` opt (true for static, false for live) so the shared renderer does not assume a curated
`/badge/<binary>.svg` exists.

**Patterns to follow:** Mirror the existing share-render pattern used by `formatAuditTableMarkdownLines` and
`renderAuditRows` (both already in shared) — pure functions, no I/O, no Node imports, no `process.env`.

**Test scenarios:**

- The build's existing 134 tests in `tests/build.test.ts` continue to pass (renderer wrappers preserve the positional
  API).
- `renderAudienceBanner` and `renderCoverageSummary` tests in `tests/build.test.ts` continue to pass via the re-export
  from `src/build/scorecards-render.mjs`.

**Verification:** `bun test tests/build.test.ts` green; `bun run build` emits the same scorecard page count and badge
SVG count as before; static `/score/anc` HTML is byte-identical for the rendered scorecard sections.

### U2. Worker live route thin-wraps the shared renderer

**Goal:** `handleLiveScorePage` produces full scorecard output via the shared renderer instead of its own bespoke
summary HTML.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** U1.

**Files:**

- `src/worker/score/summary-render.ts` — `buildScoreSummaryBody` and `buildScoreSummaryMarkdown` become thin wrappers;
  the local `Scorecard` type narrows to just the fields the wrapper touches.

**Approach:** The wrapper derives a minimal `tool` from `scorecard.tool`, sets `breadcrumb` to `{ href: '/', label: '←
Score another' }`, sets `showBadgePreview: false`, and supplies a custom `ctaNoteHtml` that points at `/install` plus
the `anc audit .` project-mode shortcut. The freshness marker ("cached" / "just scored") flows through as a span inside
the `headerSubline` opt (see U3).

**Patterns to follow:** The shared renderer is the source of truth for section ordering and classnames.

**Test scenarios:**

- See U6.

**Verification:** Visual comparison of `/score/anc` and `/score/live/anc` (seeded into local R2) shows identical section
ordering and class names; classname diff limited to the editorial / freshness split documented in R3 and R4.

### U3. Header subline opt keeps meta out of the h1

**Goal:** The binary/anc/spec/freshness line renders as a small meta paragraph below the h1, not inside the h1.

**Requirements:** R4.

**Dependencies:** U1.

**Files:**

- `src/shared/scorecard-format.mjs` — `buildScorecardBody` accepts new opts `titleSuffix` (inline content after the h1
  text) and `headerSubline` (HTML for a `<p class="live-score-summary__meta">` paragraph below the h1). The original
  `freshnessMarker` opt was dropped because it conflated h1-inline content with below-h1 meta.
- `src/worker/score/summary-render.ts` — Worker callsite splits the line: `titleSuffix` carries the version pill;
  `headerSubline` carries the binary/anc/spec/freshness line including the freshness marker span.

**Approach:** When `titleSuffix` is set, the h1 renders as `<h1>${name}${titleSuffix}</h1>`. When `headerSubline` is
set, a `<p class="live-score-summary__meta">${headerSubline}</p>` renders directly after the h1, ahead of any
registry-editorial description and meta-div. The static path passes neither opt; its header is byte-identical to the
pre-PR state.

**Patterns to follow:** The existing `.live-score-summary__meta` CSS rule in `src/styles/site.css` already styles the
small meta paragraph correctly. No new CSS.

**Test scenarios:**

- Live HTML response contains `<h1>cowsay <span class="live-score-summary__version">3.04</span></h1>` followed by `<p
  class="live-score-summary__meta">...</p>` (cowsay = non-registry seeded fixture).
- Static `/score/anc` HTML response continues to render the legacy `<h1>anc</h1>` followed by `<p
  class="scorecard-header__desc">...</p>` and `<div class="scorecard-header__meta">...</div>` (no regression).

**Verification:** Side-by-side header structure comparison from `wrangler dev`.

### U4. Shared registry-index loader

**Goal:** One isolate-level cache of `dist/registry-index.json` serves both `/api/score` and the new
`/score/live/<binary>` redirect check.

**Requirements:** R5, R6.

**Dependencies:** none.

**Files:**

- `src/worker/score/registry-lookup.ts` — adds `loadRegistryIndex(env)`, `_resetRegistryIndexCache()`, and a
  module-scope `registryIndexPromise` singleton. The asset URL is `https://assets.internal/registry-index.json` via
  `env.ASSETS.fetch`.
- `src/worker/score/handler.ts` — drops its own `loadRegistryIndex` and `_resetIndexCache` registry slice; imports both
  from `registry-lookup`. The hint-index loader stays in handler.ts (no second consumer yet).

**Approach:** Module-scope promise cache; on fetch failure, reset the promise to `null` and rethrow so the next request
retries. This mirrors the pattern the handler already used; the move just exposes the function.

**Patterns to follow:** Same isolate-level singleton pattern that `loadShellTemplate` in
`src/worker/score/summary-render.ts` already uses for the score-live shell template.

**Test scenarios:**

- See U6 (curated-tool redirect describe block).

**Verification:** Handler tests continue to pass; new redirect tests exercise the loader path.

### U5. Curated-tool redirect in handleLiveScorePage

**Goal:** A registry-curated binary at `/score/live/<binary>` returns 301 to `/score/<slug>`.

**Requirements:** R5, R6.

**Dependencies:** U4.

**Files:**

- `src/worker/score/registry-lookup.ts` — adds `resolveCuratedSlug(binary, registryIndex)`. Returns the canonical
  `entry.name` when `binary === entry.name` (fast path via `by_slug[binary]`) or when `binary === entry.binary` for any
  entry (O(n) scan over `Object.values(by_slug)`).
- `src/worker/score/summary-render.ts` — `handleLiveScorePage` calls `loadRegistryIndex` then `resolveCuratedSlug`
  before the cache read. On a hit, returns a `301` response with `Location: /score/<slug>${wantMarkdown ? '.md' : ''}`
  and the same `Cache-Control: public, max-age=300` that the rest of the site's redirects use.

**Approach:** The redirect check runs after `parseLiveScorePathMatch` but before the R2 read, so a stale cache entry for
a curated binary never reaches the renderer. On `loadRegistryIndex` failure, the redirect step is skipped and the live
path proceeds (soft-fail per KTD).

**Patterns to follow:** The 301 shape mirrors the `/check` → `/audit` and `/score/live/<binary>.html` →
`/score/live/<binary>` redirects already in `src/worker/index.ts`.

**Test scenarios:**

- See U6.

**Verification:** Manual `wrangler dev` verification matrix recorded in U6 / Verification below.

### U6. Tests for parity and redirect

**Goal:** Cover the new behaviors and lock down the contract.

**Requirements:** all (test coverage).

**Dependencies:** U2, U3, U5.

**Files:**

- `tests/score-live-page.test.ts` — extended.

**Approach:** Add parity assertions to the existing happy-path describe (full audit groups present, principle badge
present, embed snippet rendered for eligible scorecards, below-floor hint rendered when not eligible, reproduce CTA
renders the recorded invocation). Add a new `curated-tool redirect` describe block with seven cases covering name match,
binary-alias match, `.md` suffix preservation, Accept-header content negotiation, cache-precedence (redirect wins over a
stale cache entry), false-positive guard (non-registry binary renders normally), and asset-fetch-failure soft-fail
(registry-index 404 → redirect skipped, live path proceeds). The mock env grows a `registry` option so tests opt in to a
fixture registry-index.

**Test scenarios:**

- Happy path: `/score/live/ripgrep` returns 200 with HTML containing `scorecard-audits`, `audit-group`, `audit-table`,
  `scorecard-meta`, "Version scored", "principles met", "2/8" (for the SAMPLE_SCORECARD's mix of fail/warn/pass),
  `scorecard-embed--eligible` when `badge.eligible`, `scorecard-embed--below` when not, `scorecard-cta` with the
  recorded `run.invocation` verbatim.
- Top-issues ordering: FAIL ranks before WARN.
- Clean scorecard: "no issues found" message present.
- XSS sanity: scorecard fields with `<script>` payloads emit entity-escaped output.
- Markdown twin: contains `# <name>`, `**Score:** <pct>% pass rate`, `**Principles:** ...`, `## Embed the badge`, `##
  Reproduce locally`, the absolute principle link `https://anc.dev/p4`, no raw `<`.
- Curated-tool redirect (name match): `/score/live/anc` returns 301 with `Location: /score/anc`.
- Curated-tool redirect (binary alias): `/score/live/rg` returns 301 with `Location: /score/ripgrep`.
- `.md` suffix preservation: `/score/live/anc.md` returns 301 with `Location: /score/anc.md`.
- Accept-header propagation: `Accept: text/markdown` on `/score/live/anc` returns 301 with `Location: /score/anc.md`.
- Cache-precedence: redirect fires even when an R2 cache entry exists for the curated binary (stale-cache defense).
- False-positive guard: `/score/live/cowsay` (non-registry) returns 200, not 301, when registry-index is seeded with
  curated entries that do not include cowsay.
- Asset-fetch failure: when `registry-index.json` returns 404, the redirect step is skipped and the live path returns
  200 with the rendered scorecard.
- 405 for non-GET/HEAD methods.
- 404 for missing cache entry on a non-registry binary.
- 500 plain-text when the score-live shell template asset is missing (defense in depth).

**Verification:** `bun test tests/score-live-page.test.ts` green at 37 passes (was 30 after the parity work before this
unit; +7 from the redirect block).

---

## Risks and Mitigations

- **Risk: stale R2 entries for binaries that get added to the registry later.** A binary scored against the live path
  before being added to the registry will have an R2 entry at `scores/<binary>/<spec>.json`. After the binary lands in
  the registry, the redirect check (U5) sees it as curated and 301s. The stale R2 entry never serves; it expires under
  the 7-day R2 lifecycle. Considered acceptable.
- **Risk: redirect loop if a tool's name and binary both somehow end up at `/score/live/`.** Mitigation: the canonical
  path the redirect targets is `/score/<entry.name>`. `entry.name` is unique in `registry.yaml` (enforced in
  `src/build/scorecards.mjs` `loadRegistry`). The static `/score/<binary>` → `/score/<name>` redirect for alias binaries
  is also build-emitted (`src/build/08-scorecards-emit.mjs`), so the worst case is a two-hop redirect on the alias path
  (`/score/live/rg` → `/score/ripgrep` lands directly, no double-hop).
- **Risk: editorial drift if the registry-index loader serves a stale value across deploys.** Mitigation: the promise
  cache is per-isolate; Cloudflare Workers re-instantiate isolates frequently, so the staleness window is bounded to one
  isolate's lifetime. Same posture the handler.ts code already had.
- **Risk: a future Worker route imports the static-path build module by accident.** Mitigation: `src/shared/` is the
  dependency direction — build code and Worker code both depend on shared, never the other way around. The Worker bundle
  does not include `src/build/` code at all.
- **Risk: the `bun run build` rebuild loses byte-identity for static scorecard pages.** Mitigation: the build wrapper
  preserves the legacy positional signature and forwards the same data into the shared renderer; the static page output
  was diffed against the pre-PR build and confirmed byte-identical for the rendered scorecard sections.

---

## Verification

- `bun test`: 767 pass, 0 fail, 2036 expect calls (29 files). 7 of those are the new redirect tests; the rest are the
  pre-existing suite running green against the refactored shared renderer.
- `bun test tests/score-live-page.test.ts`: 37 pass. The pre-PR baseline was 23 (before parity work); after the parity
  commit was 30; after the redirect commit is 37.
- `bun test tests/build.test.ts`: 134 pass. Renderer wrappers preserve the positional API; the existing
  `renderAudienceBanner`, `renderCoverageSummary`, `computePrincipleScore`, `extractTopIssues`, `buildScorecardBody`,
  `buildScorecardMarkdown` tests all continue to pass.
- `bun run --silent biome check`: clean on changed files after final commit.
- `bunx tsc --noEmit`: no new TypeScript errors attributable to the change.
- `bun run build`: 112 html, 112 md, 97 scorecard pages, 96 badges. Same shape as the base.
- `wrangler dev --env staging --local --port 8787` manual verification, with `anc-v0.5.0.json` seeded into local R2 as
  `scores/anc/0.5.0.json` and `scores/cowsay/0.5.0.json`:

| URL                                          | Result                           | Why                                    |
| -------------------------------------------- | -------------------------------- | -------------------------------------- |
| `/score/anc`                                 | 200                              | Static-path render unchanged.          |
| `/score/live/anc`                            | 301 → `/score/anc`               | Registry name match (R5).              |
| `/score/live/rg`                             | 301 → `/score/ripgrep`           | Registry binary-alias match (R5).      |
| `/score/live/anc.md`                         | 301 → `/score/anc.md`            | `.md` suffix preserved (R5).           |
| `Accept: text/markdown` on `/score/live/anc` | 301 → `/score/anc.md`            | Accept-header propagation (R5).        |
| `/score/live/cowsay`                         | 200 (renders full scorecard)     | Non-registry binary path (R1, R3, R4). |
| `/score/live/cowsay.md`                      | 200 (renders full markdown twin) | Non-registry markdown twin (R2).       |

- Post-merge `dev` push deploy: `gh run view 26781132070` → conclusion `success`.

---

## Sources and Research

- PR: <https://github.com/brettdavies/agentnative-site/pull/139>
- Squash merge commit on `dev`: `3e886c8` (2026-06-01).
- Original feature-branch commits (collapsed by the squash): `53783a7`, `0073545`, `e6f95c3`.
- Prior plan establishing the live-scoring DO + cache contract:
  `docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md`.
- Prior plan establishing the registry-leaderboard + scorecard pages:
  `docs/plans/2026-04-17-001-feat-registry-leaderboard-scorecard-pages-plan.md`.
- Scorecard schema reference: `content/scorecard-schema.md`.
- Cache contract: `src/worker/score/cache.ts` (key shape, 7-day R2 lifecycle, refusal-to-cache-half-state).
- Sandbox invocation that produces the cached scorecard: `src/worker/score/sandbox-exec.ts` (`anc audit --command
  <binary> --output json`).
- Build-time equivalent invocation: `docker/score/score-anc100.sh` (same `anc audit ...` shape).
