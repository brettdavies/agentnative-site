# Framework Idioms: Other Languages

Supporting reference for non-Rust CLI frameworks. Each section covers what the framework gives for free, what must be
implemented manually, and anti-patterns to avoid — organized by the 7 agent-readiness principles. For Rust/clap idioms,
see the primary reference `framework-idioms.md`.

---

## Click (Python)

### What Click gives for free

**P1 Non-interactive.** Options with `required=True` produce a clear error on missing values. Type validation on
parameters catches bad input before the handler runs.

**P3 Progressive help.** Layered `--help` on every command and group. Automatic parameter documentation from type
annotations. Group-level help lists all subcommands with descriptions.

**P4 Actionable errors.** Error messages include the problematic value and a usage hint. Missing required options
produce a message naming the missing flag.

**P6 Composable structure.** Consistent subcommand structure via `@group.command()`. The `click.Group` class provides a
predictable command hierarchy.

### What must be implemented

**P1 Non-interactive.** Add a `--no-input` flag and check it before any `click.confirm()` or `click.prompt()` call.
Replace `prompt=True` on options with `required=True` — `prompt=True` blocks agents by waiting for interactive input,
while `required=True` errors immediately with a clear message.

**P2 Structured output.** Add a `--json` or `--output` flag manually. Branch on it in each handler to emit
`json.dumps()` output instead of formatted text. Use `click.echo(..., err=True)` for all diagnostic messages to maintain
stdout/stderr separation. Implement distinct exit codes using `ctx.exit(code)` — Click defaults to `sys.exit(1)` for all
errors without differentiating failure types.

**P3 Progressive help.** Add examples to help text using the `epilog` parameter on `@click.command()`. Click does not
auto-generate examples from usage patterns.

**P5 Safe retries.** Add `--dry-run` and `--force`/`--yes` flags manually. Wire `--dry-run` into handlers to preview
mutations without executing them.

**P6 Composable structure.** Implement TTY detection using `sys.stdout.isatty()` or
`click.get_text_stream('stdout').isatty()`. Support stdin reading via `click.get_text_stream('stdin')` or
`type=click.File('-')`. Handle SIGPIPE by wrapping the entry point in a try/except for `BrokenPipeError` or by setting
`signal.signal(signal.SIGPIPE, signal.SIG_DFL)`.

**P7 Bounded responses.** Add `--limit`, `--quiet`, and `--timeout` flags manually. Implement output clamping for list
commands.

### Anti-patterns

Using `prompt=True` on options without a `--no-input` guard — agents hang on the prompt. Calling `click.confirm()`
without checking `--yes` or `--force` first. Using `click.echo()` for both data and messages, which mixes data and
diagnostics on stdout — use `click.echo(..., err=True)` for diagnostics. Catching exceptions with bare `except` blocks
that swallow errors silently.

---

## argparse (Python)

### What argparse gives for free

**P1 Non-interactive.** Required arguments produce an error message on missing values rather than prompting.

**P3 Progressive help.** Layered help via subparsers. Automatic `--help` flag on all parsers and subparsers.

**P4 Actionable errors.** Usage message and error hint on missing required args or invalid values.

### What must be implemented

**P1 Non-interactive.** Avoid using `input()` as a fallback for missing arguments — make arguments required instead.
There is no built-in environment variable support; implement it manually by reading `os.environ` and passing values as
defaults.

**P2 Structured output.** Implement entirely from scratch. Add an `--output` or `--json` argument, branch on it in
handlers, and use `json.dumps()` for serialization. Implement stdout/stderr separation manually — argparse provides no
output routing. Define and enforce distinct exit codes with `sys.exit(code)`.

**P3 Progressive help.** Add examples using the `epilog` parameter combined with `RawDescriptionHelpFormatter` — the
default formatter reformats epilog text and destroys example formatting. Use `description` for extended command
descriptions.

**P5 Safe retries.** Add `--dry-run`, `--force`, and `--yes` arguments manually. Wire them into every write handler.

**P6 Composable structure.** Implement TTY detection using `sys.stdout.isatty()`. Support stdin reading via
`type=argparse.FileType('r')` with `default='-'` or use `nargs='?'`. Handle SIGPIPE explicitly. There is no built-in
shell completion — use `argcomplete` as a third-party add-on.

