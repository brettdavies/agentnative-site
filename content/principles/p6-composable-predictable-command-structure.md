# P6: Composable and Predictable Command Structure

## Definition

CLI tools MUST integrate cleanly with pipes, scripts, and other tools. That means handling SIGPIPE, detecting TTY for
color and formatting decisions, supporting stdin for piped input, and maintaining a consistent, predictable subcommand
structure.

## Why Agents Need It

Agents compose CLI tools into pipelines:

```bash
tool list --output json | jaq '.[] | .id' | xargs tool get
```

Every link in that chain has to behave predictably. A tool that panics on SIGPIPE when piped to `head` breaks the
pipeline. A tool that emits ANSI color codes into a pipe pollutes downstream JSON parsing. A tool with inconsistent
subcommand naming forces the agent to memorize exceptions rather than apply patterns. Composability is what makes a CLI
tool a building block rather than a dead end.

## Requirements

**MUST:**

- SIGPIPE is handled so that piping to `head`, `tail`, or any tool that closes the pipe early does not crash the
  process. In Rust, restore the default SIGPIPE handler as the first executable statement in `main()`:

  ```rust
  unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL); }
  ```

  Equivalents in other languages: in Python, restore the default `SIGPIPE` handler at startup
  (`signal.signal(signal.SIGPIPE, signal.SIG_DFL)`); in Go, the runtime's default handling already exits cleanly on
  EPIPE writes; in Node.js, handle `EPIPE` on `process.stdout`.

- TTY detection, plus support for `NO_COLOR` and `TERM=dumb`. When stdout or stderr is not a terminal, color codes are
  suppressed automatically.
- Shell completions available via a `completions` subcommand (clap_complete in Rust; equivalents elsewhere). This is a
  Tier 1 meta-command: it works without config, auth, or network.
- *(Applies when: CLI makes network calls.)* A `--timeout` flag with a sensible default (30 seconds is the canonical
  recommendation for typical request/response operations; longer for streaming or upload commands). Agents operating
  under their own time budgets need to fail fast rather than block on a slow upstream.
- *(Applies when: CLI invokes a pager for output.)* Support `--no-pager` or respect `PAGER=""`. Pagers block headless
  execution indefinitely.
- *(Applies when: CLI uses subcommands.)* Agentic flags (`--output`, `--quiet`, `--no-interactive`, `--timeout`)
  propagate to every subcommand automatically (e.g., `global = true` in clap).
- *(Applies when: CLI runs long-running operations.)* SIGTERM is handled gracefully: in-flight writes flush or roll
  back, locks release, and the process exits non-zero within a bounded shutdown window. The next invocation succeeds
  without manual cleanup. Agents commonly cancel a long-running call when their own deadline expires; a tool that leaves
  half-written state behind on SIGTERM forces the agent to clean up before retrying.

**SHOULD:**

- Commands that accept input read from stdin when no file argument is provided. Pipeline composition depends on it.
- Pick one subcommand-naming convention and apply it consistently: `noun verb`, `verb noun`, or verb-only at the top
  level (e.g., `git commit`, `git push`). Mixing kebab-case compound verbs (`list-users`) with nested noun-verb (`user
  show`) in the same tool forces agents to learn exceptions.
- Three-tier dependency gating: Tier 1 (meta-commands like `completions`, `version`) needs nothing; Tier 2 (local
  commands) needs config; Tier 3 (network commands) needs config + auth. `completions` and `version` always work, even
  in broken environments.
- When a CLI exposes multiple distinct operations, model them as subcommands rather than mutually-exclusive flags. `tool
  search "query"` is preferable to `tool --search "query" --get "id"`. Single-operation tools (`grep`, `curl`, `jq`) are
  exempt: flags are their operation surface.

**MAY:**

- A `--color auto|always|never` flag for explicit color control beyond TTY auto-detection.
- *(Applies when: CLI uses subcommands.)* Subcommand verbs follow community-standard names (`get`, `list`, `create`,
  `update`, `delete`); flag spellings follow widely-used canonical forms (`--force`, `--yes`, `--limit`, `--quiet`,
  `--verbose`). Convergence reduces an agent's per-tool relearning cost: an agent that has seen `kubectl get` and `gh
  repo list` recognizes `tool list` immediately, without re-reading `--help`.

## Evidence

- `libc::signal(libc::SIGPIPE, libc::SIG_DFL)` (or the equivalent in the target language) as the first statement of
  `main()`.
- `IsTerminal` trait usage (`std::io::IsTerminal` or the `is-terminal` crate).
- `NO_COLOR` and `TERM=dumb` checks.
- `clap_complete` in `Cargo.toml`.
- A `completions` subcommand in the CLI enum.
- Tiered match arms in `main()` separating meta-commands from config-dependent commands.

## Anti-Patterns

- Missing SIGPIPE handler: `cargo run -- list | head` panics with "broken pipe".
- Hard-coded ANSI escape codes without TTY detection.
- Color output in JSON mode: ANSI codes inside JSON string values break downstream parsing.
- A `completions` command that requires auth or config to run.
- No stdin support on commands where piped input is a natural use case.

Measured by audit IDs `p6-sigpipe`, `p6-no-color`, `p6-completions`, `p6-timeout`, `p6-agents-md`. Run `anc audit
--principle 6 .` against the CLI under test to see each.
