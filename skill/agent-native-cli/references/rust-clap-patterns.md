# Rust/clap Patterns for Agent-Native CLIs

How to implement each of the 7 agent-readiness principles using Rust and clap's derive API. Each section covers the clap
attributes, crate features, and architectural patterns that satisfy the principle. All patterns reference the canonical
template files in `templates/` for concrete implementations.

## P1: Non-Interactive by Default

Use clap's derive API with the `env` attribute on every flag so agents can configure the tool entirely through
environment variables without constructing argument strings. Place `env = "TOOL_FLAG_NAME"` on each `#[arg()]`
attribute, using a consistent prefix derived from the binary name (e.g., `BIRD_` for bird, `XURL_` for xurl-rs).

For boolean flags controlled by env vars, use `FalseyValueParser::new()` in the `value_parser` attribute. Without this,
clap treats any non-empty env var value as truthy, meaning `TOOL_QUIET=0`, `TOOL_QUIET=false`, and `TOOL_QUIET=no` all
incorrectly enable quiet mode. FalseyValueParser recognizes "0", "false", "no", "off", and "" as falsey values, matching
shell scripting conventions. See `templates/output-format.rs` for the canonical flag definitions showing
FalseyValueParser on the `--quiet` and `--no-interactive` flags.

Add a `--no-interactive` global flag that gates all interactive prompts. When this flag is set (or when stdin is not a
TTY), skip any dialoguer or inquire prompts and either use default values or return an error explaining what input is
needed. The check is straightforward: if `cli.no_interactive` is true or `!std::io::stdin().is_terminal()`, do not
prompt. This ensures agents never hang waiting for input they cannot provide.

Mark all four agentic flags (`--output`, `--quiet`, `--no-interactive`, `--timeout`) as `global = true` in the
`#[arg()]` attribute. Global flags propagate to all subcommands automatically, so agents do not need to discover which
subcommand accepts which flag. xurl-rs established this four-flag pattern: `--output text|json|jsonl` for format
selection, `--quiet` for suppressing diagnostics, `--no-interactive` for automation paths, and `--timeout` for network
operation bounds.

## P2: Structured, Parseable Output

Define an `OutputFormat` enum deriving `ValueEnum` with three variants: Text, Json, and Jsonl. Text is the default for
human users; Json produces a single JSON object per response; Jsonl produces one JSON object per line for streaming
consumption. Agents set `--output json` and parse the response with standard JSON tooling. See
`templates/output-format.rs` for the enum definition.

Create an `OutputConfig` struct that bundles the output format, color preference, and quiet state. Construct it once in
`main()` from the parsed CLI flags and thread it as a shared reference through every function that produces output. This
is the OutputConfig pattern from bird and xurl-rs: no function ever calls `println!` or `eprintln!` directly. Instead,
functions accept `&OutputConfig` and format their output accordingly. See `templates/output-format.rs` for the struct
definition and constructor.

Use `serde` with the `Serialize` derive on all response types. When the output format is Json or Jsonl, serialize the
response with `serde_json::to_string` or `serde_json::to_string_pretty` and write to stdout. When the format is Text,
format the response for human consumption with aligned columns, colors (when the TTY and NO_COLOR checks permit), and
contextual labels.

Define exit codes in a dedicated module or as methods on the error enum, not as scattered integer literals. Use
sysexits-compatible values: 0 for success, 1 for general command errors, 2 for usage errors (bad arguments), 77 for
authentication errors (EX_NOPERM), and 78 for configuration errors (EX_CONFIG). Agents parse exit codes to decide their
next action: 77 means re-authenticate and retry, 78 means check the config file. See `templates/error-types.rs` for the
exit code mapping method.

Implement a format-aware `print()` method on the error enum. When the output format is Json or Jsonl, serialize the
error as a JSON object to stderr with fields for error kind, message, and exit code. When the format is Text, print a
colored human-readable message to stderr. This ensures agents always receive parseable error output when they request
JSON mode. See `templates/error-types.rs` for the complete print method.

## P3: Progressive Help Discovery

Use the `after_help` attribute on `#[command()]` to place usage examples after the flags section. This is where agents
look. Clap's doc comments on the struct populate the `about` field, which appears at the top of `--help` output before
the flags. The `long_about` attribute expands the description shown with `--help` (vs the short version in `-h`).
Neither about nor long_about satisfies agent discovery needs because agents scan past the flag definitions to find
concrete invocation examples.

Place 3-5 usage examples in `after_help`, showing the most common invocations including the agentic flags. Format
examples as plain text with a label and the command, one per line. Include at least one example with `--output json` and
one with `--quiet` to demonstrate agent-mode usage.

