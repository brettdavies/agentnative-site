---
title: "feat: Add a MAY web-audit check for markdown-twin frontmatter"
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
type: feat
created: 2026-08-03
product_contract_source: ce-plan-bootstrap
plan_depth: standard
related_plans:
  - docs/plans/2026-08-03-002-feat-twin-frontmatter-emit-plan.md
---

# feat: Add a MAY web-audit check for markdown-twin frontmatter

## Summary

Add one new `optional`-tier (MAY) check to the web-audit registry, `markdown-frontmatter`, that rewards a site whose
root markdown twin (`Accept: text/markdown` on `/`) begins with a YAML frontmatter block (`title` / `description` /
`url` style metadata). Its antecedent flips it to `n_a` when the site exposes no markdown twin at all, so a site is
never penalized for a surface it does not offer. Detection uses a small dedicated Worker handler
(`markdown-frontmatter`) that structurally recognizes a leading, terminated frontmatter fence with at least one key
line, without pulling a YAML parser into the Worker.

This is part (b) of Feature 2. Part (a) (emitting frontmatter into anc.dev's own twins) is a separate, independently
shippable plan: `docs/plans/2026-08-03-002-feat-twin-frontmatter-emit-plan.md`. This check works against any site
regardless of whether (a) has shipped; once (a) ships, anc.dev self-audits as `pass` for this check.

---

## Problem Frame

The web-audit engine scores a site's agent-facing surface against a registry of checks grouped into six categories, each
check carrying a MUST/SHOULD/MAY obligation (`required`/`recommended`/`optional` tier). The `content-for-agents`
category already rewards serving markdown via content negotiation (`accept-markdown`, a SHOULD). It does **not** yet
reward the next increment of quality: markdown twins that carry structured frontmatter so an agent gets canonical
`title`/`description`/`url` without parsing the body. context.dev does this and it is a genuine, cheap ingestion win
worth surfacing in the audit.

Two fairness constraints shape the design:

1. A site that serves no markdown twin must not be dinged for missing frontmatter on a twin it does not have. That is
   the antecedent's job: gate to `n_a` (`antecedent-unmet`) when no twin is served.
2. A site that serves a twin but without frontmatter must not be penalized either. That is the MAY-absent rule the
   engine already implements: an applicable MAY that is simply absent is re-tagged `n_a` (`optional-absent`) and
   excluded from scoring. The only penalty case is a **broken** frontmatter block (opened but malformed), which is worse
   than absence because it misleads a parser.

So the check only ever adds reward (a `pass` earns the MAY weight in both the relative and global scores), never a
penalty except for a genuinely malformed block.

---

## Requirements

- **R1** A new registry check `markdown-frontmatter`: `tier: optional` (MAY), `category: content-for-agents`,
  `principle: P2`, `site_types: [all]`, `weight: 1`.
- **R2** The check passes when the site's root markdown twin begins with a YAML frontmatter block: a leading `---` fence
  line, a terminating `---` (or `...`) fence line, and at least one `key:` mapping line between them.
- **R3** The check's antecedent flips it to `n_a` (`antecedent-unmet`) when the site exposes no markdown twin (the
  `markdown-twin` antecedent does not resolve `apply`).
- **R4** When a twin is served but carries no leading frontmatter, the check finalizes to `n_a` (`optional-absent`) via
  the existing MAY-absent rule (no penalty).
- **R5** When a twin is served with a malformed frontmatter block (leading `---` but no terminator, or a fence pair with
  no key line), the check is `broken` (present-but-invalid penalty).
- **R6** Detection runs in the Worker with no new heavy dependency: structural recognition only, no YAML parse, no
  `js-yaml` in the Worker bundle.
- **R7** A 1:1 remediation entry exists for the new check (build validation requires it), with
  `title`/`goal`/`fix`/`resources`.
- **R8** The new check composes cleanly with the concurrent Feature 1 markdown-serving MAY check(s): distinct check id,
  a shareable markdown-twin antecedent, and a single coordinated `accept-markdown` wave-1 promotion.
- **R9** The scorecard JSON shape and `WEB_SCHEMA_VERSION` are unchanged (the `na_reason` union already includes both
  reasons; adding a check does not change the shape).

---

## Key Technical Decisions

### KTD1. A dedicated `markdown-frontmatter` handler, not the generic `http` handler

