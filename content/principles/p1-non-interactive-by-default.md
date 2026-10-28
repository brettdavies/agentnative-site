# P1: Non-Interactive by Default

## Definition

Every automation path MUST run without human input. A CLI tool that blocks on an interactive prompt is invisible to an
agent: the agent hangs, the user sees nothing, and the operation times out silently.

## Why Agents Need It

An agent calling a CLI cannot type. When the tool prompts for a confirmation or a credential, the agent's process stalls
until timeout: no tokens recovered, no structured signal that interaction was requested, and no way to distinguish
"waiting for input" from "still processing." Interactive prompts in automation paths are a leading cause of agent-tool
deadlock.

## Requirements

**MUST:**

- Every flag settable via environment variable. Use a falsey-value parser for booleans so that `TOOL_QUIET=0` and
  `TOOL_QUIET=false` correctly disable the flag rather than being treated as truthy non-empty strings. In Rust / clap:

  ```rust
  #[arg(long, env = "TOOL_QUIET", global = true,
        value_parser = FalseyValueParser::new())]
  quiet: bool,
  ```

- When stdin is not a TTY, or when `--no-interactive` is set, every blocking-input surface (prompt libraries, read-line
  calls, TUI session initialization) resolves from defaults, reads from stdin, or exits non-zero with an actionable
  error. The tool MUST NOT block waiting for input that cannot arrive.
- *(Applies when: CLI authenticates against a remote service.)* A headless authentication path. The canonical flag is
  `--no-browser`, which triggers the OAuth 2.0 Device Authorization Grant
  ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)): the CLI prints a URL and a code; the user authorizes on another
  device. Agents cannot open browsers. Non-canonical alternatives (`--device-code`, `--remote`, `--headless`) are
  acceptable but SHOULD migrate toward `--no-browser`.
- *(Applies when: CLI accepts secret material as input.)* At least one input path that does not leak the secret into
  process listings, shell history, or the parent environment. The two leak-resistant paths are stdin and a `--*-file`
  flag pointing at a credential file. Flag-value forms (`--token <value>`) and environment variables (`TOOL_TOKEN`) MAY
  exist as convenience surfaces but MUST NOT be the only programmatic path. Cloud-CLI env-var conventions
  (`AWS_ACCESS_KEY_ID`, `GH_TOKEN`) count as convenience paths under this rule, not as substitutes for it. A CLI whose
  only secret-input path is `--password <value>` leaks the secret into `ps` output on every invocation.

**SHOULD:**

- Auto-detect non-interactive context via TTY detection on stdin (and stderr, where prompts target it) and suppress
  prompts when no terminal is present, even without an explicit `--no-interactive` flag. Language-specific entry points:
  `std::io::IsTerminal` in Rust 1.70+, `process.stdin.isTTY` in Node, `sys.stdin.isatty()` in Python.
- Document default values for prompted inputs in `--help` output so agents can pass them explicitly instead of accepting
  whatever default ships.

**MAY:**

- Offer rich interactive experiences (spinners, progress bars, multi-select menus) when a TTY is detected and
  `--no-interactive` is not set, provided the non-interactive path remains fully functional.

## Scope

"Agent" in this specification means a process invoking the CLI as a subprocess. This spec's automated audits verify
behavior under non-TTY stdin. TTY-driving agents (tmux panes, `ssh -t` sandbox shells, `expect` automation, computer-use
desktop agents) are affected by the same MUSTs, but `anc` currently does not allocate a PTY during verification. Pass
verdicts for TTY-driving-agent scenarios are probable-but-not-verified; see [/coverage](/coverage) for the gap.

## Evidence

- `--no-interactive` flag in the CLI struct with an env-var binding.
- Boolean env vars parsed with a falsey-value parser (not the default string parser).
- TTY guard wrapping every `dialoguer`, `inquire`, or equivalent prompt call.
- `--no-browser` flag present on authenticated CLIs.
- `env = "TOOL_..."` attribute on every flag that takes user input.
- A stdin or `--*-file` path for every secret-accepting flag, present alongside (not instead of) any convenience
  flag-value or env-var alternative.

## Anti-Patterns

- Bare `dialoguer::Confirm::new().interact()` with no TTY check and no `--no-interactive` override — agents hang
  indefinitely.
- Boolean environment variables parsed as plain strings, so `TOOL_QUIET=false` is truthy because the string is
  non-empty.
- `stdin().read_line()` in a code path reached during normal operation without a TTY check first.
- Hard-coded credentials prompts with no env-var or config-file alternative.
- OAuth flow that unconditionally opens a browser with no headless escape hatch.
- A `--password <value>` flag with no stdin or file alternative — every invocation leaks the secret into process
  listings.

Measured by audit IDs `p1-env-hints`, `p1-env-flags-source`, `p1-non-interactive`, `p1-flag-existence`,
`p1-non-interactive-source`, `p1-headless-auth`, `p1-secret-non-leaky-path`, `p1-tty-detection-source`,
`p1-defaults-in-help`, `p1-rich-tui`. Run `anc audit --principle 1 .` against the CLI under test to see each.