**P7 Bounded responses.** Add `--limit`, `--quiet`, and `--timeout` arguments manually. Implement all pagination and
output clamping logic from scratch.

### Anti-patterns

Using `input()` to collect missing values instead of making arguments required — agents cannot respond to interactive
prompts. Using the default `HelpFormatter`, which truncates epilog text and destroys example formatting — always use
`RawDescriptionHelpFormatter`. Catching `SystemExit` to suppress argparse errors, which hides actionable messages from
agents. Using `print()` for both data and diagnostics without any stdout/stderr separation.

---

## Cobra (Go)

### What Cobra gives for free

**P1 Non-interactive.** Required flags via `MarkFlagRequired()` produce errors on missing values. `cobra.ExactArgs()`
validates positional argument counts.

**P3 Progressive help.** Layered help with `--help` on every command. The `Example` field on command structs displays
usage examples in help output — but only when populated.

**P4 Actionable errors.** Error on unknown flags with a suggestion for the closest match. Usage hint printed alongside
errors from `RunE` functions.

**P6 Composable structure.** Consistent subcommand hierarchy via `AddCommand()`. Built-in shell completion generation
for bash, zsh, fish, and PowerShell via `cobra.Command` completion methods.

### What must be implemented

**P1 Non-interactive.** Add a `--no-interactive` flag and gate any `bufio.NewReader(os.Stdin)` prompts behind it.
Environment variable support must be implemented via `cobra.OnInitialize` with `viper.AutomaticEnv()` or manual
`os.Getenv()` calls.

**P2 Structured output.** Add a persistent `--output` flag on the root command with `json`, `table`, and `yaml` values.
Use `cmd.OutOrStdout()` for data and `cmd.ErrOrStderr()` for diagnostics — these respect any output redirection set on
the command. Use `encoding/json` for JSON serialization. Implement distinct exit codes in the root command's
`PersistentPostRunE` or by returning typed errors from `RunE` and mapping them in `main()`.

**P3 Progressive help.** Populate the `Example` field on every command that takes its own arguments or flags with
concrete invocation patterns. Cobra does not auto-generate examples — an empty `Example` field means no examples appear
in help.

**P5 Safe retries.** Add `--dry-run` and `--force`/`--yes` flags manually. Wire them into `RunE` handlers.

**P6 Composable structure.** Implement TTY detection using `golang.org/x/term` or `mattn/go-isatty`. Support stdin
reading via `cmd.InOrStdin()`. Respect `NO_COLOR` by checking `os.Getenv("NO_COLOR")` before emitting ANSI codes.

**P7 Bounded responses.** Add `--limit`, `--quiet`, and `--timeout` flags manually. Implement pagination with cursor or
offset patterns. Use `context.WithTimeout()` for network request timeouts.

### Anti-patterns

Leaving the `Example` field empty on commands — agents rely on examples to discover invocation patterns. Using
`fmt.Println` for both data and errors — use `cmd.OutOrStdout()` and `cmd.ErrOrStderr()`. Returning `nil` from `RunE` on
failure instead of an error — this reports success (exit 0) when the command actually failed. Using `os.Exit()` inside
`RunE` handlers, which bypasses deferred cleanup functions and prevents the root command from mapping errors to exit
codes.

---

## Commander (Node.js)

### What Commander gives for free

**P1 Non-interactive.** Required options via `.requiredOption()` produce errors on missing values. Argument validation
on positional arguments.

**P3 Progressive help.** Layered `--help` on all commands. Automatic description from `.description()`. Option
descriptions in help output.

**P4 Actionable errors.** Error message and usage hint on missing required options or unknown flags.

**P6 Composable structure.** Consistent subcommand structure via `.command()` and `.addCommand()`.

### What must be implemented

**P1 Non-interactive.** Add a `--no-interactive` flag and check it before any `inquirer` or `prompts` library calls.
Environment variable support must be implemented manually using `process.env` — Commander has no built-in env var
binding for options.

**P2 Structured output.** Add a `--json` or `--output` option manually. Branch on it in action handlers to emit
`JSON.stringify()` output. Use `process.stdout.write()` for data and `process.stderr.write()` for diagnostics. Implement
distinct exit codes using `process.exitCode = code` or `process.exit(code)`.

**P3 Progressive help.** Add examples using `.addHelpText('after', text)` for content that appears after the options
list. Commander does not auto-generate examples.

