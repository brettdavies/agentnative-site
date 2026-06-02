---
title: 'feat: Scorecard status taxonomy + scoring fairness (Path 2)'
type: feat
status: shipped
date: 2026-05-21
shipped_in: "Cross-repo: spec v0.5.0 (d5d4086, PR #44), CLI v0.5.0 (eba2145, PR #72), skill v0.5.0 (dff0412, PR #23), site via release #145 (08958bc). Schema landed at 0.6 per plan, then advanced to 0.7 alongside the check to audit rename (CLI PR #65). Full 98-tool registry rescored on schema 0.7 against anc v0.5.0. Plan retained as the historical record of the migration arc, decision rationale (7-status vs annotated skip, conditional antecedents, deferral of compound antecedents to v2), and release-train ordering."
origin: anc v0.4.0 rescore session, 2026-05-21 — sandbox-driven fairness analysis triggered by the v0.4.0 behavioral audit expansion (11 → 18 checks) widening the denominator and exposing the existing scoring algorithm's conflations
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
- Site renderer updates to handle the new statuses (per-audit icons, badge color logic)
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
  Read by the site at build time to render per-audit tier badges.
- `scripts/score-sandbox.py` — host-side sandbox; not in build pipeline. Loads all scorecards, joins with matrix tiers,
  runs candidate algorithms, emits markdown report plus parquet/CSV for notebook follow-up.
- `scorecards/*.json` — 96 latest-version files, schema_version 0.5. Each has `results[]` (id, status, evidence,
  confidence, layer, group) and `summary` (pass/warn/fail/skip/error totals).
- `content/methodology.md` — current public methodology page. Documents the existing formula; needs rewrite when the new
  scoring lands.
- `content/scorecard-schema.md` — per-field JSON schema documentation. Needs update for the new status enum.
- `content/badge.md` — badge contract and eligibility floor. Needs threshold revisit after the algorithm change.

### Institutional learnings

- The v0.4.0 dogfood analysis in the CLI README (`anc audit . --binary` = 18 checks, 15 pass / 1 warn / 0 fail / 2 skip
  / 0 error) was the first hint of the conflation. The two skips for anc itself (`p1-flag-existence`,
  `p6-no-pager-behavioral`) are arguably inapplicable rather than opt-out, but the README treats them generically.
- The `coverage_summary` block in each scorecard already exposes per-tier verified counts. The data exists; the scoring
  formula just does not use it directly.
