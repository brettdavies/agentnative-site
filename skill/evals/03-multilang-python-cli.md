# Eval 03 — Make a Python CLI agent-ready (cross-language guidance)

## Task

You are handed a small Python CLI written with Click. It is functional but human-oriented — it prints colored output
unconditionally, prompts for missing arguments interactively, and exits `1` for both "user error" and "internal
exception" without distinction. The team wants it to be operable by AI agents alongside humans.

You should bring it up to the agent-readiness standard **without rewriting it in Rust**. The standard's auditor has
limited source-analysis coverage for Python (it analyzes some patterns via ast-grep, but the bulk of the audit is the
behavioral layer — spawning the binary and inspecting `--help`, exit codes, output shape). Use that.

## Workdir

`/tmp/eval-multilang-python-cli-$(date +%s)/`

Set up the seed CLI:

```bash
mkdir -p /tmp/eval-multilang-python-cli-$(date +%s)
cd /tmp/eval-multilang-python-cli-$(date +%s)
uv venv && source .venv/bin/activate
uv pip install click
mkdir -p notesctl/notesctl
cat > notesctl/pyproject.toml <<'EOF'
[project]
name = "notesctl"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["click"]

[project.scripts]
notesctl = "notesctl.cli:main"
EOF
cat > notesctl/notesctl/__init__.py <<'EOF'
EOF
cat > notesctl/notesctl/cli.py <<'EOF'
import click

@click.group()
def main():
    """Manage notes."""

@main.command()
@click.option("--title", prompt=True, help="Note title")
def add(title):
    click.echo(click.style(f"Added note: {title}", fg="green"))

@main.command()
def list():
    for i in range(3):
        click.echo(click.style(f"#{i} sample note", fg="cyan"))
EOF
cd notesctl && uv pip install -e . && cd ..
which notesctl  # confirm the binary is on PATH
```

You now have a `notesctl` binary on the venv `$PATH`. That is your starting target.

## Required artifacts

1. `notesctl/` — the source tree with your fixes committed (`git init` inside, one commit per fix).
2. `notesctl/AGENTS.md` — per-project AGENTS.md.
3. `scorecard-before.json` and `scorecard-after.json` — auditor JSON output, before and after your fixes.
4. `language-notes.md` — at least three places where you consulted language-specific guidance (Click in this case)
   instead of forcing Rust-flavored idioms. Each entry: (a) the agent-readiness requirement you were fixing, (b) the
   Click idiom you used, (c) the file/section where you found the guidance.
5. `NOTES.md` — investigation log + self-score.

## The cross-language probe

The most important thing this eval tests is **whether you found the language-specific guidance** rather than
mechanically translating Rust patterns. Three Click-specific behaviors you should encounter:

- `@click.option("--title", prompt=True)` is the Click idiom for interactive prompting. Removing it (or gating it on
  `sys.stdin.isatty()`) is the agent-readiness fix. Note the **convention** for stdin-driven non-interactivity in Click,
  which differs from the Rust/clap pattern of "always require, no `prompt`".
- Click's `click.style(..., fg=...)` always emits ANSI escapes by default. Click respects `NO_COLOR` via `click.style`
  only when wrapped — figure out the canonical idiom (it is **not** `if not isatty: skip color`).
- Click does not provide a built-in `--output json` enum the way clap does with `ValueEnum`. The canonical Click pattern
  uses `click.Choice([...])`. Use it, do not invent your own validation layer.

## Success criteria (score 0–10 each)

1. **Language-specific guidance was consulted.** `language-notes.md` lists at least three Click-specific idioms with
   file/section pointers (e.g. `references/<reference-file>.md § <section-name>`). If you wrote `match ... { ... }` Rust
   pseudocode in your plan instead of Click, that is a fail.
2. **`auditor --command notesctl` works.** You used the binary-name resolution path rather than pointing the auditor at
   a non-Rust source tree (which has limited Python coverage). The auditor still produces a usable scorecard.
3. **Prompt removal honors the spec.** Click's `prompt=True` was either removed, replaced with a required-flag pattern,
   or gated on TTY — and the choice is justified in `NOTES.md` by quoting the relevant P1 requirement.
4. **NO_COLOR is honored.** Running `NO_COLOR=1 notesctl list | cat` produces no ANSI escapes. The fix uses Click's
   canonical idiom, not a hand-rolled `os.environ.get("NO_COLOR")` check.
5. **Exit codes are distinguished.** Running `notesctl add --title 'x' < /dev/null` (where input is missing) exits with
   one code; an internal exception exits with another. The codes match the spec's P4 mapping (look it up).
6. **Structured output exists.** `notesctl list --output json` (or whatever flag you picked) produces parseable JSON.
   `notesctl list --output json | jq '.[0].title'` succeeds.
7. **AGENTS.md is honest.** The AGENTS.md you wrote names this is a Python/Click CLI and points future agents at `uv pip
   install -e .` (or similar) for setup. Do not paste the Rust starter template's AGENTS.md verbatim.
8. **Behavioral-vs-source layer understood.** `NOTES.md` explains in 2–3 sentences why the auditor's source layer is
   limited for Python and which finding categories you cannot get without the binary running.

## Anti-patterns to detect

- **Forcing Rust starter templates onto Python code.** `clap-main.rs` is not a Python file. If your transcript shows you
  copying it and then deleting it, document the dead end. Better: you read the language idioms file first.
- **Hand-rolled JSON serialization when Click + `json` would suffice.** Click + the stdlib `json` module is the
  canonical idiom for Click apps that need `--output json`. Custom serializers are a smell.
- **Ignoring `--audit-profile`.** Click-style CLIs that legitimately prompt are NOT TUIs in the `human-tui` sense — if
  you reached for `--audit-profile human-tui` to silence the prompt failure, that is wrong. The fix is to remove the
  prompt, not to declare yourself exempt.
- **80% floor or schema 0.5.** Either string in your notes is wrong; check the actual values from
  `scorecard-after.json`.
- **Counting source-layer rows toward the score.** `anc`'s source-layer coverage is Rust-only; for a Python tool the
  source layer is essentially absent and the score is computed from behavioral-layer rows only anyway. Do not try to
  "fix" missing source-layer rows by adding Rust — they are out of scope for `score_pct` even on Rust tools. Read
  `spec/principles/scoring.md` § "Scope: shipped-binary behavior only" if you need the contract.

## Escalation rule

When the spec text and the language guidance disagree (or seem to), the spec is authoritative for the **requirement**,
the language guidance is authoritative for the **idiom that satisfies it**. The lookup order is:

1. Canonical spec file (`spec/principles/p<N>-*.md`) for what the rule actually requires.
2. Language-idioms reference (the file that covers Python/Click/argparse).
3. Click's own docs at <https://click.palletsprojects.com> for any Click-specific question the bundle's reference does
   not cover.
4. Ask the user only if the requirement itself is ambiguous (which is rare; usually the rule is clear and only the idiom
   is in question).

Document escalations in `NOTES.md` § "Escalations".

## What "done" looks like

`scorecard-after.json` exists, has fewer `fail` rows than `scorecard-before.json`, and `language-notes.md` shows three
distinct Click-specific decisions. `NOTES.md` ends with a § "Self-score" table covering all eight criteria.
