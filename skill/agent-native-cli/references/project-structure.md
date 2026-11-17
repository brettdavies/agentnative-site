# Project Structure for Agent-Native Rust CLIs

Required project structure beyond the CLI interface. Covers living documentation, error handling architecture, output
formatting, testing patterns, dependency requirements, and documentation files. Each section specifies what to create,
why it matters for agent consumers, and which template to start from.

## AGENTS.md

Create an AGENTS.md file at the repository root. This is the living documentation file that AI agents read to understand
how to work with the project. Agents will execute the commands listed in this file, so accuracy is non-negotiable. A
stale or incorrect AGENTS.md is worse than no AGENTS.md because agents will follow its instructions and fail silently or
destructively.

Use `templates/agents-md-template.md` as the starting point. Fill in every bracketed placeholder with project-specific
values. The required sections are:

**Build and Run.** Exact commands for building, running, and installing the binary. Include both debug and release
builds. Agents use these commands to verify changes compile before committing.

**Test.** Commands for running all tests, a single test, integration tests only, and tests with output visible. Agents
run tests after every code change and need to know the exact invocations.

**Lint and Format.** Commands for formatting and linting. Include the combined command that runs both. Agents run these
before committing to ensure CI will pass.

**Architecture.** Binary name, one-line description, and a module overview table mapping each module to its single
responsibility. Agents use this to navigate the codebase and determine which module to modify for a given task.

**Exit Codes.** Table mapping each exit code to its meaning and the action an agent should take. This is the contract
between the CLI and its agent consumers. Agents use exit codes to decide whether to retry, re-authenticate, or report an
error.

**Quality Bar.** Non-negotiable standards: clippy clean with `-D warnings`, rustfmt formatted, no `unwrap()` in
production code, MSRV, and documentation requirements.

**Conventions.** Project-specific patterns that agents must follow: OutputConfig threading, diag! macro usage, AppError
enum for errors, try_parse() instead of parse(), and the four global agentic flags.

**Common Pitfalls.** Mistakes that agents (and humans) commonly make in this codebase. Each pitfall states the mistake
and its consequence. Agents check this list before submitting changes.

Keep AGENTS.md accurate by updating it whenever the build system, module structure, or conventions change. Treat it as a
first-class project artifact, not an afterthought.

## Error Types Module

Create a centralized error module at `src/error.rs` (for simple tools) or `src/errors/` (for tools with many error
categories). Use `templates/error-types.rs` as the starting point.

The error module contains a single error enum (named `AppError` by convention) with one variant per error category. Each
variant maps to a sysexits-compatible exit code through an `exit_code()` method and to a machine-readable kind string
through a `kind()` method. The canonical mapping is Config to 78, Auth to 77, and Command to 1. Add domain-specific
variants as needed (e.g., RateLimit, NotFound, Timeout) with appropriate exit codes.

Use `thiserror` for the error enum derive. The `#[error("...")]` attribute defines Display, and `#[source]` chains cause
errors. For projects that prefer minimal dependencies, implement `std::fmt::Display` and `std::error::Error` manually
instead. The compliance auditor accepts either approach.

Implement a format-aware `print()` method on the error enum that accepts `&OutputConfig` and writes to stderr. When the
output format is Json or Jsonl, serialize the error as a JSON object with error, kind, message, and exit_code fields.
When the format is Text, print a human-readable message with optional color. See `templates/error-types.rs` for the
complete implementation.

Never scatter `process::exit()` calls throughout library code. Every function returns `Result<T, AppError>`, and only
`main()` converts errors to exit codes. This ensures every error path flows through the format-aware print method and
produces consistent output regardless of where the error originated.

## Output Module

Create an output module at `src/output.rs`. Use `templates/output-format.rs` as the starting point.

The output module contains three items: the `OutputFormat` enum, the `OutputConfig` struct, and the `diag!` macro.

**OutputFormat** is a clap `ValueEnum` with three variants: Text, Json, and Jsonl. It drives the `--output` flag.

**OutputConfig** bundles the output format, color preference, and quiet state into a single struct that is constructed
once in `main()` and threaded as a shared reference through every function that produces output. The constructor detects
TTY status using `std::io::IsTerminal`, respects the `NO_COLOR` environment variable, and checks for `TERM=dumb`. No
function in the codebase should call `println!` or `eprintln!` directly. All output goes through functions that accept
`&OutputConfig` and format accordingly.

**The diag! macro** wraps `eprintln!` with a guard that checks `OutputConfig::suppress_diag()`. When diagnostics are
suppressed (quiet mode or structured output mode), the macro short-circuits before evaluating the format string
arguments, achieving zero allocation. Use `diag!(out, "Processing {} items", count)` for all informational, progress,
and diagnostic messages throughout the codebase.

