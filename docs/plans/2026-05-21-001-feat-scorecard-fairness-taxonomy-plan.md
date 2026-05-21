---
title: 'feat: Scorecard status taxonomy + scoring fairness (Path 2)'
type: feat
status: proposed
date: 2026-05-21
origin: anc v0.4.0 rescore session, 2026-05-21 — sandbox-driven fairness analysis triggered by the v0.4.0 behavioral check expansion (11 → 18 checks) widening the denominator and exposing the existing scoring algorithm's conflations
---

# feat: Scorecard status taxonomy + scoring fairness (Path 2)

> **Triage note.** This plan describes a multi-repo change. The bulk of the implementation lands in
> `brettdavies/agentnative` (spec) and `brettdavies/agentnative-cli` (CLI). The site repo executes the downstream
> renderer and methodology updates after the spec + CLI artifacts ship. The plan lives here because the analysis,
> sandbox data, and the cross-repo migration plan were produced in this repo during the v0.4.0 rescore session.

---

## Summary

The current scoring formula `score_pct = pass / (pass + warn + fail)` plus the 5-status output `{pass, warn, fail, skip,
error}` produces a leaderboard percent that conflates four semantically different reasons a check might fail to
contribute, and flattens RFC 2119's three-tier requirement hierarchy into a binary pass-or-not. The conflation is
invisible when the spec is small; it becomes visible when the check menu expands. v0.4.0's behavioral-layer expansion
(11 → 18 checks per tool, with several new MAY-tier items) exposed it: 27 tools dropped 5–17 points purely from the
larger denominator, even though their actual compliance posture is unchanged.

The path forward separates input shape from formula choice. First, the spec adopts a 7-status taxonomy that lets a
verifier distinguish "tool deliberately did not adopt this" from "this check does not apply to this tool" from "the
linter could not measure." Conditional requirements (e.g., "if a CLI ships `--output json`, it MUST also expose a
schema") get an explicit representation in `coverage-matrix.json`. With the cleaner input, a downstream scoring formula
(tier-weighted, ceiling-aware) can be specified without ambiguity. The CLI implements the new statuses, bumps the
scorecard schema, and the site rescores the registry against the post-change CLI.

This plan does **not** specify final weight values or the final formula. Those are downstream decisions that depend on
the disambiguated data; the sandbox in `scripts/score-sandbox.py` explores candidates but no single configuration is
fair under the current 5-status data. Path 2 fixes the foundation; the formula choice is a separate spec issue once this
lands.

---

## Problem Frame

### The four-way `skip` overload

The current 5-status set buries four distinct outcomes in a single `skip` status:

1. **Inapplicable check.** `bat` does not accept secret-bearing flags. `p1-secret-non-leaky-path` has no surface area to
   evaluate. The check is logically `n/a`; the tool has nothing to comply with.
2. **Opt-out adoption.** `fzf` does not ship a skill bundle. `p8-bundle-install` evaluates to "the feature exists in the
   spec; the tool chose not to ship it." Whether to penalize this is a deliberate policy choice, not a measurement gap.
3. **Conditional antecedent unmet.** A tool that does not ship `--output json` has no schema-discovery surface to fail.
   The MUST is conditional on the antecedent ("if you ship JSON, you MUST also ship the schema"); when the antecedent is
   unmet, the consequent does not apply.
4. **Linter probe limitation.** A tool's `--help` rendering masks a flag the probe expected to find via safe probes. The
   tool may comply; the linter could not measure. The CLI README documents this for `p2-json-output` specifically
   ("`--output/--format` flag detected but could not validate JSON via safe probes").

Downstream the scoring algorithm has no signal to differentiate these. The user's instinct is that they should not all
land in the same bucket. Conflating (1) and (4) under-penalizes tools that genuinely opt out. Treating (2) like a MUST
violation over-penalizes tools for non-adoption of optional features.

### The tier flatness

RFC 2119 defines three requirement tiers (MUST / SHOULD / MAY). The current status output collapses to two penalty
shapes: MUST-miss → `fail`, SHOULD-miss → `warn`, MAY-miss → `warn`. SHOULD and MAY land at the same penalty weight,
even though their normative meaning is distinct. A MAY is "truly optional"; a SHOULD is "strongly recommended absent
good reason." Same denominator weight makes neither claim honestly.

### Conditional requirements

A category that does not fit cleanly anywhere in the current model: requirements that are **only** binding **if** an
antecedent holds. Examples drawn from the existing spec:

