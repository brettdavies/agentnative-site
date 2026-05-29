"""Tunable settings. Edit here to slide the PROD column, change the eligibility
floors, or repoint the data source; the algorithms live in algorithms.py."""

from __future__ import annotations

import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# PROD knobs — the live-formula candidate the report tracks against the fixed grid.
PROD_TIER_WEIGHTS: dict[str, float] = {"must": 1.0, "should": 1.0, "may": 1.0}
PROD_OPT_OUT_IN_DENOM: bool = True
EXEC_CREDIT: dict[str, float] = {"pass": 1.0, "warn": 0.5, "fail": 0.0, "opt_out": 0.0}

# Report reference columns. The leaderboard sorts by PROD_COL and reports rank
# movement against BASELINE_COL; both must name a registered algorithm.
PROD_COL = "PROD"
BASELINE_COL = "A_current"

FLOORS: tuple[int, ...] = (70, 75, 80, 85, 90)
BUCKETS: tuple[tuple[int, int], ...] = (
    (90, 100),
    (80, 89),
    (70, 79),
    (60, 69),
    (50, 59),
    (0, 49),
)

# Where the 0.6 scorecards live. SANDBOX_DATA (absolute or repo-relative) overrides.
# Defaults to the local-rescore scratch dir; point at "scorecards" once the
# committed cards are regenerated at schema 0.6 (U6).
DATA_SUBDIR: str = ".context/u3-rescore/scratch"
DATA_DIR = REPO / os.environ.get("SANDBOX_DATA", DATA_SUBDIR)
OUT_DIR = REPO / ".context/score-sandbox"