Use the `long_about` attribute for extended description text that explains what the command does, when to use it, and
how it relates to other subcommands. This appears in `--help` but not in the short `-h` output, providing progressive
disclosure within the help system itself.

Env vars appear automatically in `--help` output when the `env` attribute is set on `#[arg()]`. Clap renders them as
`[env: TOOL_FLAG_NAME=]` next to each flag, so agents can discover both the flag name and the env var override without
reading documentation.

For subcommand CLIs, place `after_help` on the top-level struct and on each subcommand that takes its own arguments or
options. Agents invoking `tool subcommand --help` should see examples specific to that subcommand. A subcommand whose
help shows no positional argument and no option beyond `-h`/`--help` and the global flags (`tool version`) is exempt
from `p3-must-subcommand-examples`: its usage line is its whole call shape.

## P4: Fail Fast with Actionable Errors

Use `try_parse()` on the Cli struct instead of `parse()`. This is the critical lesson from the payg project: clap's
`parse()` method calls `process::exit()` directly when argument parsing fails, bypassing any custom error handler. The
agent never sees structured error output because the process terminates before the error formatting code runs. With
`try_parse()`, parse errors return as `Result::Err` values that the code can format according to the output mode. See
`templates/clap-main.rs` for the try_parse pattern with JSON error output on parse failure.

Use `thiserror` for the error enum. The `#[error("...")]` attribute on each variant defines the Display implementation,
and the `#[source]` attribute chains cause errors. This produces ergonomic error construction (variants accept source
errors directly) and a complete error chain for debugging. See `templates/error-types.rs` for the canonical error enum
with thiserror derives.

Implement an `exit_code()` method on the error enum that maps each variant to its sysexits-compatible code. Also
implement a `kind()` method that returns a machine-readable string (e.g., "config", "auth", "command") for JSON error
serialization. Agents use the kind field to categorize errors programmatically without parsing human-readable messages.

Structure error messages with three parts: what failed, why it failed, and what to do about it. The thiserror
`#[error()]` format string handles the first two parts. For the third part (remediation), include the suggestion in the
error variant's data or append it in the print method. For example, an auth error should say "Authentication failed:
token expired. Run `tool auth login` to re-authenticate."

Restrict `process::exit()` calls to `main()` only. Library code returns `Result<(), AppError>`, and `main()` converts
the error to an exit code via the `exit_code()` method. This ensures every error path goes through the format-aware
print method. The `run()` function pattern in `templates/clap-main.rs` demonstrates this: main dispatches meta-commands
directly and delegates everything else to `run()`, which returns `Result`.

## P5: Safe Retries and Explicit Mutation Boundaries

Add a `--dry-run` flag to every subcommand that performs write operations (create, update, delete, post). When dry-run
is set, the command validates inputs and reports what it would do without executing the mutation. Format dry-run output
the same way as real output (respecting `--output json`) so agents can verify the operation before committing. For
read-oriented CLIs that have few or no write operations, `--dry-run` is a SHOULD rather than a MUST.

Add `--force` or `--yes` flags to destructive operations (delete, overwrite, reset). Without these flags, the command
should either prompt for confirmation (when interactive) or refuse to proceed (when `--no-interactive` is set). This
creates an explicit mutation boundary: agents must consciously opt into destructive actions.

Design commands to be idempotent where possible. A "create" command that receives an ID should succeed silently if the
resource already exists with the same state, rather than returning an error. A "delete" command should succeed if the
resource is already absent. Idempotency enables safe retries: agents can re-run failed commands without checking whether
the previous attempt partially succeeded.

Categorize subcommands as read or write operations. Read commands (list, get, search, show) need no safety flags. Write
commands (create, update, delete, post) need `--dry-run` at minimum. Destructive write commands (delete, overwrite)
additionally need a confirmation flag: `--yes` or `--force` are the recommended names, and a flag under another name
meets `p5-must-force-yes` when the command's `--help` documents it as confirming without a prompt. Use this
categorization to set appropriate defaults: read commands are always safe to retry; write commands require explicit
opt-in for mutation.

## P6: Composable and Predictable Structure

### Flags vs Subcommands

Use subcommands for distinct operations (verbs) and flags for behavior modifiers. This is not a style preference — it
determines whether agents can discover and compose operations predictably.

**Subcommands for operations.** Each distinct action the CLI performs is a subcommand with its own arguments: `tool
search "query"`, `tool post --body "text"`, `tool auth login`. Never model operations as flags (`tool --search "query"`
is wrong). Subcommands appear in `--help` output as a discoverable list, while operation-flags are hidden among dozens
of modifiers.

