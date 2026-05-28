#!/usr/bin/env -S uv run python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Score-algorithm sandbox — schema 0.6, binary-behavior scope.

Loads 7-status (schema 0.6) scorecards, each result row carrying its own `tier`,
and computes candidate scoring algorithms side by side. Emits a markdown report
and a per-tool CSV into `.context/score-sandbox/` (gitignored local-only).

SCOPE: public leaderboard scores reflect SHIPPED-BINARY behavior only. Every row
consumed here is layer="behavioral" (`anc check --command <binary>`). Source and
repo-layer checks are out of scope for the badge — they belong to a future
advisory `--fix` mode. On the live leaderboard `anc` is the lone tool scored with
source access; in this sandbox it is scored binary-only like the rest, so the
comparison is apples-to-apples.

Status handling (fixed):
  pass / warn / fail  — always in the denominator; exec credit 1.0 / 0.5 / 0.0
  opt_out             — in the denominator iff PROD_OPT_OUT_IN_DENOM; credit 0.0
  n_a / skip / error  — always excluded from both numerator and denominator

──────────────────────────────────────────────────────────────────────────────
TUNABLE KNOBS — edit and re-run. The PROD column reflects these; the fixed
comparison columns never move, so PROD slides against a stable backdrop.
"""
PROD_TIER_WEIGHTS: dict[str, float] = {"must": 1.0, "should": 1.0, "may": 1.0}
PROD_OPT_OUT_IN_DENOM: bool = True
EXEC_CREDIT: dict[str, float] = {"pass": 1.0, "warn": 0.5, "fail": 0.0, "opt_out": 0.0}
FLOORS: tuple[int, ...] = (70, 75, 80, 85, 90)
# Where the 0.6 scorecards live. Defaults to the local-rescore scratch dir; point
# at "scorecards" once the committed cards are regenerated at schema 0.6 (U6).
DATA_SUBDIR: str = ".context/u3-rescore/scratch"
# ──────────────────────────────────────────────────────────────────────────────

import csv
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATA_DIR = REPO / os.environ.get("SANDBOX_DATA", DATA_SUBDIR)
OUT_DIR = REPO / ".context/score-sandbox"

DENOM_LIVE = ("pass", "warn", "fail")


def load() -> dict[str, list[dict]]:
    """Load 0.6 scorecards, keeping only binary-behavior rows."""
    out: dict[str, list[dict]] = {}
    dropped = 0
    for f in sorted(DATA_DIR.glob("*.json")):
        rows = json.loads(f.read_text())["results"]
        behavioral = [r for r in rows if r.get("layer", "behavioral") == "behavioral"]
        dropped += len(rows) - len(behavioral)
        out[f.stem] = behavioral
    if dropped:
        print(f"note: dropped {dropped} non-behavioral rows (out of binary scope)", file=sys.stderr)
    return out


def current(rows: list[dict]) -> int:
    """Live formula: pass / (pass + warn + fail). No weights; opt_out excluded."""
    p = sum(1 for r in rows if r["status"] == "pass")
    d = sum(1 for r in rows if r["status"] in DENOM_LIVE)
    return round(100 * p / d) if d else 0


def weighted_ratio(rows: list[dict], weights: dict[str, float], opt_out_in_denom: bool) -> int:
    """sum(tier_weight * exec_credit) / sum(tier_weight) over in-denominator rows."""
    num = den = 0.0
    for r in rows:
        st = r["status"]
        w = weights.get(r.get("tier") or "must", 1.0)
        if st in DENOM_LIVE:
            num += w * EXEC_CREDIT[st]
            den += w
        elif st == "opt_out" and opt_out_in_denom:
            num += w * EXEC_CREDIT["opt_out"]
            den += w
    return round(100 * num / den) if den else 0


FLAT = {"must": 1.0, "should": 1.0, "may": 1.0}
W123 = {"must": 1.0, "should": 2.0, "may": 3.0}
W124 = {"must": 1.0, "should": 2.0, "may": 4.0}

# PROD (from the knobs above) first, then a fixed comparison grid that never moves.
COLUMNS: dict[str, object] = {
    "PROD":      lambda r: weighted_ratio(r, PROD_TIER_WEIGHTS, PROD_OPT_OUT_IN_DENOM),
    "A_current": current,
    "flat_excl": lambda r: weighted_ratio(r, FLAT, False),
    "flat_IN":   lambda r: weighted_ratio(r, FLAT, True),
    "w123_excl": lambda r: weighted_ratio(r, W123, False),
    "w123_IN":   lambda r: weighted_ratio(r, W123, True),
    "w124_IN":   lambda r: weighted_ratio(r, W124, True),
}


def profile(rows: list[dict]) -> dict[str, int]:
    c: dict[str, int] = {}
    for r in rows:
        c[r["status"]] = c.get(r["status"], 0) + 1
    return c


def ranks(scored: dict[str, dict[str, int]], col: str) -> dict[str, int]:
    ordered = sorted(scored, key=lambda s: scored[s][col], reverse=True)
    out: dict[str, int] = {}
    prev = None
    rank = 0
    for i, s in enumerate(ordered, 1):
        if scored[s][col] != prev:
            rank, prev = i, scored[s][col]
        out[s] = rank
    return out


def render(cards: dict[str, list[dict]], scored: dict[str, dict[str, int]]) -> str:
    cols = list(COLUMNS)
    profs = {s: profile(rows) for s, rows in cards.items()}
    ra, rp = ranks(scored, "A_current"), ranks(scored, "PROD")
    weights_str = "/".join(str(int(PROD_TIER_WEIGHTS[t])) for t in ("must", "should", "may"))
    L: list[str] = []
    push = L.append

    push("# Scoring sandbox — schema 0.6, binary-behavior")
    push("")
    push(f"Tools analyzed: {len(cards)} (binary-behavior, schema 0.6). "
         f"Generated by `scripts/score-sandbox.py`.")
    push("")
    push(f"**PROD config:** tier weights MUST/SHOULD/MAY = {weights_str}; "
         f"`opt_out` {'IN' if PROD_OPT_OUT_IN_DENOM else 'EXCLUDED FROM'} the denominator; "
         f"exec credit pass/warn/fail/opt_out = 1.0/0.5/0.0/0.0; n_a/skip/error excluded.")
    push("")
    push("## Configurations")
    push("")
    push("- **PROD** — the tunable knobs at the top of this script (current: above).")
    push("- **A_current** — live formula `pass / (pass + warn + fail)`, no weights, opt_out excluded.")
    push("- **flat_excl / flat_IN** — flat 1/1/1 weights; opt_out excluded / counted.")
    push("- **w123_excl / w123_IN** — skating 1/2/3 weights; opt_out excluded / counted.")
    push("- **w124_IN** — steep 1/2/4 weights; opt_out counted.")
    push("")

    push("## Eligibility counts (tools at/above floor)")
    push("")
    push("| Floor | " + " | ".join(cols) + " |")
    push("| --- | " + " | ".join("---:" for _ in cols) + " |")
    for fl in FLOORS:
        cells = [str(sum(1 for s in scored if scored[s][c] >= fl)) for c in cols]
        push(f"| >= {fl} | " + " | ".join(cells) + " |")
    push("")

    push("## Distribution by score bucket")
    push("")
    push("| Bucket | " + " | ".join(cols) + " |")
    push("| --- | " + " | ".join("---:" for _ in cols) + " |")
    for lo, hi in [(90, 100), (80, 89), (70, 79), (60, 69), (50, 59), (0, 49)]:
        cells = [str(sum(1 for s in scored if lo <= scored[s][c] <= hi)) for c in cols]
        push(f"| {lo}-{hi} | " + " | ".join(cells) + " |")
    push("")

    push("## Median / min / max per column")
    push("")
    push("| Stat | " + " | ".join(cols) + " |")
    push("| --- | " + " | ".join("---:" for _ in cols) + " |")
    stats = {c: sorted(scored[s][c] for s in scored) for c in cols}
    push("| median | " + " | ".join(str(stats[c][len(stats[c]) // 2]) for c in cols) + " |")
    push("| min | " + " | ".join(str(stats[c][0]) for c in cols) + " |")
    push("| max | " + " | ".join(str(stats[c][-1]) for c in cols) + " |")
    push("")

    push("## Per-tool leaderboard (sorted by PROD)")
    push("")
    push("| # | Slug | P/W/F/O/NA/skip | " + " | ".join(cols) + " | Δrank A→PROD |")
    push("| ---: | --- | :---: | " + " | ".join("---:" for _ in cols) + " | :---: |")
    order = sorted(scored, key=lambda s: (scored[s]["PROD"], scored[s]["A_current"]), reverse=True)
    for i, s in enumerate(order, 1):
        p = profs[s]
        prof = (f"{p.get('pass',0)}/{p.get('warn',0)}/{p.get('fail',0)}/"
                f"{p.get('opt_out',0)}/{p.get('n_a',0)}/{p.get('skip',0)}")
        d = ra[s] - rp[s]
        arrow = f"▲{d}" if d > 0 else (f"▼{-d}" if d < 0 else "–")
        cells = " | ".join(str(scored[s][c]) for c in cols)
        push(f"| {i} | {s} | {prof} | {cells} | {arrow} |")
    push("")

    push("## Biggest rank movers, A_current → PROD")
    push("")
    movers = sorted(scored, key=lambda s: ra[s] - rp[s], reverse=True)
    push("| Slug | A% | PROD% | A rank | PROD rank | Δrank |")
    push("| --- | ---: | ---: | ---: | ---: | :---: |")
    for s in movers:
        d = ra[s] - rp[s]
        if d == 0:
            continue
        arrow = f"▲{d}" if d > 0 else f"▼{-d}"
        push(f"| {s} | {scored[s]['A_current']} | {scored[s]['PROD']} | {ra[s]} | {rp[s]} | {arrow} |")
    push("")
    return "\n".join(L)


def main() -> int:
    if not DATA_DIR.exists():
        print(f"error: missing data dir {DATA_DIR}", file=sys.stderr)
        return 1
    cards = load()
    if not cards:
        print(f"error: no scorecards in {DATA_DIR}", file=sys.stderr)
        return 1
    scored = {s: {c: COLUMNS[c](rows) for c in COLUMNS} for s, rows in cards.items()}

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    md = render(cards, scored)
    (OUT_DIR / "report.md").write_text(md)
    with (OUT_DIR / "tools.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["slug", *COLUMNS])
        for s in sorted(scored, key=lambda s: scored[s]["PROD"], reverse=True):
            w.writerow([s, *(scored[s][c] for c in COLUMNS)])

    print(md)
    print(f"\n---\nreport:    {(OUT_DIR / 'report.md').relative_to(REPO)}", file=sys.stderr)
    print(f"per-tool:  {(OUT_DIR / 'tools.csv').relative_to(REPO)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
