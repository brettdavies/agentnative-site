"""Orchestration: load the 0.6 scorecards, score every registered algorithm, and
emit the long-form parquet, per-tool CSV, and markdown report."""

from __future__ import annotations

import sys

# Importing algorithms registers them in the shared ALGORITHMS dict.
from . import algorithms as _algorithms  # noqa: F401
from . import config, report
from .frame import load, write_long_parquet, write_tools_csv
from .registry import ALGORITHMS


def main() -> int:
    if not config.DATA_DIR.exists():
        print(f"error: missing data dir {config.DATA_DIR}", file=sys.stderr)
        return 1
    cards = load(config.DATA_DIR)
    if not cards:
        print(f"error: no scorecards in {config.DATA_DIR}", file=sys.stderr)
        return 1

    scored = {
        slug: {name: alg.fn(rows) for name, alg in ALGORITHMS.items()}
        for slug, rows in cards.items()
    }

    config.OUT_DIR.mkdir(parents=True, exist_ok=True)
    (config.OUT_DIR / "report.md").write_text(report.render(cards, scored))
    write_tools_csv(scored, list(ALGORITHMS), config.PROD_COL, config.OUT_DIR / "tools.csv")
    write_long_parquet(cards, config.OUT_DIR / "long.parquet")

    print((config.OUT_DIR / "report.md").read_text())
    for label, name in (("report", "report.md"), ("per-tool", "tools.csv"), ("long-form", "long.parquet")):
        print(f"{label}: {(config.OUT_DIR / name).relative_to(config.REPO)}", file=sys.stderr)
    return 0
