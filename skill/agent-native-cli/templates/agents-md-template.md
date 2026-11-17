# AGENTS.md

<!-- Template for a CLI tool's AGENTS.md. This file tells AI agents how to work
     with this project — build commands, test commands, conventions, architecture,
     and common pitfalls. Replace all bracketed placeholders. -->

## Build & Run

- Build: `cargo build`
- Run: `cargo run -- [args]`
- Release build: `cargo build --release`
- Install locally: `cargo install --path .`

## Test

- All tests: `cargo test`
- Single test: `cargo test test_name`
- Integration tests only: `cargo test --test '*'`
- With output: `cargo test -- --nocapture`

## Lint & Format

- Format: `cargo fmt`
- Lint: `cargo clippy -- -D warnings`
- Both: `cargo fmt && cargo clippy -- -D warnings`

## Architecture

[Binary name]: [one-line description of what it does]

### Module Overview

| Module | Responsibility |
| ------ | ------------- |
| `src/main.rs` | Entry point: SIGPIPE fix, try_parse, dependency-gated command dispatch |
| `src/cli/` | CLI argument definitions (clap derive), subcommand routing |
| `src/error.rs` | Error enum with exit code mapping (Config=78, Auth=77, Command=1) |
| `src/output.rs` | OutputConfig, OutputFormat, diag! macro, TTY/color detection |
| [add modules] | [their responsibilities] |

### Exit Codes

| Code | Meaning | Agent Action |
| ---- | ------- | ----------- |
| 0 | Success | Continue |
| 1 | Command error | Log error, do not retry blindly |
| 2 | Usage error (bad args) | Fix arguments |
| 77 | Auth error | Re-authenticate, then retry |
| 78 | Config error | Check config file, report to user |

## Quality Bar

- Clippy clean (`-D warnings`)
- rustfmt formatted
- No `unwrap()` in production code (ok in tests)
- MSRV: [version]
- All public types documented

## Conventions

- Output goes through `OutputConfig` — never naked `println!` or `eprintln!`
- Diagnostics use `diag!` macro — suppressed in quiet/JSON mode
- Errors use `AppError` enum — never `process::exit()` except in main
- `try_parse()` not `parse()` — custom error handling for JSON output
- Global flags: `--output text|json|jsonl`, `--quiet`, `--no-interactive`, `--timeout`

## Common Pitfalls

- Using `parse()` instead of `try_parse()` bypasses JSON error output
- Calling `process::exit()` skips destructors and error formatting
- Forgetting SIGPIPE fix causes panics when piping to `head`
- Using `println!` directly breaks --quiet and --output json
- Boolean env vars need `FalseyValueParser` or `TOOL_QUIET=0` enables quiet

## Known Debt

[List any known issues, oversized modules, or planned improvements]

## References

- [Link to relevant documentation]
- [Link to solutions-docs entries]
