# Methodology

How the ANC 100 leaderboard is built, what each score means, and what the leaderboard does *not* claim to measure.

For the field-by-field shape of the underlying JSON, see the [scorecard schema reference](/scorecard-schema).

## What gets scored

Every entry on the [leaderboard](/scorecards) is the output of `anc audit <binary>` against a real CLI tool, run on
Brett's machine, committed to the site repo as JSON, and rendered into the per-tool page at `/score/<name>`. The
[registry](https://github.com/brettdavies/agentnative-site/blob/main/registry.yaml) is the single source of truth for
which tools are in the set.

Adding a tool means filing a registry entry. Removing a tool means filing a registry deletion. There is no other
inclusion criterion.

### Contributor flow: registry PR and scorecard PR may land in either order

A tool needs two artifacts to appear on the leaderboard: a registry entry (`registry.yaml`) and a scorecard
(`scorecards/<name>-v<version>.json`). The build accepts these in either order:

- **Editorial-PR-first.** A registry entry without a matching scorecard is a "registry orphan": the build emits a
  warning and excludes the entry from the leaderboard until a scorecard PR lands. This is the expected steady-state for
  a freshly-nominated tool.
- **Scorecard-PR-first.** A scorecard whose filename slug has no registry entry is a "scorecard orphan": the build emits
  the symmetric warning and excludes the scorecard from the leaderboard until the editorial PR lands.

Both directions surface as a structured CI annotation on the PR (`WARNINGS_JSON: { scorecardOrphans, registryOrphans }`)
so reviewers see drift without grepping logs. The build still passes in either orphaned state; the warning is the nudge,
not a blocker. Once both halves land, the tool appears on the leaderboard at the next deploy.

## The seven outcomes

Each audit resolves to one of seven statuses. Whether a status counts in the denominator is the load-bearing
distinction: it decides whether the audit moves the score at all.

| Status    | Credit | In denominator | Meaning                                                                                  |
| --------- | ------ | -------------- | ---------------------------------------------------------------------------------------- |
| `pass`    | full   | yes            | Requirement met.                                                                         |
| `warn`    | half   | yes            | A requirement was only partially satisfied.                                              |
| `fail`    | none   | yes            | A MUST-tier requirement was not satisfied.                                               |
| `opt_out` | none   | yes            | The tool could implement the requirement but deliberately does not.                      |
| `n_a`     | —      | no             | A conditional requirement whose antecedent is absent: it does not apply to this tool.    |
| `skip`    | —      | no             | The probe could not measure the property. A linter limitation, not a tool defect.        |
| `error`   | —      | no             | The audit raised an exception inside `anc`. A bug on the linter side, not a tool defect. |

`pass`, `warn`, `fail`, and `opt_out` all count toward the denominator, so a tool is measured against everything it
could reasonably be expected to do. `n_a`, `skip`, and `error` drop out of both sides of the ratio, so a audit that does
not apply or could not be measured never moves the number in either direction.

`opt_out`, `n_a`, and `skip` separate three situations that a single status would blur together: a tool that chose not
to ship a feature (`opt_out`), a requirement that does not apply to this tool (`n_a`), and a property the probe could
not see (`skip`). Whether a missing feature is a deliberate `opt_out` or a genuine `n_a` is decided per audit by `anc`'s
verifier and documented in its source; a disagreement about that call is filed against the
[`agentnative` CLI](https://github.com/brettdavies/agentnative-cli/issues), not this site.

## How a score is computed

The headline number on each tool's row scores how the shipped binary behaves against the requirements that apply to it.

**Scope: behavioral audits only.** Only behavioral-layer requirements, the ones that invoke the binary and observe what
it does, enter the headline score. Source-layer and project-layer results are reported on the per-tool page but do not
move the number (see [Layers](#layers-behavioral-project-source)). A behavioral score compares every tool on the same
ground: what an agent observes when it runs the tool, independent of implementation language.

**The denominator** is every behavioral audit whose status is `pass`, `warn`, `fail`, or `opt_out`. `n_a`, `skip`, and
`error` are excluded from both numerator and denominator.

**The numerator credits each outcome.** A `pass` earns full credit (1.0); a `warn` earns half (0.5), because a partial
satisfaction is worth more than none; a `fail` and an `opt_out` earn nothing (0.0). The score is the credit earned over
the credit available:

```text
score = round(100 × (pass + 0.5 × warn) / (pass + warn + fail + opt_out))
```

When no behavioral audit applies, the denominator is empty and the score is 0.

**Worked example.** A tool with 20 `pass`, 7 `warn`, 0 `fail`, 1 `opt_out`, 1 `n_a`, and 14 `skip` behavioral audits:
the denominator is the 28 audits that count, since the `n_a` and the 14 `skip`s drop out. The numerator is 20 + 0.5 × 7
= 23.5. The score is round(100 × 23.5 / 28) = 84.

The formula also carries a per-tier weight (see [Requirement tiers](#requirement-tiers)). It is flat today, so it does
not change the arithmetic above; it is a published parameter rather than a hard-coded constant, so re-tuning it later is
a documented change rather than a silent one. The formula, the tier weights, and the badge floor are held stable for at
least six months from publication.

## Requirement tiers

RFC 2119 defines three requirement levels, and each scored requirement carries its tier in the scorecard:

- **MUST** — required for conformance. A missed MUST is a `fail` (no credit).
- **SHOULD** — strongly recommended absent a good reason. A missed SHOULD is a `warn` (half credit).
- **MAY** — genuinely optional. A missed MAY is a `warn` (half credit).

The status already encodes severity: a missed MUST is scored `fail` (no credit), and a missed SHOULD or MAY is scored
`warn` (half credit). The separate per-tier weight is the lever for valuing the tiers differently in the denominator;
while it stays flat, missing a SHOULD and missing a MAY move the score by the same amount.

## Conditional requirements

Some requirements bind only when an antecedent feature is present. "If a CLI ships `--output json`, it MUST also expose
its schema" is a MUST, but only for tools that ship JSON output. The standard models these as conditional requirements
with a named antecedent audit.

When the antecedent is present, the requirement is evaluated normally. When the antecedent is absent, the requirement is
`n_a` and drops out of the score. A tool is never penalized for skipping a requirement whose precondition it never met.
The antecedent's own outcome decides what the dependent requirement emits:

| Antecedent outcome               | Dependent requirement     |
| -------------------------------- | ------------------------- |
| `pass`, `warn`, `fail` (present) | evaluated normally        |
| `opt_out`, `n_a` (absent)        | `n_a`                     |
| `skip`, `error` (unmeasured)     | inherits `skip` / `error` |

The tier is independent of the condition. A conditional MUST applies with full MUST force when its antecedent is met; a
conditional SHOULD applies with full SHOULD force. The antecedent decides *whether* the requirement fires; the tier
decides *how much* a miss costs once it does.

## Cohort bands and the badge floor

A tool clears the badge floor at a score of **70**. At or above the floor, scores fall into named cohort bands:

| Band        | Score    |
| ----------- | -------- |
| Exemplary   | 85–100   |
| Strong      | 80–84    |
| Solid       | 75–79    |
| Qualified   | 70–74    |
| Below floor | under 70 |

The band thresholds are part of the standard; the color the site renders for each band is a site choice. A tool at or
above 70 may embed the [agent-native badge](/badge); below 70 it can still link to its scorecard but should not display
the badge as a quality signal. See the [badge convention](/badge) for the embed contract.

## Principles met

The **principles met** column counts how many of the eight principles (P1–P8) have *all* their audits passing: no
warnings, no failures. A tool can post a 90% score and still meet only four of eight principles, if the misses cluster
inside a few principle groups. Both numbers are surfaced because either, alone, hides the shape of the result. The
per-tool page is the ground truth.

Bonus audits (`CodeQuality` and `ProjectStructure`) are listed on each tool's page but not blended into the score. They
are language-specific and would create unfair comparisons across tools.

## What the audience signal is, and is not

`anc` classifies each scored tool as one of:

- `agent-optimized`: the four signal audits (P1 non-interactive, P2 JSON output, P6 NO_COLOR, P7 quiet) all pass or warn
  at most once. (One warn allowance reflects the reality that the four signal audits are correlated; a near-conformant
  tool may miss on one edge, e.g., honoring `NO_COLOR` but not `NO_COLOR=0`. Requiring zero warns would over-penalize
  otherwise-conformant tools.)
- `mixed`: two of the four signal audits warn.
- `human-primary`: three or more of the four signal audits warn.
- `null` with `audience_reason: "suppressed"`: when the active audit profile suppresses one or more of the four signal
  audits, the classifier has insufficient input and refuses to label. The per-tool page surfaces the reason so a reader
  can see *why* the field is empty rather than guessing.

The classifier is **informational, not authoritative**. It is a one-line summary derived from a fixed set of four
behavioral audits. The per-audit evidence shown alongside is the ground truth. A tool labeled `human-primary` may still
be safe to use from an agent in narrow, well-bounded ways. A tool labeled `agent-optimized` may still surprise an agent
on a audit the classifier does not look at.

When the classifier disagrees with intuition (for example, a tool you consider agent-hostile gets `agent-optimized`),
the fix lives in one of two places:

1. The tool fits an exception category that should suppress some audits → file a registry update adding an
   `audit_profile` (see below).
2. The classifier is missing a signal that ought to count → file an issue against the
   [`agentnative` CLI](https://github.com/brettdavies/agentnative-cli) proposing a new MUST-level audit.

Patching the *site* to override a CLI verdict is never the answer. The site renders what the CLI emits.

## Audit profiles: scoping the standard to a tool's category

Some tools intentionally do not satisfy parts of the standard because the standard does not apply to their category.
Lazygit is interactive on purpose because it is a TUI. `find` does not emit JSON because POSIX utilities don't. Holding
these tools to audits that punish their core design produces a misleading score and a hostile leaderboard.

`anc` v0.1.3 exposes four exception categories via `--audit-profile`. The exact suppression set lives in
[`SUPPRESSION_TABLE`](https://github.com/brettdavies/agentnative-cli/blob/main/src/principles/registry.rs) in the CLI
source and is the contract this site renders against:

| Category          | Suppresses                               | Use when...                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human-tui`       | P1 non-interactive variants + P6 SIGPIPE | Tool's primary mode is an interactive terminal UI (e.g., `lazygit`). TUIs intercept the TTY by design and install their own signal handlers.                                                                  |
| `file-traversal`  | (no audits suppressed in v0.1.3)         | Tool emits filenames as its output protocol (`fd`, `find`). Today the applicability filter on subcommand-shape audits already produces the right Skip outcome; the table entry is reserved for future audits. |
| `posix-utility`   | P1 non-interactive variants              | Tool predates structured output and follows POSIX conventions (`grep`, `awk`). The no-prompt MUST is satisfied vacuously by the stdin protocol.                                                               |
| `diagnostic-only` | P5 dry-run                               | Tool is read-only by design (`nvidia-smi`, `lsof`). Read-write-distinction and force-yes are still uncovered in v0.1.3.                                                                                       |

When a tool is scored under an audit profile, the suppressed audits still appear on the per-tool page, tagged **N/A by
category** with a pointer to the profile that excluded them. The reader sees what was excluded and why; the audits are
not silently removed.

Every audit-profile change is a registry change, reviewed in the open. There is no per-tool override that does not show
its work.

### Profiles applied to the current registry

| Tool        | Profile          | Why                                                                                 |
| ----------- | ---------------- | ----------------------------------------------------------------------------------- |
| `lazygit`   | `human-tui`      | Git TUI - primary mode is full-screen interactive UI                                |
| `gitui`     | `human-tui`      | Git TUI - parallel project to lazygit                                               |
| `tmux`      | `human-tui`      | Terminal multiplexer - bare invocation attaches/starts an interactive session       |
| `fzf`       | `human-tui`      | Interactive fuzzy-match picker over stdin                                           |
| `broot`     | `human-tui`      | Interactive directory-tree browser                                                  |
| `yazi`      | `human-tui`      | Interactive file manager - full-screen browse is the primary mode                   |
| `bottom`    | `human-tui`      | Interactive process/system monitor (htop-class)                                     |
| `bandwhich` | `human-tui`      | Interactive network bandwidth monitor                                               |
| `atuin`     | `human-tui`      | Interactive shell-history search; bare-binary mode and `atuin search` are TUI-first |
| `navi`      | `human-tui`      | Interactive cheatsheet picker                                                       |
| `jnv`       | `human-tui`      | Interactive jq-filter editor over a JSON document                                   |
| `fd`        | `file-traversal` | Emits filenames as its output protocol; reserved for future suppressions in v0.1.3  |

Profiles **not** currently applied to any tool, with the criteria a future entry must meet:

- `posix-utility`: Tool predates structured output and follows POSIX-style stdin/stdout conventions. Modern stream
  processors (`jq`, `yq`, `dasel`, `miller`, etc.) already pass P1 non-interactive audits vacuously, so the suppression
  is unnecessary and `posix-utility` is not applied.
- `diagnostic-only`: Tool can never mutate state by design. Suppresses only P5 dry-run. The current registry's read-only
  candidates (`procs`, `dust`, `tree`) all pass P5 already, so the profile would be a no-op annotation. It will become
  useful when P5 grows audits beyond dry-run that warrant skipping for read-only diagnostics.

The general rule for adding a profile: **apply it only when an unsuppressed audit is fighting the tool's category, not
its design quality**. A TUI legitimately blocks on a TTY; that's a category fact, not a defect. A CLI that *could* be
non-interactive but isn't is a defect; no profile applies.

## Layers: behavioral, project, source

`anc` runs three layers of audits:

- **Behavioral**: invokes the binary and observes what it does — `--help`, `--version`, `--output json`, SIGPIPE,
  NO_COLOR, exit codes. Language-agnostic. This is the only layer that feeds the headline score.
- **Project**: inspects the project tree: `AGENTS.md`, manifest files, recommended dependencies. Language-agnostic.
  Reported on the per-tool page, not scored.
- **Source**: runs ast-grep patterns against source code. Catches `unwrap()`, naked `println!`, missing error types.
  Rust and Python today, more languages as they ship. Reported on the per-tool page, not scored.

Only behavioral results move the headline number. Project- and source-layer results are shown on the per-tool page for
context but stay out of the score: blending them would penalize a tool for how many languages the linter covers, or for
a project-tree convention, rather than for how the shipped binary behaves to an agent. A behavioral-only score keeps
every tool measured on the same ground.

Note that P8 (discoverable skill bundles) spans both layers: its bundle-install and related behavioral audits count
toward the score, while the presence of the bundle file itself is a project-layer audit that does not.

## Re-running the same audits locally

Every score on the leaderboard is reproducible. [Install `anc`](/install), then run:

```bash
anc audit <binary> --output json
```

Pass `--audit-profile <category>` to apply the same suppression set the leaderboard applies. The committed scorecards
under [`scorecards/`](https://github.com/brettdavies/agentnative-site/tree/main/scorecards) record the exact CLI version
each score was generated from, so anyone can pin to the same `anc` build and reproduce a row exactly.

## Re-scoring and challenges

Re-scoring is manual at launch. When a tool ships a release that changes its agent-readiness story:

- File an issue on [`agentnative-site`](https://github.com/brettdavies/agentnative-site/issues/new) titled `re-score:
  <tool>` and link the release notes. The committed scorecard will be regenerated against the new version.
- If a tool's category is misclassified (e.g., a TUI is being scored as a general-purpose CLI), file an issue titled
  `audit-profile: <tool> <category>` with the rationale. Audit-profile changes are registry edits; they ship with the
  next site deploy.
- If a audit itself is wrong (false positives, weak signal, missing edge case), file the issue against the
  [`agentnative` CLI](https://github.com/brettdavies/agentnative-cli/issues), not this site. Site renders; CLI judges.

## Constructive framing

A low score is a snapshot, not a verdict. Each failing audit on a per-tool page links to the principle page that defines
the requirement and the fix guidance. The leaderboard exists to make the standard concrete, not to shame tool authors
who built before the standard existed. Most of the tools listed here predate `anc` by years.

If you maintain one of the tools on the leaderboard and want to improve its score, the per-tool page is your punch list.
The audit IDs (`p1-non-interactive`, `p2-json-output`, etc.) are stable and citeable in commits and PRs.
