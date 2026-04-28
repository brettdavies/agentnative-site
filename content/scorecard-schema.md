# Scorecard schema

A scorecard is the structured output of `anc check <binary> --output json`. The site reads scorecards under
[`scorecards/`](https://github.com/brettdavies/agentnative-site/tree/main/scorecards) and renders them at
[/scorecards](/scorecards) and at each tool's `/score/<name>` page. This page documents every field that appears in a
scorecard, what it means, and where it comes from. It is intentionally exhaustive: anything in the JSON should be
explainable from this page.

## Filename

Scorecards are stored on disk as:

```text
scorecards/<name>-v<version>.json
```

Where `<name>` matches the registry's `name` field (URL slug) and `<version>` is the SemVer string captured at scoring
time. The filename carries the **tool name** and the **version** the score was generated against — neither field is
duplicated inside the JSON body. Re-deriving them from the filename is the canonical path; no API consumer should expect
a `name` or `version` key inside the document.

There is also no `generated_at` timestamp inside the JSON. The closest signal is git history on the
[`scorecards/`](https://github.com/brettdavies/agentnative-site/commits/main/scorecards) directory. Future versions of
the `anc` CLI may add these fields; today they are filename-only.

## Top-level fields

```json
{
  "schema_version": "...",
  "spec_version": "...",
  "audience": "...",
  "audience_reason": null,
  "audit_profile": null,
  "summary": { ... },
  "coverage_summary": { ... },
  "results": [ ... ]
}
```

| Field              | Type                | Source        | Meaning                                                                                                       |
| ------------------ | ------------------- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| `schema_version`   | string              | `anc` emitted | Version of the JSON envelope itself. Pre-1.0; bumped when fields are added, removed, or renamed.              |
| `spec_version`     | string              | `anc` emitted | Version of the [agentnative spec](/principles) the run conformed to. Independent of `schema_version`.         |
| `audience`         | string \| null      | `anc` emitted | One-line audience classification. See [audience signal](/methodology#what-the-audience-signal-is-and-is-not). |
| `audience_reason`  | string \| null      | `anc` emitted | Set to `"suppressed"` when an active audit profile blanks the audience signal. Otherwise null.                |
| `audit_profile`    | string \| null      | registry      | Exception category passed to anc via `--audit-profile`. See [audit profiles](/methodology#audit-profiles).    |
| `summary`          | object              | derived       | Tally of how the runner's checks finished. See [summary](#summary) below.                                     |
| `coverage_summary` | object              | derived       | Tally of how many spec requirements the run verified. See [coverage_summary](#coverage_summary) below.        |
| `results`          | array of result obj | `anc` emitted | One entry per behavioral check that ran. See [results](#results) below.                                       |

## `summary`

Counts of the checks the runner actually executed. Adds up to `total`.

```json
"summary": {
  "total": 11,
  "pass": 8,
  "warn": 0,
  "fail": 0,
  "skip": 3,
  "error": 0
}
```

| Field   | Type    | Meaning                                                                                                                                           |
| ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `total` | integer | Number of checks the runner attempted on this tool. Equals `pass + warn + fail + skip + error`.                                                   |
| `pass`  | integer | Checks that succeeded with no concerns.                                                                                                           |
| `warn`  | integer | Checks that found a soft signal — partial compliance, deprecated pattern, mild inconsistency.                                                     |
| `fail`  | integer | Checks that found a clear non-compliance.                                                                                                         |
| `skip`  | integer | Checks the runner correctly judged inapplicable. Either the tool's shape made the check meaningless, or the active `audit_profile` suppressed it. |
| `error` | integer | The check itself crashed and produced no signal. Not evidence of a defect; not blended into the score.                                            |

The headline score on the leaderboard is `pass / (pass + warn + fail)` — `skip` and `error` are excluded from the
denominator on purpose, as documented on the [methodology page](/methodology#how-a-score-is-computed).

## `coverage_summary`

Tally of how much of the agentnative **spec** the run verified. Distinct from `summary`, which counts the runner's
checks. One implemented check can verify zero, one, or many spec requirements; many spec requirements aren't yet covered
by any implemented check.

```json
"coverage_summary": {
  "must":   { "total": 23, "verified": 9 },
  "should": { "total": 16, "verified": 0 },
  "may":    { "total": 7,  "verified": 0 }
}
```

| Field             | Type    | Meaning                                                                                               |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `must.total`      | integer | Number of MUST-tier requirements in the active spec version. Same for every tool scored at that spec. |
| `must.verified`   | integer | MUSTs satisfied by passing checks for *this* tool.                                                    |
| `should.total`    | integer | Number of SHOULD-tier requirements in the spec.                                                       |
| `should.verified` | integer | SHOULDs satisfied by passing checks for this tool.                                                    |
| `may.total`       | integer | Number of MAY-tier requirements in the spec.                                                          |
| `may.verified`    | integer | MAYs satisfied by passing checks for this tool.                                                       |

If `coverage_summary.must.verified` is below `summary.pass`, that's expected — a single passing check can map to
multiple MUSTs. If `should.verified` and `may.verified` are zero across the board, that's also expected: those tiers are
aspirational and will fill in as the runner grows checks mapped to them.

## `results`

Array of one object per check the runner attempted. Order is stable across runs of the same `anc` version.

```json
{
  "id": "p3-help",
  "label": "Help flag produces useful output",
  "group": "P3",
  "layer": "behavioral",
  "status": "pass",
  "evidence": null,
  "confidence": "high"
}
```

| Field        | Type           | Meaning                                                                                                                                                  |
| ------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | string         | Stable identifier (e.g., `p3-help`, `p1-non-interactive`). Citeable in commits and PRs.                                                                  |
| `label`      | string         | Human-readable name for the check.                                                                                                                       |
| `group`      | string         | Principle group this check belongs to: `P1`–`P7`. Drives the **principles met** column on the leaderboard.                                               |
| `layer`      | string         | `behavioral`, `project`, or `source`. See [layers](/methodology#layers-behavioral-project-source) on methodology.                                        |
| `status`     | string         | `pass`, `warn`, `fail`, `skip`, or `error`. Definitions match the [`summary` table](#summary) above.                                                     |
| `evidence`   | string \| null | Short explanation when status is `skip`, `warn`, or `fail`. Often references the suppressing audit profile or the input that triggered the check.        |
| `confidence` | string         | `high`, `medium`, or `low`. Reflects how directly the check observed the property — direct flag presence is high; inference from `--help` text is lower. |

### `status` semantics in detail

- `pass` — Check ran, found no issue.
- `warn` — Check ran, found a soft signal worth noting. Lowers the headline score.
- `fail` — Check ran, found a hard non-compliance. Lowers the headline score.
- `skip` — Check did not run, by design. Either the tool's surface made it inapplicable (e.g., a `--help` parser check
  on a tool with no flags) or the active `audit_profile` suppressed it (`evidence` will name the profile).
- `error` — Check tried to run and crashed before producing a verdict. Treated as no-signal, not a defect.

## What is *not* in the scorecard (yet)

The site is transparent about gaps that future schema bumps may fill. Today, the JSON does **not** carry:

- **Tool name** — read it from the filename, registry entry, or per-tool page.
- **Version** — same as above. Filename is the source of truth.
- **Generated-at timestamp** — git history on `scorecards/<name>-v<version>.json` is the closest signal. Treat the
  scorecard as "the score for this version of the tool, as of the most recent commit touching this file."
- **Per-check timing** — execution times are observable from the runner's stdout but not captured in the JSON.

When the `anc` CLI grows fields for any of the above, the schema page above will be updated and `schema_version` will
bump.

## Why is `audience` `null` for some tools?

When a tool is scored with `audit_profile: human-tui`, anc suppresses one or more of the four signal checks the audience
classifier consumes. With incomplete inputs, the classifier emits `audience: null` and sets `audience_reason:
"suppressed"` rather than guess. This is correct, intentional, and shared across every TUI on the leaderboard. The
[methodology page](/methodology#what-the-audience-signal-is-and-is-not) covers the full classifier definition.