**Nested subcommands for namespaced operations.** Group related operations under a parent subcommand: `tool auth login`,
`tool auth status`, `tool auth clear`. In clap, this means a `Commands` enum with a variant that holds its own
`Subcommand`-derived enum. Limit nesting to two levels — deeper hierarchies are hard for agents to navigate.

**Global flags for cross-cutting modifiers.** The four agentic flags (`--output`, `--quiet`, `--no-interactive`,
`--timeout`) and any other modifier that applies to all operations must have `global = true` in their `#[arg()]`
attribute. Without this, agents must discover per-subcommand which flags are accepted. Global flags propagate
automatically to all subcommands.

**Local flags for command-specific modifiers.** Flags that only make sense for one subcommand stay local: `tool search
--max-results 50`, `tool post --reply-to 123`. Do not make these global — it pollutes every subcommand's `--help` with
irrelevant options.

**Both flag and subcommand for universal meta-commands.** `--help` and `--version` must exist as flags (universal
convention, clap provides both). A `help` or `version` subcommand is optional bonus discoverability. clap gives `help`
subcommand automatically when subcommands are defined.

### SIGPIPE

Set the SIGPIPE handler to SIG_DFL as the first operation in `main()`. Rust installs a custom SIGPIPE handler that
converts broken pipe signals into panics, causing ugly stack traces when an agent pipes output to `head`, `jq`, or other
tools that close the pipe early. The fix is a single unsafe block using `libc::signal(libc::SIGPIPE, libc::SIG_DFL)`
wrapped in `#[cfg(unix)]`. See `templates/clap-main.rs` for the exact placement, which must be before any I/O
operations.

Use `std::io::IsTerminal` (stable since Rust 1.70) to detect whether stdout and stderr are connected to a terminal. Gate
color output, progress bars, and interactive formatting behind the TTY check. Also respect the `NO_COLOR` environment
variable (any value disables color) and `TERM=dumb` (disables color and fancy formatting). The `OutputConfig::new()`
constructor in `templates/output-format.rs` shows all three checks combined into the `use_color` field.

Implement shell completion generation using `clap_complete`. Add a `Completions` subcommand (or a `--completions` flag)
that accepts a `clap_complete::Shell` as a `ValueEnum` and writes the completion script to stdout. Use the three-tier
dependency gating pattern from bird: completion generation is a Tier 1 meta-command that requires no config, no network,
and no authentication. It always works, even in a broken environment. See `templates/clap-main.rs` for the three-tier
dispatch pattern where completions are handled before config loading.

Support piped stdin for commands that accept input. Use `std::io::stdin().is_terminal()` to detect whether input is
being piped, and read from stdin when a file argument is absent or set to `-`. This enables agent workflows like `echo
'{"query": "test"}' | tool search --output json`.

The three-tier main() dependency gating pattern organizes subcommands by their dependency requirements. Tier 1
(meta-commands like completions and version) need nothing and are dispatched first. Tier 2 (local commands like config
show) need configuration loaded but no network. Tier 3 (network commands like fetch and search) need config plus
authentication plus network access. Each tier gates on its dependencies and fails fast with a clear error if they are
missing. This prevents agents from waiting for a network timeout only to discover the config file is absent.

## P7: Bounded, High-Signal Responses

Implement the `diag!` macro pattern from bird to gate diagnostic output behind the `suppress_diag()` check. The macro
wraps `eprintln!` and short-circuits when diagnostics are suppressed (quiet mode or JSON output), achieving zero
allocation because the format string arguments are never evaluated. Use `diag!(out, "Processing {} items", count)`
throughout the codebase instead of bare `eprintln!`. See `templates/output-format.rs` for the macro definition and the
`suppress_diag()` method that controls it.

Add a `--quiet` flag that suppresses all non-essential output. Essential output is the primary data the command was
asked to produce. Non-essential output includes progress indicators, informational messages, and diagnostic details.
Wire `--quiet` through OutputConfig and use the `diag!` macro for all non-essential messages so they are automatically
suppressed. Note that JSON and JSONL output modes also suppress diagnostics: agents parsing structured output must not
encounter interleaved human text on stderr.

Add `--limit` or `--max-results` flags to commands that query paginated endpoints or produce variable-length output. Use
`clamp()` on the pagination value to enforce both a minimum (typically 1) and maximum (the API's hard limit or a
sensible default like 100). For example, `let page_size = cli.limit.clamp(1, 100)`. This prevents agents from
accidentally requesting zero results or exceeding API rate limits with unbounded requests.

Add a `--timeout` flag for commands that make network requests. Default to a sensible value (30 seconds is common) and
expose it via env var (`TOOL_TIMEOUT`). Agents operating under their own time budgets can tighten the timeout to fail
fast rather than blocking on a slow upstream.
