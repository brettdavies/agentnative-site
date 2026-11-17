# Evals

Self-contained eval prompts that exercise the discovery + workflow this bundle teaches. Each prompt is dispatchable to a
fresh agent with no other context; the agent must find the right skill from its description, follow the workflow, and
produce the listed artifacts.

## How to run

Dispatch the prompt body to a fresh agent (e.g., a Task / Agent / general-purpose subagent — anything that starts with
no conversation history). The agent picks a workdir, follows the prompt, and writes its artifacts there. Workdir output
lives at `/tmp/<eval-name>-<ts>/` per the convention — never committed.

The eval body **never names this skill** so the run actually tests whether the description is discoverable. If the agent
invokes the skill by name (because it saw the name in some other index), record that as a discovery confound and re-run
the eval as written.

## Evals in this bundle

| File                                                                       | What it exercises                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`01-greenfield-rust-cli.md`](./01-greenfield-rust-cli.md)                 | Discovery + the new-Rust-CLI loop: scaffolding from templates, `anc audit`, badge claim once eligible.                                                                                                 |
| [`02-remediate-existing-rust-cli.md`](./02-remediate-existing-rust-cli.md) | JSON-shape interpretation (`id`, `audit_id`, `tier`, `opt_out`, `n_a`), spec lookup, fix application, re-audit.                                                                                        |
| [`03-multilang-python-cli.md`](./03-multilang-python-cli.md)               | Cross-language guidance: agent reaches `framework-idioms-other-languages.md` instead of forcing Rust patterns.                                                                                         |
| [`04-prove-the-contract.md`](./04-prove-the-contract.md)                   | Testing layer: agent discovers the per-principle test checklist, adapts a named OSS test block red-first, and keeps fixes out of the prove-it layer (tests handed over, never implementation recipes). |

## Conventions each eval follows

1. **Self-contained** — never names the bundle in the prompt body; tests discoverability from frontmatter description.
2. **Workdir-first** — every eval names its `/tmp/...` workdir up front.
3. **Required artifacts** — explicit list of files the agent must leave behind.
4. **Numbered success criteria** — 5–8 items, each scored 0–10 by a reviewer (human or LLM-as-judge).
5. **Document dead-ends** — the agent must note approaches it tried and abandoned in `NOTES.md`.
6. **Regression-tests prior evals' findings** — when an eval is re-run after a fix, prior failure modes appear in §
   "Anti-patterns to detect" so they cannot recur silently.
7. **Forces at least one escalation when appropriate** — at least one ambiguity per eval where the agent must consult
   the escalation order rather than guess.

When you re-run an eval after refactoring the bundle, diff the new transcript against the previous one. Score
regressions live under § "Anti-patterns to detect" in each prompt.
