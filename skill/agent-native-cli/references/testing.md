# Testing the Agent Contract

Black-box behavioral tests that prove the eight-principle contract from outside the tool: spawn the real binary (or call
the real handler), observe stdout, stderr, exit codes, and headers, and assert. This is the same contract `anc audit`
scores, expressed as tests you own in your own repo, so the guarantees hold in your CI between audits. `anc` audits from
the outside; it does not write your test suite. This file tells you what to assert; the files in the "Adapt these" table
are CI-green suites to start from.

> **Guardrail: tests, not recipes.** Allowed: adapting the robust tests referenced here, and asserting any observable
> behavior (flags, exit codes, output shape, ANSI bytes, headers). Forbidden: reading this file as implementation
> guidance; no item below says how to make an assertion pass. For the "how", read
> [`framework-idioms.md`](./framework-idioms.md),
> [`framework-idioms-other-languages.md`](./framework-idioms-other-languages.md),
> [`rust-clap-patterns.md`](./rust-clap-patterns.md), the starter files under [`templates/`](../templates/), and the
> principle text in [`spec/principles/`](../spec/principles/).

Each checklist item is an assertion intent: an input, an action, and an expected observable. Write it in your language's
harness (table below) or start from the in-bundle skeletons under [`templates/tests/`](../templates/tests/README.md).
Work red-first: adapt a block, watch it fail for the right reason, then make it pass.

```bash
cargo test --test cli        # or: bun test, pytest, go test ./..., rspec
anc audit --output json . | jq '[.results[] | select(.tier == "must" and .status == "fail")] | length'
```

Three version numbers sit near each other in this ecosystem and none is interchangeable with another. Source each from
the artifact its tool emits, never from memory or from a neighboring number.

| Number  | Identifies               | Source of truth                                               |
| ------- | ------------------------ | ------------------------------------------------------------- |
| `0.7.0` | The spec, principle text | `spec/VERSION`                                                |
| `0.7.0` | The `anc` release        | `anc --version`                                               |
| `0.9`   | The scorecard schema     | `schema_version` in the scorecard; `$id` of `anc emit schema` |

The spec file cited in each section is the source of truth for the principle; these items do not restate it.

## P1: Non-interactive by default

Spec: [`p1-non-interactive-by-default.md`](../spec/principles/p1-non-interactive-by-default.md).

- Run any verb with stdin closed (`< /dev/null`): the process exits promptly; it neither hangs nor prompts.
- Omit a required input: the tool exits non-zero with a message naming the missing flag, instead of prompting for it.
- Set the documented env-var form of a flag and omit the flag: behavior matches the flag form.
- Bare invocation (no arguments): a deliberate, safe behavior (help text or a usage error), never an implicit action
  with side effects. Assert whichever behavior your tool documents.

Proven in: `test_bare_invocation_prints_help` (`tests/integration.rs`, table below). Read past its name: the body
asserts the usage-error arm (exit code 2 with usage text on stderr), not help on stdout with exit 0.

## P2: Structured, parseable output

Spec: [`p2-structured-parseable-output.md`](../spec/principles/p2-structured-parseable-output.md).

- `--output json` stdout parses with a real JSON parser; never regex-match styled text to "check" JSON.
- The parsed object carries a stable top-level key set; assert both directions (every expected key present, no
  unexpected keys), so accidental renames and accidental additions both fail.
- The `--json` alias (when shipped; the alias is a spec-level SHOULD) produces the same shape as `--output json`.
- A bad invocation under JSON mode emits a typed error envelope (keys such as `error`, `kind`, `message`, `exit_code`)
  on the documented stream, so a JSON-pinned consumer never needs a second parser for failures.
- With `NO_COLOR=1` (and when piped), output contains no ANSI escape bytes (`\x1b[`) and still parses.
- Reserve exact-text assertions for wording that is itself the contract; parse and assert fields everywhere else, so
  formatting changes (column widths, color, phrasing) do not break the suite.

Proven in: `test_audit_json_output`, `test_scorecard_json_has_stable_top_level_keys`, `test_no_color_env`,
`test_bad_invocation_emits_json_error_envelope`, `test_bad_invocation_with_json_alias_emits_envelope`.

## P3: Progressive help discovery

