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
time. The filename's `<version>` segment is the **canonical version anchor** — the site reads it directly off disk and
displays it as the scored version on every per-tool page. The scorecard's `tool.version` field (added in schema 0.4) is
informational; when both are present and disagree, the build aborts with an integrity error. The filename never lies.

## Top-level fields

```json
{
  "schema_version": "0.4",
  "spec_version": "...",
  "tool":   { "name": "...", "binary": "...", "version": "..." },
  "anc":    { "version": "..." },
  "run":    { "invocation": "...", "started_at": "...", "duration_ms": 0,
              "platform": { "os": "...", "arch": "..." } },
  "target": { "kind": "...", "path": null, "command": "..." },
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
| `tool`             | object              | `anc` emitted | Self-describing identity for the tool that was scored. See [tool](#tool) below. **Added in 0.4.**             |
| `anc`              | object              | `anc` emitted | Provenance of the `anc` build that produced the scorecard. See [anc](#anc) below. **Added in 0.4.**           |
| `run`              | object              | `anc` emitted | Run-context: what was invoked, when, on what platform. See [run](#run) below. **Added in 0.4.**               |
| `target`           | object              | `anc` emitted | What the run was scoring (command vs. binary vs. project). See [target](#target) below. **Added in 0.4.**     |
| `audience`         | string \| null      | `anc` emitted | One-line audience classification. See [audience signal](/methodology#what-the-audience-signal-is-and-is-not). |
| `audience_reason`  | string \| null      | `anc` emitted | Set to `"suppressed"` when an active audit profile blanks the audience signal. Otherwise null.                |
| `audit_profile`    | string \| null      | registry      | Exception category passed to anc via `--audit-profile`. See [audit profiles](/methodology#audit-profiles).    |
| `summary`          | object              | derived       | Tally of how the runner's checks finished. See [summary](#summary) below.                                     |
| `coverage_summary` | object              | derived       | Tally of how many spec requirements the run verified. See [coverage_summary](#coverage_summary) below.        |
| `results`          | array of result obj | `anc` emitted | One entry per behavioral check that ran. See [results](#results) below.                                       |

## `tool`

Self-describing tool identity. Lets a downstream consumer answer "what was scored?" without cross-referencing the
registry.

```json
"tool": {
  "name": "rg",
  "binary": "rg",
  "version": "ripgrep 15.1.0"
}
```

| Field     | Type           | Meaning                                                                                                                                                                                                                                                                                                                                                            |
| --------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`    | string         | The literal `--command` argv passed to anc. For tools where the registry name differs from the binary (e.g., registry `ripgrep` → binary `rg`), this is the binary, not the registry slug. The filename slug owns the registry-name side of the join.                                                                                                              |
| `binary`  | string         | Executable name resolved from `$PATH` at scoring time. Equals `tool.name` for command-mode runs except when a tool ships under an alias.                                                                                                                                                                                                                           |
| `version` | string \| null | Best-effort version string. The CLI dumps the first line of `<binary> --version` here without further parsing — it may carry the marketing string ("eza - A modern, maintained replacement for ls"), the full multi-line block, or `null` when the binary doesn't print anything parseable. **The filename's `<version>` is canonical**; this field is a courtesy. |

**Build-time invariant:** when `tool.version` contains a SemVer-shaped token (`X.Y` or `X.Y.Z`), it must equal the
filename version. Drift fails the build with a parser-asymmetry error — the regen script's `version_extract` snippet and
the CLI's internal probe are the only two places that derive a version from the binary, and they must agree.

## `anc`

Provenance for the scorecard: which `anc` build produced it.

```json
"anc": {
  "version": "0.2.1"
}
```

| Field     | Type   | Meaning                                                                                             |
| --------- | ------ | --------------------------------------------------------------------------------------------------- |
| `version` | string | Self-reported version of the `anc` binary that ran the score. Read from `Cargo.toml` at build time. |

The per-tool page renders `anc.version`.

## `run`

Run-context: the literal invocation, when it ran, how long it took, and what platform it ran on.

```json
"run": {
  "invocation": "anc check --command rg --output json",
  "started_at": "2026-04-30T04:18:53.099683344Z",
  "duration_ms": 53,
  "platform": { "os": "linux", "arch": "x86_64" }
}
```

| Field           | Type    | Meaning                                                                                                                                                      |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `invocation`    | string  | The verbatim argv that produced this scorecard, joined with single spaces. The per-tool "Reproduce locally" CTA renders this directly for command-mode runs. |
| `started_at`    | string  | RFC 3339 timestamp of when the run started. UTC. Validated as parseable by `Date` at build time.                                                             |
| `duration_ms`   | integer | Wall-clock duration of the entire scoring run in milliseconds.                                                                                               |
| `platform.os`   | string  | OS the binary ran on (`linux`, `darwin`, `windows`).                                                                                                         |
| `platform.arch` | string  | CPU architecture the binary ran on (`x86_64`, `aarch64`, …).                                                                                                 |

**Security note — `run.invocation`:** for command-mode runs the invocation is the canonical `anc check --command <name>
[--audit-profile <X>] [--output json]` shape, which is safe to embed publicly. For project-mode runs (`target.kind:
"project"`) the invocation may include a local filesystem path (`anc check ./local/repo`); the site falls back to the
synthesized form for those runs to avoid leaking machine-local paths into HTML, markdown, and `/llms-full.txt`. Mirror
this gate downstream if you fetch the JSON directly.

## `target`

What the run was scoring: a command, a binary on disk, or a project tree.

```json
"target": {
  "kind": "command",
  "path": null,
  "command": "rg"
}
```

| Field     | Type           | Meaning                                                                                                                                                                                                                                                    |
| --------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`    | string         | One of `command`, `binary`, or `project`. Drives whether the per-tool page's reproduce CTA renders `run.invocation` verbatim (`command`) or falls back to the synthesized form (others). Future schema-version source-layer scorecards will use `project`. |
| `path`    | string \| null | Filesystem path when `kind` is `project` or `binary`; `null` for `command`-mode runs.                                                                                                                                                                      |
| `command` | string \| null | The `--command` argv string when `kind` is `command`; `null` otherwise. For command-mode runs this equals `tool.name`.                                                                                                                                     |

**Security note — `target.path`:** when `kind` is `project`, this can carry a local directory path (`/home/me/dev/foo`).
It is not currently rendered on any per-tool page (every leaderboard entry today is command-mode), but downstream
consumers reading the JSON should treat it as machine-local.

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

The site is transparent about gaps that future schema bumps may fill. Schema 0.4 closed the tool-identity / generated-at
gap (see `tool`, `anc`, `run`, `target` above). Still outstanding today:

- **Per-check timing** — `run.duration_ms` is the wall-clock total for the run, not per-check. Individual check timings
  are observable from the runner's stdout but not captured in the JSON.
- **Editorial fields inside the scorecard** — tier, language, creator, description, install, repo/url remain in the
  registry. Migrating them into the scorecard would let the registry shrink to a name list; deferred to a future schema
  bump.

When the `anc` CLI grows fields for any of the above, the schema page above will be updated and `schema_version` will
bump.

## Why is `audience` `null` for some tools?

When a tool is scored with `audit_profile: human-tui`, anc suppresses one or more of the four signal checks the audience
classifier consumes. With incomplete inputs, the classifier emits `audience: null` and sets `audience_reason:
"suppressed"` rather than guess. This is correct, intentional, and shared across every TUI on the leaderboard. The
[methodology page](/methodology#what-the-audience-signal-is-and-is-not) covers the full classifier definition.
