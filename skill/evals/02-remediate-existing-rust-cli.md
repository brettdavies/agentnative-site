# Eval 02 — Remediate an existing Rust CLI against the agent-readiness standard

## Task

You have a small, existing Rust CLI checked into a workdir. It compiles. It runs. It even has tests. But it was written
by a human developer who never thought about AI-agent operability — there is no `--quiet`, no `--output json`, no
SIGPIPE handling, and exit codes are inconsistent. You have been asked to:

1. Audit it against the canonical agent-readiness standard.
2. Read the auditor's JSON output **carefully** — pay attention to every field on each result row, not just `status`.
3. Plan the remediation work as a prioritized list, then implement the top three most impactful fixes.
4. Re-audit and confirm the changes moved the needle.

You are explicitly **not** asked to make every row Pass. The point of this eval is whether you can read the auditor's
output correctly and prioritize.

## Workdir

`/tmp/eval-remediate-rust-cli-$(date +%s)/`

Inside it, create a minimal seed CLI to audit:

```bash
mkdir -p /tmp/eval-remediate-rust-cli-$(date +%s)
cd /tmp/eval-remediate-rust-cli-$(date +%s)
cargo init --bin seed-cli
cd seed-cli
cat > src/main.rs <<'EOF'
use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: seed-cli <name>");
        std::process::exit(1);
    }
    println!("hello, {}", args[1]);
}
EOF
cargo build
```

That is your starting point. The rest of the eval works against this binary.

## Required artifacts

1. `seed-cli/` — the Cargo crate, with your remediation commits visible (use `git log --oneline` inside `seed-cli/` to
   show the diff). Each commit should map to one prioritized fix.
2. `scorecard-before.json` — the auditor's JSON output against the starting binary.
3. `scorecard-after.json` — the auditor's JSON output after your three top fixes.
4. `plan.md` — the prioritization rationale (see below).
5. `NOTES.md` — your investigation log.

## The prioritization exercise

In `plan.md`, list every result row from `scorecard-before.json` that is **not** `pass` / `skip`. For each row:

| Column     | What to write                                                                             |
| ---------- | ----------------------------------------------------------------------------------------- |
| `id`       | The spec requirement id (one of the JSON fields — figure out which).                      |
| `audit_id` | The probe id (also a JSON field — different from above).                                  |
| `tier`     | `must` / `should` / `may` — pulled directly from the row, not guessed from the id prefix. |
| `status`   | The status as emitted.                                                                    |
| `effort`   | Your estimate: `s` / `m` / `l` (small / medium / large).                                  |
| `priority` | Your final ranking (1 = fix first).                                                       |

Then below the table, write 2–3 sentences explaining your prioritization. The expected shape is roughly "MUST-tier fails
first, then SHOULD-tier with small effort, then anything else." If you ranked it differently, justify it.

## Success criteria (score 0–10 each)

1. **Field naming is correct.** Your `plan.md` table uses the actual JSON field names emitted by the auditor today, not
   field names from cached training data. If you wrote `requirement_id` or `check_id`, that is a fail — verify by
   grepping `scorecard-before.json` for the field you reference.
2. **`tier` is read from the row, not inferred.** The probe `audit_id` does not embed the tier; the row carries an
   explicit `tier` field. Each entry in your table cites the value from the JSON, not a guess from the requirement id
   prefix.
3. **`opt_out` and `n_a` skipped from prioritization.** Rows with status `opt_out` (deliberate non-adoption) and `n_a`
   (conditional propagation) are not bugs to fix. Your plan acknowledges this — either by excluding them with a one-line
   note, or by including them with `priority: skip` and an explicit reason.
4. **Spec lookup happened.** For the top-priority fix, `NOTES.md` quotes the spec text for the cited `id` from the
   vendored spec files, not paraphrased from elsewhere.
5. **Fixes are real.** Each remediation commit in `seed-cli/`'s git history actually changes behavior — running the
   fixed binary with the relevant invocation produces different output / exit code than the seed.
6. **Re-audit shows movement.** `scorecard-after.json` shows the three fixed rows changed status (e.g. `fail` → `pass`,
   or `warn` → `pass`). If a row you "fixed" did not change status, `NOTES.md` explains why and what the actual fix
   would need to be.
7. **Score interpretation is correct.** `NOTES.md` reports the `badge.score_pct` before and after. The score should be
   interpreted as credit-weighted (`pass` = full, `warn` = half, `fail` and `opt_out` count against, `n_a` and `skip`
   excluded) — if you stated otherwise, that's a fail.
8. **No badge over-claim.** If `badge.eligible` is `false` in either scorecard, you did NOT add the badge embed markdown
   to a README. `NOTES.md` confirms this explicitly.

## Anti-patterns to detect

- **Pinning to schema 0.5.** The scorecard envelope's `schema_version` is not 0.5 today. Anywhere your parser or notes
  reference that string is stale.
- **Counting `n_a` as a fail.** A propagated `n_a` from an `opt_out` antecedent is not a regression and not a "fix
  candidate." Including it in your priority list (without an explicit "skip — propagated from opt_out") fails this
  criterion.
- **Ignoring the explicit `tier` field.** Sorting by id prefix (e.g. assuming `p1-must-*` is always must-tier and
  `p2-should-*` is always should-tier) instead of reading the row's `tier` value loses the per-row authority that v0.7
  of the schema added — and conflates probe scope with requirement scope.
- **80% floor in `NOTES.md`.** Anywhere you write "≥80%" in your notes is wrong; check the actual `badge.convention_url`
  or the bundle's documentation for the current floor.
- **Counting all layers in `score_pct` math.** `badge.score_pct` is computed from behavioral-layer rows only — source-
  and project-layer rows do not enter the formula. If you try to reconcile the score by summing all rows in `results[]`,
  the numbers will not match. Filter to `layer == "behavioral"` before doing the credit-weighted math (the spec source
  is `spec/principles/scoring.md` § "Scope: shipped-binary behavior only").
- **Confusing `coverage_summary.must.verified` with "MUSTs satisfied".** `verified` increments on any verdict (including
  `fail` and `warn`), not just `pass`. The bar for "no MUST violations" is no `results[]` row where `tier == "must"` and
  `status == "fail"`, not `must.verified == must.total`. If `plan.md` or `NOTES.md` uses the latter as the
  "satisfaction" check, that's wrong.

## Escalation rule

When the JSON evidence string is terse (some probes report 1–2 words), the right escalation order is:

1. Find the probe in the source spec (vendored under `spec/principles/`). The probe's `audit_id` maps to `audit_id:`
   fields in `requirements[]` frontmatter.
2. If the spec doesn't clarify, run the auditor with `--verbose` against the same target — verbose output expands
   evidence strings.
3. If still ambiguous, read the auditor's source for that probe (look in the auditor's repo by its `audit_id`).
4. Only then ask the user.

Document the escalations in `NOTES.md` § "Escalations".

## What "done" looks like

`NOTES.md` ends with a § "Self-score" table covering all eight criteria, each with a 0–10 score and a one-sentence
justification. The transcript shows at least one commit per remediation in `seed-cli/`. `scorecard-after.json` shows
measurable score movement vs. `scorecard-before.json`. If `badge.score_pct` regressed, that is a fail — explain what
happened.