- "If a CLI supports `--output json`, it MUST also support discovery via `schema` subcommand or `--schema` flag."
- "If a tool ships a config file, it SHOULD validate the schema on load."
- "If a tool exposes `--quiet`, it MAY also expose a structured progress channel for agent consumers."

The conditional construction is widespread in the principle text. The verifier code today handles it implicitly: probes
that find no antecedent emit `skip` and move on. The site renderer cannot tell that result apart from a probe failure.
The scoring algorithm cannot weight it correctly. The user's framing was sharp: there are optionals inside MUST. "If you
implement this, then you {MUST, SHOULD} implement this." The taxonomy needs a way to say that without resorting to
overloading `skip`.

### Why this matters now

The v0.4.0 rescore brought the issue to the surface. Behavioral-layer expanded from 11 checks to 18 per tool. The new
checks (`p2-schema-print`, `p6-no-pager-behavioral`, `p6-no-color-behavioral`, `p8-bundle-install`, `p8-install-all`,
`p8-bundle-update`, `p2-json-aliases`) skew toward MAY-tier features that most tools have not adopted. The behavior
under the current formula:

- 27 tools dropped 5–17 percentage points
- Max score collapsed from 100% to 94% (anc itself)
- The 100% club emptied
- The badge floor at 80% became significantly less attainable

These movements do not reflect changed compliance posture. They reflect the larger denominator interacting with the
existing conflation. If we ship the v0.4.0 rescore as-is, the public dataset locks in the unfairness. If we change the
scoring formula without fixing the input, we choose between several flavors of unfairness rather than resolving the root
cause.

---

## Scope Boundaries

### In scope

- 7-status taxonomy specification (`pass`, `warn`, `fail`, `opt_out`, `n_a`, `skip`, `error`)
- Conditional-requirement schema extension in `coverage-matrix.json` (`applicability.kind: conditional`, `antecedent`
  shape)
- CLI changes to emit the new statuses from the verifier
- Scorecard `schema_version` bump from 0.5 to 0.6
- Site renderer updates to handle the new statuses (per-check icons, badge color logic)
- Full registry rescore against the post-change CLI
- Methodology page rewrite to document the new statuses

### Out of scope (this plan)

- **Specific tier weights.** The sandbox explored ratios (1/2/3, 1/2/4) but the final choice is a separate spec issue
  once the input shape is fixed. Until the data is disambiguated, no weight set is provably fair.
- **Badge eligibility threshold recalibration.** The current 80% floor was calibrated against the current formula. After
  the algorithm change, the threshold may need to drop, rise, or stay; the call depends on what the new score
  distribution looks like.
- **A second "style" axis.** Earlier conversation explored a figure-skating-inspired technical-vs-style split. Decided
  to hold: the per-layer breakdown (behavioral / source / project) already serves as the orthogonal dimension; adding a
  subjective style score introduces noise without a clear signal.
- **Spec wording changes for principles themselves.** The principle text is correct; what needs updating is the
  scorecard data shape and the methodology that explains it.

### Deferred to follow-up work

- **`opt_out` migration backfill.** When the CLI ships the new statuses, existing v0.5 scorecards mark every former
  `skip` as `skip` (conservative). Re-categorizing into `opt_out` vs `n_a` happens probe-by-probe as the linter team
  decides each check's correct disambiguation.
- **Per-check `since_version` annotations.** Some opt-outs are recent additions (e.g., skill bundle checks landed in
  v0.4.0). Tools scored before that release should not retroactively appear as `opt_out` on those checks. Sketched but
  not specified here; tracked in the `opt_out` follow-up.

---

## Context & Research

### Sandbox data

`scripts/score-sandbox.py` (read-only, polars + PEP 723 inline deps) runs eight candidate scoring algorithms against the
96 latest-version scorecards on disk after the v0.4.0 rescore. Outputs:

- `.context/score-sandbox/long.parquet` — long-form (1728 rows, one per check per tool, with tier from coverage-matrix)
- `.context/score-sandbox/tools.csv` — per-tool aggregate scores under each candidate algorithm
- `.context/score-sandbox/report.md` — eligibility tables, distribution buckets, per-tool leaderboard, rank-mover
  analysis

Eligibility at the 80% threshold across the eight algorithms:

