# P2: Structured, Parseable Output

## Definition

CLI tools MUST separate data from diagnostics and offer machine-readable output formats. Mixing status messages with
data forces agents into fragile regex extraction that breaks on any format change.

## Why Agents Need It

An agent calling a CLI needs three things from each invocation: the data, the error (if any), and the exit code. When
data goes to stdout, diagnostics go to stderr, and errors carry machine-readable fields, the agent parses the result
reliably without heuristics. Mix these channels or ship human-formatted output only, and the agent falls back to
best-effort text parsing that fails unpredictably across versions, locales, and edge cases — silently at first,
catastrophically later.

## Requirements

**MUST:**

- A machine-readable format flag (`--output text|json|jsonl`). `text` is the default human-facing form; `json` and
  `jsonl` are the canonical machine-readable values, and at least one of them is required.
- Data goes to stdout. Diagnostics, progress indicators, and warnings go to stderr. An agent consuming JSON from stdout
  must never encounter an interleaved progress message.
- Exit codes are structured and documented. Codes 77 and 78 follow BSD `sysexits.h` (`EX_NOPERM`, `EX_CONFIG`); the
  broader sysexits range is intentionally not mandated to keep the surface small:

| Code | Meaning                           |
| ---: | --------------------------------- |
|    0 | Success                           |
|    1 | General command error             |
|    2 | Usage error (bad arguments)       |
|   77 | Authentication / permission error |
|   78 | Configuration error               |

- When `--output json` is active, errors are emitted as JSON (to stderr) with at least `error`, `kind`, and `message`
  fields. Plain-text errors in a JSON run leave the agent without structured access to the failure — it can detect
  non-zero exit but cannot route on `kind` or surface `message` programmatically.
- *(Applies when: CLI emits structured output.)* The output schema is runtime-discoverable via a `schema` subcommand or
  a `--schema` flag, returned with a documented format identifier (canonical recommendation: JSON Schema 2020-12). An
  agent that finds the tool through filesystem discovery should be able to ask the tool what shape its output takes
  without external documentation.

**SHOULD:**

- JSON output uses a consistent envelope — a top-level object with predictable keys — across every command so agents can
  rely on the same shape. Passthrough tools whose value is the user's own JSON (`jq`, `dasel`) are exempt; the envelope
  applies to commands that emit tool-defined data.
- *(Applies when: CLI emits structured output.)* The same schema is also exported to a stable file path (e.g.,
  `schema/<command>.json` in the release artifact). Runtime discovery covers ad-hoc inspection; the file path lets CI
  and static-analysis consumers pin the schema without invoking the tool.
- `--json` and `--jsonl` are accepted as aliases for `--output json` and `--output jsonl`. The canonical enum stays
  authoritative; the short forms are a convenience for the common case.

**MAY:**

- Additional output formats (CSV, TSV, YAML) beyond the core three. The core three remain mandatory.
- A `--raw` flag for unformatted output suitable for piping to other tools.

## Evidence

Rust reference implementation:

- `OutputFormat` enum with `Text`, `Json`, `Jsonl` variants deriving `ValueEnum`.
- `OutputConfig` struct with `format`, `use_color`, and `quiet` fields threaded through every output-producing function.
- `serde_json` in `Cargo.toml`.
- No `println!` in `src/` outside the output module — every print goes through `OutputConfig`.
- Exit-code constants or match arms mapping error variants to distinct numeric codes.
- `eprintln!` (or an equivalent diagnostic macro) for every diagnostic line.

## Anti-Patterns

- `println!` scattered across handlers instead of routing through the output config.
- A single exit code (1) for everything — agents cannot distinguish auth failures from config errors.
- Status lines ("Fetching data…") printed to stdout where they contaminate JSON output.
- `process::exit()` in library code, bypassing structured error propagation.
- Human-formatted tables as the only output mode with no JSON alternative.

Measured by audit ID `p2-json-output` today, with format-specific and stderr-discipline audits planned. Run `anc audit
--principle 2 .` against your CLI to see current coverage.
