---
title: "feat: Web-audit refinements implementation — fairness scoring, applicability, CF-style remediation"
date: 2026-07-09
type: feat
status: completed
completed: 2026-07-13
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
origin: docs/plans/2026-07-09-002-feat-web-audit-refinements.md
related:
  - docs/solutions/design-patterns/web-audit-fairness-scoring-model.md
---

# feat: Web-audit refinements implementation

## Summary

Turn the settled refinements design (`docs/plans/2026-07-09-002`) into shipped code. The base in-Worker web audit
(plan-001, U1-U17) is implemented on stacked branches and deployed to staging; this plan implements the seven
refinements it does not yet carry: a fairness-driven two-score scorer, a tri-state outcome model (absent vs broken vs
n_a), antecedent-gated applicability driven by declared site type and dependency-ordered probe reuse, two new checks
(`auth-md`, `webmcp`), CF-style remediation with copy-paste prompts and per-check skills at content URLs, 301 redirects
for the MCP-card aliases, and a display rework that groups by visible category while keeping the P1-P8 principles
internal.

**Target repo:** agentnative-site. Shipped to `dev` on 2026-07-13: Phases A-B (U1-U8) via #198 (`32452fd`), Phases C-F
(U9-U17) via #199 (`3123dac`). The stack was re-sliced from its original `feat/web-audit-refinements` branch series into
those two deployment PRs by the landing sequence in `docs/plans/2026-07-13-001-feat-web-audit-rebrand-landing-plan.md`.

---

## Problem Frame

The shipped audit (`src/worker/audit-web/`) scores with a single flat MUST+SHOULD credit-weighting (`computeWebScorePct`
in `scorecard.ts`), emits a `badge` object, collapses "surface absent" and "surface present but broken" both into
`fail`, gates applicability only for `applies_to: mcp-present`, and renders results grouped by the internal principle.
The design chat settled a different model on fairness grounds (captured quantitatively in
`docs/solutions/design-patterns/web-audit-fairness-scoring-model.md`): a site must never be marked down for a surface
that does not apply to it, must never be rewarded for shipping a broken one, and a bigger correct routine should outrank
a small perfect one. Delivering that requires changes across the registry, handlers, engine, scorer, routes, remediation
data, MCP tools, and the presentation build scripts.

**Note on the origin doc.** `plan-002`'s "check matrix" prose (its lines ~107-110) still describes the *old* binary warn
model ("a missed SHOULD/MAY is a warn"). That paragraph is superseded by the same doc's "Score + display model" section
and by the fairness solutions doc. This plan implements the settled model: full-or-zero credit, no warn.

---

## Requirements

Traceability back to the origin design (`plan-002`) and the user's `/ce-plan` request:

- **R1 — Tri-state outcomes.** The engine maps each applicable check to `pass` / `broken` / `absent` / `n_a`; absent and
  broken are distinct.
- **R2 — Two scores.** RELATIVE = earned / max-for-applicable-set (headline); GLOBAL = earned / maximal-site-max
  (context). Both floored at 0.
- **R3 — Outcome credit.** pass = +weight; broken = −0.75×weight (every tier); MUST/SHOULD absent = 0 numerator (MUST
  full-weight denominator, SHOULD half-weight denominator); MAY absent = n_a; no partial/warn credit.
- **R4 — Antecedent gating.** A check is scored only when its antecedent holds; otherwise n_a. Antecedents resolve from
  declared site type, discovery, or another check's result, evaluated in dependency order reusing probe results. The two
  n_a paths (antecedent-unmet vs applicable-MAY-absent) are recorded distinctly.
- **R5 — Difficulty weights as config.** Per-tier point values are configuration, unlocked (default 5/3/1), mirroring
  `scripts/scoring/score_model.py`; calibration is data-gated (n=1 today).
- **R6 — Site types.** Declared type Content or API/Application (default: run everything); MCP surface auto-detected
  from discovery regardless of declared type. A check outside the declared type is n_a (informational).
- **R7 — New checks.** `auth-md` (Agent discovery & auth, MAY, antecedent `auth-present`) and `webmcp` (MCP & API, MAY,
  antecedent `html-root`).
- **R8 — canonical-plus-redirect-aliases.** Reusable conditional: alias absent → n_a; 301 to canonical → pass; 200
  inline content → broken; missing canonical → absent on the canonical check (statuses use the R1 tri-state enum; no
  `fail` literal exists).
- **R9 — Redirects.** `/.well-known/mcp`, `/.well-known/mcp.json`, `/mcp.json`, and `GET /mcp` + `Accept:
  application/json` → 301 to `/.well-known/mcp/server-card.json`. `POST /mcp` and `GET /mcp` html/markdown unchanged.
- **R10 — Remediation restructure.** Per-check `title/goal/fix/resources`; assemble a copy-paste
  `Goal/Issue/Fix/Skill/Docs` prompt at audit time with the run's evidence as the uniform `Issue` line; the `Result`
  line derives from status+evidence.
- **R11 — Skills at content URLs.** Per-check skill docs at `/web-audit/skill/<check-id>` + `.md` twin.
  `.well-known/agent-skills/index.json` holds only a directory of pointers (no skill mimicked at a well-known URL);
  optional human `index.md`.
- **R12 — Display decoupled from principles.** Group and label by visible category; keep `principle: P1..P8` as a hidden
  per-check tag. Remove the badge; expose top-level `score_pct` + per-category rollups (`passed/counted`, excluding n_a)
- relative/global.
- **R13 — Leaderboard.** Offers both sort keys; default GLOBAL, toggle RELATIVE; result-page headline RELATIVE.
- **R14 — MCP tool parity.** `audit_website` embeds the remediation object inline per non-passing row;
  `get_web_remediation(check, evidence?)` returns the static remediation by id, filling `Issue` from the evidence arg
  when present.
- **R15 — Scoped llms.txt discovery.** `llms-txt-scoped` / `llms-full-txt-scoped` enumerate subdir candidates from the
  root `llms.txt` link index unioned with sitemap paths, antecedent-gated on the root file existing. Distinct from R11
  (the per-check fix skills).

---

## Key Technical Decisions