- Audit profiles (`anc audit . --audit-profile <category>`) already let the operator narrow scope. They are the closest
  existing mechanism to "this check does not apply to this tool"; the `opt_out` status is the natural per-audit
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
    - audit_id: p3-help
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
      audit_id: p2-json-output
  verifiers:
    - audit_id: p2-schema-print
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
      audit_id: p4-config-file-flag
  verifiers:
    - audit_id: p4-config-schema-validation
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
2. Introduce a synthetic intermediate `audit_id` that the verifier composes internally (`audit_id: p2-json-and-yaml`
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
      - audit_id: p2-json-output
      - audit_id: p2-yaml-output
```

Tracked as a follow-up spec issue post-U1; not required for the initial taxonomy.

#### Sub-decision 2c: one result per requirement row, not per audit_id

Today's matrix already has shared `audit_id` references: `p3-version` is the only verifier for both `p3-must-version`
(MUST, `--version` works at all) and `p3-should-version-short` (SHOULD, short alias accompanies it). One probe; two
distinct requirements at different tiers. The scoring layer must evaluate each row independently.

**Decision:** the CLI emits **one result per requirement row** (matrix `id`), not one per `audit_id`. Each result entry
carries the requirement's `id` as `result.id`; the underlying probe (`audit_id`) may be shared between multiple results,
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
  current matrix shape (~38 distinct audit_ids and ~57 requirement rows), the verbosity increase is small.
- **Scorecard becomes self-contained.** Third-party consumers can compute the score from the scorecard alone — no matrix
  lookup needed at scoring time. The tier metadata travels in the result.
- **Verifier internals unchanged.** The verifier still has one probe per `audit_id` internally; the result-emitter fans
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

Each verifier decides whether a missing feature is `opt_out` or `n_a` based on probe results plus per-audit policy
encoded in the verifier code. The registry stays clean; it does not need per-tool annotations like "fzf has no skill
bundle, treat as opt_out." The CLI's verifier examines the tool's surface and routes appropriately. This keeps the
registry maintainable and the policy in one place.

---

## Implementation Units

### U1. Spec — taxonomy decision + conditional schema (agentnative repo)

**Repo:** `brettdavies/agentnative` (spec).

**Status:** [released — shipped in spec v0.5.0 on 2026-05-30 via PR brettdavies/agentnative#44 → `d5d4086`; see U7 step
1] [PR brettdavies/agentnative#34](https://github.com/brettdavies/agentnative/pull/34) — 2026-05-21. Schema extension,
propagation table, worked examples, and conditional-row migrations all landed on `dev`; the v0.5.0 release rolled them
to `main` and tagged. The standalone spec issue proposing the 7-status taxonomy was dropped (the plan, PR #34, and
`principles/AGENTS.md` together carry the proposal; a single-repo issue would be redundant).

**Source location (where U1 lives today, as of 2026-05-26):**

- Branch: `agentnative-spec` `dev`, head commit `b4f4d02` (PR #34 squash-merge).
- `main`: does NOT contain U1. Latest `main` commit is `1625416` (release: PRODUCT.md migration), predates PR #34.
- Tags: latest is `v0.4.0` (tagged 2026-05-07), which predates U1. There is no `v0.5.0` or `v0.5.0-rc.*` tag.

**Downstream-consumer impact:** Both `agentnative-cli` and `agentnative-site` vendor the spec via their respective
`scripts/sync-spec.sh`. The default resolution path returns the latest `v*` tag (currently `v0.4.0`), so a blind
`sync-spec.sh` rerun re-pulls pre-U1 content. To consume U1 ahead of a spec release, use the `--ref` flag (or the
`SPEC_REF` env var) added to both scripts alongside this plan unit:

```bash
# Pull U1 by branch HEAD (recommended for early iteration):
bash scripts/sync-spec.sh --ref dev

# Pull U1 by explicit commit SHA (recommended for any PR that vendors mid-flight spec work,
# so the PR body can record the exact pin):
bash scripts/sync-spec.sh --ref b4f4d02
```

`--ref` accepts branches, tags, and commit SHAs uniformly via the GitHub contents API (`gh api`). The resolved short SHA
is printed every run so the user knows exactly what landed; record that SHA in any consumer PR body that vendors
non-released content so the pin is traceable post-merge. When U1 cuts as `v0.5.0` (or `v0.5.0-rc.*`), downstream
consumers can drop `--ref` and return to the default-tag path.

**Work:**

- [shipped] Add `applicability.kind: conditional` with `antecedent` shape to the principle frontmatter schema and the
  coverage-matrix schema documentation (`principles/AGENTS.md` — worked examples for conditional MUST + SHOULD,
  antecedent-status propagation table, compound-antecedent deferral note).
- [shipped] Update `content/principles/p*.md` for any principle where a requirement is conditional. Five rows migrated:
  `p2-must-schema-print` and `p2-should-schema-file` (antecedent `p2-json-output`); `p8-must-bundle-install`,
  `p8-may-install-all`, `p8-may-bundle-update` (antecedent `p8-bundle-exists`). p8 prose re-expressed in "If X, then it
  MUST/MAY Y" construction. The remaining 18 `{if: <reason>}` rows across p1, p3, p4, p5, p6, p7 stay as-is until the
  CLI's verifier catalog grows to cover their prerequisites.
- [released] Spec `VERSION` bumped to `0.5.0` and `CHANGELOG.md` entry landed via PR brettdavies/agentnative#44 on
  2026-05-30.

**Acceptance:**

- [met] `coverage-matrix.json` schema doc reflects the conditional shape.
- [met] At least one principle's prose explicitly uses the if-X-then-MUST-Y construction (p8 across MUST + both MAYs; p2
  already read conditionally in context and stayed as-is).
- [met] Spec `VERSION` bump and `CHANGELOG.md` entry shipped in v0.5.0 (PR #44).

**Dependencies:** None; this is the foundation.

### U2. CLI — emit new statuses, bump schema (agentnative-cli repo)

**Status:** [shipped to dev only — NOT released]
[PR brettdavies/agentnative-cli#62](https://github.com/brettdavies/agentnative-cli/pull/62) — squash-merged to
`agentnative-cli` `dev` at `3839696`. 7-status emission, per-row results, antecedent propagation, and the schema 0.6
bump all landed. The CHANGELOG entry, `Cargo.toml` bump, and tag publish are deferred to the cli release PR (U7 step 2)
that closes out U2 + U3b together.

**Repo:** `brettdavies/agentnative-cli`.

**Source location:**

- `dev`: contains U2 at squash commit `3839696`. `SCHEMA_VERSION` reads `0.6`.
- `main`: does NOT contain U2.
- Tags: latest is `v0.4.0`; no `v0.5.0` or `v0.5.0-rc.*` yet. `Cargo.toml` on `dev` still reads `0.4.0`.
- Vendored spec basis: pinned at `b4f4d02` on cli `dev` (the in-flight U1 SHA at vendor time). Vendored `VERSION` reads
  `0.4.0`. Spec v0.5.0 has since shipped (2026-05-30); the cli release PR (U7 step 2) re-vendors forward to v0.5.0.

**Work:**

- [shipped] Result emission switched from per-`audit_id` to per-requirement-row (Decision 2c). One probe whose
  `audit_id` appears in N matrix rows now emits N result entries, each carrying the requirement row's `id` as
  `result.id` and the row's `level` as `result.tier`. Concrete example in code: `src/checks/behavioral/version.rs`
  declares `covers: &["p3-must-version", "p3-should-version-short"]`; the scorecard emitter fans out both rows.
- [shipped] Probe results emit `opt_out` where the tool clearly has the capability surface but does not ship the feature
  (e.g., `p8-bundle-install` for tools without an `AGENTS.md`; see
  `src/checks/project/bundle_exists.rs::opt_out_no_bundle`).
- [shipped] Probe results emit `n_a` where a conditional antecedent is unmet, driven by the matrix's
  `applicability.kind: conditional` rows per the propagation table in Decision 2a. Propagation logic in
  `src/principles/registry.rs`.
- [shipped] `skip` retained for the residual case: probe limitation.
- [shipped] `scorecard.schema.json` bumped from 0.5 to 0.6. `opt_out` and `n_a` added to the status enum, matching
  counters in `summary`, `tier` field on each `results[]` entry.
- [shipped] `summary.score_pct` uses the transitional formula: existing pass/(pass+warn+fail) shape, with `opt_out`
  excluded from the denominator and `n_a` excluded from both. Documented in `src/scorecard/mod.rs` as transitional
  pending U3.
- [shipped] `anc audit` text output renders the new statuses (per-audit status badges in terminal output).
- [shipped] CLI tests: fixtures cover each new status; counter aggregation asserted in `summary`; per-row emission
  asserted for shared audit_ids (`p3-version` produces both `p3-must-version` and `p3-should-version-short`);
  antecedent-status propagation table from Decision 2a asserted; red-team test pass added in `12c1d32` covers parser,
  propagation, score, and schema drift.

**Acceptance:**

- [met] `cargo test` green (PR #62 CI clean, mergeStateStatus CLEAN).
- [met] Test fixture exists for each new status.
- [met] `anc audit --command <test-binary> --output json` emits valid 0.6-schema output (schema embedded via
  `include_str!`; tests assert `schema_version == "0.6"`).
- Deferred to release PR: CHANGELOG entry for the new statuses + schema bump.
- Deferred to release PR: `Cargo.toml` version bump and tag publish.

**Dependencies:** U1 (spec defines the statuses). [met — vendored at `b4f4d02`.]

### U3. Spec — scoring formula choice (agentnative repo, follow-up)

**Status:** [released — shipped in spec v0.5.0 on 2026-05-30 via PR brettdavies/agentnative#44 → `d5d4086`; see U7 step
1] [PR brettdavies/agentnative#39](https://github.com/brettdavies/agentnative/pull/39) — squash-merged to
`agentnative-spec` `dev` at `972c9d3` and rolled to `main` as part of v0.5.0.

**Repo:** `brettdavies/agentnative` (spec).

**Source location:** `agentnative-spec` `main` at v0.5.0 (`d5d4086`); the formula PR's pre-release squash was at
`972c9d3` on `dev`. `principles/scoring.md` is the single source of truth for the formula; `docs/badge.md` carries the
floor and band edits.

**Chosen formula (`principles/scoring.md`):**

- **Scope: shipped-binary behavior only.** Only behavioral-layer requirement rows enter the formula. Source-layer and
  project-layer checks are excluded from the public score (reserved for a future advisory mode). This holds uniformly,
  including `anc` scoring itself.
- **Denominator set `D`** = rows whose status is in `{pass, warn, fail, opt_out}`. `n_a`, `skip`, `error` are excluded
  from both sides. `opt_out` counts in the denominator (deliberate non-adoption counts against).
- **Credit-weighted numerator:** `credit(pass) = 1.0`, `credit(warn) = 0.5`, `credit(fail) = credit(opt_out) = 0.0`.
- **Tier weights:** a tunable published parameter, currently flat (`w(must) = w(should) = w(may) = 1`). General form is
  `score_pct = round(100 × Σ_{i∈D} w(tier_i)·credit(status_i) / Σ_{i∈D} w(tier_i))`; under flat weights this reduces to
  `round(100 × (n_pass + 0.5·n_warn) / (n_pass + n_warn + n_fail + n_opt_out))`. Empty `D` scores 0.
- **Eligibility floor: 70** (lowered from 80).
- **Cohort bands:** Exemplary `≥ 85`, Strong `80–84`, Solid `75–79`, Qualified `70–74`, below-floor `< 70`. Band
  thresholds are the spec-side contract; rendered colors are site-owned (U4).
- **Stability commitment:** formula, weights, floor, and band thresholds held stable ≥ 6 months from publication.

**Upstream basis:** Landed on `agentnative-spec` `dev`, same branch as U1. The sandbox-rescore exploration consumed U2's
CLI output from `agentnative-cli` `dev`. No spec-side vendoring change needed for this unit.

**Acceptance:**

- [met] Formula documented in spec (`principles/scoring.md`).
- CLI implementation of the formula is owned by U3b — a spec PR cannot edit the CLI's Rust. U3 closes when the formula
  is documented; U3b closes when `score_pct` computes it.
- [met] The methodology section of the spec explains the rationale (binary-behavior scope, opt_out-counts rationale,
  flat-weights rationale, low-floor-plus-bands rationale).

**Dependencies:** U1, U2 (the input must be clean before the formula is chosen). [met.]

### U3b. CLI — implement final scoring formula (agentnative-cli repo)

**Status:** [shipped to dev only — NOT released]
[PR brettdavies/agentnative-cli#64](https://github.com/brettdavies/agentnative-cli/pull/64) — squash-merged to
`agentnative-cli` `dev` at `43d4f7c`. The behavioral-only credit-weighted formula, the 80→70 floor drop, and the README
/ CLAUDE.md doc sync all landed. The CHANGELOG entry, `Cargo.toml` bump, and tag publish are deferred to the cli release
PR (U7 step 2) that closes out U2 + U3b together.

**Repo:** `brettdavies/agentnative-cli`.

**Source location:** `dev` at squash commit `43d4f7c`. `score_pct` in `src/scorecard/mod.rs` is behavioral-only and
credit-weighted; `BADGE_ELIGIBILITY_FLOOR_PCT` reads `70`. `Cargo.toml` still reads `0.4.0` (bump deferred). No spec
re-vendor was performed — `scoring.md` is not a vendored file (see Upstream basis); formula authority is cited as
`agentnative-spec@972c9d3` in the PR body.

**Upstream basis:** Lands on `agentnative-cli` `dev`. **No spec re-vendor and no version bump are required for this
unit.** The formula is Rust code in `score_pct`, not a vendored artifact: `scripts/sync-spec.sh` vendors only `VERSION`,
`CHANGELOG.md`, and `principles/p*-*.md` — `principles/scoring.md` is not in the glob, so a resync would not pull the
formula doc regardless. Spec `dev`'s `VERSION` still reads `0.4.0` (bump deferred to the spec release PR), so vendoring
from the SHA would change no version number. Per-row `tier` inputs come from `src/principles/registry.rs`
(hand-maintained), not the vendored tree. Cite `agentnative-spec@972c9d3 / principles/scoring.md` in the U3b PR body as
the formula's authority; the clean spec resync happens when `v0.5.0` cuts (U6's gate, not U3b's).

**Scope decisions (resolved against `scoring.md`, 2026-05-28):**

- **Behavioral-only score.** `score_pct` filters to `layer == Behavioral`; source- and project-layer rows still emit in
  the scorecard but do not contribute to `score_pct` or the badge. Matches `scoring.md`'s shipped-binary-behavior scope.
  This shifts `anc`'s own dogfood number.
- **Bands stay site-side.** The CLI emits `score_pct` + `eligible` only; the site maps score → band → color in U4. No
  `band` field on `BadgeInfo`; scorecard schema stays `0.6`.
- **Tier weights as named consts in the general weighted form.** Implement `Σ w·credit / Σ w` with `W_MUST = W_SHOULD =
  W_MAY = 1` as named constants, so a future non-flat re-tune is a one-line change (matches `scoring.md`'s "parameter,
  not constant" framing).

**Work:**

- [shipped] Rewrote `fn score_pct` in `src/scorecard/mod.rs`: restricted to behavioral-layer rows; denominator set `D =
  {pass, warn, fail, opt_out}`; credit-weighted numerator (`pass` 1.0, `warn` 0.5, `fail`/`opt_out` 0.0); tier weights
  applied as named consts (`W_MUST`/`W_SHOULD`/`W_MAY`) in the general `Σ w·credit / Σ w` form via the new `tier_weight`
- `status_credit` helpers; empty `D` → 0.
- [shipped] Lowered `BADGE_ELIGIBILITY_FLOOR_PCT` from `80` to `70`.
- [shipped] Replaced the "transitional pending U3" docstring on `score_pct` with a doc comment citing `scoring.md` as
  the formula authority.
- [shipped] CLI tests: hand-computed expected `score_pct` per status fixture under the new formula; behavioral-only
  exclusion asserted (a source/project-layer `fail` does not move the score); 70-floor boundary asserted in
  `compute_badge`; `scoring.md` worked-example fixture added (20 pass / 7 warn / 0 fail / 1 opt_out / 1 n_a / 14 skip →
  84). Reworked the at-floor, opt_out-in-denominator, and full-pipeline propagation cases.
- [shipped] Updated the CLI README's Scoring section, dogfood table, and badge field reference (and the CLAUDE.md
  scorecard reference) to the final formula and the behavioral-only scope.

**Acceptance:**

- [met] The CLI's `badge.score_pct` computes the `scoring.md` formula over behavioral-layer rows.
- [met] `cargo test` green (793 passing); `score_pct` fixtures assert the chosen formula, the behavioral-only exclusion,
  and the 70 floor.
- Deferred to release PR: CHANGELOG entry for the formula change; `Cargo.toml` bump and tag publish (bundled with the U2
  release or a follow-on, per release sequencing).

**Consequence to flag for U4/U6:** under behavioral-only scope, `anc audit . --source` scores `0%` / ineligible by
design (empty `D`). `anc` dogfoods to 100% in `--binary` and full mode (34/34 behavioral pass; 9 behavioral skips
excluded).

**Dependencies:** U3 (the formula must be chosen before the CLI can implement it). [met — `972c9d3`.]

### U4. Site — renderer updates for 7-status output (this repo)

**Status:** [shipped to dev only — NOT released]
[PR brettdavies/agentnative-site#128](https://github.com/brettdavies/agentnative-site/pull/128) — squash-merged to
`agentnative-site` `dev` at `6241b69`. Renderer support for the 7-status taxonomy plus side-by-side loading of schema
0.5 and 0.6 scorecards. Built against a hand-authored 0.6 fixture validated against the published scorecard 0.6 JSON
Schema; no published CLI release was needed (that is U6's gate). The live corpus stays 0.5 until the U6 rescore.

**Repo:** `brettdavies/agentnative-site` (this repo).

**Upstream basis:** Consumes U2 from `agentnative-cli` (the schema 0.6 fixture shape). During development, `cargo build`
CLI `dev` locally and run `anc audit --output json` to produce schema-0.6 fixtures for the site's renderer unit tests.
The release-side dependency (published CLI via the Homebrew tap for the docker/score image) is U6's gate, not U4's; U4
can complete against local-build fixtures alone. No `sync-spec.sh` change needed here; the site's vendored spec only
matters for U5.

**Work:**

- [done] Per-check status rendering routes through a shared `statusLabel()` map (`src/shared/scorecard-format.mjs`); the
  HTML rows (`src/build/scorecards-render.mjs`) emit `check--opt_out` / `check--n_a` classes distinct from
  `check--skip`, and the markdown twin reuses the same labels (`OPT-OUT`, `N/A`).
- [n/a] The leaderboard table has no skip+error visual bucket to split — it renders score and principles only
  (`src/build/scorecards-render.mjs`, `src/client/leaderboard.ts`). Per-status rendering lives in the per-tool "All
  Checks" table, covered by the per-audit work above.
- [shipped in #126] Badge cohort-band colors already landed on the spec-side band thresholds in `src/build/badge.mjs`
  (Exemplary / Strong / Solid / Qualified / below-floor); no further color change was needed for U4.
- [deferred to U5] Vale accept-list entries for `opt_out` / `n_a` are not needed yet: the terms enter prose only in the
  U5 methodology rewrite, not in U4's code.
- [done] Build-time schema gate widened from the single `0.5` string to the supported set `{0.5, 0.6}` so the migration
  window loads both side by side; anything outside the set still fails the build.
- [done] Regression + unit tests cover the new statuses (HTML render classes/labels, markdown rows, `statusLabel` map,
  and the 0.5 / 0.6 / mixed / out-of-set load paths).

**Acceptance:**

- [met] `bun test` green (765 passing).
- [met] `bun run build` produces dist/ (97 scorecard pages, 96 badges); the only warnings are the pre-existing
  registry-index owner/repo notes for `make` / `nvidia-smi` / `cf`, unrelated to U4.
- [met] The rendered `/score/<tool>` page shows distinct treatment for `opt_out`, `n_a`, and `skip` (asserted by the
  7-status render test).
- [met] A schema 0.6 fixture loads through the build invariants; the fixture validates against the published scorecard
  0.6 JSON Schema.

**Dependencies:** U2 (CLI must emit the new statuses before the site can render them).

### U5. Site — methodology rewrite (this repo)

**Status:** [shipped to dev only — NOT released]
[PR brettdavies/agentnative-site#129](https://github.com/brettdavies/agentnative-site/pull/129) — squash-merged to
`agentnative-site` `dev` at `ccb5844`. The methodology, scorecard-schema, and badge pages plus the README `## Scoring`
section now document the 7-status taxonomy, the conditional-requirement mechanism, and the behavioral-only
credit-weighted formula. Beyond the original doc scope, U5 also lowered the badge eligibility floor display to 70,
expanded the principles-met column to P1-P8 (`PRINCIPLE_NAMES` was missing P8, so it read `N/7`), and vendored
`principles/scoring.md` (`sync-spec.sh` now pulls it) with the reference tree resynced to `agentnative-spec` `dev` at
`972c9d3`. The live corpus stays schema 0.5 until the U6 rescore; see U6's production-promotion gate.

**Repo:** `brettdavies/agentnative-site`.

**Upstream basis:** Consumes U3 (spec formula choice) from `agentnative-spec`. The U5 dev landing vendored spec `dev` at
`972c9d3` via `bash scripts/sync-spec.sh --ref 972c9d3`; spec v0.5.0 has since shipped (2026-05-30), so any follow-up
resync (notably the U6 rescore) should use the default `sync-spec.sh` path (no `--ref`) to pin to the released tag. The
vendored `src/data/spec/principles/p*-*.md` carries the formula and methodology language the site mirrors.

**Work:**

- [shipped] `content/methodology.md` documents the 7-status taxonomy, the conditional-requirement mechanism, and the U3
  scoring formula (behavioral-only, credit-weighted, flat tier weights, floor 70, cohort bands) with a worked example.
- [shipped] `content/scorecard-schema.md` documents the new status enum, the new summary counters, the per-row `tier`
  field, and the previously-undocumented `badge` object.
- [shipped] `content/badge.md` reflects the 70 floor and the cohort-band color table.
- [shipped] The README's `## Scoring` section points at the new methodology and formula.

**Acceptance:**

- [met] `bash scripts/prose-check.sh` green (0 blocking).
- [met] `unslop` score 0 on the rewritten pages.
- [met] The methodology page explains the new statuses with worked examples.

**Dependencies:** U3 (the formula must be chosen before the methodology can document it accurately).

### U6. Site — registry rescore against post-change CLI (this repo)

**Repo:** `brettdavies/agentnative-site`.

**Upstream basis:** Requires the published `anc` CLI via the `brettdavies/homebrew-tap` formula (the docker/score image
installs `anc` via brew in its default mode, not from a local build). That release is tracked as U7 below; U6 cannot run
until U7 publishes. The release must carry **both** the taxonomy work (schema-0.6 statuses + the behavioral-only
formula, U2 / U3b) **and** the `check`→`audit` rename (agentnative-cli #65, `ff1275f`): the site shipped its half of the
rename in #131 (`5073bd7`), so `docker/score/score-anc100.sh` and the live-scoring worker now invoke `anc audit`, which
the current published `v0.4.0` (ships `anc check`, schema 0.5) does not provide. U6 is gated on that release, not on any
sync-spec flag. Also pull the spec at the same release tag via `bash scripts/sync-spec.sh` (default path, no `--ref`) so
the leaderboard's vendored spec matches the CLI's spec.

**Production-promotion gate (carried from U5).** U5 already landed on `dev`: the badge eligibility floor renders at 70,
the principles-met column counts P1-P8, the scoring documentation describes the behavioral-only credit-weighted formula,
and `principles/scoring.md` is vendored. The live scorecard corpus is still schema 0.5, scored under the prior formula
and floor, so on `dev` the floor copy and the principles-met column describe the new model while the displayed scores
are still the prior values. This rescore is what reconciles the data to the documented model. **Do not promote `dev` to
`main` until this unit lands** — production must not show floor-70 copy and P1-P8 columns over prior-formula scores. The
U6 PR body and the leaderboard scaffolding note (see Communication, below) carry the "scores moved" messaging when the
reconciled data goes live.

Promotion is additionally gated on the `check`→`audit` rename coupling. `dev` now carries the site half of the rename
(#131, `5073bd7`): the live-scoring worker and `docker/score/score-anc100.sh` invoke `anc audit`, and the production
sandbox container pin in `wrangler.jsonc` must run an audit-capable published `anc` before `dev` reaches `main`. The
published `v0.4.0` ships `anc check` only, so promoting before U7 publishes would break both the leaderboard rescore and
live scoring in production.

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

**Dependencies:** U2, U3, U3b, U7 (CLI must ship the new statuses, the formula must be specified in U3, and the CLI must
compute the final formula in U3b — the rescore is only meaningful against the final formula, not the transitional one —
and U7 must publish a release carrying that work plus the `audit` rename, since docker/score brew-mode installs the
published tap formula). U7 gates this unit.

### U7. Release train — publish the audit-capable `anc` (spec → cli → skill)

**Status:** [in-progress — spec stage shipped 2026-05-30 as v0.5.0 (PR brettdavies/agentnative#44 → `d5d4086`); cli
stage next, then skill, then website]

**Repos (release strictly in this order):** `brettdavies/agentnative` (spec) → `brettdavies/agentnative-cli` (cli) →
`brettdavies/agentnative-skill` (skill). The site is the fourth and final stage — U6's rescore lands on `dev`, then
`dev` promotes to `main`. The full train is **spec → cli → skill → website.** The order is load-bearing: each stage
vendors or references published content from the stage before it (the skill vendors spec but its prose references the
cli's published `anc audit` surface), so releasing out of order ships a downstream artifact against content that is not
yet published.

**Why this is a unit.** U1–U3b each landed on `dev` with their `VERSION` / `Cargo.toml` bump, CHANGELOG entry, and tag
publish explicitly deferred to "the release PR that closes out the taxonomy unit." U6 cannot run until the cli release
exists: `docker/score/build.sh` default (`ANC_SOURCE=brew`) installs `anc` from the `brettdavies/homebrew-tap` formula,
so the rescore scores against a *published* binary, not a local build. The same release also clears the live-scoring
staging red — the sandbox image's pinned `anc` release and the worker's `anc audit` invocation both need an
audit-capable published CLI (tracked in the live-scoring plan, but the release artifact is shared).

**Why this order:**

- **Spec first** — source of truth for the taxonomy and principle text; both the cli and the skill vendor it via their
  `sync-spec.sh`. Nothing downstream can pin a tag that does not exist yet. [shipped: spec v0.5.0, PR #44 → `d5d4086`,
  2026-05-30.]
- **CLI second** — vendors the spec, implements the statuses + formula, and is the published binary the site installs
  via brew (U6) and pins in the sandbox image (live scoring). Ships before the skill so the skill's prose lands against
  an installable `anc audit`, not against a release that does not yet exist. This is the stage U6 blocks on.
- **Skill third** — vendors the spec, and its bundle prose references `anc audit` and `anc skill install <host>` (the
  `check`→`audit` rename shipped as agentnative-skill #19). The skill does **not** vendor the cli; the ordering
  constraint is the prose reference, not a vendoring relationship. Releasing after the cli means a user who follows the
  published skill's commands hits a brew-installed `anc` that responds to `audit` rather than a v0.4.0 `anc check`. A
  notional alternative is to release the skill earlier and reference cli capabilities that exist only on the cli's `dev`
  branch, but that produces a published-skill window where the documented commands fail against the installable binary,
  so the cli-first sequence is preferred.
- **Website last** — U6 rescores against the published cli + matching spec tag, lands on `dev`, then `dev`→`main` (the
  production-promotion gate above).

**What the release train must carry:**

- **Spec:** [shipped as v0.5.0 — PR brettdavies/agentnative#44, merge commit `d5d4086`, tag `d765b7b`, GitHub Release
  331986638 published 2026-05-30 18:29:42Z, publish.yml run 26691600422 green.] Carries the conditional-schema +
  taxonomy content (U1 — was on spec `dev` at `b4f4d02`) and the scoring-formula doc (U3 — was on spec `dev` at
  `972c9d3`). `scripts/sync-spec.sh` default-path now resolves `v0.5.0` instead of pre-taxonomy `v0.4.0`.
- **CLI:** schema-0.6 / 7-status emission (U2 — cli `dev` `3839696`), behavioral-only credit-weighted `score_pct` +
  floor 70 (U3b — cli `dev` `43d4f7c`), the `check`→`audit` rename (agentnative-cli #65 — cli `dev` `ff1275f`), and a
  spec re-vendor at `v0.5.0`. The published `anc` must expose the `audit` subcommand: the site shipped its half of the
  rename in #131 (`5073bd7`), so the live-scoring worker and `docker/score/score-anc100.sh` now invoke `anc audit`,
  which the current published `v0.4.0` (ships `anc check`, schema 0.5) does not provide.
- **Skill:** the `check`→`audit` rename (agentnative-skill #19 — skill `dev` `e6bf388`) plus a spec re-vendor at
  `v0.5.0`. #19 re-vendored spec `v0.4.0` (pre-taxonomy), so the release must re-vendor *forward* to the new spec tag,
  not stay at `v0.4.0`, so the published bundle's `anc audit` examples match the released cli and the released spec.

**Work (in release order):**

1. **Spec release** [shipped]: spec v0.5.0 tagged 2026-05-30 (commit `d5d4086`, tag `d765b7b`, Release 331986638);
   publish.yml run 26691600422 green; `VERSION` on `main` reads `0.5.0`. Downstream `repository_dispatch` to cli/site is
   non-blocking by design and the warning ("Dispatch to $repo failed (may not have a handler yet); continuing.") is
   expected — the cli and skill release flows are driven manually.
2. **CLI release:** re-vendor the spec at the `v0.5.0` tag, bump `Cargo.toml`, finalize `CHANGELOG.md` (new statuses,
   schema 0.6, final formula, `audit` rename), merge `dev`→`main`, tag, let CI publish the linux + macos artifacts.
3. Confirm the cli release workflow's `repository_dispatch` updates the `brettdavies/homebrew-tap` `agentnative` formula
   to the new tag; verify a clean `brew install brettdavies/tap/agentnative` reports the new `anc --version` and that
   `anc audit --help` resolves.
4. **Skill release:** re-vendor the spec at the `v0.5.0` tag, bump the skill `VERSION`, finalize `CHANGELOG.md`, merge
   `dev`→`main`, tag. Skill prose pointing at `anc audit` / `anc skill install <host>` is now backed by a
   brew-installable cli that exposes those subcommands.

**Acceptance:**

- [met] Spec released at the new tag; `sync-spec.sh` default path (no `--ref`) pulls the taxonomy content. (Spec v0.5.0
  shipped 2026-05-30; verified via tag `d765b7b` and publish.yml run 26691600422.)
- `agentnative-cli` tagged at the new version; release artifacts published.
- Homebrew tap formula points at the new tag; `anc audit` resolves from a clean brew install.
- Skill released at the new tag with the spec re-vendored and `anc audit` examples published.
- `anc audit --command <tool> --output json` emits schema-0.6 output from the published binary.

**Dependencies:** U2, U3, U3b (the cli work being released), plus the `check`→`audit` rename across spec (#40 —
`283a306`, shipped in v0.5.0), skill (#19 — `e6bf388`), and cli (#65 — `ff1275f`). The spec (U1 + U3 content) is cut
first, the cli second, the skill third; the website (U6) is gated on the cli stage.

---

## System-Wide Impact

### Cross-repo coordination

The change touches four repos. During development the dependency chain is spec → CLI → site (spec defines the input
shape, CLI implements it, site consumes it); the skill joins at release time because its bundle prose references `anc
audit`. The sequence is non-negotiable; skipping the spec step means the CLI and site implement against a moving target.

The dev-phase handoff happens at `dev`-merge boundaries:

- spec U1 lands on `dev` (taxonomy + conditional schema decided)
- CLI U2 lands on `dev` (the new statuses are emitted)
- spec U3 lands on `dev` (the formula is chosen)
- CLI U3b lands on `dev` (`score_pct` computes the final formula)
- site U4 / U5 land on `dev` (renderer + methodology)

The release handoff (U7) is a strict train — **spec → cli → skill → website:**

- spec releases first (tagged; carries U1 + U3 content). [shipped: v0.5.0, PR #44 → `d5d4086`, 2026-05-30.]
- cli releases second (re-vendors the new spec tag; carries U2 + U3b + the `audit` rename, agentnative-cli #65;
  publishes via the Homebrew tap). The site shipped its rename half in #131, so the published `anc` must expose `audit`
  before the rescore or live scoring can run.
- skill releases third (re-vendors the new spec tag; ships the `anc audit` rename, agentnative-skill #19). The skill
  vendors spec, not cli, but its prose references `anc audit` and `anc skill install <host>`, so it ships after the cli
  so a brew-installed `anc` already responds to the documented subcommands.
- website is last: U6 rescores against the published cli + matching spec tag on `dev`, then `dev`→`main` closes the loop

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

**Mitigation:** the CLI's per-audit policy is the policy authority. Each verifier has a docstring documenting the
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

**Mitigation:** ship in strict order (U1 → U2 → U4 → U3 → U3b → U5 → U7 → U6). Each step is a separate PR with its own
review. Defensive rendering on the site side (fall back to `skip` rendering for any unknown status) is acceptable cost.

### Risk: schema_version bump misses a consumer

The CLI's `scorecard.schema.json` is consumed by the site at build time, by agent integrations that parse `anc audit
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

- `src/checks/*.rs` (or wherever the verifier policy lives) — per-audit status disambiguation
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
- **CLI README v0.4.0 dogfood section:** `anc audit . --binary` = 18 checks, 15 pass / 1 warn / 0 fail / 2 skip / 0
  error → 94% under current formula
- **RFC 2119** (key words for requirement levels)
- **RFC 8174** (uppercase vs lowercase ambiguity)
- **PR #108** (site README rewrite which introduced the `## Scoring` section that triggered the fairness conversation)
- **Conversation context:** v0.4.0 rescore session, 2026-05-21. Brett's figure-skating analogy framed the
  spec-ceiling-rewards-ambition insight. Brett's observation about conditional MUSTs framed the `n_a` requirement.