Spec: [`p3-progressive-help-discovery.md`](../spec/principles/p3-progressive-help-discovery.md).

- `--help` exits 0 and contains usage plus the verb list.
- `<verb> --help` exits 0 and documents that verb's flags (grep for a flag you ship).
- `--version` exits 0 and prints the tool name and a version string.
- `help <verb>` (when shipped) succeeds and matches the `<verb> --help` content.

Proven in: `test_help`, `test_version`, `test_help_subcommand_works`, `test_command_flag_appears_in_help`.

## P4: Fail fast, actionable errors

Spec: [`p4-fail-fast-actionable-errors.md`](../spec/principles/p4-fail-fast-actionable-errors.md).

- Every arm of your exit-code table has a test, even the trivial ones; an unasserted mapping drifts silently.
- An unknown flag exits with the usage code and a non-empty stderr message.
- A nonexistent target (path, id, host) exits with its documented code and an actionable stderr message.
- Errors go to stderr and data goes to stdout; assert the stream, not just the text.

Proven in: `test_audit_nonexistent_path`, `test_audit_bogus_flag`, `test_command_flag_unknown_binary_errors`.

## P5: Safe retries, mutation boundaries

Spec: [`p5-safe-retries-mutation-boundaries.md`](../spec/principles/p5-safe-retries-mutation-boundaries.md).

- First establish whether the tool has real write operations (an observable mutation of a file, row, or remote object).
  Every P5 requirement is conditional: the spec gates `p5-must-dry-run` on "CLI has write operations" and
  `p5-must-force-yes` on "CLI has destructive operations". A tool with none records the items below as non-adoption
  (`n_a` / `skip`), not violations, and skips the rest of this section.
- `--dry-run` on a mutating verb exits 0, prints the plan, and leaves state untouched; assert the actual state (file,
  row, remote object) after the run, not just the output text.
- A mutating verb in a non-TTY without its confirmation flag either refuses with the documented exit code or falls back
  to dry-run; assert whichever behavior the tool documents.
- Re-running an idempotent verb produces the same result with no duplicate side effects.
- Wire the standard's own auditor into CI: spawn `anc audit --output json` against your repo and assert no `fail` status
  on the principle rows you claim (the `tests/dogfood.rs` pattern in the table below).

Proven in: `dogfood_no_p5_fail_after_skill_subcommand`, `dogfood_no_p2_fail_after_skill_subcommand`
(`tests/dogfood.rs`).

## P6: Composable, predictable structure

Spec:
[`p6-composable-predictable-command-structure.md`](../spec/principles/p6-composable-predictable-command-structure.md).

- Tokens after the `--` separator parse as positionals, never as flags or verb names.
- A value-taking flag whose value collides with a verb name treats the token as the value (flag-value pairing).
- Piping stdout into an early-exiting consumer (`| head -1`) produces no SIGPIPE panic or stack trace.
- Shell completions generate for at least one shell and are non-empty.

Proven in: `test_double_dash_separator_with_path`, `test_command_flag_value_matching_subcommand_name`,
`test_completions_bash`.

## P7: Bounded, high-signal responses

Spec: [`p7-bounded-high-signal-responses.md`](../spec/principles/p7-bounded-high-signal-responses.md).

- `--quiet` output is strictly smaller than normal output and contains no progress or per-item status lines.
- `--quiet` combines with other global flags and positionals in any documented order.
- `--limit` or pagination flags clamp the row count; assert the count, not the wording.

Proven in: `test_audit_quiet`, `test_default_subcommand_preserves_global_flag_before_path`.

## P8: Discoverable skill bundles

Spec: [`p8-discoverable-skill-bundle.md`](../spec/principles/p8-discoverable-skill-bundle.md).

- `--help` output advertises the bundle-install surface (grep for the documented verb or flag shape).
- The advertised install verb runs against a temp destination and leaves the documented artifact, or its `--dry-run`
  prints the exact command it would run.

The install surface is tool-specific, so no shared OSS block exists; write these two assertions against your own
documented surface.

## Web surfaces: the analog contract

An agent-facing HTTP surface has the same prove-it obligation with different observables. The TS/bun anchor in the table
below asserts, end-to-end against a stubbed environment (no live server):

