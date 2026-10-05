# P3: Progressive Help Discovery

## Definition

Help text MUST be layered so agents (and humans) can drill from a short summary to concrete usage examples without
reading the entire manual. The critical layer is the one that appears **after** the flags list, because that is where
readers look for invocation patterns.

## Why Agents Need It

Agents discover how to use a tool by calling `--help` and scanning the output. They skip past flag definitions (which
describe what is *possible*) and hunt for examples (which describe what to *do*). A flags list alone is enough rope to
produce a failed invocation; examples are what turn discovery into action. Without examples in the help output, an agent
trial-and-errors its way into a working call, burning tokens and sometimes landing on a wrong-but-silent success.

## Requirements

The principle is framework-agnostic. `clap`'s `after_help` is the worked example below; analogs include `cobra`'s
`Example` (Go), `argparse`'s `epilog` (Python), `docopt`'s usage block, and the `Examples:` convention in `gh` /
`kubectl`.

**MUST:**

- Every subcommand ships at least one concrete invocation example showing the command with realistic arguments, rendered
  in the section that appears after the flags list. In clap this is the `after_help` attribute.
- The top-level command ships at least one concrete example, and 2–3 when the tool has multiple primary use cases.
- The top-level command responds to `--version` with a non-empty version line on stdout and exits 0. Agents pin against
  tool versions to detect breaking changes; a `--version` that errors, exits non-zero, or prints nothing forces every
  consumer to scrape the binary path or manifest for a clue.

**SHOULD:**

- When the CLI exposes a structured-output mode (see [P2](/p2)), examples show human and agent invocations side by side:
  a text-output example followed by its `--output json` equivalent. Readers see the pair; agents see the JSON form.
- Short `about` for command-list summaries; `long_about` reserved for detailed descriptions visible with `--help` but
  not `-h`.
- A short alias for `--version` works: `-V` (clap default; `curl`, `wget`, `gzip`), `-v` (`npm`, `node`, `bun`, `yarn`,
  `make`), or `-version` (Go's `flag` package). Any of the three is sufficient. Agents probing tool versions across many
  CLIs save token cost when they can pin against a one- or two-character flag; the long-only path forces an extra parse
  step.
- *(Applies when: CLI uses subcommands.)* Command-list entries name the command directly (`status`, `server stop`)
  rather than repeat the binary name on every line (`tool status`, `tool server stop`). An agent scanning the block
  takes the command token straight from the left column instead of reconstructing it from a prefix it already knows from
  the `Usage:` line. A hand-written list that repeats the binary name leaves every command second on its line:

  ```text
  Usage: tool [options]

  Commands:
    tool status    Show server status
    tool start     Start the server
    tool stop      Stop the server
  ```

  The clap-shaped list leads each entry with the command itself:

  ```text
  Usage: tool <COMMAND>

  Commands:
    status  Show server status
    start   Start the server
    stop    Stop the server
  ```

  The bare invocation line, which documents what the tool does with no arguments, is the one entry that legitimately
  carries the binary name alone.

**MAY:**

- A dedicated `examples` subcommand or `--examples` flag that outputs a curated set of usage patterns for agent
  consumption.

## Evidence

- `after_help` (or `after_long_help`) attribute on the top-level parser struct.
- `after_help` attribute on every subcommand variant.
- Example invocations in `after_help` text that include realistic arguments, not placeholder `<foo>` tokens.
- Both `about` (short) and `after_help` (examples) present on each subcommand.
- The command list's left column holds bare command tokens; the binary name appears in the `Usage:` line and in
  examples, not at the head of each command entry.

## Anti-Patterns

- Relying solely on `///` doc comments: those populate `about` / `long_about`, not `after_help`, so no examples render
  after the flags list.
- A single `about` string serving as both summary and usage documentation.
- Examples buried in a README or man page but absent from `--help` output.
- `after_help` text that describes the flags in prose instead of demonstrating them in code.
- A hand-written command list that prefixes every entry with the binary name, so the command token sits second on each
  line and a scanner has to strip the prefix before it can read the command.

Measured by audit IDs `p3-help`, `p3-after-help`, `p3-version`, `p3-unprefixed-command-list`. Run `anc audit
--principle 3 .` against the CLI under test to see each.
