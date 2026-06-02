# P7: Bounded, High-Signal Responses

## Definition

CLI tools MUST provide mechanisms to control output volume. Agent context windows are finite and expensive: a tool that
dumps tens of thousands of lines of unfiltered output wastes tokens on every request and can exceed smaller context
windows entirely, breaking the conversation that invoked it. "High-signal" here means the bytes that survive `--quiet`
are the ones the caller asked for (data and errors), not progress, decoration, or chatter.

## Why Agents Need It

Unbounded CLI output is expensive for any agent: token cost and context-window capacity for LLM agents, parse cost and
memory pressure for scripts, schedulers, and other automation. Either way, the agent ends up truncating (losing
potentially important data) or consuming the full response (wasting cycles on noise). Bounded output with `--quiet`,
`--verbose`, and `--limit` flags gives the agent precise control over how much data arrives, keeping responses
high-signal and inside budget.

## Requirements

**MUST:**

- A `--quiet` flag suppresses non-essential output: progress indicators, informational messages, decorative formatting.
  When `--quiet` is set, only requested data and errors appear. Implementations typically route diagnostics through a
  macro that short-circuits when quiet is on:

  ```rust
  macro_rules! diag {
      ($cfg:expr, $($arg:tt)*) => {
          if !$cfg.quiet { eprintln!($($arg)*); }
      }
  }
  ```

- *(Applies when: CLI has list-style commands.)* List operations clamp to a documented default maximum. A `list` without
  `--limit` does not return more than a configurable ceiling (e.g., 100 items), and that ceiling is named in `--help` so
  callers can plan around it. If more items exist, the output indicates truncation: `"truncated": true` in JSON, a
  stderr note in text mode.

**SHOULD:**

- A `--verbose` flag (or `-v` / `-vv`) escalates diagnostic detail when agents need to debug failures.
- A `--limit` or `--max-results` flag lets callers request exactly the number of items they want.
- A `--timeout` flag bounds execution time. An agent waiting indefinitely on a hung network call cannot proceed.

**MAY:**

- Cursor-based pagination flags (`--after`, `--before`) for efficient traversal of large result sets.
- Automatic verbosity reduction in non-TTY contexts (the same behavior `--quiet` explicitly requests).

## Evidence

- A `--quiet` flag that respects both CLI and environment-variable input, with explicit override semantics (e.g.,
  `--quiet=false` beats `QUIET=1`).
- A diagnostic macro (or equivalent gate) that short-circuits when `quiet` is true.
- `--limit` or `--max-results` on every list / search command.
- Pagination clamping logic (e.g., `min(requested, MAX_RESULTS)`).
- `--timeout` flag with a sensible default.
- `--verbose` flag for diagnostic escalation.
- A `suppress_diag()` method that returns true when quiet is set or when the output format is JSON / JSONL.

## Anti-Patterns

- List commands that return all results with no default limit: an agent listing 50,000 items floods its context window.
- No `--quiet` flag: agents consuming JSON output still receive interleaved diagnostic text on stderr.
- `--verbose` as the only output control. If there is no way to reduce output, bounded responses do not exist.
- Progress bars or spinners that write to stderr in non-TTY contexts, adding noise to agent logs.
- No `--timeout` on network operations. A stalled request blocks the agent indefinitely.

Measured by audit IDs `p7-quiet`, `p7-limit`, `p7-timeout`. Run `anc audit --principle 7 .` against the CLI under test
to see each.
