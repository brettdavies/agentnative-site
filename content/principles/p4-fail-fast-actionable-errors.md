# P4: Fail Fast with Actionable Errors

## Definition

CLI tools MUST detect invalid state early, exit with a structured error, and tell the caller three things: what failed,
why, and what to do next. An error that says "operation failed" gives an agent nothing to act on.

## Why Agents Need It

Agents operate in a retry loop: attempt, observe, decide. When an error is vague or unstructured — a bare stack trace, a
one-word failure, a mixed-channel splurge — the agent cannot tell whether to retry, re-authenticate, fix configuration,
or escalate to the user. Distinct exit codes — when paired with this standard's published mapping — let the agent act
correctly without parsing message text. The difference between exit code 77 (re-authenticate) and exit code 78 (fix
config) determines whether the agent retries OAuth or asks the user to check their config file. Getting that wrong
wastes entire conversation turns.

Codes 77 and 78 follow BSD `sysexits.h` (`EX_NOPERM`, `EX_CONFIG`); most CLIs today do not distinguish auth from config
errors at the exit-code layer — this standard adopts `sysexits.h` numbering so agents can disambiguate.

## Requirements

**MUST:**

- Parse arguments with `try_parse()` instead of `parse()`. Clap's `parse()` calls `process::exit()` directly, bypassing
  custom error handlers — which means `--output json` cannot emit JSON parse errors. `try_parse()` returns a `Result`
  the tool can format:

  ```rust
  let cli = Cli::try_parse()?;
  ```

- Error types map to distinct exit codes. At minimum:

| Code | Meaning                 |
| ---: | ----------------------- |
|    0 | Success                 |
|    1 | General command error   |
|    2 | Usage / argument error  |
|   77 | Auth / permission error |
|   78 | Configuration error     |

- Every error message contains **what failed**, **why**, and **what to do next**. Example:

  ```text
  Authentication failed: token expired (expires_at: 2026-03-25T00:00:00Z).
  Run `tool auth refresh` or set TOOL_TOKEN.
  ```

**SHOULD:**

- Error types use a structured enum (via `thiserror` in Rust) with variant-to-kind mapping for JSON serialization.
  Agents match on error kinds programmatically rather than parsing message text.
- Locally-verifiable config and auth invariants (file presence, token format, required keys) are checked before any
  network call. Remote validation is the network call's responsibility and SHOULD use distinct exit codes.
- Error output respects `--output json`: JSON-formatted errors go to stderr when JSON output is selected, consistent
  with [P2](/p2)'s stream discipline (stdout for data, stderr for diagnostics).

## Evidence

- `Cli::try_parse()` in `main()`, not `Cli::parse()`.
- Error enum with `#[derive(Error)]` and distinct variants for config, auth, and command errors.
- `exit_code()` method on the error type returning variant-specific codes.
- `kind()` method returning a machine-readable string for JSON serialization.
- `run()` function returning `Result<(), AppError>`, not calling `process::exit()` internally.
- Error messages containing remediation steps ("run X" or "set Y") alongside the cause.

## Anti-Patterns

- `Cli::parse()` anywhere in the codebase — it silently prevents JSON error output.
- `process::exit()` in library code or command handlers. Only `main()` (and signal/panic handlers it installs) may call
  it, after all error handling.
- A single catch-all error variant that maps everything to exit code 1.
- Error messages that state the symptom without the cause or fix ("Error: request failed").
- Panics (`unwrap()`, `expect()`) on recoverable errors in production code paths.

Measured by check ID `p4-bad-args` today, with `p4-process-exit`, `p4-unwrap`, and `p4-exit-codes` planned. Run `anc
check --principle 4 .` against your CLI to see current coverage.