| Model                                      | Tools ≥ 80% | Notes                                                                 |
| ------------------------------------------ | ----------: | --------------------------------------------------------------------- |
| A: Current (`pass / (pass + warn + fail)`) |          16 | Baseline. What the live leaderboard shows today.                      |
| B: Tier-weighted 1/2/3, skip excluded      |          85 | Too lenient. Tier weights barely matter when MUST dominates by count. |
| C: Tier-weighted 1/2/4, skip excluded      |          88 | Same problem as B; steeper MAY weight does not fix the denominator.   |
| D: Compliance + extras (two numbers)       |          14 | Honest about tiers; harder to render as a single badge.               |
| E: B + MAY-warn reclassified as skip       |          89 | Even more lenient; treats every MAY non-adoption as inapplicable.     |
| F: Compliance × 0.85 + extras × 0.15       |          13 | Single-number variant of D; tracks current model closely.             |
| G: 1/2/3 weights, skip in denominator      |           3 | True skating model. Brutal under current data because skip is ambig.  |
| H: G + MAY-warn → skip                     |           2 | Slightly more lenient than G but still surfaces the conflation issue. |

The pattern is clear: every model is either too lenient (B / C / E) because skip excludes too liberally, or too strict
(G / H) because skip-in-denominator penalizes legitimately inapplicable checks. The "right" model needs disambiguated
input.

### Tier distribution observation

The current spec is MUST-heavy. Across the 96-tool dataset:

- MUST: ~76% of checks (median 13 per tool)
- SHOULD: ~5% (median 1 per tool)
- MAY: ~17% (median 3 per tool)
- Unknown (not in matrix): ~3% (currently `p3-version` only)

Tier-weighted scoring shifts results less than expected because MUST already dominates by check count. The SHOULD and
MAY tiers are minority signal; weight changes alone do not move the leaderboard significantly. The denominator treatment
of skip-bucket statuses moves it far more.

### Relevant code

- `src/data/coverage-matrix.json` — current per-requirement metadata: `level` (must/should/may), `applicability.kind`
  (universal/conditional — already declared but conditional handling is incomplete), `verifiers[]` (check-id + layer).
  Read by the site at build time to render per-check tier badges.
- `scripts/score-sandbox.py` — host-side sandbox; not in build pipeline. Loads all scorecards, joins with matrix tiers,
  runs candidate algorithms, emits markdown report plus parquet/CSV for notebook follow-up.
- `scorecards/*.json` — 96 latest-version files, schema_version 0.5. Each has `results[]` (id, status, evidence,
  confidence, layer, group) and `summary` (pass/warn/fail/skip/error totals).
- `content/methodology.md` — current public methodology page. Documents the existing formula; needs rewrite when the new
  scoring lands.
- `content/scorecard-schema.md` — per-field JSON schema documentation. Needs update for the new status enum.
- `content/badge.md` — badge contract and eligibility floor. Needs threshold revisit after the algorithm change.

### Institutional learnings

- The v0.4.0 dogfood analysis in the CLI README (`anc check . --binary` = 18 checks, 15 pass / 1 warn / 0 fail / 2 skip
  / 0 error) was the first hint of the conflation. The two skips for anc itself (`p1-flag-existence`,
  `p6-no-pager-behavioral`) are arguably inapplicable rather than opt-out, but the README treats them generically.
- The `coverage_summary` block in each scorecard already exposes per-tier verified counts. The data exists; the scoring
  formula just does not use it directly.
- Audit profiles (`anc check . --audit-profile <category>`) already let the operator narrow scope. They are the closest
  existing mechanism to "this check does not apply to this tool"; the `opt_out` status is the natural per-check
  generalization.

### External references

- RFC 2119 — Key words for use in RFCs to Indicate Requirement Levels. Defines MUST / SHOULD / MAY semantics.
- RFC 8174 — Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words. Reaffirms the three-tier hierarchy.
- Figure skating IJS (International Judging System) — element-value model that informed the "spec ceiling rewards
  ambition + execution" framing. Total points scored against the maximum possible, not pass/attempt ratio.

---

## Key Technical Decisions

### Decision 1: Adopt a 7-status taxonomy, not a sub-reason annotation on `skip`

| Status    | In numerator? | In denominator? | Meaning                                                     |
| --------- | :-----------: | :-------------: | ----------------------------------------------------------- |
| `pass`    |      yes      |       yes       | Requirement met                                             |
| `warn`    |    partial    |       yes       | SHOULD- or MAY-tier requirement not satisfied (per tier)    |
| `fail`    |      no       |       yes       | MUST-tier requirement not satisfied                         |
| `opt_out` |      no       |       yes       | Tool could implement but does not (deliberate non-adoption) |
| `n_a`     |      no       |       no        | Conditional antecedent unmet; check inapplicable            |
| `skip`    |      no       |       no        | Linter probe limitation; could not measure                  |
| `error`   |      no       |       no        | Linter raised an exception (anc-side bug)                   |