- **KTD-1 (R1). Tri-state at the handler boundary.** Extend `ProbeOutcome['status']` so handlers report `absent`
  (surface not present: e.g. 404 / NXDOMAIN / missing card) separately from `broken` (present but invalid: non-2xx where
  2xx expected, malformed body, wrong content-type, failed assertion on a fetched document). The engine maps handler
  status → scorecard status; `fail` splits into `absent | broken`. Rationale: the fairness scorer needs the distinction
  and it can only be judged where the probe result lives.
- **KTD-2 (R4). Dependency-ordered evaluation, probe reuse, two n_a paths.** Replace the flat
  `mapConcurrentUnordered(registry.checks)` fan-out with a two-wave evaluation: wave 1 performs the single canonical
  root-HTML fetch (status + Content-Type + a parsed link scan) and runs the antecedent-source checks (robots, llms-txt,
  llms-full-txt, openapi, oauth-discovery) alongside MCP discovery; wave 2 runs dependent checks with antecedents
  resolved from wave-1 results. The root fetch result is threaded through `HandlerContext` so the six existing root-HTML
  checks (`root-meta-description`, `root-link-rel`, `noscript-fallback`, `schema-org-jsonld`, `semantic-html`,
  `accept-markdown`) plus `link-headers` reuse it instead of each re-fetching `/` — that dedup is what actually bounds
  net subrequests, not the ordering alone. Record n_a with a `na_reason` discriminator: `antecedent-unmet` vs
  `optional-absent` (applicable MAY absent), so the page can word them differently ("not applicable" vs "not implemented
  (optional)"). Because wave 1 partially serializes a previously fully parallel fan-out, quantify the wave-1 subrequest
  count against the 25s deadline before deleting the old path.
- **KTD-3 (R2/R3/R5). Scorer mirrors the dev tool.** The engine scorer reproduces `scripts/scoring/score_model.py`'s
  formula exactly (`credit`: pass +1, absent 0, broken −broken_factor; SHOULD-absent half denominator; MAY-absent
  excluded; relative = earned/applicable_max, global = earned/universe_max, both floored at 0). Difficulty weights and
  `broken_factor` are config with defaults 5/3/1 and 0.75. `universe_max` is derived from the full registry. A unit test
  asserts the engine and the Python tool agree on a shared fixture.
- **KTD-4 (R6). API-surface detection is a union of signals (monitored).** `api-surface` holds when ANY of: declared
  type is API/Application; the root HTML references `openapi`/`swagger` or carries a `service-desc`/`service-doc` link;
  `openapi.json` probes 200; or the root `llms.txt` contains a link to an API. Accept a small false-positive risk (a
  content site with a stray reference could get a MUST `openapi` fail) and monitor real audits; over/under-detection is
  called out in Risks.
- **KTD-5 (R15). Scoped-llms candidate set = links ∪ sitemap, deduped, SSRF-guarded.** `llms-txt-scoped` /
  `llms-full-txt-scoped` enumerate subdir candidates from BOTH the root `llms.txt` link index AND top-level sitemap
  paths, deduplicated across the two sources before probing, under the existing per-audit deadline/concurrency budget.
  Candidate hrefs come from the target's own (attacker-controlled) documents, so every candidate is restricted to the
  audited origin and routed through `validatePublicUrl`/`guardedFetch` — an off-origin or private-IP href is dropped,
  never fetched (see Risks).
- **KTD-6 (R8/R9). Aliases become 301 redirects.** Today `src/worker/index.ts` serves the *same server-card body* at the
  aliases; change the alias branch to emit `301` to the canonical `/.well-known/mcp/server-card.json`. The canonical
  path and `POST /mcp` / html-markdown `GET /mcp` are untouched. The audit's `well-known-mcp-card` check applies the
  canonical-plus-redirect-aliases rule.
- **KTD-7 (R11). Skills live at content URLs; well-known is pointers only.** Per-check skill prose is a content page
  (`/web-audit/skill/<check-id>` + `.md` twin), served through the existing content/markdown-twin path.
  `.well-known/agent-skills/index.json` is extended to list each fix skill as `{name, url, type}` with `url` targeting
  the content page; no skill body is mimicked under `.well-known`.
- **KTD-8 (R12). Display grouped by category; principle hidden; badge removed.** `scorecard.ts` drops `badge`, adds
  top-level `score_pct` (RELATIVE), `score` object (`relative`, `global`), and `categories[]` rollups
  (`passed/counted`). `principle` stays on each row as a hidden tag (kept, not shown/linked). The scorecard schema
  version bumps.
- **KTD-9 (R13). GLOBAL is the default board sort.** The leaderboard emitter and client sort by GLOBAL by default with a
  RELATIVE toggle; the result page headlines RELATIVE.
- **KTD-10. Stacked branches, PR per phase, no auto-merge.** The series stacks on `feat/web-audit-refinements`. Group
  PRs by phase (A-F) unless a unit is independently reviewable; each PRs to `dev`; merges wait for explicit approval
  (per the repo's dev-branch squash flow).
- **KTD-11. Schema version + drift guard.** Bump `WEB_SCHEMA_VERSION` (`0.1` → `0.2`), update
  `content/web-scorecard-schema.md` to the new shape, and extend the existing schema-version drift test so the doc and
  constant cannot diverge.

---

## High-Level Technical Design

Engine evaluation flow (KTD-1, KTD-2, KTD-3). Wave 1 resolves the signals every antecedent reads; wave 2 scores the rest
with no additional root/robots/llms fetches.

```mermaid
flowchart TD
  A[POST /api/audit-web or audit_website\n{ url, site_type? }] --> B[MCP discovery + root fetch + root-HTML link scan]
  B --> W1[Wave 1: antecedent-source checks\nrobots, llms-txt, llms-full-txt, openapi, oauth-discovery]
  W1 --> R[Resolve antecedent tokens\nfrom declared type + discovery + wave-1 results]
  R --> W2[Wave 2: dependent checks\nreuse probe results, no re-fetch]
  W1 --> M[Map each applicable check to\npass / broken / absent / n_a]
  W2 --> M
  M --> S[Two-score scorer\nrelative = earned/applicable_max\nglobal = earned/universe_max]
  S --> C[Scorecard: score_pct + score{relative,global}\n+ categories[] rollups + rows w/ hidden principle]
  C --> OUT[NDJSON stream + R2 cache + MCP results]
```

Outcome credit table (antecedent already met; the wave-2 gate excludes unmet antecedents as n_a before this applies):

```text
Tier    pass        broken        absent
MUST    +w, /w      -0.75w, /w    0, /w
SHOULD  +w, /w      -0.75w, /w    0, /0.5w
MAY     +w, /w      -0.75w, /w    n_a (excluded)
```

---

## Output Structure

New files this series creates (existing files are modified in place per each unit's `Files`):

```text
src/worker/audit-web/
  antecedents.ts            # antecedent token resolver + api-surface union (U3)
  score.ts                  # two-score scorer, replaces scoring in scorecard.ts (U4)
  remediation.ts            # remediation load + prompt/result assembly (U12)
  handlers/
    auth-md.ts              # auth-md probe (U6)
    webmcp.ts               # webmcp probe (U6)
    scoped-llms.ts          # scoped llms.txt/llms-full.txt discovery (U8)
content/
  web-audit-skill/          # per-check skill prose + .md twins served at /web-audit/skill/<id> (U10)
tests/
  web-audit-antecedents.test.ts
  web-audit-two-score.test.ts
  web-audit-canonical-redirect.test.ts
  web-audit-scoped-llms.test.ts
  web-audit-remediation-assembly.test.ts
```

---

## Implementation Units

### Phase A — Scoring foundation

*Shipped to `dev` in #198 (`32452fd`), 2026-07-13.*

#### U1. Registry applicability model (data + types + build) [shipped]

- **Goal:** Replace the single `applies_to` field with the full applicability model: `tier` (MUST/SHOULD/MAY keyword
  already present), `site_types[]`, `antecedent` token, and an `eval` rule tag. Add the `auth-md` and `webmcp` rows and
  their category assignments. Keep `principle` as a hidden tag.
- **Requirements:** R4, R6, R7, R12.
- **Dependencies:** none.
- **Files:** `src/data/web-audit/registry.yaml`, `src/build/13-web-audit-registry.mjs`,
  `src/worker/audit-web/registry.ts`, `tests/build-mcp-catalog.test.ts` (sibling registry-projection assertions if
  colocated) or a new `tests/web-audit-registry.test.ts`.
- **Approach:** Extend `WebCheck` with `site_types: ('content'|'api'|'mcp'|'all')[]`, `antecedent: AntecedentToken`,
  `eval?: 'canonical-redirect'|'scoped-discovery'`. Migrate every row in `registry.yaml` to the plan-002 matrix values.
  `applies_to` is removed; the engine's old hardcoded `applies_to === 'mcp-present'` gate moves into the antecedent
  resolver (U3). The build projection validates every `antecedent` and `eval` against the known token/rule sets and
  fails the build on an unknown value (fail-fast).
- **Patterns to follow:** the existing YAML→`dist/_internal` JSON projection in `13-web-audit-registry.mjs`; enum
  validation as done for handlers.
- **Test scenarios:** registry projection includes `auth-md` and `webmcp` with the expected antecedent/site_types/eval;
  build fails on an unknown antecedent token; every check has exactly one category from the five visible categories;
  `principle` survives projection but is not surfaced in any public field. `Covers R7.`
- **Verification:** `bun run build` regenerates the registry JSON; all rows carry the new fields; type-check passes.

#### U2. Tri-state probe outcomes (absent vs broken) [shipped]

- **Goal:** Handlers distinguish `absent` from `broken`; the engine surfaces `pass | broken | absent | n_a | skip |
  error`.
- **Requirements:** R1.
- **Dependencies:** U1.
- **Files:** `src/worker/audit-web/handlers/types.ts`, `src/worker/audit-web/handlers/http.ts`,
  `src/worker/audit-web/handlers/mcp.ts`, `src/worker/audit-web/handlers/cors-preflight.ts`,
  `src/worker/audit-web/handlers/dns-doh.ts`, `src/worker/audit-web/engine.ts`, `src/worker/audit-web/assert.ts`,
  `tests/web-audit-handlers.test.ts`, `tests/web-audit-assert.test.ts`.
- **Approach:** Add `'absent'` and `'broken'` to `ProbeOutcome['status']` (keep `na`/`skip`/`error`). In `http.ts`: a
  404/410 (or NXDOMAIN-equivalent) on the primary URL is `absent`; a fetched-but-failed assertion (2xx with wrong
  body/content-type, or an unexpected non-2xx where the surface clearly exists) is `broken`. `mcp.ts`,
  `cors-preflight.ts`, `dns-doh.ts` classify analogously (no records → absent; malformed/error response → broken).
  `engine.ts` `probeStatusToScorecard` maps the new statuses through; `summarizeEvidence` keeps its human line.
- **Patterns to follow:** existing `assert.ts` assertion outcomes; `summarizeEvidence` branching per handler.
- **Test scenarios:** http 404 → `absent`; http 200 with content-type mismatch → `broken`; mcp endpoint present but
  `initialize` returns error → `broken`; dns with zero answers → `absent`; a 5xx where a document is expected →
  `broken`; existing pass/na/skip/error paths unchanged. `Covers R1.`
- **Verification:** handler tests assert the tri-state mapping for each handler; engine emits the new statuses in
  `result` events.

#### U3. Antecedent resolution + dependency-ordered evaluation [shipped]

- **Goal:** Gate every check by its antecedent, resolved from declared site type, discovery, or another check's result,
  evaluated in dependency order with probe reuse. Record the two n_a paths distinctly.
- **Requirements:** R4, R6 (site-type gating consumed here; declaration plumbed in U7), KTD-4.
- **Dependencies:** U1, U2.
- **Files:** `src/worker/audit-web/antecedents.ts` (new), `src/worker/audit-web/engine.ts`,
  `src/worker/audit-web/discovery.ts`, `src/worker/audit-web/handlers/types.ts` (add the shared root fetch
  body/Content-Type/link-scan to `HandlerContext`), `src/worker/audit-web/handlers/http.ts` (the six root-HTML checks +
  `link-headers` read the shared root fetch instead of re-fetching `/`), `tests/web-audit-antecedents.test.ts`,
  `tests/web-audit-discovery.test.ts`.
- **Approach:** New `antecedents.ts` exports `resolveAntecedent(token, ctx) → 'apply' | 'n_a'` where `ctx` carries
  declared site type, discovery result, the root fetch (status + content-type + parsed link scan), and a map of
  already-computed check results. Implement each token from the plan-002 resolution table (`none`, `http-root`,
  `html-root`, `mcp-present`, `mcp-auth`, `api-surface`, `schemas-ref`, `docs-site`, `root-llms-txt`,
  `root-llms-full-txt`, `robots-present`, `auth-present`). `api-surface` is the union in KTD-4. The engine restructures
  into wave 1 (antecedent-source checks + root-HTML link scan) then wave 2 (dependent checks); a check whose antecedent
  resolves to n_a yields `status: 'n_a'` with `na_reason: 'antecedent-unmet'`. An applicable MAY that comes back
  `absent` is re-tagged `n_a` with `na_reason: 'optional-absent'` (per R3). Concurrency cap is preserved within each
  wave.
- **Execution note:** Start with a failing engine test that asserts wave ordering (a `robots-ai-rules` check sees
  `robots-present` resolved from the `robots` result, not a second fetch) before refactoring the fan-out.
- **Patterns to follow:** the existing deadline/`mapConcurrentUnordered` machinery; the current `applies_to ===
  'mcp-present'` gate is the seed for `mcp-present`.
- **Test scenarios:** site-type cases are driven by a synthetic `ctx.siteType` at the unit level (the entry-point wiring
  lands in U7, so U3 carries no runtime dependency on it); `robots-ai-rules` n_a when `/robots.txt` 404 (robots-present
  false), applied when robots 200; `oauth-protected-resource` n_a with no MCP endpoint; `llms-full-txt` n_a on a
  non-docs site; `api-surface` true via each of the four signals independently and false when none hold; MAY-absent
  tagged `optional-absent`, antecedent-unmet tagged `antecedent-unmet`; wave 2 and the six root-HTML checks issue no
  duplicate `/` fetch for a reused probe (assert fetch call count). `Covers R4.`
- **Verification:** antecedent unit tests pass for all twelve tokens; engine test confirms zero re-fetch for reused
  signals.

#### U4. Two-score scorer (replace flat scoring, drop badge) [shipped]

- **Goal:** Compute RELATIVE + GLOBAL per the outcome table; emit `score_pct` + `score{relative,global}` + per-category
  rollups; remove `badge`.
- **Requirements:** R2, R3, R5, R12, KTD-3, KTD-11.
- **Dependencies:** U1, U2, U3.
- **Files:** `src/worker/audit-web/score.ts` (new), `src/worker/audit-web/scorecard.ts`,
  `src/worker/audit-web/engine.ts`, `scripts/scoring/score_model.py` (extend `UNIVERSE` with `auth-md`, `webmcp`, and
  the scoped-llms ids so its `universe_max` matches the registry-derived one — or drive `UNIVERSE` from the projected
  registry JSON to prevent drift), `tests/web-audit-two-score.test.ts`, `tests/web-audit-scoring.test.ts`,
  `tests/web-audit-scorecard-format.test.ts`.
- **Approach:** `score.ts` implements `scoreWebAudit(results, weights, brokenFactor, universeMax)` returning `{
  relative, global, categories }`, mirroring `scripts/scoring/score_model.py` (pass +w, broken −0.75w, MUST/SHOULD
  absent 0 with MUST full / SHOULD half denominator, MAY absent excluded, both scores floored at 0).
  Weights/`brokenFactor` come from a config object (defaults 5/3/1, 0.75). `universeMax` sums weights over the full
  registry. `scorecard.ts` drops `badge`/`computeWebScorePct`, adds `score_pct` (RELATIVE), `score`, and `categories[]`
  (`{name, passed, counted}` excluding n_a), and keeps `coverage_summary`. Bump `WEB_SCHEMA_VERSION` to `0.2`.
- **Test scenarios:** the fairness pair (4/5-MUST big platform vs 2/2-MUST small site) ranks GLOBAL big > small while
  RELATIVE small = 100; a broken MAY lowers both scores below the same-count all-absent case; a SHOULD-absent drags less
  than a MUST-absent for the same numerator; all-n_a category reports `0/0` and contributes nothing; scorer output
  equals `score_model.py` on a shared committed fixture (parity test) — the fixture exercises the configurable weights
  and `broken_factor`. `Covers R2. Covers R3. Covers R5.`
- **Verification:** scoring tests pass; scorecard JSON no longer contains `badge`; `score_pct` present at top level.

---

### Phase B — Applicability + new checks

*Shipped to `dev` in #198 (`32452fd`), 2026-07-13.*

#### U5. canonical-plus-redirect-aliases eval rule (scoring side) [shipped]

- **Goal:** Implement the reusable conditional and wire it to `well-known-mcp-card`.
- **Requirements:** R8.
- **Dependencies:** U2, U3.
- **Files:** `src/worker/audit-web/assert.ts` (the eval rule folds in here — one consumer today, no new module),
  `src/worker/audit-web/handlers/http.ts` or `ssrf.ts` (a redirect-inspecting probe mode, `maxRedirects: 0`, that
  surfaces the `301`/`308` status + `Location` per alias rather than following it), `src/worker/audit-web/engine.ts`,
  `tests/web-audit-canonical-redirect.test.ts`.
- **Approach:** For a check tagged `eval: canonical-redirect`, evaluate each alias with a non-following probe
  (`maxRedirects: 0`) that returns the status + `Location` — the default `http` handler follows redirects and reports
  only the final hop, so it cannot see the 301. absent → `n_a`; a `301`/`308` whose `Location` resolves to the canonical
  path → `pass` (regardless of what the canonical returns); a `200` serving content inline → `broken`
  (ambiguous/duplicate, worse than absent). The canonical path missing is `absent` on the canonical check itself (a
  SHOULD, so half-weight in the relative denominator). The alias set for the MCP card: `/.well-known/mcp`,
  `/.well-known/mcp.json`, `/mcp.json`, and `GET /mcp` + `Accept: application/json`.
- **Test scenarios:** alias 301→canonical = pass; alias serving 200 inline = broken; alias 404 = n_a; canonical 404 =
  absent on canonical; a 302 (non-permanent) treated per rule (pass only on 301/308, per Open Questions). `Covers R8.`
- **Verification:** the rule unit test covers all four alias states + the canonical-missing case.

#### U6. auth-md + webmcp probe handlers [shipped]

- **Goal:** Add the two new check handlers.
- **Requirements:** R7.
- **Dependencies:** U1, U2.
- **Files:** `src/worker/audit-web/handlers/auth-md.ts` (new), `src/worker/audit-web/handlers/webmcp.ts` (new),
  `src/worker/audit-web/engine.ts` (register in `HANDLERS`), `tests/web-audit-handlers.test.ts`.
- **Approach:** `auth-md` probes the agent-registration metadata surface (antecedent `auth-present`), classifying
  present-and-valid → pass, present-malformed → broken, missing → absent. `webmcp` probes for browser WebMCP tool
  exposure (antecedent `html-root`); it is a *probe of the target site*, distinct from this site's own
  `src/client/webmcp.ts` client. Both reuse the guarded fetch + assertion machinery.
- **Patterns to follow:** `handlers/http.ts` structure; `ProbeOutcome` contract from U2.
- **Test scenarios:** auth-md present/valid → pass, malformed → broken, missing → absent, no auth surface → n_a via
  antecedent; webmcp detected → pass, absent → absent, n_a when root is not html. `Covers R7.`
- **Verification:** both handlers registered; handler tests green.

#### U7. Site-type declaration plumbing [shipped]

- **Goal:** Accept a declared site type on both entry points and thread it into applicability; default run-everything;
  MCP auto-detected regardless.
- **Requirements:** R6.
- **Dependencies:** U3.
- **Files:** `src/worker/audit-web/route.ts`, `src/worker/audit-web/engine.ts`, `src/worker/mcp/tools/web-audit.ts`,
  `tests/web-audit-routes.test.ts`, `tests/web-audit-mcp-tools.test.ts`.
- **Approach:** `POST /api/audit-web` body gains optional `site_type: 'content' | 'api'` (absent → run everything); the
  `audit_website` MCP tool gains the same optional arg with an enum in its input schema. `RunWebAuditInput` carries
  `siteType?`; the antecedent resolver (U3) consumes it. Cache key (`keyFor`) must incorporate `site_type` so a Content
  run and an API run for the same domain do not collide.
- **Test scenarios:** no `site_type` → every check applicable except antecedent-gated ones; `content` → API-only checks
  (`openapi`, `api-catalog`) become n_a; `api` → docs-only checks (`llms-full-txt`) unaffected by type but MCP still
  evaluated when discovered; cache key differs by `site_type`; invalid `site_type` rejected with 400 / MCP validation
  error. `Covers R6.`
- **Verification:** route + MCP-tool tests assert type-driven applicability and cache-key separation.

#### U8. Scoped llms.txt discovery (links ∪ sitemap, deduped) [shipped]

- **Goal:** Implement `llms-txt-scoped` / `llms-full-txt-scoped` candidate enumeration.
- **Requirements:** R15, KTD-5.
- **Dependencies:** U2, U3.
- **Files:** `src/worker/audit-web/handlers/scoped-llms.ts` (new), `src/worker/audit-web/engine.ts`,
  `tests/web-audit-scoped-llms.test.ts`.
- **Approach:** Build the candidate set from the root `llms.txt` link index (reused from the `root-llms-txt` probe) plus
  top-level sitemap paths, deduplicated across both sources before probing. **SSRF:** candidate hrefs come from the
  target's own attacker-controlled documents, so restrict every candidate to the audited origin (drop off-origin hosts)
  and route it through `validatePublicUrl`/`guardedFetch`, exactly like the entry-point target — a private-IP or
  off-origin href must never be fetched. Bound total candidates to a small cap and run under the existing per-audit
  deadline/concurrency. Antecedents `root-llms-txt` / `root-llms-full-txt` gate these to n_a when the root file is
  absent.
- **Test scenarios:** candidates from llms.txt links and sitemap are merged and de-duplicated (a path appearing in both
  is probed once); an absolute off-origin or private-IP href in `llms.txt`/sitemap is dropped and never fetched; n_a
  when the root llms.txt is absent; the candidate cap is respected; a scoped file present-and-valid → pass, malformed →
  broken. `Covers R15.`
- **Verification:** dedupe asserted by probe-call count; cap enforced.

---

### Phase C — Redirects + skills

*Shipped to `dev` in #199 (`3123dac`), 2026-07-13.*

#### U9. MCP-card alias 301 redirects [shipped]

- **Goal:** Serve 301s at the aliases instead of duplicate bodies.
- **Requirements:** R9.
- **Dependencies:** none (independent of the engine; can PR early).
- **Files:** `src/worker/index.ts`, `src/worker/mcp-descriptor-paths.ts`, `tests/worker-mcp.test.ts` (or the
  descriptor-path test), `tests/e2e/mcp.e2e.ts`.
- **Approach:** In `index.ts`, the alias branch (`MCP_DESCRIPTOR_ALIAS_PATHS` + `GET /mcp` with `Accept:
  application/json`) returns `301` with `Location: <origin>/.well-known/mcp/server-card.json` and an appropriate
  cache-control, instead of the rewritten card body. The canonical `GET /.well-known/mcp/server-card.json`, `POST /mcp`,
  and `GET /mcp` html/markdown paths are unchanged. Confirm no other consumer relied on the alias serving a body.
- **Test scenarios:** each alias returns 301 to the canonical; canonical still 200s the card; `GET /mcp` + `Accept:
  text/html` still serves the page; `POST /mcp` JSON-RPC unchanged; `Accept: application/json` on `/mcp` → 301. `Covers
  R9.`
- **Verification:** worker tests assert 301 + Location; e2e confirms redirect chain resolves.

#### U10. Per-check skill docs at content URLs [shipped]

- **Goal:** Serve `/web-audit/skill/<check-id>` + `.md` twin per check.
- **Requirements:** R11.
- **Dependencies:** U2 (status shape only). U10 authors the per-check skill prose and U12 consumes it for the `Skill:`
  link — a one-way dependency (U12 → U10), no cycle. Sequence U10 before U11 so the pointer directory has live targets.
- **Files:** `content/web-audit-skill/<check-id>.md` (new, one per remediable check), `src/worker/index.ts` (route
  `/web-audit/skill/<id>` through the existing content + markdown-twin path), `tests/web-audit-routes.test.ts`,
  `tests/e2e/skill.e2e.ts`.
- **Approach:** Author one skill page per check (goal, fix, resources, and the copy-paste prompt shape). Serve through
  the standard content route with content negotiation so `/web-audit/skill/openapi` and `/web-audit/skill/openapi.md`
  both resolve. This is the `Skill:` link target used by remediation (U12).
- **Test scenarios:** `/web-audit/skill/openapi` returns HTML; `.md` twin returns markdown; unknown check id → 404;
  content negotiation via `Accept: text/markdown` serves the twin. `Covers R11.`
- **Verification:** route test + skill e2e pass for a representative check.

#### U11. agent-skills directory of pointers [shipped]

- **Goal:** Extend `/.well-known/agent-skills/index.json` to list every web-audit fix skill; optional human `index.md`.
- **Requirements:** R11.
- **Dependencies:** U10.
- **Files:** the `/.well-known/agent-skills/index.json` source (static under `public/.well-known/` or its build emitter
  — confirm at implementation), optionally `public/.well-known/agent-skills/index.md`,
  `tests/e2e/discoverability.e2e.ts` or `tests/e2e/agents.e2e.ts`.
- **Approach:** Add a `skills[]` entry `{name, url, type}` per web-audit fix skill, `url` pointing at the content-URL
  doc from U10. Add a minimal human-readable `index.md` alongside (design says optional; ship it — cheap and improves
  discoverability). No skill body is served under `.well-known`.
- **Test scenarios:** `index.json` lists a skills entry per remediable check with content-URL targets; every listed
  `url` resolves 200 (cross-check against U10 routes); `index.md` renders. `Covers R11.`
- **Verification:** e2e asserts the index lists the skills and the targets resolve.

---

### Phase D — Remediation

*Shipped to `dev` in #199 (`3123dac`), 2026-07-13.*

#### U12. remediation.yaml restructure + prompt/result assembly [shipped]

- **Goal:** Restructure remediation to `title/goal/fix/resources` and assemble the copy-paste prompt + Result line at
  audit time.
- **Requirements:** R10.
- **Dependencies:** U2 (status), U10 (skill URL target).
- **Files:** `src/data/web-audit/remediation.yaml`, `src/worker/audit-web/remediation.ts` (new; load + assemble),
  `src/worker/audit-web/copy.ts`, `tests/web-remediation.test.ts`, `tests/web-audit-remediation-assembly.test.ts`.
- **Approach:** Each check entry carries `title`, `goal`, `fix`, `resources[]` (drop the MCP-shape-only `{{evidence}}`
  template). `remediation.ts` assembles, per non-passing check: the `prompt` block (`Goal / Issue / Fix / Skill / Docs`)
  with the run's evidence as the `Issue` line and `Skill: <origin>/web-audit/skill/<id>`; and the `Result` line derived
  from status+evidence (affirmative for pass, negative for fail/broken/absent). Bespoke `result` copy per check is an
  optional override.
- **Test scenarios:** a non-passing check assembles a prompt with the live evidence in `Issue` and the correct skill
  URL; a pass yields a Result line and no remediation object; `resources[]` render into `Docs:` comma-separated; a check
  missing a remediation entry degrades gracefully (no crash, generic prompt). `Covers R10.`
- **Verification:** assembly tests pass; the prompt matches the plan-002 worked example shape.

#### U13. MCP tools inline remediation [shipped]

- **Goal:** `audit_website` embeds remediation inline per non-passing row; `get_web_remediation(check, evidence?)`
  returns static remediation by id.
- **Requirements:** R14.
- **Dependencies:** U12.
- **Files:** `src/worker/mcp/tools/web-audit.ts`, `src/worker/mcp/tools/web-remediation.ts`,
  `src/worker/mcp/instructions.ts` (the web-scorecard-shape sentence still says `badge` — drop that word for the 0.2
  shape), `tests/web-audit-mcp-tools.test.ts`, `tests/worker-mcp-audit.test.ts`, `tests/worker-mcp.test.ts` (the
  literal-assertion drift test), `tests/e2e/mcp.e2e.ts`.
- **Approach:** `audit_website` result rows gain `result`, `status` (incl. `n_a`), and (for non-passing) a `remediation`
  object (`goal/fix/skill_url/resources/prompt`) per the worked example; passing rows carry no remediation; a MAY absent
  carries `status: n_a` and no remediation. `get_web_remediation` returns the static remediation for any check id,
  filling `Issue` from the `evidence` arg when passed (generic line otherwise). The current tool's param is `check_id`
  (not `check`); keep `check_id` and reshape the response from `{title, body, evidence_template}` to `{goal, fix,
  skill_url, resources, prompt}`. Tool count stays 13 (both tools already exist; this reshapes their output); update
  `instructions.ts` (drop `badge`) and its literal-assertion drift test together.
- **Test scenarios:** `audit_website` embeds remediation only on non-passing rows; n_a rows have no remediation;
  `get_web_remediation("openapi")` returns the static object; with an `evidence` arg the `Issue` line uses it; unknown
  check id → `found: false`. `Covers R14.`
- **Verification:** MCP tool tests + audit e2e assert the inline/by-id shapes; handshake still reports 13 tools.

---

### Phase E — Display + schema

*Shipped to `dev` in #199 (`3123dac`), 2026-07-13.*

#### U14. Result page + summary-render rework [shipped]

- **Goal:** Group by visible category, per-category rollups, per-check Goal/Result/Fix/Resources + copy-paste prompt
  with a copy button; remove the badge; headline RELATIVE.
- **Requirements:** R12, R10.
- **Dependencies:** U4, U12.
- **Files:** `src/worker/audit-web/summary-render.ts`, `src/worker/audit-web/route.ts` (reads `score_pct` not
  `badge.score_pct`), `src/shared/scorecard-format.mjs` (see Approach — the web path stops delegating category/rollup to
  it), `src/client/web-audit.ts`, `content/web-audit.md`, `tests/web-audit-scorecard-format.test.ts`,
  `tests/e2e/web-audit.e2e.ts`.
- **Approach:** Render sections per visible category with a `passed/counted` rollup. `src/shared/scorecard-format.mjs`
  groups by principle, reads `badge.score_pct`, and is co-owned by the CLI `/score/live` path, so the web renderer must
  NOT reuse its principle-grouping/badge logic — either give the web path its own category-grouping render in
  `summary-render.ts`, or add an opt-in category+`score_pct` mode to the shared module (do not remap `row.group` to
  category; that breaks the CLI consumers). Fix an explicit category display order as a single source of truth (a
  `category_order` in the U1 registry) reused by the page, the markdown twin, the leaderboard, and MCP output. Each
  check row shows Goal (always), Result (always), Fix (when not passing), Resources (Docs + Skill link), and the
  copy-paste prompt behind a copy button with idle (`Copy prompt`) / success (`Copied`, timed revert) / fallback
  (clipboard denied, select-all textarea) states. The score header labels RELATIVE as the headline and GLOBAL as a
  smaller labeled secondary metric so the two percentages are not read as competing. `route.ts` stops reading
  `badge.score_pct` (removed in U4) and reads top-level `score_pct`. Principle is not shown or linked.
- **Test scenarios:** page groups rows under the five categories in the fixed `category_order`; a category with only n_a
  rows shows `0/0` and is de-emphasized; the two n_a wordings render distinctly (`antecedent-unmet` reads "not
  applicable", `optional-absent` reads "not implemented, optional"); a non-passing row exposes the prompt + copy button
  and the button shows its `Copied` state on click; no badge markup; headline equals RELATIVE with GLOBAL as a labeled
  secondary; markdown twin mirrors the structure. `Covers R12.`
- **Verification:** format test + web-audit e2e assert category grouping, rollups, and badge removal.

#### U15. Leaderboard: default GLOBAL sort + toggle [shipped]

- **Goal:** Sort the board by GLOBAL by default, offer a RELATIVE toggle.
- **Requirements:** R13, KTD-9.
- **Dependencies:** U4.
- **Files:** `src/build/web-leaderboard-render.mjs` (three `badge.score_pct` reads → top-level `score_pct`/`score`),
  `src/build/14-web-scorecards-emit.mjs` (its malformed-guard asserts `badge.score_pct` — retarget to `score_pct`),
  `scorecards/web/anc.dev.json` (regenerate the committed seed to the 0.2 `score_pct`/`score`/`categories` shape; it
  currently carries `badge` + `schema_version: 0.1`), `src/client/web-audit.ts` (or the leaderboard client),
  `content/web-audit.md`, a leaderboard test (extend `tests/web-audit-scorecard-format.test.ts` or add
  `tests/web-leaderboard.test.ts`).
- **Approach:** The emitter carries both `relative` and `global` per row; the render/client sorts by GLOBAL by default
  with a RELATIVE toggle. Ship the seed migration (`scorecards/web/anc.dev.json` to 0.2) and the emitter/render
  `badge`-to-`score_pct` changes in the SAME PR as the U4 schema bump so `bun run build` never sees a mixed shape. The
  toggle is a labeled two-option segmented control (`Global | Relative`) with the active option marked, GLOBAL
  preselected, and the selection persisted in a URL param so a shared or reloaded board keeps the sort. The per-domain
  result page still headlines RELATIVE.
- **Test scenarios:** board default order is by GLOBAL desc; toggling re-sorts by RELATIVE and marks the active option;
  the sort persists across reload via the URL param; a site perfect for its type ranks below a bigger, higher-GLOBAL
  site by default (its RELATIVE is 100 but its GLOBAL is lower) and rises to the top under RELATIVE; `bun run build`
  regenerates the anc.dev seed and the emitter accepts the 0.2 shape with no `badge`. `Covers R13.`

- **Verification:** leaderboard test asserts both sort orders.

#### U16. Scorecard schema doc + version bump + drift guard [shipped]

- **Goal:** Document the `0.2` scorecard shape and guard against doc/constant drift.
- **Requirements:** R12, KTD-11.
- **Dependencies:** U4, U13.
- **Files:** `content/web-scorecard-schema.md`, `tests/web-audit-scorecard-format.test.ts` (the web-schema conformance
  test — it pins `schema_version`, the `DOCUMENTED_TOP_LEVEL` field list including `badge`, and the badge assertions;
  `tests/scorecard-schema-version.test.ts` is the CLI scorecard and never sees `WEB_SCHEMA_VERSION`). Optionally add a
  dedicated web drift test pinning `content/web-scorecard-schema.md` to `WEB_SCHEMA_VERSION`.
- **Approach:** Update the schema doc to the new shape: top-level `score_pct`, `score{relative,global}`, `categories[]`
  rollups, row `status` including `n_a` with `na_reason`, the inline `remediation` object, and the removal of `badge`.
  Bump the documented version to match `WEB_SCHEMA_VERSION = 0.2`. Update `tests/web-audit-scorecard-format.test.ts`'s
  `DOCUMENTED_TOP_LEVEL` (drop `badge`, add `score_pct`/`score`/`categories`), its `schema_version` assertion (0.1 to
  0.2), and the `webScorecard()` fixture, so the doc and the emitted shape cannot diverge.
- **Test scenarios:** the drift test fails if the doc version and `WEB_SCHEMA_VERSION` disagree; the doc describes every
  top-level field the scorecard emits (field-presence cross-check if feasible). `Covers R12.`
- **Verification:** schema-version test green at `0.2`.

---

### Phase F — End-to-end coverage

*Shipped to `dev` in #199 (`3123dac`), 2026-07-13.*

#### U17. E2E across the new surfaces [shipped]

- **Goal:** Prove the refined surfaces end to end on the staging opt-in project.
- **Requirements:** R1-R14 (integration level).
- **Dependencies:** all prior units.
- **Files:** `tests/e2e/web-audit.e2e.ts`, `tests/e2e/mcp.e2e.ts`, `tests/e2e/discoverability.e2e.ts`.
- **Execution note:** extend the existing remote-staging opt-in projects (skip-gated on `ANC_STAGING_BASE_URL`) rather
  than spinning local long-running servers.
- **Approach:** Add e2e assertions for: alias 301 redirects; `/web-audit/skill/<id>` + `.md` twin; the agent-skills
  index listing resolvable skill URLs; a `site_type`-scoped audit changing applicability; the result page's category
  grouping and RELATIVE headline; `audit_website` inline remediation on a non-passing check.
- **Test scenarios:** covered by the surfaces above; each assertion is skip-gated when the staging base URL is absent.
- **Verification:** the opt-in e2e project passes against staging after deploy.

---

## Scope Boundaries

**In scope:** the seven refinement workstreams (R1-R14) across registry, handlers, engine, scorer, routes, remediation,
MCP tools, presentation, schema, and e2e.

### Deferred to Follow-Up Work

- **Difficulty-weight calibration.** Weights stay config (default 5/3/1) and unlocked; tuning waits on real anc100 audit
  data (n=1 today). Only the *mechanism* (config + the `score_model.py` parity test) ships now.
- **Named grade/level band.** No global grade or "Level N / Agent-Native" tier by default; a named tier can be added
  later if wanted.
- **Bespoke per-check Result copy.** Result lines derive from status+evidence uniformly; hand-authored per-check result
  copy is an optional later override.
- **Commerce checks** (`x402`, `mpp`, `ucp`, `acp`) and a Commerce site type — out of scope.

### Out of scope

- Re-litigating the fairness model itself (settled; captured in
  `docs/solutions/design-patterns/web-audit-fairness-scoring-model.md`).
- The base audit plumbing (cache, SSRF, limiter, discovery transport) beyond the tri-state and antecedent changes named
  above.

---

## Risks & Dependencies

- **api-surface over-detection (KTD-4).** The union of signals can turn `openapi` into a MUST `fail` on a content site
  that merely references OpenAPI. Mitigation: monitor real audits; the signal set is easy to narrow (drop the weakest
  signal) without a schema change. Called out as a monitored decision, not a silent default.
- **Engine restructure regression (KTD-2).** Moving from an unordered fan-out to two waves risks changing
  concurrency/deadline behavior. Mitigation: preserve the deadline machinery; assert zero re-fetch and wave ordering in
  tests before deleting the old path.
- **Scorer/tool divergence (KTD-3).** The engine scorer and `score_model.py` could drift. Mitigation: a committed shared
  fixture + a parity test that fails on divergence.
- **Alias-redirect consumers (KTD-6).** Something may depend on an alias serving a body. Mitigation: U9 confirms no
  consumer reads the alias body; the canonical path is unchanged.
- **Cache-key vs read-path (U7).** `GET /web/<domain>` and `get_website_audit` resolve by domain only, so keying the
  cache by `site_type` would strand every typed audit. Mitigation: store `site_type` in the cached payload (one
  domain-keyed entry, last-writer-wins), not in `keyFor`.
- **SSRF via link-derived probes (U8).** Scoped-llms candidates come from the target's own `llms.txt`/sitemap, which an
  attacker controls; an off-origin or private-IP href could steer Worker egress at internal or metadata endpoints. The
  entry-point SSRF guard only validated the original target. Mitigation: same-origin restriction plus
  `validatePublicUrl` on every candidate (U8/KTD-5). The pre-existing DNS-rebinding residual in `ssrf.ts` is inherited,
  not widened.
- **Schema consumers.** The `0.2` shape changes top-level fields (badge removed, score_pct/score/categories added).
  Downstream readers (leaderboard emitter, any external consumer) must move together; the drift guard (U16) and the
  emitter updates (U14/U15) are in the same series.

---

## Open Questions

- **Category membership** (the five visible categories and their check assignments) is adopted from the plan-002
  proposed table; redline during U1/U14 if a grouping reads wrong to users. Not blocking.
- **302 vs 301 on aliases** (U5/U9): the rule credits `301`/`308`; decide whether a `302` alias is `pass` or `broken`.
  Recommended: only `301`/`308` = pass (permanent-redirect intent); document in the eval rule.
- **agent-skills `index.md`** (U11): shipping a minimal human index by default; drop it if it adds noise.
- **Streaming render model** (U14): the result page is fed by an NDJSON stream, but category grouping needs every row's
  category before it can group. Decide whether the page buffers the full stream then renders grouped sections (with a
  skeleton/loading state meanwhile) or renders a flat live list that regroups on completion. This drives the loading
  state design and cannot be inferred; resolve before U14.
- **GLOBAL-beside-RELATIVE copy** (U14): the exact label strings for the headline RELATIVE and the secondary GLOBAL, so
  users do not read them as competing percentages. The U14 approach picks a default layout; lock the strings there.

---

## Sources & Research

- `docs/plans/2026-07-09-002-feat-web-audit-refinements.md` — the settled design (origin). This plan implements its
  "Score + display model" section; its stale "check matrix" warn prose is superseded.
- `docs/solutions/design-patterns/web-audit-fairness-scoring-model.md` — the fairness scoring rationale
  (relative+global, outcome scale, antecedent gating) this plan encodes.
- `docs/solutions/architecture-patterns/agent-readiness-audit-surface-2026-07-01.md` — standards-stability tiers and the
  `applies_to`→antecedent lineage.
- `scripts/scoring/score_model.py` — the dev-only calibration tool the engine scorer (U4) mirrors; guarded from main.
- Current implementation read for grounding: `src/worker/audit-web/{engine,scorecard,route,registry}.ts`,
  `src/worker/index.ts` (MCP alias serving), `src/data/web-audit/{registry,remediation}.yaml`.
