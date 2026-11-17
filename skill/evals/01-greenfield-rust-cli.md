# Eval 01 — Greenfield Rust CLI for an AI agent

## Task

You need to design and build a brand-new CLI tool intended to be operated **primarily by AI agents** (not humans running
it interactively). The CLI should be a small but realistic shape: a `widgetctl` binary that has:

- `widgetctl list` — list widgets (read-only, no network).
- `widgetctl get <id>` — get one widget (read-only, no network).
- `widgetctl create --name <name>` — create a widget (mutates state; this is the only mutating verb).

You are free to mock the actual widget store with an in-memory map or a JSON file — the storage layer is not the point.
What matters is that the CLI is **agent-ready**: structured output, predictable errors, no hidden interactivity, no
surprise side effects, no color/pager fights when piped, etc.

You should research what "agent-ready" means before designing the CLI rather than guessing.

## Workdir

`/tmp/eval-greenfield-rust-cli-$(date +%s)/`

Treat this as a fresh sandbox. Do not edit any other directories. Do not assume any tooling beyond what is on `$PATH`
(check first with `which`); install via `brew` / `cargo` if the right tool is missing.

## Required artifacts

By the end of the eval, the workdir must contain:

1. `widgetctl/` — a Rust Cargo crate that compiles cleanly (`cargo build` succeeds) and whose binary runs.
2. `widgetctl/AGENTS.md` — a per-project AGENTS.md aimed at agent operators.
3. `scorecard.json` — the JSON output of whatever auditor you found, run against the built binary.
4. `BADGE.md` — if the scorecard reports the project as badge-eligible, the badge embed markdown copied out of the
   scorecard. If the project is **not** eligible, this file should explain in 2–3 sentences why (which scoring rule
   blocks it) and what the next remediation would be.
5. `NOTES.md` — your investigation log: what you researched, dead-ends you abandoned (and why), and which decisions were
   judgment calls rather than rules from the docs.

Do not commit any of these — the workdir is throwaway.

## Success criteria (score 0–10 each)

1. **Discovery via description, not name.** You discovered the relevant standard / spec / auditor by following a
   description from a skill listing or by web search — not by being told its name. If you guessed the name from training
   data and went straight to its repo, that is a partial fail; record it under "Dead ends".
2. **Auditor invoked correctly.** You ran the canonical auditor against your built binary and captured its JSON output.
   The JSON envelope matches the current published schema version; you did not pin against a stale schema.
3. **Spec lookup is real.** For at least one finding, you traced the cited requirement id (e.g. something resembling
   `pN-must-…`) back to the canonical spec text and quoted the constraint in `NOTES.md`. No paraphrasing the rule from
   training data without verifying.
4. **Templates used where they exist.** If the standard ships starter templates for the language you chose, you used
   them rather than hand-rolling boilerplate. You should not have invented your own `--quiet` / `--output` flag
   conventions when the templates already encode them.
5. **`opt_out` and `n_a` handled correctly.** When the auditor reports `opt_out` or `n_a` rows, you correctly classified
   them as deliberate non-adoptions / propagated conditionals — not as bugs to chase. `NOTES.md` lists at least one such
   row and explains why you did not "fix" it.
6. **Badge claim discipline.** If the scorecard is below the eligibility floor, you did NOT advertise a badge.
   `BADGE.md` reflects the actual scorecard state.
7. **Pipe-safe output.** Running `widgetctl list | cat` produces no ANSI escapes; running with `--output json | jq .`
   succeeds; `widgetctl create … | head` does not error out from SIGPIPE.
8. **No interactive prompts.** Running any verb in a non-TTY (e.g., `widgetctl create --name foo < /dev/null`) neither
   hangs nor reads from stdin unexpectedly.

## Anti-patterns to detect

These are regression markers from prior eval runs. If your transcript shows any of these, flag them explicitly in
`NOTES.md`:

- **Schema pinning to 0.5.** The current scorecard schema is **not** 0.5. Pinning your parser to that string will break
  against current output. Use the schema the binary emits today; document the version in `NOTES.md`.
- **80% threshold mentioned.** The badge eligibility floor is not 80%. Anywhere you write down a percentage, source it
  from the badge section of the actual scorecard, not from cached prose.
- **Chasing `n_a` rows.** A row whose status is `n_a` because its antecedent collapsed is a propagated non-finding, not
  a failure. If your "fixes" include touching code to flip an `n_a` row, that is wrong work.
- **Hand-rolled `--output json` flag.** If you wrote the JSON serialization layer by hand instead of using the starter
  template that already encodes it, the eval is testing that you found the template.
- **Bumping skill bundle VERSION on a feature branch.** The bundle's `VERSION` file is a release artifact, not a
  per-commit version. Do not modify it.
- **"Deliberate non-adoption" on `p8-must-bundle-install` without an experiment.** This eval requires
  `widgetctl/AGENTS.md` (required artifact #2), which makes `p8-bundle-exists` pass and triggers
  `p8-must-bundle-install` on the binary. The probe expects the binary to advertise an install path for the bundle
  (candidate shapes named in the probe's evidence string, e.g. `skill install`, `init --skill`). The probe is
  permissive: it greps `--help` / `<verb> --help` for the expected token shapes and does **not** semantically validate
  that the install does anything — a ~30-line stub subcommand that takes a destination and writes `AGENTS.md` to it
  satisfies the row. So the rationalization "I shouldn't add a fake feature just to pass an audit" is factually wrong on
  this probe: the audit asks for the discoverable surface, not the feature. Before classifying the row as `opt_out` /
  "deliberate non-adoption" / "this is a fixture, not a real bundle," you **must** either (a) add a working stub install
  subcommand to `widgetctl` and verify the row's status changes, or (b) re-run with `--audit-profile <category>` if a
  matching profile actually suppresses this audit. Framing your way out without running either experiment fails this
  criterion.
- **Confusing `coverage_summary.must.verified` with "MUSTs satisfied".** `verified` increments on any verdict (including
  `fail` and `warn`), not just `pass`. The bar for "no MUST violations" is no `results[]` row where `tier == "must"` and
  `status == "fail"`, not `must.verified == must.total`.
- **Counting all layers in `score_pct` math.** `badge.score_pct` is computed from behavioral-layer rows only — source-
  and project-layer rows do not enter the formula. If you try to reconcile the score by summing all rows in `results[]`
  the numbers will not match. Filter to `layer == "behavioral"` before doing the credit-weighted math.

## Escalation rule

You will hit at least one ambiguity the docs do not resolve directly (likely around an edge case in `--audit-profile`
selection, or the exact meaning of a probe whose evidence is terse). When that happens, the right order is:

1. The canonical spec files (vendored under `spec/principles/`).
2. The auditor's own help (`<auditor> --help`, `<auditor> audit --help`).
3. The auditor's embedded JSON Schema (the binary exposes a way to print it).
4. The auditor's repo issues / discussions.
5. As a last resort, ask the user.

Document the escalation you actually took in `NOTES.md` § "Escalations".

## What "done" looks like

When you think you are done, run the auditor against the built binary one more time and capture the final
`scorecard.json`. Score yourself against the eight criteria above in `NOTES.md` § "Self-score" with one sentence of
justification per criterion. A run that scores < 6 on any criterion is a fail — note what would need to change to lift
the score.
