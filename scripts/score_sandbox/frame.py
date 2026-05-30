"""Data layer: load 0.6 scorecards, build the long-form frame, and emit the
parquet + CSV artifacts. Polars lives here and nowhere else."""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import polars as pl


def load(data_dir: Path) -> dict[str, list[dict]]:
    """Load 0.6 scorecards, keeping only binary-behavior rows, keyed by slug."""
    out: dict[str, list[dict]] = {}
    dropped = 0
    for f in sorted(data_dir.glob("*.json")):
        rows = json.loads(f.read_text())["results"]
        behavioral = [r for r in rows if r.get("layer", "behavioral") == "behavioral"]
        dropped += len(rows) - len(behavioral)
        out[f.stem] = behavioral
    if dropped:
        print(f"note: dropped {dropped} non-behavioral rows (out of binary scope)", file=sys.stderr)
    return out


def profile(rows: list[dict]) -> dict[str, int]:
    """Status -> count for one tool."""
    c: dict[str, int] = {}
    for r in rows:
        c[r["status"]] = c.get(r["status"], 0) + 1
    return c


def long_frame(cards: dict[str, list[dict]]) -> pl.DataFrame:
    """One row per audit per tool: slug, audit_id, status, layer, tier."""
    rows = [
        {
            "slug": slug,
            "audit_id": r.get("id", ""),
            "status": r["status"],
            "layer": r.get("layer", ""),
            "tier": r.get("tier") or "must",
        }
        for slug, results in cards.items()
        for r in results
    ]
    return pl.DataFrame(rows)


def write_long_parquet(cards: dict[str, list[dict]], path: Path) -> None:
    long_frame(cards).write_parquet(path)


def write_tools_csv(
    scored: dict[str, dict[str, int]],
    columns: list[str],
    prod_col: str,
    path: Path,
) -> None:
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["slug", *columns])
        for s in sorted(scored, key=lambda s: scored[s][prod_col], reverse=True):
            w.writerow([s, *(scored[s][c] for c in columns)])
