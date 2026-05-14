# Check your CLI

`anc` (also installable as `agentnative` — they're aliases for the same binary) is the reference linter for this
standard. It scores any CLI tool against the eight principles and tells you, by check ID, where it passes and where it
falls short.

## Install

See [/install](/install) for `brew`, `cargo`, and platform-archive instructions. Once `anc` is on `$PATH`, the rest of
this page is what to do with it.

## Run it

```bash
# Against the current project (cargo workspace, binary, or source tree)
anc check .

# Against a compiled binary directly
anc check ./target/release/mycli

# Agent-friendly output
anc check . --output json

# Narrow to one principle
anc check . --principle 3
```

## Read the output

```text
P1 — Non-Interactive by Default
  [PASS] Non-interactive by default (p1-non-interactive)
  [PASS] Has --no-interactive flag (p1-flag-existence)

P3 — Progressive Help
  [PASS] Help flag produces useful output (p3-help)
  [PASS] Version flag produces version output (p3-version)

P4 — Fail Fast with Actionable Errors
  [PASS] Rejects invalid arguments (p4-bad-args)

P6 — Composable Command Structure
  [PASS] Handles SIGPIPE cleanly (p6-sigpipe)
  [PASS] Respects NO_COLOR (p6-no-color-behavioral)

P7 — Bounded, High-Signal Responses
  [PASS] Has --quiet flag (p7-quiet)
```

Each line ends with a stable check ID (`p1-non-interactive`, `p2-json-output`, `p6-sigpipe`, etc.). Cite those IDs in
issues, commits, and agent output; they do not change between versions.

## Three check layers

- **Behavioral** — runs your compiled binary and inspects `--help`, `--version`, `--output json`, SIGPIPE, NO_COLOR, and
  exit codes. Language-agnostic.
- **Source** — ast-grep pattern matching on source code. Catches `.unwrap()`, missing error types, naked `println!`.
  Rust and Python today; more languages as they land.
- **Project** — file and manifest inspection. Looks for `AGENTS.md`, recommended dependencies, dedicated error and
  output modules.

Pass `--binary` for behavioral-only (skip source). Pass `--source` for source-only (skip behavioral). Most projects want
the default, which is "run everything."

## What a score means

A `[PASS]` is a requirement met, not a compliment. A `[WARN]` is a SHOULD the tool doesn't satisfy; ignoring it is a
choice, not a bug. A `[FAIL]` is a MUST the tool doesn't satisfy; agents will hit the edge it describes and the tool
will surprise them. Nothing here is a vanity metric — the checks map one-to-one to the requirements on the
[principles page](/).

## See how widely-used CLIs score

The [**ANC 100 leaderboard**](/scorecards) is what running `anc check` produces at scale: every popular CLI tool, scored
against the same eight principles, with full per-check evidence under `/score/<name>`. The scoring rules are documented
on the [methodology page](/methodology); the underlying JSON schema is enumerated at
[/scorecard-schema](/scorecard-schema).

Source: [github.com/brettdavies/agentnative-cli](https://github.com/brettdavies/agentnative-cli).
