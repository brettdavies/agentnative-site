#!/usr/bin/env -S uv run --no-project python3 -B
"""Web-audit scoring-model exploration tool (DEV ONLY, guarded from main).

Models the web-audit scoring algorithm so we can tune it against real audit
data before locking numbers into the engine. Not shipped: this directory is
blocked from `main` by the guard-main-docs workflow.

Design (from docs/plans/2026-07-09-002 and the "Fairness before public
scoring" vault reflection):

  - Two scores. RELATIVE ("for sites like yours") is the headline: earned
    points over the max achievable for THIS site's applicable set, so a
    site perfect for its type approaches 100. GLOBAL is context: earned
    over a maximally-agent-ready site's max, so a bigger/harder routine
    ranks higher (4/5 MUSTs > 2/2 MUSTs).
  - Outcome scale: n_a = null (excluded); absent = 0; pass = +value;
    broken = -BROKEN_FACTOR * value (a present-but-invalid surface misleads
    agents, so it is worse than absent). No partial/warn credit.
  - Difficulty weights per tier are deliberately UNLOCKED pending real
    anc100 data (n=1 today). Override with --weights must,should,may.

Usage:
    score_model.py                      # run the built-in scenarios
    score_model.py --weights 10,4,1     # try steeper difficulty
    score_model.py --broken 0.75        # broken penalty factor
    score_model.py --scorecard scorecards/web/anc.dev.json   # score real data
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field

# The check universe (id -> tier), from the refinements matrix. Update when the
# matrix tiers change. This is the denominator source for the GLOBAL score.
UNIVERSE: dict[str, str] = {
    # MUST
    "mcp-initialize": "must", "mcp-tools-list": "must", "openapi": "must",
    # SHOULD
    "mcp-capabilities": "should", "mcp-unknown-method": "should", "mcp-get-fast-fail": "should",
    "mcp-cors-preflight": "should", "mcp-cors-actual": "should", "well-known-mcp-card": "should",
    "llms-txt": "should", "accept-markdown": "should", "root-meta-description": "should",
    "noscript-fallback": "should", "robots": "should", "link-headers": "should",
    "root-link-rel": "should", "robots-ai-rules": "should", "content-signals": "should",
    # MAY
    "mcp-usage-doc": "may", "json-schemas": "may", "api-catalog": "may", "llms-full-txt": "may",
    "llms-txt-scoped": "may", "llms-full-txt-scoped": "may", "schema-org-jsonld": "may",
    "semantic-html": "may", "sitemap": "may", "dns-aid": "may", "web-bot-auth": "may",
    "security-txt": "may", "a2a-agent-card": "may", "agent-skills": "may",
    "oauth-discovery": "may", "oauth-protected-resource": "may",
}

TIERS = ("must", "should", "may")


@dataclass
class Model:
    weight: dict[str, float]
    broken_factor: float
    universe: dict[str, str] = field(default_factory=lambda: dict(UNIVERSE))

    def universe_max(self) -> float:
        return sum(self.weight[t] for t in self.universe.values())


def credit(outcome: str, broken_factor: float) -> float | None:
    """Per-check credit multiplier. None means excluded (n_a)."""
    return {"pass": 1.0, "absent": 0.0, "broken": -broken_factor}.get(outcome, None)


@dataclass
class Rows:
    """A site's per-check outcomes as (tier, outcome) pairs. outcome in
    {pass, absent, broken, n_a}."""

    items: list[tuple[str, str]]

    def score(self, m: Model) -> dict[str, float | int]:
        earned = 0.0
        applicable_max = 0.0
        for tier, outcome in self.items:
            c = credit(outcome, m.broken_factor)
            if c is None:  # n_a excluded from both
                continue
            earned += m.weight[tier] * c
            applicable_max += m.weight[tier]  # if this had passed
        relative = round(100 * earned / applicable_max) if applicable_max else 0
        global_ = round(100 * earned / m.universe_max())
        return {
            "earned": round(earned, 1),
            "relative": max(0, relative),
            "global": max(0, global_),
        }


def from_buckets(**buckets: int) -> Rows:
    """Build rows from per-tier bucket counts, e.g.
    from_buckets(must_pass=3, should_pass=15, may_pass=10, may_absent=6).

    MAY is truly optional: an absent MAY is n_a (excluded), never a 0. Only
    MUST/SHOULD absence counts as a 0. Present-but-broken counts at every tier."""
    items: list[tuple[str, str]] = []
    for tier in TIERS:
        for outcome in ("pass", "absent", "broken"):
            if tier == "may" and outcome == "absent":
                continue  # MAY absent -> n_a, excluded
            items += [(tier, outcome)] * buckets.get(f"{tier}_{outcome}", 0)
    return Rows(items)


def from_scorecard(path: str) -> Rows:
    """Map a committed web scorecard's results[] to outcomes. The current
    engine can't tell absent from broken, so `fail` maps to `absent`; the
    tri-state arrives with the refined engine."""
    data = json.load(open(path))
    items = []
    for row in data.get("results", []):
        tier = row.get("keyword") or UNIVERSE.get(row.get("id"), "may")
        status = row.get("status")
        if status == "pass":
            outcome = "pass"
        elif status == "fail":
            # MUST/SHOULD fail = absent (counted 0); MAY fail = absent = n_a (excluded).
            # The old engine can't tell absent from broken, so broken MAYs aren't
            # penalized here; the tri-state arrives with the refined engine.
            outcome = "n_a" if tier == "may" else "absent"
        else:
            outcome = "n_a"
        items.append((tier, outcome))
    return Rows(items)


SCENARIOS: dict[str, Rows] = {
    "big platform 4/5 MUST": from_buckets(must_pass=4, must_absent=1, should_pass=13, should_absent=2, may_pass=10, may_absent=6),
    "small site 2/2 MUST": from_buckets(must_pass=2, should_pass=8, may_pass=3, may_absent=13),
    "perfect content blog": from_buckets(should_pass=9, may_pass=4, may_absent=12),
    "perfect maximal platform": from_buckets(must_pass=3, should_pass=15, may_pass=16),
    "expansive but sloppy (8 broken MAY)": from_buckets(must_pass=3, should_pass=15, may_pass=6, may_broken=8),
    "required-only, zero optionals": from_buckets(must_pass=3, should_pass=15, may_absent=16),
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", default="5,3,1", help="must,should,may difficulty (default 5,3,1; UNLOCKED)")
    ap.add_argument("--broken", type=float, default=0.75, help="broken penalty factor (default 0.75)")
    ap.add_argument("--scorecard", help="score a committed web scorecard JSON instead of the scenarios")
    args = ap.parse_args()

    wm, ws, wy = (float(x) for x in args.weights.split(","))
    model = Model(weight={"must": wm, "should": ws, "may": wy}, broken_factor=args.broken)

    print(f"weights must/should/may = {wm}/{ws}/{wy} | broken = -{args.broken}x | "
          f"universe_max = {model.universe_max():g}\n")

    if args.scorecard:
        rows = from_scorecard(args.scorecard)
        r = rows.score(model)
        print(f"{args.scorecard}: relative {r['relative']}%  (global {r['global']}%, earned {r['earned']})")
        return 0

    print(f"{'scenario':40} {'relative':>9} {'global':>7} {'earned':>7}")
    print("-" * 68)
    for name, rows in SCENARIOS.items():
        r = rows.score(model)
        print(f"{name:40} {r['relative']:>8}% {r['global']:>6}% {r['earned']:>7}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