**Rationale.** Sub-reasons on `skip` keep the field count stable but require every consumer (scoring algorithm, site
renderer, agent integrations) to parse the sub-reason. Distinct status values keep the parsing trivial and the semantics
legible in raw JSON inspection. The denominator-impact distinction (whether the status counts in the denominator) is the
load-bearing axis; making it explicit per status makes the scoring formula a one-line decision.

**Alternative considered:** keep `skip` as the single value; add `skip_reason: "not_applicable" | "opt_out" |
"probe_limitation"`. Rejected because the scoring formula has to special-case parsing the reason, and downstream agents
inspecting raw JSON cannot tell from `status: "skip"` alone whether the check counts toward the score.

### Decision 2: Conditional requirements get explicit antecedent metadata

The "optional iff compliance" pattern (a requirement that applies if and only if an antecedent feature is present) needs
explicit representation in `coverage-matrix.json`. The same machinery handles conditional MUSTs and conditional SHOULDs
identically; `applicability` is orthogonal to `level`. Without explicit representation, the verifier handles the
conditional implicitly (probes that find no antecedent emit `skip`), and the conflation problem follows.

Extend `coverage-matrix.json` row schema:

```yaml
# Existing universal row (unchanged):
- id: p3-must-top-level-examples
  principle: 3
  level: must
  applicability:
    kind: universal
  verifiers:
    - check_id: p3-help
      layer: behavioral
```

#### Worked example: conditional MUST

```yaml
# Reads: "if a CLI ships --output json, it MUST also expose its JSON Schema."
- id: p2-must-schema-when-json
  principle: 2
  level: must
  applicability:
    kind: conditional
    antecedent:
      check_id: p2-json-output
  verifiers:
    - check_id: p2-schema-print
      layer: behavioral
```

#### Worked example: conditional SHOULD

```yaml
# Reads: "if a tool ships a --config-file flag, it SHOULD validate the file's
# schema on load before any mutation."
- id: p4-should-config-schema-validation
  principle: 4
  level: should
  applicability:
    kind: conditional
    antecedent:
      check_id: p4-config-file-flag
  verifiers:
    - check_id: p4-config-schema-validation
      layer: behavioral
```

The two examples differ only in `level`. The antecedent-handling machinery is identical. A tool with no `--config-file`
gets `n_a` on `p4-should-config-schema-validation`; a tool with `--config-file` that does not validate the schema gets
`warn` (a SHOULD violation, not a MUST violation). The level decides the penalty severity *when* the consequent fires;
the antecedent decides *whether* it fires at all.

#### Sub-decision 2a: antecedent-status propagation

The antecedent does not need a `requires_status` field. The spec defines a fixed *feature-present* test that all
conditional rows use by default:

| Antecedent status | Antecedent interpretation                | Consequent emits   |
| ----------------- | ---------------------------------------- | ------------------ |
| `pass`            | Feature present and working              | Evaluated normally |
| `warn`            | Feature present, partially OK            | Evaluated normally |
| `fail`            | Feature present, broken                  | Evaluated normally |
| `opt_out`         | Feature deliberately absent              | `n_a`              |
| `n_a`             | Feature itself was conditional and unmet | `n_a`              |
| `skip`            | Probe could not measure                  | `skip` (inherits)  |
| `error`           | Probe raised an exception                | `error` (inherits) |

Rationale: the conditional asks "is the prerequisite feature present at all?" not "is it fully compliant?" A tool with
broken JSON output still has JSON output; the schema requirement still applies (and may also fail). Indeterminate
antecedent statuses (`skip`, `error`) propagate to the consequent because the linter cannot meaningfully evaluate a
dependent check whose prerequisite is unmeasured.

Rows that need stricter or looser propagation than the default can opt in via an explicit `requires_status` field (e.g.,
`requires_status: pass` to require the prerequisite to be fully working before the consequent applies); the v1 schema
omits the field so the common case stays minimal. Adding `requires_status` later is backward compatible.

#### Sub-decision 2b: compound antecedents deferred to v2

The v1 schema supports single-antecedent conditionals only. If a requirement reads "if X AND Y, then MUST Z," the v1
modeling options are:

1. Split into two rows that *both* depend on a single antecedent (Z depends on X with one row; Z' depends on Y with a
   second row; the spec prose binds them together).
2. Introduce a synthetic intermediate `check_id` that the verifier composes internally (`check_id: p2-json-and-yaml`
   returns `pass` iff both formats are supported), then the conditional row points at the synthetic.

