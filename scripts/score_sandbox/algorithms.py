"""Survey algorithms — the file you edit to add or tweak candidates. Each is a
function from a tool's rows to a 0-100 score, registered with a one-line doc.
Compose the primitives in scoring.py; read tunable knobs from config.py."""

from __future__ import annotations

from . import config
from .registry import algorithm
from .scoring import current as live_current
from .scoring import weighted_ratio

FLAT = {"must": 1.0, "should": 1.0, "may": 1.0}
W123 = {"must": 1.0, "should": 2.0, "may": 3.0}
W124 = {"must": 1.0, "should": 2.0, "may": 4.0}


@algorithm("PROD", "the tunable knobs in config.py (current PROD config shown above)")
def prod(rows: list[dict]) -> int:
    return weighted_ratio(rows, config.PROD_TIER_WEIGHTS, config.PROD_OPT_OUT_IN_DENOM, config.EXEC_CREDIT)


@algorithm("A_current", "live formula `pass / (pass + warn + fail)`, no weights, opt_out excluded")
def a_current(rows: list[dict]) -> int:
    return live_current(rows)


@algorithm("flat_excl", "flat 1/1/1 weights; opt_out excluded")
def flat_excl(rows: list[dict]) -> int:
    return weighted_ratio(rows, FLAT, False, config.EXEC_CREDIT)


@algorithm("flat_IN", "flat 1/1/1 weights; opt_out counted")
def flat_in(rows: list[dict]) -> int:
    return weighted_ratio(rows, FLAT, True, config.EXEC_CREDIT)


@algorithm("w123_excl", "skating 1/2/3 weights; opt_out excluded")
def w123_excl(rows: list[dict]) -> int:
    return weighted_ratio(rows, W123, False, config.EXEC_CREDIT)


@algorithm("w123_IN", "skating 1/2/3 weights; opt_out counted")
def w123_in(rows: list[dict]) -> int:
    return weighted_ratio(rows, W123, True, config.EXEC_CREDIT)


@algorithm("w124_IN", "steep 1/2/4 weights; opt_out counted")
def w124_in(rows: list[dict]) -> int:
    return weighted_ratio(rows, W124, True, config.EXEC_CREDIT)