The generic `http` handler evaluates `body_regex` with `assertHttp`, which compiles the pattern with `im` flags. Under
multiline `m`, `^---` matches a `---` line **anywhere** in the body, which a markdown thematic break (horizontal rule)
trivially produces. There is no way to anchor at absolute string start (JS regex has no `\A`, and touching the shared
pure `assert.ts` to add one is out of proportion). So detection needs a small dedicated handler that inspects the body
from its first byte. This matches the existing per-concern handler pattern (`webmcp`, `auth-md`, `scoped-llms` are all
dedicated handlers).

### KTD2. Structural detection, not a YAML parse

The handler recognizes the block structurally: strip an optional leading BOM; require the body to start with a `---`
fence line; scan for a terminating `---`/`...` line; require at least one line between the fences matching a `key:`
shape (`^\S[^:]*:(\s|$)`). It does **not** parse the YAML. `js-yaml` is a build-only dependency; importing it into the
Worker adds bundle weight and runtime cost for no gain, because the audit only needs "is there a well-formed frontmatter
block", not the parsed values (R6). A malformed-but-fenced block is caught as `broken` by the "no key line / no
terminator" branches.

### KTD3. Gate on a shared `markdown-twin` antecedent; do not duplicate it (Feature 1 owns its definition)

The antecedent for "this site serves a markdown twin" reads only wave-1 outcomes (`ctx.sources`), never a fresh fetch,
so its markdown signal (`accept-markdown`) must be a wave-1 source. The concurrent Feature 1 plan
(`docs/plans/2026-08-03-001-feat-web-audit-md-agent-rewards-plan.md`) **already** introduces exactly this: an antecedent
token named `markdown-twin` (resolving `apply` on a three-way disjunction: `accept-markdown` passed, a `text/markdown`
`rel="alternate"` root Link header, or `/llms.txt` present) **and** the promotion of `accept-markdown` into
`WAVE1_CHECK_IDS`. Both plans need the identical token and the identical promotion, so this plan **consumes Feature 1's
`markdown-twin` rather than defining its own** (two tokens for one concept is drift; two promotions of the same id into
a `Set` is duplicative). Feature 1's disjunction is a strict superset of what this check needs, and it is the correct,
broader definition of "serves a twin".

One consequence to accept: `markdown-twin` can hold via the `llms.txt`-only disjunct on a site whose root does **not**
negotiate markdown. In that case this check's own fetch of `/` (KTD4) returns HTML, the content-type guard yields
`absent`, and the MAY-absent rule finalizes it to `n_a` (`optional-absent`). That is a correct, non-penalizing outcome,
so consuming the broader antecedent is safe.

**Fallback (only if Feature 1 does not land):** define `markdown-twin` here as `sourcePassed(ctx, 'accept-markdown') ?
'apply' : 'n_a'` in `src/worker/audit-web/antecedents/content.ts` and add `accept-markdown` to `WAVE1_CHECK_IDS` (U2
carries this fallback). The root plain-GET fetch (`text/html`) cannot detect a twin, so the wave-1 promotion is required
either way. This fallback resolver drops Feature 1's `error`-on-root-network-failure and `n_a`-on-non-HTML-root
branches, which is acceptable because the check is non-penalizing: both dropped branches resolve to `n_a` here anyway.
When Feature 1 is present, its three-way disjunction is the authoritative `markdown-twin`; this plan consumes it and
never redefines it.

### KTD4. The handler does its own `Accept: text/markdown` fetch of `/`

The single canonical root fetch threaded through `HandlerContext.root` is a plain GET (`text/html`); it cannot be reused
for the twin body. Handlers do not currently receive the wave-1 `sources` map, so the handler cannot reuse
`accept-markdown`'s response body either. The handler issues its own guarded fetch of `/` with `Accept: text/markdown`
(one extra subrequest, well within the concurrency-6 / 25s-deadline budget). Reusing a retained `accept-markdown` body
would require threading `sources`/retained bodies into `HandlerContext`; that optimization is deferred (see Scope
Boundaries), since the antecedent already guarantees the twin exists so the extra fetch is cheap and simple.

### KTD5. No scorecard schema bump; count-assertion bumps are required