When real cases surface that cannot be modeled either way, v2 of the schema gains an `antecedent` array with an `op:
all_of | any_of` discriminator:

```yaml
# Sketch only — not in v1.
applicability:
  kind: conditional
  antecedent:
    op: all_of
    checks:
      - check_id: p2-json-output
      - check_id: p2-yaml-output
```

Tracked as a follow-up spec issue post-U1; not required for the initial taxonomy.

#### Sub-decision 2c: one result per requirement row, not per check_id

Today's matrix already has shared `check_id` references: `p3-version` is the only verifier for both `p3-must-version`
(MUST, `--version` works at all) and `p3-should-version-short` (SHOULD, short alias accompanies it). One probe; two
distinct requirements at different tiers. The scoring layer must evaluate each row independently.

**Decision:** the CLI emits **one result per requirement row** (matrix `id`), not one per `check_id`. Each result entry
carries the requirement's `id` as `result.id`; the underlying probe (`check_id`) may be shared between multiple results,
but each result is an independent evaluation against a specific requirement's tier. The result entry also carries an
explicit `tier` field so the scoring formula does not need a matrix lookup.

```json
// scorecard fragment — both entries come from the same p3-version probe internally
"results": [
  { "id": "p3-must-version",         "status": "pass", "tier": "must",   "evidence": null },
  { "id": "p3-should-version-short", "status": "warn", "tier": "should", "evidence": "--version present; short alias -V not detected" }
]
```

Trade-offs:

- **More verbose JSON.** A single probe that satisfies five requirement rows produces five result entries. For the
  current matrix shape (~38 distinct check_ids and ~57 requirement rows), the verbosity increase is small.
- **Scorecard becomes self-contained.** Third-party consumers can compute the score from the scorecard alone — no matrix
  lookup needed at scoring time. The tier metadata travels in the result.
- **Verifier internals unchanged.** The verifier still has one probe per `check_id` internally; the result-emitter fans
  out one probe's output to N matrix rows that reference it.
- **Per-row evaluation policy lives in the CLI.** The matrix declares the multi-row relationship; the CLI decides how
  the shared probe's findings translate to each row's status. Each row's emission logic is documented in the verifier
  source.

**Rationale.** The user identified that "there are optionals within MUST" — conditional MUSTs are the formal
representation. Per RFC 2119 semantics, a conditional MUST applies with full force when its antecedent is met, and
simply does not apply otherwise. That is `n_a`, not a free pass and not a violation. The same logic generalizes to
SHOULD and MAY: a conditional SHOULD applies with full SHOULD force when its antecedent is met; a conditional MAY
applies with full MAY force. The tier is independent of the conditional.

### Decision 3: Defer the scoring formula choice to a follow-up spec issue

This plan stops short of selecting tier weights or a final formula. The sandbox has demonstrated that no single
configuration is fair under the current 5-status data. Once the taxonomy ships and existing scorecards are rescored with
the disambiguated input, a separate spec issue chooses the formula. Candidates the sandbox already evaluated:

- Compliance + extras (two numbers; downstream renderers decide whether to combine for a single badge)
- Tier-weighted with spec-ceiling denominator (skating model; brutal under current data, may be fair under disambiguated
  data)
- Weighted blend (compliance × 0.85 + extras × 0.15; single number, tracks current model closely)

Each becomes a tractable choice once the input shape is clean.

### Decision 4: schema_version bumps from 0.5 to 0.6 (not 1.0)

The scorecard JSON shape changes: the `status` enum gains two values (`opt_out`, `n_a`); `summary` aggregates gain two
counters. Existing consumers will treat the new statuses as unknown until they upgrade. A minor bump (0.5 → 0.6) signals
backward-compatible-with-graceful-degradation: a consumer that does not understand `opt_out` can fall back to treating
it as `skip` (the conservative bucket). A major bump (1.0) would imply a deeper restructure; not warranted.

### Decision 5: opt_out audit policy lives in the CLI, not in the registry

Each verifier decides whether a missing feature is `opt_out` or `n_a` based on probe results plus per-check policy
encoded in the verifier code. The registry stays clean; it does not need per-tool annotations like "fzf has no skill
bundle, treat as opt_out." The CLI's verifier examines the tool's surface and routes appropriately. This keeps the
registry maintainable and the policy in one place.

---

## Implementation Units

### U1. Spec — taxonomy decision + conditional schema (agentnative repo)

**Repo:** `brettdavies/agentnative` (spec).

