# Eval 04: Prove the contract with black-box tests

## Task

You are handed a small Python CLI (seed below). It works, but it is human-oriented and carries several contract
violations you have not been told about. The team wants it operable by AI agents, and, just as important, they want a
**test suite the repo owns** that proves the agent-facing contract and keeps proving it in CI.

Research what behaviors an agent-ready CLI must exhibit and how a repo proves them with its own tests. Produce a
black-box test suite that covers at least: non-interactivity, structured output, help discovery, error behavior, and
composability. Prefer adapting proven, CI-green test files published by the standard's ecosystem over inventing a suite
from scratch. Run the suite before changing the CLI so the seeded violations fail first, then fix the CLI minimally
until the suite is green.

## Workdir

`/tmp/eval-prove-the-contract-$(date +%s)/`

Set up the seed CLI:

```bash
mkdir -p /tmp/eval-prove-the-contract-$(date +%s)
cd /tmp/eval-prove-the-contract-$(date +%s)
mkdir -p tinyctl
cat > tinyctl/tinyctl <<'EOF'
#!/usr/bin/env python3
import argparse
import json

ITEMS = {"1": "alpha", "2": "beta", "3": "gamma"}


def main():
    p = argparse.ArgumentParser(prog="tinyctl", description="Manage tiny items.")
    sub = p.add_subparsers(dest="verb")
    lp = sub.add_parser("list", help="List items")
    lp.add_argument("--output", choices=["text", "json"], default="text")
    gp = sub.add_parser("get", help="Get one item")
    gp.add_argument("id")
    ap = sub.add_parser("add", help="Add an item")
    ap.add_argument("--name")
    args = p.parse_args()
    if args.verb == "list":
        if args.output == "json":
            print(json.dumps({"items": [{"id": k, "name": v} for k, v in ITEMS.items()]}))
        else:
            for k, v in ITEMS.items():
                print(f"\033[36m#{k}\033[0m {v}")
    elif args.verb == "get":
        print(ITEMS[args.id])
    elif args.verb == "add":
        name = args.name or input("name: ")
        print(f"added {name}")
    else:
        p.print_help()


if __name__ == "__main__":
    main()
EOF
chmod +x tinyctl/tinyctl
./tinyctl/tinyctl list   # confirm the seed runs before you start
```

## Required artifacts

1. `tinyctl/`: the CLI plus a `tests/` directory containing your black-box suite, runnable with one command (name it in
   `NOTES.md`).
2. `test-run-red.txt`: captured runner output from the suite executed **before** any change to `tinyctl`, showing the
   seeded violations failing.
3. `test-run-green.txt`: captured runner output after your minimal fixes, all tests passing.
4. `ADAPTATION.md`: a table mapping each test (or test block) in your suite to (a) the published source file and named
   block you adapted it from, and (b) the principle it proves. Rows you wrote from scratch say so, with one line on why
   no adaptable block covered them.
5. `NOTES.md`: investigation log: what you researched, dead ends you abandoned (and why), escalations, and the
   self-score table.

Do not commit any of these; the workdir is throwaway.

## Success criteria (score 0-10 each)

1. **Discovery via description, not name.** You reached the testing guidance by following the relevant skill's entry
   points (its description, then its body pointers), not by being told a file name. `NOTES.md` records the hop from
   entry point to guidance.
2. **Adapted, not invented.** The suite is an adaptation of published, CI-green test files from the standard's
   ecosystem. `ADAPTATION.md` cites the source file and at least one named test block per adapted row, and the harness
   matches the guidance's language mapping for Python (spawn the binary; do not import its functions).
3. **Per-principle coverage.** At least P1, P2, P3, P4, and P6 each have one or more behavioral assertions, each with a
   concrete input, action, and expected observable.
4. **Red first.** `test-run-red.txt` predates any `tinyctl` change and shows the seeded violations failing for the right
   reasons (assertion messages name the observable, not a generic error).
5. **Black-box discipline.** Every test spawns the real binary and asserts observables only: exit codes, stdout and
   stderr as streams, parsed JSON fields, ANSI bytes. Structured assertions parse the JSON; none regex-match styled
   human text.
6. **Guardrail held.** Your fixes to `tinyctl` came from your own judgment or from implementation-guidance material,
   never from the testing guidance itself. `NOTES.md` names, for at least two fixes, where the idea came from; the
   testing layer only supplied the failing assertion.
7. **Every exit-code arm asserted.** The exit-code mapping you settled on for `tinyctl` has one test per documented
   code, including the trivial arms.

## Anti-patterns to detect

These are guardrail and regression markers. If your transcript shows any of these, flag them explicitly in `NOTES.md`:

- **Implementation recipe copied as "testing".** Pasting flag-wiring or handler code out of any guidance file into
  `tinyctl` and presenting it as part of the test work. Tests came from the prove-it layer; fixes are your own work.
- **White-box tests.** Importing `tinyctl` internals (functions, dicts) into the suite instead of spawning the binary.
  The contract is observable behavior; internal calls prove the wrong thing.
- **Invented coverage with an adaptable block available.** Hand-rolling a JSON-envelope or NO_COLOR test shape when the
  ecosystem file you already found contains a named block for it. Deviations are fine when justified in `ADAPTATION.md`;
  silent reinvention is the failure.
- **Green-only suite.** Tests written (or fixed) after the CLI change, so nothing ever failed. The red log is the
  evidence the suite actually guards the contract.
- **Regex-matching styled output.** Asserting on colored, column-aligned human text where a parseable format exists.
- **Schema pinning to 0.5 or an 80% badge floor.** Both values are wrong; source any number you write down from the
  artifacts the tools emit today.

## Escalation rule

You will hit at least one ambiguity the guidance does not resolve directly (a likely one: what, if anything, the
mutation-safety principle requires of `tinyctl add`, and whether a missing `--dry-run` is a violation or a non-adoption
for a tool this small). When that happens, the right order is:

1. The canonical principle files (vendored under `spec/principles/`).
2. The live, linked source files the testing guidance points at, read at the source repo's HEAD.
3. The auditor's own help and embedded schema, if you installed it.
4. As a last resort, ask the user.

Document the escalation you actually took in `NOTES.md` under an "Escalations" heading.

## What "done" looks like

`test-run-green.txt` shows the full suite passing against the fixed `tinyctl`; `test-run-red.txt` is preserved
unmodified from before the fixes; `ADAPTATION.md` maps every test to a source block and principle (or justifies a
from-scratch row); and `NOTES.md` ends with a "Self-score" table covering all seven criteria with one sentence of
justification each. A run that scores below 6 on any criterion is a fail; note what would need to change to lift the
score.
