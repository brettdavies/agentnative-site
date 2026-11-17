# Framework Idioms: Rust / clap

Rust with clap (derive macros) is the primary target framework for agent-native CLI tools. This reference covers what
clap gives you for free, what you must implement yourself, and anti-patterns to avoid — organized by each of the 7
agent-readiness principles.

For non-Rust frameworks, see the summary table at the end of this file and the companion reference
`framework-idioms-other-languages.md`.

## P1: Non-Interactive by Default

**Free from clap.** The `env` attribute on derive args auto-reads environment variables, removing the need for
interactive prompts to collect configuration. The `default_value_t` attribute provides sensible defaults so args can be
omitted entirely in automation. Required args without defaults produce a clear error message rather than a prompt.

**Must implement.** Define a `--no-interactive` global flag that gates all interactive behavior. Guard every call to
dialoguer, inquire, or any prompt library behind this flag — when `--no-interactive` is set (or stdin is not a TTY),
skip the prompt and either use the default or error with a message explaining which flag to pass instead. Use
`FalseyValueParser::new()` for boolean environment variables so that `TOOL_QUIET=0` and `TOOL_QUIET=false` correctly
disable the flag rather than being interpreted as truthy strings.

**Anti-patterns.** Using dialoguer or inquire prompts without a `--no-interactive` escape hatch — agents hang
indefinitely on prompts. Parsing boolean environment variables as plain strings where any non-empty value (including
`"0"` and `"false"`) is treated as true. Relying on `prompt=true` semantics from other frameworks without an explicit
bypass flag.

## P2: Structured, Parseable Output

**Free from clap.** The `ValueEnum` derive macro makes it trivial to define an `--output text|json|jsonl` flag with
compile-time validation of allowed values. Setting `global = true` on the output flag propagates it to all subcommands
without repeating the definition.

**Must implement.** Create an `OutputConfig` struct that threads output preferences (format, quiet, color choice)
through the call stack — see `templates/output-format.rs` for the canonical pattern. Use `serde_json` for all JSON
serialization. Enforce stderr/stdout separation: data goes to stdout, diagnostics go to stderr. Implement format-aware
error printing so that errors are emitted as JSON objects when `--output json` is active, not as plain text that breaks
a JSON stream. Define distinct exit codes for distinct failure types — see `templates/error-types.rs` for the sysexits
mapping pattern.

**Anti-patterns.** Naked `println!` calls scattered through handler code — every output call should go through the
OutputConfig. Mixing data and diagnostics on stdout, which makes it impossible for agents to parse command output
reliably. Emitting ANSI color codes unconditionally without checking TTY status or the `NO_COLOR` environment variable.

## P3: Progressive Help Discovery

**Free from clap.** Doc comments on structs and enum variants automatically populate the `about` field in help text. The
`--help` flag is generated on every command and subcommand. Subcommand listing is automatic.

**Must implement.** Use `after_help` (not `about` or `long_about`) to add usage examples — `after_help` content appears
after the flags section, which is where agents look for invocation patterns. Use `long_about` for an extended
description that appears with `--help` but not in subcommand listings. Make environment variables visible by using the
`env` attribute on args so they appear in help text automatically. Ensure the `after_help` of each subcommand that takes
its own arguments or options includes at least one concrete invocation example showing required flags and typical
values.

**Anti-patterns.** Relying only on doc comments, which populate `about` but not `after_help` — this produces help text
with no examples. Adding examples to `long_about` instead of `after_help`, which places them before the flags section
rather than after. Help text exceeding roughly 80 lines per subcommand, which floods agent context windows.

## P4: Fail Fast with Actionable Errors

**Free from clap.** Colored error messages with the problematic value highlighted. Automatic usage hints when an
argument is missing or invalid. Compile-time validation of required args via the derive macro.

**Must implement.** Use `try_parse()` instead of `parse()` on the Args struct — `parse()` calls `process::exit()`
directly, bypassing custom error handlers and preventing format-aware error output. Define a custom error enum using
`thiserror` with variants for each failure category (Config, Auth, Network, Command) — see `templates/error-types.rs`
for the pattern. Map each error variant to a specific exit code using sysexits conventions (Config to 78, Auth to 77, IO
to 74). Implement format-aware error printing: when `--output json` is active, serialize errors as JSON objects with
`error`, `code`, and `suggestion` fields rather than emitting plain text.