Adding a check does not change the scorecard JSON shape: `na_reason` is already `'antecedent-unmet' |
'optional-absent'`, and the `results[]` row shape is unchanged. `WEB_SCHEMA_VERSION` stays `0.2`;
`content/web-scorecard-schema.md` needs no version change (it documents the shape + taxonomy generically and points at
the registry for the check list). What **does** change: this MAY check adds `+1` to the registry size, the live
`universeMax`, and the MAY tier count, so several count-bearing assertions move. Standalone deltas (from today's
36-check baseline): `checks.length` 36 -> 37 at four sites (`tests/web-remediation.test.ts:35`,
`tests/web-audit-routes.test.ts:381`, `tests/web-audit-scoring.test.ts:54` and `:232`), plus the
`tests/web-remediation.test.ts:33` describe-title string ("no misses across all 36" -> "37"); the two tier-distribution
object assertions in `tests/web-audit-scoring.test.ts` (`{ required: 3, recommended: 15, optional: 18 }` at `:130` and
`{ must: 3, should: 15, may: 18 }` at `:137`, each MAY `+1` to `optional`/`may` 19); and the `universeMax` block (`:335`
78 -> 79, its inline arithmetic comment at `:329` `3 MUST x5 + 15 SHOULD x3 + 18 MAY x1 = 78` -> `19 MAY x1 = 79`, and
the `:327` tier-distribution test title 3/15/18 -> 3/15/19). **If Feature 1 (which adds four MAY checks) merges first**,
the baselines shift: `checks.length` 40 -> 41, `universeMax` 82 -> 83, distribution 3/15/22 -> 3/15/23. The
second-merged plan reconciles to the cumulative literal; do not write `37`/`79` blindly. The two-score parity fixture
(`tests/fixtures/web-audit-score-parity.json`) uses a synthetic universe, not the live registry count, so it is
unaffected.

---

## High-Level Technical Design

Evaluation flow for the new check, keyed on the two fairness constraints:

```text
      wave 1 (unconditional probes)                 wave 2 (gated)
   ┌───────────────────────────────┐
   │ accept-markdown  (PROMOTED)    │───► sources['accept-markdown'] = pass|absent|broken
   │ robots, llms-txt, sitemap, ... │
   └───────────────────────────────┘
                     │
                     ▼
        antecedent 'markdown-twin':
        sourcePassed('accept-markdown') ?
             ┌── no ──► n_a (antecedent-unmet)         [R3: site serves no twin]
             └── yes ─► run markdown-frontmatter handler
                              │
                              ▼  GET / with Accept: text/markdown
                    ┌─────────────────────────────────────────┐
                    │ starts with '---' fence?                 │
                    │   no  ─► absent ─► finalizeOptional ─► n_a (optional-absent)  [R4]
                    │   yes ─► terminator + >=1 key line?      │
                    │            no  ─► broken   [R5: malformed]│
                    │            yes ─► pass  (+1 MAY weight)   [R2: reward]│
                    └─────────────────────────────────────────┘
```

---

## Output Structure

New file created by this plan (all other changes edit existing files):

```text
src/worker/audit-web/handlers/
└── markdown-frontmatter.ts    # the dedicated detection handler
```

---

## Implementation Units

### U1. Add the `markdown-frontmatter` handler

**Goal:** A Worker handler that fetches the root twin and returns `pass` / `absent` / `broken` per the frontmatter
structure.

**Requirements:** R2, R5, R6.

**Dependencies:** none.

**Files:**
- `src/worker/audit-web/handlers/markdown-frontmatter.ts` (new)
- `src/worker/audit-web/engine.ts` (register in the `HANDLERS` map)
- `src/worker/audit-web/registry.ts` (`WebCheckHandler` union: add `'markdown-frontmatter'`)
- `src/build/13-web-audit-registry.mjs` (`WEB_AUDIT_HANDLERS` set: add `'markdown-frontmatter'`)
- `tests/web-audit-handlers.test.ts` (new cases)

**Approach:**
1. Signature `runMarkdownFrontmatter(check, ctx): Promise<ProbeOutcome>`, matching the other handlers. Read `path`
   (default `/`) and `headers` (default `{ Accept: 'text/markdown' }`) from `check.with`.
2. `guardedFetch(resolveUrl(ctx.base, path), { headers }, { ...ctx.fetchOptions, timeoutMs })` via the SSRF guard (never
   a bare `fetch`); reuse `timeoutMsFor` / `resolveUrl` from `handlers/shared`.
