#!/usr/bin/env -S uv run python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "polars>=1.0",
# ]
# ///
"""Score-algorithm sandbox entry point.

Loads schema-0.6 (7-status, per-row-tier) scorecards and computes candidate
scoring algorithms side by side, emitting a markdown report, a per-tool CSV, and
a long-form parquet into `.context/score-sandbox/` (gitignored local-only).

The logic lives in the `score_sandbox` package next to this file:
  score_sandbox/config.py      tunable knobs (PROD weights, floors, data source)
  score_sandbox/algorithms.py  add or tweak survey algorithms here
"""

import sys
from pathlib import Path

# Keep the tree clean: no __pycache__ next to the package. Set before importing
# score_sandbox so none of its modules are cached. Recompilation cost is trivial
# for an occasional analysis run.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from score_sandbox.run import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