**P5 Safe retries.** Add `--dry-run` and `--force`/`--yes` options manually. Wire them into action handlers.

**P6 Composable structure.** Implement TTY detection using `process.stdout.isTTY`. Support stdin reading via
`process.stdin` with stream handling. Generate shell completions using `tabtab` or a custom completions subcommand.
Handle SIGPIPE by listening for the `error` event on stdout with code `EPIPE` and exiting cleanly. Respect `NO_COLOR` by
checking `process.env.NO_COLOR`.

**P7 Bounded responses.** Add `--limit`, `--quiet`, and `--timeout` options manually. Implement pagination and output
clamping in handlers.

### Anti-patterns

Using `inquirer` or `prompts` without checking `process.stdin.isTTY` first — agents have no TTY and the prompt hangs.
Using `console.log` for both data and messages, which mixes them on stdout. Calling `process.exit(0)` inside `.action()`
handlers on error, which reports success when the command failed. Swallowing errors in `.action()` with empty catch
blocks.

---

## yargs (Node.js)

### What yargs gives for free

**P1 Non-interactive.** `.demandOption()` for required flags produces clear error messages. `.env()` method auto-reads
environment variables with a configurable prefix — one of the few Node.js frameworks with built-in env var support.

**P3 Progressive help.** `.example()` method adds usage examples directly to help output. `.epilogue()` for additional
help text. Layered help with `--help` on all commands.

**P4 Actionable errors.** `.fail()` method provides a hook for custom error formatting. Error messages include the
problematic flag and valid choices for enum-type options.

**P6 Composable structure.** `.completion()` generates shell completion scripts. Consistent subcommand structure via
`.command()`.

### What must be implemented

**P1 Non-interactive.** Add a `--no-interactive` flag and gate any `inquirer` or `prompts` calls behind it. While yargs
provides `.env()` for env var reading, boolean env vars still need careful handling to avoid truthy-string problems.

**P2 Structured output.** Add a `--json` or `--output` option and branch on it in handlers. Use
`process.stdout.write(JSON.stringify(...))` for data and `process.stderr.write()` for diagnostics. Implement distinct
exit codes using `process.exitCode`.

**P3 Progressive help.** While `.example()` exists, ensure every subcommand that takes its own arguments or options has
at least one example — yargs does not enforce this. Add examples showing required flags, typical values, and piping
patterns.

**P5 Safe retries.** Add `--dry-run` and `--force`/`--yes` options manually. Wire them into command handlers.

**P6 Composable structure.** Implement TTY detection using `process.stdout.isTTY`. Support stdin reading via
`process.stdin`. Handle SIGPIPE by catching `EPIPE` errors on stdout. Respect `NO_COLOR` by checking
`process.env.NO_COLOR`.

**P7 Bounded responses.** Add `--limit`, `--quiet`, and `--timeout` options manually. Implement output clamping and
pagination logic.

### Anti-patterns

Using `inquirer` without a TTY check — identical to the Commander anti-pattern but compounded because yargs' `.env()`
can lead developers to assume all input paths are non-interactive when prompts still exist in the code. Ignoring the
`.fail()` hook and letting yargs print raw error objects. Using `console.log` for both data and diagnostics. Defining
`.example()` only on the root command but not on subcommands.

---

## oclif (Node.js)

### What oclif gives for free

**P1 Non-interactive.** Required flags via `required: true` in flag definitions produce errors on missing values.

**P2 Structured output.** The `--json` flag is available when a command sets `static enableJsonFlag = true` — oclif
handles JSON serialization of the return value automatically. Error objects are serialized as JSON when the flag is
active.

**P3 Progressive help.** Layered help with `--help` on all commands. The `static examples` array on command classes
populates help text with usage examples. The `static description` property provides the command summary.

**P4 Actionable errors.** The `CLIError` class provides structured error handling with exit codes. The `Errors` module
includes `warn()` and `error()` methods with consistent formatting. Errors are automatically formatted as JSON when
`--json` is active.

**P6 Composable structure.** Hook system for lifecycle events. Plugin architecture for extending CLI functionality.
Consistent command structure via the class-based command pattern.

### What must be implemented

**P1 Non-interactive.** Add a `--no-interactive` flag for commands that use `inquirer` (which oclif bundles). Gate
interactive prompts behind this flag and TTY detection.

