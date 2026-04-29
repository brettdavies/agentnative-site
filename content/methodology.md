# Methodology

How the ANC 100 leaderboard is built, what each score means, and what the leaderboard does *not* claim to measure.

For the field-by-field shape of the underlying JSON, see the [scorecard schema reference](/scorecard-schema).

## What gets scored

Every entry on the [leaderboard](/scorecards) is the output of `anc check <binary>` against a real CLI tool, run on
Brett's machine, committed to the site repo as JSON, and rendered into the per-tool page at `/score/<name>`. The
[registry](https://github.com/brettdavies/agentnative-site/blob/main/registry.yaml) is the single source of truth for
which tools are in the set.

Adding a tool means filing a registry entry. Removing a tool means filing a registry deletion. There is no other
inclusion criterion.

## How a score is computed

The headline number on each tool's row is a pass rate:

```text
score = pass / (pass + warn + fail)
```

`skip` and `error` outcomes are excluded from the denominator. A `skip` means the check was not applicable to this tool
(e.g., a flag-parsing check on a tool with no flags). An `error` means the check itself crashed and produced no signal.
Neither is evidence of a defect, so neither moves the score.

**A note on weighting.** The pass rate weighs MUST violations (`fail`) and SHOULD violations (`warn`) equally in the
headline number. Per RFC 2119 those are categorically different — a `fail` means non-conformance with the standard; a
`warn` means a missed default. The headline is a deliberate simplification chosen so a single number is comparable
across tools; the **principles met** column is where conformance lives. A tool with one `fail` and zero `warn` will
score higher than a tool with zero `fail` and three `warn`, but only the first tool is non-conformant — read both
columns together. The per-tool page is the ground truth.

The **principles met** column counts how many of the seven principles (P1–P7) have *all* their checks passing — no
warnings, no failures. A tool can have a 90% pass rate and still meet only four of seven principles, if the warnings
cluster inside three principle groups. Both numbers are surfaced because either, alone, hides the shape of the result.

Bonus checks — `CodeQuality` and `ProjectStructure` — are listed on each tool's page but not blended into the primary
score. They are language-specific and would create unfair comparisons across tools.

## What the audience signal is, and is not

`anc` v0.1.3+ classifies each scored tool as one of:

- `agent-optimized` — the four signal checks (P1 non-interactive, P2 JSON output, P6 NO_COLOR, P7 quiet) all pass or
  warn at most once. (One warn allowance reflects the reality that the four signal checks are correlated — a
  near-conformant tool typically misses on one edge, e.g., honoring `NO_COLOR` but not `NO_COLOR=0`; requiring zero
  warns would over-penalize otherwise-conformant tools.)
- `mixed` — two of the four signal checks warn.
- `human-primary` — three or more of the four signal checks warn.
- `null` with `audience_reason: "suppressed"` — when the active audit profile suppresses one or more of the four signal
  checks, the classifier has insufficient input and refuses to label. The per-tool page surfaces the reason so a reader
  can see *why* the field is empty rather than guessing.

The classifier is **informational, not authoritative**. It is a one-line summary derived from a fixed set of four
behavioral checks. The per-check evidence on the same page is the ground truth. A tool labeled `human-primary` may still
be safe to use from an agent in narrow, well-bounded ways. A tool labeled `agent-optimized` may still surprise an agent
on a check the classifier does not look at.

When the classifier disagrees with intuition — for example, a tool you consider agent-hostile gets `agent-optimized` —
the fix lives in one of two places:

1. The tool fits an exception category that should suppress some checks → file a registry update adding an
   `audit_profile` (see below).
2. The classifier is missing a signal that ought to count → file an issue against the
   [`agentnative` CLI](https://github.com/brettdavies/agentnative-cli) proposing a new MUST-level check.

Patching the *site* to override a CLI verdict is never the answer. The site renders what the CLI emits.

## Audit profiles: scoping the standard to a tool's category

Some tools intentionally do not satisfy parts of the standard because the standard does not apply to their category.
Lazygit is interactive on purpose — it is a TUI. `find` does not emit JSON because POSIX utilities don't. Holding these
tools to checks that punish their core design produces a misleading score and a hostile leaderboard.

`anc` v0.1.3 exposes four exception categories via `--audit-profile`. The exact suppression set lives in
[`SUPPRESSION_TABLE`](https://github.com/brettdavies/agentnative-cli/blob/main/src/principles/registry.rs) in the CLI
source and is the contract this site renders against:

| Category          | Suppresses                               | Use when...                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human-tui`       | P1 non-interactive variants + P6 SIGPIPE | Tool's primary mode is an interactive terminal UI (e.g., `lazygit`). TUIs intercept the TTY by design and install their own signal handlers.                                                                  |
| `file-traversal`  | (no checks suppressed in v0.1.3)         | Tool emits filenames as its output protocol (`fd`, `find`). Today the applicability filter on subcommand-shape checks already produces the right Skip outcome; the table entry is reserved for future checks. |
| `posix-utility`   | P1 non-interactive variants              | Tool predates structured output and follows POSIX conventions (`grep`, `awk`). The no-prompt MUST is satisfied vacuously by the stdin protocol.                                                               |
| `diagnostic-only` | P5 dry-run                               | Tool is read-only by design (`nvidia-smi`, `lsof`). Read-write-distinction and force-yes are still uncovered in v0.1.3.                                                                                       |

When a tool is scored under an audit profile, the suppressed checks still appear on the per-tool page, tagged **N/A by
category** with a pointer to the profile that excluded them. The reader sees what was excluded and why; the checks are
not silently removed.

Every audit-profile change is a registry change, reviewed in the open. There is no per-tool override that does not show
its work.

### Profiles applied to the current registry

| Tool        | Profile          | Why                                                                                 |
| ----------- | ---------------- | ----------------------------------------------------------------------------------- |
| `lazygit`   | `human-tui`      | Git TUI — primary mode is full-screen interactive UI                                |
| `gitui`     | `human-tui`      | Git TUI — parallel project to lazygit                                               |
| `tmux`      | `human-tui`      | Terminal multiplexer — bare invocation attaches/starts an interactive session       |
| `fzf`       | `human-tui`      | Interactive fuzzy-match picker over stdin                                           |
| `broot`     | `human-tui`      | Interactive directory-tree browser                                                  |
| `yazi`      | `human-tui`      | Interactive file manager — full-screen browse is the primary mode                   |
| `bottom`    | `human-tui`      | Interactive process/system monitor (htop-class)                                     |
| `bandwhich` | `human-tui`      | Interactive network bandwidth monitor                                               |
| `atuin`     | `human-tui`      | Interactive shell-history search; bare-binary mode and `atuin search` are TUI-first |
| `navi`      | `human-tui`      | Interactive cheatsheet picker                                                       |
| `jnv`       | `human-tui`      | Interactive jq-filter editor over a JSON document                                   |
| `fd`        | `file-traversal` | Emits filenames as its output protocol; reserved for future suppressions in v0.1.3  |

Profiles **not** currently applied to any tool, with the criteria a future entry must meet:

- `posix-utility` — Tool predates structured output and follows POSIX-style stdin/stdout conventions. Modern stream
  processors (`jq`, `yq`, `dasel`, `miller`, etc.) already pass P1 non-interactive checks vacuously, so the suppression
  is unnecessary and `posix-utility` is not applied.
- `diagnostic-only` — Tool can never mutate state by design. Suppresses only P5 dry-run. The current registry's
  read-only candidates (`procs`, `dust`, `tree`) all pass P5 already, so the profile would be a no-op annotation. It
  will become useful when P5 grows checks beyond dry-run that warrant skipping for read-only diagnostics.

The general rule for adding a profile: **apply it only when an unsuppressed check is fighting the tool's category, not
its design quality**. A TUI legitimately blocks on a TTY; that's a category fact, not a defect. A CLI that *could* be
non-interactive but isn't is a defect — no profile applies.

## Layers: behavioral, project, source

`anc` runs three layers of checks:

- **Behavioral** — invokes the binary, inspects `--help`, `--version`, `--output json`, SIGPIPE, NO_COLOR, exit codes.
  Language-agnostic. Every tool on the leaderboard is scored at this layer.
- **Project** — inspects the project tree: `AGENTS.md`, manifest files, recommended dependencies. Language-agnostic.
- **Source** — runs ast-grep patterns against source code. Catches `unwrap()`, naked `println!`, missing error types.
  Rust + Python today; more languages as they ship.

The headline score combines behavioral and project. Source-layer results, when available, are reported separately on the
per-tool page. They are not blended into the primary score because doing so would penalize Go, Node, and Java tools for
the absence of language coverage in the linter, not for any property of the tool.

## Re-running the same checks locally

Every score on the leaderboard is reproducible. [Install `anc`](/install), then run:

```bash
anc check <binary> --output json
```

Pass `--audit-profile <category>` to apply the same suppression set the leaderboard applies. The committed scorecards
under [`scorecards/`](https://github.com/brettdavies/agentnative-site/tree/main/scorecards) record the exact CLI version
each score was generated from, so anyone can pin to the same `anc` build and reproduce a row exactly.

## Re-scoring and challenges

Re-scoring is manual at launch. When a tool ships a release that changes its agent-readiness story:

- File an issue on [`agentnative-site`](https://github.com/brettdavies/agentnative-site/issues/new) titled `re-score:
  <tool>` and link the release notes. The committed scorecard will be regenerated against the new version.
- If a tool's category is misclassified — e.g., a TUI is being scored as a general-purpose CLI — file an issue titled
  `audit-profile: <tool> <category>` with the rationale. Audit-profile changes are registry edits; they ship with the
  next site deploy.
- If a check itself is wrong — false positives, weak signal, missing edge case — file the issue against the
  [`agentnative` CLI](https://github.com/brettdavies/agentnative-cli/issues), not this site. Site renders; CLI judges.

## Constructive framing

A low score is a snapshot, not a verdict. Each failing check on a per-tool page links to the principle page that defines
the requirement and the fix guidance. The leaderboard exists to make the standard concrete, not to shame tool authors
who built before the standard existed. Most of the tools listed here predate `anc` by years.

If you maintain one of the tools on the leaderboard and want to improve its score, the per-tool page is your punch list.
The check IDs (`p1-non-interactive`, `p2-json-output`, etc.) are stable and citeable in commits and PRs.