3. On request error or null status: return `{ status: 'error', ... }` (operational, excluded from scoring).
4. Detection on `resp.body`: strip a leading BOM; if it does not start with a `---` fence line -> `absent`. Else scan
   subsequent lines for a `---` or `...` terminator; if none -> `broken` (unterminated). Between the fences, require at
   least one line matching `^\S[^:]*:(\s|$)` (a `key:` mapping line); if none -> `broken` (empty/degenerate block).
   Otherwise -> `pass`.
5. Evidence rows mirror the http handler shape (`url`, `status`, `ok`, `why`), e.g. `why: ['frontmatter present (N key
   lines)']` / `['no leading frontmatter fence']` / `['unterminated frontmatter fence']`.
6. Defensive content-type check: if the response is `text/html` (antecedent should preclude this), treat as `absent`
   rather than scanning HTML for a stray `---`.
7. Never use `any`; type `check.with` with a local `MarkdownFrontmatterWith` shape as the other handlers do.

**Patterns to follow:** `src/worker/audit-web/handlers/http.ts` (guarded fetch, evidence shape, `classifyMiss` idea),
`handlers/auth-md.ts` and `handlers/webmcp.ts` (dedicated-handler structure), `handlers/shared.ts` (`resolveUrl`,
`timeoutMsFor`).

**Test scenarios:**
- Body starting with `---\ntitle: X\ndescription: Y\nurl: https://z/\n---\n\n# H` (fetchImpl-injected) -> `pass`.
- Body with a leading `---` fence and a key line but no terminating fence -> `broken` (unterminated).
- Body with `---\n---\n` (fence pair, no key line) -> `broken` (degenerate block).
- Body with `---\n# just a comment\n---\n` (fence pair whose only inter-fence line is a YAML comment, no `key:` line) ->
  `broken` (the "≥1 key line" edge case: a `# ...` comment is not a key line).
- Body starting with prose / an H1 (no fence) -> `absent`.
- Body whose only `---` is a mid-document thematic break (rule) after real prose -> `absent` (not a false `pass`;
  confirms KTD1's anchoring requirement).
- Body with a leading UTF-8 BOM before the `---` fence -> `pass` (BOM tolerated).
- `text/html` response body that happens to contain `---` -> `absent` (content-type guard).
- Fetch error (null status) -> `error`.
- CRLF line endings (`---\r\ntitle: X\r\n---\r\n`) -> `pass`.

**Verification:** Handler unit tests pass; `engine.ts` type-checks with the handler wired into `HANDLERS`.

---

### U2. Ensure the shared `markdown-twin` antecedent exists (consume Feature 1's, or add the fallback)

**Goal:** The `markdown-twin` antecedent token resolves from `accept-markdown`'s wave-1 result, so U3's check can gate
on it. Ownership is coordinated with Feature 1 (plan 001), which introduces the identical token and the same wave-1
promotion.

**Requirements:** R3, R8.

**Dependencies:** none (independent of U1). **Coordination:** Feature 1 (plan 001) also introduces `markdown-twin` + the
`accept-markdown` wave-1 promotion.

**Files (fallback path only — skip when Feature 1 already landed these):**
- `src/worker/audit-web/antecedents/content.ts` (add `markdown-twin` resolver + unmet-evidence)
- `src/worker/audit-web/registry.ts` (`AntecedentToken` union: add `'markdown-twin'`)
- `src/build/13-web-audit-registry.mjs` (`WEB_AUDIT_ANTECEDENTS` set: add `'markdown-twin'`)
- `src/worker/audit-web/antecedents/waves.ts` (`WAVE1_CHECK_IDS`: add `'accept-markdown'`)
- `tests/web-audit-antecedents-content.test.ts`, `tests/web-audit-antecedents-waves.test.ts`

**Approach:**
1. **If Feature 1's `markdown-twin` + `accept-markdown` wave-1 promotion are already present** (merged or in the same
   integration branch): this unit is a no-op beyond confirming the token exists and resolves. Do **not** re-add the
   token (a duplicate `AntecedentToken` member / `contentResolvers` key is a type/build error) and do **not** re-add
   `accept-markdown` to `WAVE1_CHECK_IDS` (harmless but duplicative). Skip to U3.