**P2 Structured output.** Opt in to `--json` per command by setting `static enableJsonFlag = true` — it is not enabled
globally by default. Ensure the command's `run()` method returns the data object that should be serialized. Implement
stdout/stderr separation for commands that do not use the JSON flag.

**P3 Progressive help.** Populate `static examples` on every command class that takes its own arguments or flags with
concrete invocation patterns including flags and typical values. oclif does not auto-generate examples — an empty
`examples` array means no examples in help.

**P5 Safe retries.** Add `--dry-run` and `--force`/`--yes` flags manually in the flag definitions. Wire them into the
`run()` method.

**P6 Composable structure.** Handle SIGPIPE — Node.js does not handle it natively, and oclif does not add handling.
Catch `EPIPE` errors on stdout and exit cleanly. Implement TTY detection using `process.stdout.isTTY` for cases beyond
the built-in JSON flag behavior. Generate shell completions using the `@oclif/plugin-autocomplete` plugin. Respect
`NO_COLOR` by checking the environment variable before emitting ANSI codes.

**P7 Bounded responses.** Add `--limit`, `--quiet`, and `--timeout` flags manually. Implement pagination and output
clamping — oclif provides no built-in pagination support.

### Anti-patterns

Forgetting to set `static enableJsonFlag = true` on data-returning commands — the `--json` flag only works when
explicitly opted in. Leaving the `static examples` array empty, which produces help text with no usage examples. Using
`this.log()` for both data and diagnostics — use `this.log()` for data and `this.warn()` or `process.stderr.write()` for
diagnostics. Throwing raw `Error` objects instead of `CLIError` with a proper exit code, which produces unhelpful stack
traces instead of actionable messages.

---

## Thor (Ruby)

### What Thor gives for free

**P1 Non-interactive.** `method_option` for named flags with `required: true` produces errors on missing values.

**P3 Progressive help.** Layered help with `help` subcommand on all command classes. `desc` method provides per-method
descriptions. Automatic subcommand listing.

**P4 Actionable errors.** Error on unknown flags with the closest match suggestion. Ruby's exception model provides
natural error propagation — `raise` in any method bubbles up with a stack trace that can be caught and reformatted.

**P6 Composable structure.** Subcommand hierarchy via `register` and subclass patterns. Consistent command structure
from the method-based definition model.

### What must be implemented

**P1 Non-interactive.** Add a `--no-interactive` class option and gate any `ask()`, `yes?()`, or `TTY::Prompt` calls
behind it. Environment variable support must be implemented manually using `ENV['VAR_NAME']` in default value blocks or
via a configuration layer.

**P2 Structured output.** Add a `--json` or `--output` class option and branch on it in methods. Use `$stdout.puts` with
`JSON.generate()` for data output and `$stderr.puts` for diagnostics. Implement distinct exit codes using `exit` or
`abort` — Thor defaults to exit 1 for all errors.

**P3 Progressive help.** Add examples using `long_desc` on methods — Thor's `desc` is limited to a single line. There is
no built-in mechanism for examples in help text; embed them in `long_desc` with formatting.

**P5 Safe retries.** Add `--dry-run` and `--force`/`--yes` class options manually. Wire them into methods that perform
mutations.

**P6 Composable structure.** Implement TTY detection using `$stdout.tty?`. Support stdin reading via `$stdin.read` or
`ARGF`. Generate shell completions manually or with a completions subcommand — Thor has no built-in completion
generation. Handle SIGPIPE by trapping the signal with `Signal.trap('PIPE', 'EXIT')` or rescuing `Errno::EPIPE`. Respect
`NO_COLOR` by checking `ENV['NO_COLOR']`.

**P7 Bounded responses.** Add `--limit`, `--quiet`, and `--timeout` class options manually. Implement pagination and
output clamping in methods. Use `Timeout.timeout()` for network request timeouts.

### Anti-patterns

Using `ask()` or `yes?()` without checking a `--yes` flag first — agents cannot respond to interactive prompts. Using
`say` for both data and messages, which mixes everything on stdout — use `$stderr.puts` for diagnostics. Rescuing
`StandardError` broadly and printing a generic message, which hides actionable details from agents. Relying on Ruby's
default exit code of 1 for all failures without mapping error types to distinct codes.