**Anti-patterns.** Using `parse()` instead of `try_parse()`, which calls `process::exit()` before you can format the
error or run cleanup. Using `.unwrap()` or `.expect()` in production code paths, which produces panic backtraces that
are useless to agents. Emitting generic "something went wrong" messages without specifying what failed, what value was
invalid, or what the correct invocation looks like.

## P5: Safe Retries and Explicit Mutation Boundaries

**Free from clap.** Nothing directly — clap provides no built-in support for dry-run, idempotency, or confirmation
gates.

**Must implement.** Add a `--dry-run` flag to every subcommand that performs write operations. Wire it into the handler
so it executes all validation and preparation steps but stops before the actual mutation, printing what it would do. Add
a confirmation flag for destructive operations (delete, overwrite) to bypass confirmation prompts in automation; `--yes`
and `--force` are the recommended names. Implement "already exists" detection for create operations — return success
with a note rather than failing on duplicate creates.

**Anti-patterns.** Write commands that execute mutations without any confirmation or preview mechanism. A `--dry-run`
flag that is defined but not wired up (prints nothing, or still executes the mutation). Destructive operations that
succeed silently without reporting what was changed.

## P6: Composable and Predictable Command Structure

**Free from clap.** Subcommand hierarchy via enums with the `Subcommand` derive macro. The `clap_complete` crate
generates shell completions for bash, zsh, fish, and PowerShell. The `ColorChoice` enum provides a standard `--color
auto|always|never` flag.

**Must implement.** Apply the SIGPIPE fix at the top of `main()` using `libc::signal(libc::SIGPIPE, libc::SIG_DFL)` —
without this fix, piping output to `head` or `grep` causes a panic on broken pipe. Implement TTY detection using
`std::io::IsTerminal` (Rust 1.70+) or the `is-terminal` crate to suppress colors, spinners, and interactive elements
when output is piped. Respect the `NO_COLOR` environment variable by disabling color output when it is set. Structure
`main()` with three-tier dependency gating: tier 1 runs commands needing no external resources (completions, help), tier
2 runs commands needing config only, tier 3 runs commands needing network/auth — see `templates/clap-main.rs`. Support
stdin reading where appropriate using `std::io::stdin()` with `IsTerminal` to detect piped input.

**Anti-patterns.** Missing the SIGPIPE fix, which causes panics when piping to `head`, `tail`, or `grep`. Hardcoded ANSI
color codes that ignore `NO_COLOR` and `--color never`. Requiring all subcommands to authenticate even when the
requested command (like `completions` or `help`) needs no credentials.

## P7: Bounded, High-Signal Responses

**Free from clap.** Nothing directly — clap provides no built-in pagination, limiting, or output clamping.

**Must implement.** Define a `diag!` macro that gates `eprintln!` behind a quiet boolean, achieving zero allocation when
diagnostics are suppressed — see `templates/clap-main.rs` for the pattern. Add a `--quiet` flag that suppresses all
diagnostic output. Add `--limit` or `--max-results` flags to any command that returns lists, with a sensible default
(50-100 items). Add a `--timeout` flag for commands that make network requests, with a default that prevents indefinite
hangs. Implement output clamping: when a response exceeds the limit, truncate and emit a diagnostic message to stderr
indicating how many results were omitted and how to retrieve more.

**Anti-patterns.** Unbounded API responses dumped directly to stdout — a single `list` command returning thousands of
rows consumes an agent's entire context window. Verbose diagnostic output that cannot be suppressed in non-interactive
mode. Progress bars or spinners emitted to stdout (rather than stderr) that corrupt structured output.

## Other Frameworks

For non-Rust frameworks, consult `framework-idioms-other-languages.md` which covers each framework's free features,
required implementations, and anti-patterns across all 7 principles.

| Framework | Language | Idioms File |
| --------- | -------- | ----------- |
| Click | Python | `framework-idioms-other-languages.md` |
| argparse | Python | `framework-idioms-other-languages.md` |
| Cobra | Go | `framework-idioms-other-languages.md` |
| Commander | Node.js | `framework-idioms-other-languages.md` |
| yargs | Node.js | `framework-idioms-other-languages.md` |
| oclif | Node.js | `framework-idioms-other-languages.md` |
| Thor | Ruby | `framework-idioms-other-languages.md` |