**Work:**

- Write a spec issue proposing the 7-status taxonomy (this plan, condensed).
- Add `applicability.kind: conditional` with `antecedent` shape to the coverage-matrix schema documentation.
- Update `content/principles/p*.md` for any principle where a requirement is conditional (re-express in "if X then MUST
  Y" form so the conditional structure is legible in the prose).
- Bump spec `VERSION` after the conditional re-expressions land.

**Acceptance:**

- Spec issue merged with the taxonomy specified.
- `coverage-matrix.json` schema doc reflects the conditional shape.
- At least one principle's prose explicitly uses the if-X-then-MUST-Y construction.
- spec `VERSION` bumps; the change is in `CHANGELOG.md`.

**Dependencies:** None; this is the foundation.

### U2. CLI — emit new statuses, bump schema (agentnative-cli repo)

**Repo:** `brettdavies/agentnative-cli`.

**Work:**

- Switch result emission from per-`check_id` to per-requirement-row (Decision 2c). One probe whose `check_id` appears in
  N matrix rows now emits N result entries, each carrying the requirement row's `id` as `result.id` and the row's
  `level` as `result.tier`.
- Update probe results to emit `opt_out` where the tool clearly has the capability surface but does not ship the feature
  (e.g., `p8-bundle-install` for tools without an `AGENTS.md`).
- Update probe results to emit `n_a` where a conditional antecedent is unmet (e.g., `p2-must-schema-when-json` on tools
  without `--output json`), driven by the matrix's `applicability.kind: conditional` rows per the propagation table in
  Decision 2a.
- Keep `skip` for the residual case: probe limitation.
- Bump `scorecard.schema.json` from 0.5 to 0.6. Add `opt_out` and `n_a` to the status enum. Add `opt_out` and `n_a`
  counters to `summary`. Add `tier` field to each `results[]` entry.
- Update `summary.score_pct` to reflect whatever transitional formula the spec lands on (initial: leave the existing
  formula but exclude `opt_out` from the denominator and exclude `n_a` from both — minimal change that respects the new
  semantics without committing to a new formula).
- Update `anc check`'s text output to render the new statuses (per-check status badges in the terminal).
- Update CLI tests: add fixtures with the new statuses, assert correct counter aggregation in `summary`, assert per-row
  emission for shared check_ids like `p3-version`, assert antecedent-status propagation table from Decision 2a.

**Acceptance:**

- `cargo test` green.
- A test fixture exists for each new status.
- `anc check --command <test-binary> --output json` emits valid 0.6-schema output.
- CHANGELOG documents the new statuses + the schema bump.
- CLI version bumps; the bump is published.

**Dependencies:** U1 (spec defines the statuses).

### U3. Spec — scoring formula choice (agentnative repo, follow-up)

**Repo:** `brettdavies/agentnative` (spec).

**Work:**

- Open a separate spec issue: "Scoring formula choice now that inputs are disambiguated."
- Rerun `scripts/score-sandbox.py` from the site repo against the U2-rescored data; surface the eligibility shifts.
- Decide tier weights and the formula. Update the spec to document them.

**Acceptance:**

- Formula documented in spec.
- The CLI's `summary.score_pct` matches the spec's formula.
- The methodology section of the spec explains the rationale.

**Dependencies:** U1, U2 (the input must be clean before the formula is chosen).

### U4. Site — renderer updates for 7-status output (this repo)

**Repo:** `brettdavies/agentnative-site` (this repo).

**Work:**

- Update `src/build/scorecards.mjs` per-check icon mapping to handle `opt_out` and `n_a` distinct from `skip`.
- Update the leaderboard table column rendering to use the new statuses (currently aggregates skip + error in one visual
  bucket; split into the new categories).
- Update `src/build/badge.mjs` color logic if the new score range needs different bands (decision depends on U3).
- Add Vale accept-list entries if the new status names trip the spelling check (`opt_out`, `n_a`).
- Update build-time schema validation in `src/build/scorecards.mjs` to expect schema_version 0.6.
- Update regression tests to cover the new statuses.

**Acceptance:**

- `bun test` green.
- `bun run build` produces dist/ with no warnings.
- The rendered `/score/<tool>` page shows distinct visual treatment for each of the new statuses.
- Schema validation passes against a 0.6 fixture.

**Dependencies:** U2 (CLI must emit the new statuses before the site can render them).

### U5. Site — methodology rewrite (this repo)

**Repo:** `brettdavies/agentnative-site`.

**Work:**

- Rewrite `content/methodology.md` to document the 7-status taxonomy, the conditional-requirement mechanism, and the
  scoring formula chosen in U3.
- Rewrite `content/scorecard-schema.md` to document the new status enum and the new summary counters.
- Update `content/badge.md` if the eligibility floor shifted.
- Update the README's `## Scoring` section (just landed in PR #108) to point at the new methodology.

**Acceptance:**

- `bash scripts/prose-check.sh` green.
- `unslop` score 0 on the rewritten pages.
- The methodology page explains the new statuses with worked examples.

**Dependencies:** U3 (the formula must be chosen before the methodology can document it accurately).

### U6. Site — registry rescore against post-change CLI (this repo)

**Repo:** `brettdavies/agentnative-site`.

**Work:**

- Wait until the v0.5.0 (or whatever version ships with the new statuses) CLI is published via Homebrew tap.
- Rebuild the docker/score image (`bash docker/score/build.sh`).
- Run the scorer (`docker compose -f docker/score/compose.yml run --rm scorer`).
- Inspect the score deltas against the current dataset; surface big movers before pushing.
- Run `bun run build`.
- Commit the new scorecards + any superseded-version files (per existing policy: leave on disk).
- Open a PR against `dev`.

**Acceptance:**

- All 96 registry tools rescore against the post-change CLI.
- `bun test` and `bun run build` green.
- PR open against `dev`; CI green.
- Score delta summary in the PR body.

**Dependencies:** U2, U3 (CLI must ship the new statuses and the new formula must be specified).

---

## System-Wide Impact

### Cross-repo coordination

The change touches three repos in sequence: spec defines the input shape, CLI implements it, site consumes it. The
sequence is non-negotiable; skipping the spec step means the CLI and site implement against a moving target.

The handoff happens at version-bump boundaries:

- spec VERSION bump after U1 lands (signals the taxonomy is decided)
- CLI version bump after U2 ships (signals the new statuses are emitted)
- spec VERSION bump again after U3 (signals the formula is chosen)
- site rescore PR after U6 (closes the loop)

### Backward compatibility

The 5-status → 7-status transition is backward compatible by design:

- Existing 0.5 scorecards remain valid; they just don't carry the new status values.
- Consumers that don't understand `opt_out` / `n_a` should treat them as `skip` (the conservative bucket).
- The site's renderer handles 0.5 and 0.6 schema versions side-by-side during the migration window. After the full
  rescore lands, the site can drop 0.5 support.

### Badge eligibility risk

After the full rescore, some tools' badge eligibility will change. Movement direction depends on the chosen formula in
U3. Possible cases:

- Tools with many genuinely inapplicable checks (e.g., narrow-surface tools like `wc`-style filters): their scores may
  improve, because `n_a` excludes from the denominator.
- Tools with many opt-out features (e.g., tools that don't ship skill bundles): their scores may drop, because `opt_out`
  counts in the denominator.
- Tools that already comply broadly: minor movement either way.

The first time this is publicly observable, badge revocations and earnings will happen simultaneously. Document this in
the U6 rescore PR body so the inevitable "why did my badge disappear" questions have a pre-written answer.

### Leaderboard ranking shifts

Sandbox data shows that even the most modest formula changes (B / E / F families) produce 5+ point shifts on 14–27
tools. The new statuses will amplify these because the conflated `skip` bucket gets split. Expect some loud re-rankings;
communicate them in the methodology page.

---

## Risk Analysis & Mitigation

### Risk: opt_out vs n_a heuristic is wrong for edge cases

Some checks straddle the line. Example: a tool that accepts secrets via env vars only, not flags. Is
`p1-secret-non-leaky-path` (a MUST in the flag context) `n_a` because there are no secret flags? Or `opt_out` because
the tool chose env-only? Reasonable people will disagree.

**Mitigation:** the CLI's per-check policy is the policy authority. Each verifier has a docstring documenting the
heuristic it uses. Disagreements file as CLI repo issues; the verifier policy gets adjusted; the next rescore picks up
the new behavior. Treat the first wave of disagreements as calibration data.

### Risk: spec issue stalls; CLI and site work blocks

U2 depends on U1; U3 depends on U2. A multi-week stall at U1 stalls everything.

**Mitigation:** U1 has narrow scope (taxonomy + conditional schema only; no formula). Should be tractable to land in 1-2
review cycles. If it stalls, the spec issue surfaces what's blocking and the holdup is visible.

### Risk: score volatility erodes trust in the leaderboard

If scores shift significantly between U6 rescores (because the v0.5.0 verifiers behave differently than v0.4.0 ones),
the leaderboard looks unstable. Tools and embedders may hesitate to display their badge if it could change
unpredictably.

**Mitigation:** U6's PR body documents the methodology change as a one-time recalibration. The U3 formula choice should
include a "no formula changes for 6 months after this" stability commitment. Future rescores under the chosen formula
should produce small movements, not large ones.

### Risk: parallel implementations diverge

If the CLI ships the new statuses before the site renders them, the live leaderboard may show garbled output. If the
site updates its renderer before the CLI ships, the renderer has nothing to render against.

**Mitigation:** ship in strict order (U1 → U2 → U4 → U3 → U5 → U6). Each step is a separate PR with its own review.
Defensive rendering on the site side (fall back to `skip` rendering for any unknown status) is acceptable cost.

### Risk: schema_version bump misses a consumer

The CLI's `scorecard.schema.json` is consumed by the site at build time, by agent integrations that parse `anc check
--output json`, and potentially by third parties (badge embedders, leaderboard consumers).

**Mitigation:** the schema bump from 0.5 to 0.6 is backward compatible by design (new statuses optional, existing fields
unchanged). Consumers that don't validate against the schema continue to work. Consumers that do should update their
schema reference; the site is one such consumer and is updated in U4.

---

## Documentation / Operational Notes

### Files this plan implies will change

**Spec repo (`brettdavies/agentnative`):**

- `coverage/matrix.json` — schema extension for conditional rows
- `principles/p*-*.md` — prose re-expression for conditional requirements
- `VERSION`, `CHANGELOG.md`
- `CONTRIBUTING.md` — verifier authoring guidance for new status emission

**CLI repo (`brettdavies/agentnative-cli`):**

- `src/checks/*.rs` (or wherever the verifier policy lives) — per-check status disambiguation
- `src/scorecard.rs` (or similar) — schema 0.5 → 0.6 bump
- `src/scoring.rs` — formula update per U3
- `Cargo.toml`, `CHANGELOG.md`

**This repo (`brettdavies/agentnative-site`):**

- `src/data/coverage-matrix.json` — re-synced after spec bumps
- `src/build/scorecards.mjs` — renderer status handling
- `src/build/badge.mjs` — color band logic if score range shifts
- `content/methodology.md`, `content/scorecard-schema.md`, `content/badge.md`
- `scripts/score-sandbox.py` — stays in repo as the sandbox tool; can be rerun to validate the formula choice in U3
- `scorecards/*.json` — full rescore after U2 ships
- `README.md` — `## Scoring` section update

### Communication

Once U6 is open as a PR, the rescore changes are public and badge-affecting. Consider:

- A short post to the leaderboard scaffolding (top of `/scorecards` page) noting "scoring methodology updated
  YYYY-MM-DD; some scores moved."
- A migration note in `RELEASES.md` for the release that lands the U6 changes.
- A summary of "what changed in the algorithm" in the U6 PR body so the squash-merge commit carries the rationale
  forward into git history.

### Sandbox tool retention

`scripts/score-sandbox.py` is intentionally not part of the build pipeline; it is a one-off analysis tool. It stays in
the repo:

- to re-run when the v0.5.0 CLI ships, to validate the new statuses
- to re-run before each formula change to model the impact
- as evidence of the analysis that informed Path 2

It uses inline-deps via PEP 723; no environment setup required. Invocation: `uv run scripts/score-sandbox.py`.

---

## Sources & References

- **Sandbox analysis output:** `.context/score-sandbox/report.md` (local-only, gitignored, regenerable)
- **Sandbox script:** `scripts/score-sandbox.py`
- **Long-form dataframe:** `.context/score-sandbox/long.parquet` (regenerable)
- **Per-tool table:** `.context/score-sandbox/tools.csv` (regenerable)
- **v0.4.0 rescore output:** held on `feat/rescore-v0.4.0` branch, not yet merged
- **CLI README v0.4.0 dogfood section:** `anc check . --binary` = 18 checks, 15 pass / 1 warn / 0 fail / 2 skip / 0
  error → 94% under current formula
- **RFC 2119** (key words for requirement levels)
- **RFC 8174** (uppercase vs lowercase ambiguity)
- **PR #108** (site README rewrite which introduced the `## Scoring` section that triggered the fairness conversation)
- **Conversation context:** v0.4.0 rescore session, 2026-05-21. Brett's figure-skating analogy framed the
  spec-ceiling-rewards-ambition insight. Brett's observation about conditional MUSTs framed the `n_a` requirement.
