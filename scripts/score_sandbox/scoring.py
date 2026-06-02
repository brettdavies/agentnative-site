"""Scoring primitives. Algorithms compose these; they encode the fixed status
semantics (which statuses land in the denominator), not tunable policy."""

from __future__ import annotations

# Statuses always in the denominator. n_a / skip / error are always excluded;
# opt_out is denominator policy decided per algorithm (see weighted_ratio).
DENOM_LIVE: tuple[str, ...] = ("pass", "warn", "fail")


def current(rows: list[dict]) -> int:
    """Live formula: pass / (pass + warn + fail). No weights; opt_out excluded."""
    p = sum(1 for r in rows if r["status"] == "pass")
    d = sum(1 for r in rows if r["status"] in DENOM_LIVE)
    return round(100 * p / d) if d else 0


def weighted_ratio(
    rows: list[dict],
    weights: dict[str, float],
    opt_out_in_denom: bool,
    exec_credit: dict[str, float],
) -> int:
    """sum(tier_weight * exec_credit) / sum(tier_weight) over in-denominator rows."""
    num = den = 0.0
    for r in rows:
        st = r["status"]
        w = weights.get(r.get("tier") or "must", 1.0)
        if st in DENOM_LIVE:
            num += w * exec_credit[st]
            den += w
        elif st == "opt_out" and opt_out_in_denom:
            num += w * exec_credit.get("opt_out", 0.0)
            den += w
    return round(100 * num / den) if den else 0