## Testing Patterns

The behavioral contract (what to assert per principle, the language-to-harness table, and the adaptable OSS test files)
lives in [`testing.md`](./testing.md). This section covers only the Rust-specific hermetic-test architecture, which both
bird and xurl-rs share.

**Wiremock for API mocking.** Use the `wiremock` crate to create mock HTTP servers in tests. Register request matchers
and response templates, then point the tool at the mock server's URL instead of the real API. This makes tests hermetic:
they never hit the network, never consume API quota, and never fail due to upstream outages. Each test creates its own
mock server instance, so tests do not interfere with each other.

**TestEnv pattern for XDG isolation.** Create a `TestEnv` struct in the test helpers that sets up temporary directories
for XDG_CONFIG_HOME, XDG_CACHE_HOME, and XDG_DATA_HOME. Point the tool's configuration at these temp directories so
tests never read or write the developer's real config, cache, or credential files. The TestEnv struct implements Drop to
clean up temp directories automatically. This isolation is critical: without it, tests may succeed locally because a
developer has valid credentials, then fail in CI where no credentials exist.

**Sequential test phases.** Structure each test with four explicit phases: setup (create TestEnv, configure mocks,
prepare input), execute (run the command or function under test), assert (verify output, exit code, side effects), and
cleanup (handled automatically by Drop on TestEnv and MockServer). This structure makes tests scannable and ensures
cleanup happens even when assertions fail.

**Pre-flight auth gate in integration tests.** Integration tests that hit real APIs (as opposed to wiremock) need a
pre-flight check that valid credentials exist. If credentials are missing, skip the test with a clear message rather
than failing with a cryptic auth error. Use a helper function that checks for the credential file or environment
variable and calls the appropriate skip mechanism. This prevents CI from reporting false failures when auth tokens are
not configured.

## Cargo.toml Requirements

The following dependencies support the agent-native patterns described in this skill.

**clap** with the `derive` and `env` features. The `derive` feature enables the `#[derive(Parser)]` macro for
declarative CLI definitions. The `env` feature enables the `env = "VAR_NAME"` attribute on flags, which is required for
P1 (non-interactive by default). Without the `env` feature, agents cannot configure the tool through environment
variables.

**serde** and **serde_json** for structured output. Every response type derives `Serialize`, and `serde_json` serializes
responses when `--output json` is requested. These are non-negotiable for P2 (structured output).

**thiserror** for ergonomic error type construction. The `#[error()]` and `#[source]` attributes reduce boilerplate in
the error enum. Alternatively, implement `std::fmt::Display` and `std::error::Error` manually if minimizing dependencies
is a priority.

**libc** for the SIGPIPE fix. The single `libc::signal(libc::SIGPIPE, libc::SIG_DFL)` call at the top of `main()`
requires the libc crate. This is a build dependency only (no runtime cost beyond the one syscall) and is essential for
P6 (composable structure) to prevent broken pipe panics.

**clap_complete** for shell completion generation. Add it as a regular dependency (not just dev-dependency) because the
completions subcommand is part of the shipped binary. Use `clap_complete::Shell` as a `ValueEnum` for the shell
argument.

**TTY detection** via `std::io::IsTerminal` (stable since Rust 1.70, no external crate needed). For projects targeting
older Rust versions, use the `is-terminal` crate instead. TTY detection gates color output, progress bars, and
interactive formatting, which is required for P6 (composable structure).

**tracing** for structured logging. Optional but recommended for tools with complex runtime behavior. The tracing crate
provides span-based structured logging that integrates with the output format: when `--output json` is set, log output
can be structured as JSON rather than interleaved human text. Add `tracing-subscriber` for the logging backend.

## Documentation

Create three documentation files alongside AGENTS.md.

**README.md** shows both human and agent usage side by side. Include a Quick Start section for humans with installation
and basic usage, and an Agent Integration section showing the four agentic flags, JSON output parsing, exit code
handling, and environment variable configuration. Agents reading the README should be able to start using the tool
without consulting any other file.

**CLI_DESIGN.md** records design decisions for the CLI interface: why specific flag names were chosen, why certain
commands are grouped together, what tradeoffs were made between usability and agent-readiness. This document prevents
future contributors from inadvertently breaking agent contracts by explaining the reasoning behind interface choices.

**DEVELOPER.md** covers contributor setup: required Rust toolchain version, how to run tests, how to add a new
subcommand, how to add a new error variant, and how to update shell completions. Keep it focused on the mechanical steps
a contributor needs to follow. Conceptual guidance belongs in CLI_DESIGN.md, not here.
