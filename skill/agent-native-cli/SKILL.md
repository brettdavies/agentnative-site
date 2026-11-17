---
name: agent-native-cli
description: >-
  Guide to designing, building, and auditing CLI tools for use by AI agents. Pairs with
  [`anc`](https://github.com/brettdavies/agentnative-cli) (the canonical compliance auditor) and
  [`agentnative-spec`](https://github.com/brettdavies/agentnative) (the canonical principle text, vendored at
  `spec/`). Provides starter templates, language-specific implementation idioms (Rust/clap, Python Click & argparse,
  Go Cobra, JS Commander/yargs/oclif, Ruby Thor), and a getting-started guide that points agents at
  `anc audit --output json` (scorecard schema 0.9) and `anc skill install <host>` / `anc skill update --all`. Use
  when designing a new CLI tool, building a Rust/clap binary intended for agents, reviewing one for agent-readiness,
  claiming the agent-native badge (≥70% credit-weighted score), or remediating findings from `anc`. Triggers on
  agentic CLI, agent-native, CLI design, CLI standard, agent-first, CLI for agents, agent-friendly CLI, CLI
  compliance, agent-readiness, anc, anc audit, anc emit schema, anc skill install, anc skill update, agent-native
  badge, scorecard, audit_id, audit-profile, opt_out, n_a, Rust CLI, clap derive. SKIP when the user is building a
  TUI app meant for humans (use `--audit-profile human-tui` rather than this skill), writing a non-CLI library, or
  asking unrelated Rust questions not specifically about agent-readiness of a CLI.
---

# Agent-Native CLI

The standard for CLI tools designed to be operated by AI agents. Three artifacts work together:

| Artifact                                                         | Role                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`agentnative-spec`](https://github.com/brettdavies/agentnative) | Canonical text of the eight principles. Frontmatter `requirements[]` is the machine-readable contract. Vendored into [`spec/`](./spec/); snapshot refreshed each release.                                |
| [`anc`](https://github.com/brettdavies/agentnative-cli)          | The compliance auditor. Reads target source/binary, emits a JSON scorecard whose entries cite the spec requirement `id` (e.g. `p1-must-no-interactive`) and the probe `audit_id`. The runtime authority. |
| **This skill** (`agent-native-cli`)                              | The agent-facing guide. Tells the agent how to invoke `anc`, how to navigate the spec when remediating findings, and where the implementation patterns and starter templates live.                       |

The skill does **not** implement principles auditing. `anc` does. The skill teaches agents to use `anc` and supplies the
surrounding context (spec, idioms, templates) that `anc`'s findings reference.

## First action: update check

Run once per session before doing real work:

```bash
bash "$(dirname "$0")/bin/check-update"
```

Empty output → continue. `UPGRADE_AVAILABLE <local> <remote>` → prompt the user via `AskUserQuestion` (Yes / Not now /
Never). Full prompt text, snooze ladder, and state-file layout are in
[`references/update-check.md`](./references/update-check.md). Exit code is always `0`; failures degrade silently.

## Start here

→ **[`getting-started.md`](./getting-started.md):** the three working loops (existing CLI / new Rust CLI / other
language), the canonical `anc audit` invocations, the `anc skill install <host>` installer, and a "where things live"
map.

## The eight principles

Defined in [`spec/principles/`](./spec/principles/) (vendored from `agentnative-spec` at the version in
[`spec/VERSION`](./spec/VERSION); see [`spec/README.md`](./spec/README.md) for resync instructions). One file per
principle, each with machine-readable `requirements[]` frontmatter:

| #   | File                                                                                                                 | Subject                           |
| --- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| P1  | [`p1-non-interactive-by-default.md`](./spec/principles/p1-non-interactive-by-default.md)                             | Non-Interactive by Default        |
| P2  | [`p2-structured-parseable-output.md`](./spec/principles/p2-structured-parseable-output.md)                           | Structured, Parseable Output      |
| P3  | [`p3-progressive-help-discovery.md`](./spec/principles/p3-progressive-help-discovery.md)                             | Progressive Help Discovery        |
| P4  | [`p4-fail-fast-actionable-errors.md`](./spec/principles/p4-fail-fast-actionable-errors.md)                           | Fail Fast, Actionable Errors      |
| P5  | [`p5-safe-retries-mutation-boundaries.md`](./spec/principles/p5-safe-retries-mutation-boundaries.md)                 | Safe Retries, Mutation Boundaries |
| P6  | [`p6-composable-predictable-command-structure.md`](./spec/principles/p6-composable-predictable-command-structure.md) | Composable, Predictable Structure |
| P7  | [`p7-bounded-high-signal-responses.md`](./spec/principles/p7-bounded-high-signal-responses.md)                       | Bounded, High-Signal Responses    |
| P8  | [`p8-discoverable-skill-bundle.md`](./spec/principles/p8-discoverable-skill-bundle.md)                               | Discoverable Skill Bundles        |

Do not paraphrase the principles inside this skill. Read the spec files directly; they are the source of truth.

[`spec/reading-the-spec.md`](./spec/reading-the-spec.md), vendored from the spec README, defines the `requirements[]`
fields and how a flag name in requirement text applies to single-dash and single-letter flags. Read it before judging
whether a tool's flag meets a requirement.

## The anc loop: audit → fix → re-audit → claim badge

Once `anc` is installed (one-line install in [`getting-started.md`](./getting-started.md)), the work is a four-step
loop:

**1. Audit.** `anc audit --output json . > scorecard.json`. The JSON envelope is schema `0.9` and contains:

- `summary`: counter object covering the full status set (`total / pass / warn / fail / skip / error / opt_out / n_a`).
  Spans all three audit layers (behavioral, source, project).
- `coverage_summary`: `must / should / may`, each with `total` + `verified`. **`verified` counts any verdict; `pass`,
  `warn`, `fail`, and `skip` all increment it.** "Was this MUST audited at all?" not "was it satisfied." The actual bar
  for "no MUST violations" is no `results[]` row where `tier == "must" && status == "fail"` (equivalently, every MUST
  row is `pass` / `warn` / `opt_out` / `skip` / `n_a`).
- `badge.eligible` (bool), `badge.score_pct` (int), `badge.embed_markdown` (string or `null`), `badge.scorecard_url`,
  `badge.badge_url`, `badge.convention_url`. **70%** is the eligibility floor; below it, `embed_markdown` is `null` and
  the convention says do not advertise a badge. **The score is computed over behavioral-layer rows only.** Source- and
  project-layer audits do not affect `score_pct` or badge eligibility (`spec/principles/scoring.md` § "Scope:
  shipped-binary behavior only"). Under the current flat tier weights the formula reduces to a credit-weighted ratio:
  `pass = 1.0`, `warn = 0.5`, `fail` and `opt_out` = `0.0` (all in the denominator); `n_a`, `skip`, and `error` are
  excluded. The general form is tier-weighted (`w(must) · w(should) · w(may)`) but currently flat; see
  `spec/principles/scoring.md` for the formula and the cohort bands above the floor.
- `results[]`: one entry per requirement-row. Each carries `id` (the spec requirement id matching
  `spec/principles/p<N>-*.md` frontmatter, e.g. `p1-must-no-interactive`), `audit_id` (the probe that produced the row,
  e.g. `p1-non-interactive`), `tier` (`must` / `should` / `may`), `status`, `evidence`, `group`, `layer`, `confidence`,
  and `label`. A single probe like `p3-version` emits two rows (one tier-stamped `must`, one `should`), so you can
  attribute the verdict to a specific RFC 2119 level without joining the coverage matrix.
- `audit_profile`: the exemption category in effect (or `null`).
- `tool / anc / run / target` metadata: identifies the scored tool, the `anc` build, the invocation, and the resolved
  target.

**Status set.** `pass` / `warn` / `fail` / `skip` / `error` are the live verdicts. `opt_out` marks a deliberate
non-adoption (e.g. no `--output` flag → P2 schema-discovery rows collapse). `n_a` propagates from a conditional whose
antecedent is `opt_out` or `n_a`; the `evidence` field names the antecedent so the chain is legible from JSON alone. The
process exit code reflects live verdicts only: `n_a` from an `opt_out` antecedent does not force a non-zero exit.

**2. Fix.** For each `fail`, look up the cited `id` (e.g. `p1-must-no-interactive`) in `spec/principles/p<N>-*.md`'s
`requirements[]` frontmatter. Apply the fix using the implementation references below. Re-run with `--principle <N>` to
focus on one principle while iterating.

**3. Re-audit.** Re-run `anc audit --output json .` until no MUST row is in `fail`. Query the JSON with `jq '[.results[]
| select(.tier == "must" and .status == "fail")] | length'` and confirm it's `0`. Do not rely on
`coverage_summary.must.verified == coverage_summary.must.total` as the satisfaction bar; the `verified` counter
increments on any verdict, so it can equal `total` while MUST fails still exist. Use `--audit-profile <category>` to
suppress audits that don't apply to the tool class: `human-tui` (TUIs that legitimately intercept the TTY),
`file-traversal` (reserved), `posix-utility` (cat / sed / awk style), `diagnostic-only` (read-only tools). Suppressed
audits emit `Skip` with structured evidence so readers see what was excluded.

**4. Claim the badge.** Once `badge.eligible == true` (≥70%), copy `badge.embed_markdown` into the project's README. The
`text` output appends an embed hint after the summary line whenever the floor is cleared; below the floor, nothing
badge-related is printed (the convention's "do not nag" rule).

### Useful flags

- `--principle <N>`: filter the audit to one principle while iterating.
- `--binary` / `--source`: scope to one layer (skip the other).
- `--audit-profile <category>`: suppress audits that don't apply (`human-tui`, `posix-utility`, `diagnostic-only`,
  `file-traversal`).
- `--examples`: print a curated invocation block and exit (pair with `--output json` or `--json` for structured).
- `--json`: short alias for `--output json` (the `p2-should-json-aliases` convention).
- `--raw`: strip headers and summary, emit one `id<TAB>status` line per audit. Pipe-friendly for `grep` / `awk`.
- `--color <auto|always|never>` (env `AGENTNATIVE_COLOR`): control ANSI styling; honors `NO_COLOR` in `auto` mode.
- `-v` / `--verbose` (env `AGENTNATIVE_VERBOSE`): escalate diagnostic detail when debugging unexpected results.

### Get the scorecard JSON Schema

The canonical JSON Schema for the scorecard envelope ships embedded in the binary. Extract it without a network round
trip:

```bash
anc emit schema                # print to stdout
anc emit schema | jq '.title'  # inspect a field
```

The schema `$id` is `https://anc.dev/scorecard-v0.9.schema.json`. Pre-0.6 consumers treated `opt_out` / `n_a` as
unknown, so feature-detect the status enum rather than pinning to an exact list.

## Implementation guidance (when fixing findings)

Once `anc audit` reports a failure, the agent has the cited `id` (requirement-row id) and the spec text. The next
question is "how do I write code that satisfies this requirement?" The references below answer that:

| Need                                                    | File                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Rust/clap-specific patterns per principle               | [`references/rust-clap-patterns.md`](./references/rust-clap-patterns.md)                             |
| General Rust idioms (output, errors, dependency gating) | [`references/framework-idioms.md`](./references/framework-idioms.md)                                 |
| Idioms in Python, Go, JS, Ruby                          | [`references/framework-idioms-other-languages.md`](./references/framework-idioms-other-languages.md) |
| Required project structure (modules, tests, AGENTS.md)  | [`references/project-structure.md`](./references/project-structure.md)                               |
| Black-box tests that prove each principle               | [`references/testing.md`](./references/testing.md)                                                   |

After a fix lands, prove it stays fixed: [`references/testing.md`](./references/testing.md) maps each principle to
black-box assertions and to CI-green OSS test files to adapt into your own suite.

## Starter code

Drop-in starting points for greenfield Rust CLIs. Each encodes the relevant principles by construction.

| File                                                                   | Encodes                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`templates/clap-main.rs`](./templates/clap-main.rs)                   | `try_parse`, SIGPIPE fix, three-tier dependency gating, global flags |
| [`templates/error-types.rs`](./templates/error-types.rs)               | `thiserror` enum + `exit_code()` mapping                             |
| [`templates/output-format.rs`](./templates/output-format.rs)           | `OutputConfig`, `OutputFormat`, `diag!`, NO_COLOR / IsTerminal       |
| [`templates/agents-md-template.md`](./templates/agents-md-template.md) | Project-level AGENTS.md scaffold                                     |

## Compliance auditing

Use `anc`. Install once via Homebrew, cargo, or self-install:

```bash
brew install brettdavies/tap/agentnative   # binary is `anc`
cargo install agentnative
```

To install **this skill bundle** into a host's canonical skills directory, use `anc`'s built-in installer:

```bash
anc skill install claude_code              # also: codex, cursor, factory, kiro, opencode
anc skill install --all                    # install into every known host in one invocation
anc skill install --dry-run claude_code    # print resolved git command without spawning
anc skill update claude_code               # refresh an existing install (guards on SKILL.md marker)
anc skill update --all                     # refresh every known host
```

Recommended `anc audit` invocations and the full agent loop are in [`getting-started.md`](./getting-started.md). Do not
write shell scripts to grep for principle violations; `anc` already implements (and supersedes) every audit that
approach could produce.

## Sources

- [`agentnative-spec`](https://github.com/brettdavies/agentnative): canonical principle text (CC BY 4.0)
- [`agentnative-cli`](https://github.com/brettdavies/agentnative-cli): `anc`, the canonical auditor (MIT / Apache-2.0)
- [`agentnative-skill`](https://github.com/brettdavies/agentnative-skill): this repo (MIT)