- Content negotiation: explicit `Accept` beats defaults, q-values are honored, malformed headers fall back safely.
- User-Agent routing: allowlisted CLI and agent fetchers get the machine-readable branch; browsers and excluded crawlers
  get HTML.
- Header policy per branch: `Content-Type`, CORS, `Cache-Control`, robots directives.
- Cross-artifact JSON contracts: parse the committed artifacts, join them, and fail CI before shape drift ships (the
  `score-contract.test.ts` pattern).

## Language to test-harness map

| Language          | Black-box harness                                                            |
| ----------------- | ---------------------------------------------------------------------------- |
| Rust              | `assert_cmd` + `predicates`, `serde_json` for output assertions              |
| Python            | `subprocess` + `pytest`; Click apps can also drive `click.testing.CliRunner` |
| Go                | `os/exec` + `testing`                                                        |
| JS/TS (Node, Bun) | `execa` with `node:test` or `vitest`; `bun:test` on Bun                      |
| Ruby              | `Open3` + `minitest` or `rspec`                                              |

The Rust and Python rows have in-bundle skeletons under [`templates/tests/`](../templates/tests/README.md). If your
language has no CLI-shaped skeleton in this bundle (Go, Ruby), map the structure of the Rust anchor onto your harness
row: every test spawns the real binary and asserts observables. Read the TS/bun anchor as the web-surface pattern, not a
CLI pattern.

## Adapt these

Commit-pinned, CI-green files from this standard's own repos. Swap the binary name and expected tokens for your tool;
keep the assertion structure.

| File                                                                                                                                                                          | Proves                                                                                                                                                                                                                                                                                                                                                                                      | Adapt by                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`agentnative-cli/tests/integration.rs`](https://github.com/brettdavies/agentnative-cli/blob/eba21454ccbc5fae9c09613b982104676c7956a7/tests/integration.rs)                   | P1 (`test_bare_invocation_prints_help`), P2 (`test_audit_json_output`, `test_scorecard_json_has_stable_top_level_keys`, `test_no_color_env`, `test_bad_invocation_emits_json_error_envelope`), P3 (`test_help`, `test_version`), P4 (`test_audit_nonexistent_path`, `test_audit_bogus_flag`), P6 (`test_double_dash_separator_with_path`, `test_completions_bash`), P7 (`test_audit_quiet`) | Replace `anc` in `cmd()` with your binary; swap expected tokens, key sets, and exit codes for your documented contract |
| [`agentnative-cli/tests/dogfood.rs`](https://github.com/brettdavies/agentnative-cli/blob/eba21454ccbc5fae9c09613b982104676c7956a7/tests/dogfood.rs)                           | P2 and P5 CI wiring (`dogfood_no_p2_fail_after_skill_subcommand`, `dogfood_no_p5_fail_after_skill_subcommand`): run the standard's auditor against yourself in CI                                                                                                                                                                                                                           | Point the spawn at your repo; assert no `fail` on the principle prefixes you claim                                     |
| [`agentnative-site/tests/worker.test.ts`](https://github.com/brettdavies/agentnative-site/blob/6c120df73e3b63659c586b537e3e3c90dad0907e/tests/worker.test.ts)                 | The web-surface analog of P2 and P3: `detectPreference` negotiation and allowlist matrices, `applyHeaders` branch policies, `worker.fetch` end-to-end rewrites against a stubbed environment                                                                                                                                                                                                | Swap routes, User-Agent tokens, and header expectations for your surface; keep the table-driven matrix shape           |
| [`agentnative-site/tests/score-contract.test.ts`](https://github.com/brettdavies/agentnative-site/blob/6c120df73e3b63659c586b537e3e3c90dad0907e/tests/score-contract.test.ts) | P2 structured-output contract for committed artifacts: the `score-contract` describe block joins three JSON/YAML artifacts and fails CI on drift                                                                                                                                                                                                                                            | Replace the three artifacts with your own generated-plus-committed set; keep the join-and-assert structure             |

The SHAs above are pinned snapshots and this repo's CI does not check links: re-verify each link when you adapt, and
treat the newest revision of each file (the pin or the source repo's HEAD, whichever is newer) as the authoritative
robust version. A pin can sit ahead of the source repo's default branch when it snapshots that repo's integration
branch.
