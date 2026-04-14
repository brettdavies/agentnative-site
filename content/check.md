# Check your CLI

`agentnative` is the reference linter for this standard. It scores any CLI tool against the seven principles and tells
you, by check ID, where it passes and where it falls short.

## Install

```bash
cargo install agentnative
```

Or with [cargo-binstall](https://github.com/cargo-bins/cargo-binstall) for a prebuilt binary:

```bash
cargo binstall agentnative
```

## Run it

```bash
# Against the current project (cargo workspace, binary, or source tree)
agentnative check .

# Against a compiled binary directly
agentnative check ./target/release/mycli

# Agent-friendly output
agentnative check . --output json

# Narrow to one principle
agentnative check . --principle 3
```

## Read the output

```text
P1 — Non-Interactive by Default
  [PASS] Non-interactive by default (p1-non-interactive)
  [PASS] No interactive prompt dependencies (p1-non-interactive-source)

P3 — Progressive Help
  [PASS] Help flag produces useful output (p3-help)
  [WARN] after_help section missing on subcommand (p3-after-help)

P4 — Fail Fast with Actionable Errors
  [FAIL] `process::exit` found outside main (p4-process-exit)
  [PASS] Rejects invalid arguments (p4-bad-args)

30 checks: 20 pass, 8 warn, 1 fail, 1 skip, 0 error
```

Each line ends with a stable check ID (`p4-process-exit`, `p1-non-interactive`, etc.). Cite those IDs in issues,
commits, and agent output; they do not change between versions.

## Three check layers

- **Behavioral** — runs your compiled binary and inspects `--help`, `--version`, `--output json`, SIGPIPE, NO_COLOR, and
  exit codes. Language-agnostic.
- **Source** — ast-grep pattern matching on source code. Catches `.unwrap()`, missing error types, naked `println!`.
  Rust today; more languages as they land.
- **Project** — file and manifest inspection. Looks for `AGENTS.md`, recommended dependencies, dedicated error and
  output modules.

Pass `--binary` to skip source analysis, `--source` to skip behavioral. Most projects want the default, which is "run
  everything."

## What a score means

A `[PASS]` is a requirement met, not a compliment. A `[WARN]` is a SHOULD the tool doesn't satisfy; ignoring it is a
  choice, not a bug. A `[FAIL]` is a MUST the tool doesn't satisfy; agents will hit the edge it describes and the tool
  will surprise them. Nothing here is a vanity metric — the checks map one-to-one to the requirements on the
  [principles page](/).

Source: [github.com/brettdavies/agentnative](https://github.com/brettdavies/agentnative).