2. **Fallback (Feature 1 not present):** in `content.ts`, add `const markdownTwin: AntecedentResolver = (ctx) =>
   (sourcePassed(ctx, 'accept-markdown') ? 'apply' : 'n_a');`, register `'markdown-twin': markdownTwin` in
   `contentResolvers` and `'markdown-twin': 'no markdown twin served (Accept: text/markdown did not return markdown)'`
   in `contentEvidence` (`index.ts` composes both automatically). Add `'markdown-twin'` to the `AntecedentToken` union
   (`registry.ts`) and `WEB_AUDIT_ANTECEDENTS` (`13-web-audit-registry.mjs`). Add `'accept-markdown'` to
   `WAVE1_CHECK_IDS` (`waves.ts`); its `html-root` gate still applies in the wave-1 finalize loop, so behavior/score are
   unchanged, only probe timing.

**Patterns to follow:** the existing `docs-site` / `root-llms-txt` resolvers in `content.ts` (`sourcePassed`-based); the
union + set + validation triple used for every antecedent token; Feature 1's own `markdown-twin` definition if present.

**Test scenarios (fallback path; when consuming Feature 1's token, its own tests cover these):**
- `resolveAntecedent('markdown-twin', ctx({ sources: Map[['accept-markdown', outcome('pass')]] }))` -> `apply`.
- `resolveAntecedent('markdown-twin', ctx({ sources: Map[['accept-markdown', outcome('absent')]] }))` -> `n_a`.
- `resolveAntecedent('markdown-twin', ctx({}))` (no source) -> `n_a`.
- `WAVE1_CHECK_IDS.has('accept-markdown')` is `true` (extend the waves test's id list).
- The existing wave-1 members still resolve/pass (no regression from the promotion).

**Verification:** `markdown-twin` resolves and `accept-markdown` is a wave-1 source (from whichever plan owns it); `bun
run build` normalizes the registry (validation set admits the token).

---

### U3. Register the check + remediation, and reconcile the live-registry assertions

**Goal:** The `markdown-frontmatter` check is in `registry.yaml` with a 1:1 remediation entry, and every live-registry
assertion (count, `universeMax`, tier distribution) is reconciled by `+1 MAY` (see KTD5 for
standalone-vs-after-Feature-1 baselines).

**Requirements:** R1, R4, R7, R9.

**Dependencies:** U1 (handler name must be in `WEB_AUDIT_HANDLERS`), U2 (antecedent token `markdown-twin` must be in
`WEB_AUDIT_ANTECEDENTS`, whether from Feature 1 or the U2 fallback). The build's registry validation rejects an unknown
handler/antecedent, so U1 and U2 land first.

**Files:**
- `src/data/web-audit/registry.yaml` (new check in the `content-for-agents` block)
- `src/data/web-audit/remediation.yaml` (new `markdown-frontmatter` entry)
- `tests/web-remediation.test.ts` (`checkIds.length` `:35`, `+1`; describe-title string "no misses across all 36" `:33`)
- `tests/web-audit-routes.test.ts` (`checks.length` `:381`, `+1`)
- `tests/web-audit-scoring.test.ts` (`checks.length` `:54` and `:232`, `+1`; tier-distribution objects `{ required: 3,
  recommended: 15, optional: 18 }` `:130` and `{ must: 3, should: 15, may: 18 }` `:137`, MAY `+1`; `universeMax` `:335`,
  `+1`, and its inline arithmetic comment `:329`; `:327` tier-distribution test title, MAY `+1`)
- `tests/web-audit-antecedents-engine.test.ts` (end-to-end scenarios for the new check)

**Approach:**
1. Registry entry (append to the `content-for-agents` section for stable display ordering):
   ```yaml
   - id: markdown-frontmatter
     category: content-for-agents
     tier: optional
     principle: P2
     site_types: [all]
     antecedent: markdown-twin
     weight: 1
     title: Markdown twin carries YAML frontmatter
     handler: markdown-frontmatter
     with:
       path: /
       headers: { Accept: text/markdown }
     hint: Prefix each markdown twin with YAML frontmatter (title, description, canonical url) so agents ingest page metadata without parsing the body.
   ```
   Do not hand-author a `keyword` (it derives from `tier`); the build aborts if present.
2. Remediation entry (title/goal/fix/resources), mirroring the `accept-markdown` entry's voice; resources point at a
   stable frontmatter reference and the anc.dev example twin.
3. Reconcile every live-registry count-bearing assertion by `+1 MAY` (see the Files list and KTD5 for exact sites and
   baselines).

**Patterns to follow:** the `accept-markdown` registry entry (~line 308) and its remediation entry (~line 166); the
append-a-check convention (the build derives `keyword`, generates the `/web-audit/skill/markdown-frontmatter` page, and
the discovery index entry automatically, so no display wiring is needed).

**Test scenarios:**
- End-to-end (engine test with an injected fetch impl): a site whose `/` markdown twin has frontmatter -> the
  `markdown-frontmatter` result is `pass` and contributes its MAY weight.
- A site that serves a twin without frontmatter -> `n_a` with `na_reason: 'optional-absent'` (not counted, R4).
- A site presenting none of the three markdown signals (`accept-markdown` absent, no `/llms.txt`, and no `text/markdown`
  `rel="alternate"` root Link) -> `n_a` with `na_reason: 'antecedent-unmet'` (R3).
- A site serving a malformed (unterminated) frontmatter twin -> `broken` (R5), and the two-score result is lower than
  the same site with the twin frontmatter-absent.
- `normalizeWebAuditRegistry` accepts the new check (handler + antecedent validate) and `normalizeWebRemediation` passes
  1:1 (no orphan, full coverage).
- The reconciled count / `universeMax` / tier-distribution assertions read the `+1 MAY` totals.

**Verification:** `bun test` green (assertions reconciled, engine scenarios pass); `bun run build` emits
`dist/_internal/web-audit-registry.json` with the new check present and `dist/web-audit/skill/markdown-frontmatter.md`.

---

## Scope Boundaries

**In scope:** one MAY check (`markdown-frontmatter`), its dedicated handler, the remediation entry, gating on the shared
`markdown-twin` antecedent (consumed from Feature 1, or added via U2's fallback), and the live-registry test
reconciliation.

**Out of scope / Deferred to Follow-Up Work:**
- Reusing `accept-markdown`'s retained response body instead of a second fetch (would require threading
  `sources`/retained bodies into `HandlerContext`; the antecedent already guarantees the twin exists, so the extra fetch
  is cheap). KTD4.
- Probing frontmatter on non-root twins (per-page). This check probes `/` only, matching `accept-markdown`'s single-URL
  scope.
- Validating the frontmatter's field contents (e.g. requiring `url` to be canonical). Structural presence only (KTD2); a
  stricter content check is a future increment.
- Any scorecard schema/version change (KTD5).

**Explicit non-goals:** changing the scoring formula, the two-score parity fixture, or the six display categories.

---

## Cross-Feature Contention Notes

Feature 1 is on disk as `docs/plans/2026-08-03-001-feat-web-audit-md-agent-rewards-plan.md` (four MAY checks for serving
markdown to agent user-agents). It touches the **same** registry, remediation, antecedent, and test-count files. Read as
concrete facts, not hypotheticals:

- **Shared `markdown-twin` antecedent + `accept-markdown` wave-1 promotion (direct collision, resolved).** Feature 1's
  U1/U2 introduce an antecedent token named exactly `markdown-twin` (a three-way disjunction: `accept-markdown` passed
  OR root `rel="alternate"` `text/markdown` Link OR `/llms.txt` present) **and** promote `accept-markdown` into
  `WAVE1_CHECK_IDS`. This plan's U2 is written to **consume** that shared token rather than redefine it (KTD3); only the
  U2 fallback adds it, and only if Feature 1 does not land. Do not let both plans add the `markdown-twin` union member /
  resolver (a type/build error) or both edit `WAVE1_CHECK_IDS` (duplicative). Whichever merges first owns the
  definitions.
- **Guaranteed conflict on the live-registry assertions.** Feature 1 bumps `checks.length` 36 -> 40, `universeMax` 78 ->
  82, and the tier distribution 3/15/18 -> 3/15/22 (`tests/web-remediation.test.ts`, `tests/web-audit-routes.test.ts`,
  `tests/web-audit-scoring.test.ts`). This plan adds one MAY on top. The second-merged plan reconciles to the cumulative
  literals (checks 41, universeMax 83, distribution 3/15/23); do not write the standalone `37`/`79` values blindly. See
  KTD5.
- **Registry / remediation append points.** Both add YAML entries to the same two files, both in the
  `content-for-agents` category. Keep diffs disjoint by appending distinct blocks with distinct ids. This plan uses id
  `markdown-frontmatter`; Feature 1's ids include `markdown-cli-ua` (and three siblings) — no id collision.
- **No handler overlap.** Feature 1's markdown-serving checks use the existing `http` handler; this plan ships a new
  dedicated `markdown-frontmatter` handler. No collision on `HANDLERS` / `WEB_AUDIT_HANDLERS` beyond both files being
  edited.

Part (a) of Feature 2 (`docs/plans/2026-08-03-002-...`) is in the build pipeline and does not touch this plan's files;
it only affects whether anc.dev self-audits `pass` here.

---

## System-Wide Impact / Operational Notes

- **Global score shift for all sites.** Adding a MAY to the registry raises the GLOBAL universe denominator
  (`universeMaxOf` over the live registry). Every audited site's `score.global` shifts slightly until sites adopt
  frontmatter; relative scores are unaffected for sites without a twin (the check is `n_a` for them). This is the
  intended MAY behavior.
- **Seed / leaderboard rescore.** Web board surfaces render from R2 at request time; seeded and leaderboard scorecards
  are recomputed by the rescore workflow. After deploy, trigger a rescore so persisted global scores reflect the new
  universe (same operational step used for prior registry changes). Staging e2e should exercise a site with frontmatter
  (anc.dev, once part (a) ships) and one without.
- **Auto-generated surfaces.** The build auto-emits `/web-audit/skill/markdown-frontmatter` (HTML + twin) and the
  agent-skills discovery index entry from registry + remediation; no manual page authoring.

---

## Assumptions

- `accept-markdown` staying a wave-1 source has no hidden consumer that assumes it is wave-2 (grep confirms it is
  referenced only in `registry.yaml` / `remediation.yaml`, and the waves test is a subset-presence check, not an
  exact-set assertion).
- The Worker runtime's `guardedFetch` honors a custom `Accept` header on the handler's own fetch (the `accept-markdown`
  http check already does exactly this).
- `content/web-scorecard-schema.md` documents the taxonomy generically and does not enumerate a per-check list or count,
  so it needs no edit (verified by grep). If a per-check enumeration is added later, it becomes a follow-up doc touch.

---

## Open Questions

- **OQ1** Should a fence pair with zero key lines (`---\n---`) be `broken` (this plan) or `absent`? Chosen default:
  `broken`, because an empty frontmatter block is present-but-useless and signals a templating bug worth flagging.
  Revisit if it proves noisy on real sites.
- **OQ2** Remediation `resources` links: cite a canonical frontmatter reference (e.g. a YAML front-matter convention
  doc) plus the anc.dev example twin, or only the anc.dev example? Default: both, once part (a) makes the anc.dev
  example real.

---

## Sources & Research

- Registry + validation: `src/data/web-audit/registry.yaml` (`accept-markdown` ~line 308),
  `src/build/13-web-audit-registry.mjs` (`WEB_AUDIT_HANDLERS`, `WEB_AUDIT_ANTECEDENTS`, keyword-from-tier derivation,
  1:1 remediation validation).
- Remediation catalog: `src/data/web-audit/remediation.yaml` (`accept-markdown` ~line 166).
- Engine + probe model: `src/worker/audit-web/engine.ts` (wave 1/2, `gate`, `finalizeOptional`), `handlers/http.ts` +
  `handlers/types.ts` + `handlers/shared.ts` (handler contract), `assert.ts` (`im`-flag body_regex limitation behind
  KTD1).
- Antecedents: `antecedents/index.ts` (composition), `antecedents/content.ts` (`sourcePassed` resolvers),
  `antecedents/context.ts` (`sourcePassed`), `antecedents/waves.ts` (`WAVE1_CHECK_IDS`), `antecedents/root.ts`
  (`html-root`).
- Scoring: `src/worker/audit-web/score.ts` (`universeMaxOf`, MAY-absent excluded), `src/worker/audit-web/scorecard.ts`
  (`NaReason = 'antecedent-unmet' | 'optional-absent'`, `WEB_SCHEMA_VERSION = '0.2'`).
- Auto-generated skill pages: `src/build/15-web-audit-skills.mjs`.
- Test coupling: `tests/web-remediation.test.ts:35`, `tests/web-audit-routes.test.ts:381`,
  `tests/web-audit-scoring.test.ts:54,232` (count `36`); `tests/web-audit-two-score.test.ts` (synthetic universe,
  unaffected); `tests/web-audit-handlers.test.ts`, `tests/web-audit-antecedents-engine.test.ts` (patterns for new
  cases).
