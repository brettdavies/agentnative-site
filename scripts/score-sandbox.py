#!/usr/bin/env -S uv run python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "polars>=1.0",
# ]
# ///
"""Score-algorithm sandbox.

Loads every latest-version scorecard plus the coverage-matrix, joins per-check tier
metadata onto each result row, and computes several candidate scoring algorithms
side-by-side as a polars DataFrame. Emits into `.context/score-sandbox/` (gitignored
local-only artifact dir per the repo's `.context/` convention):

    .context/score-sandbox/long.parquet   long-form dataframe (one row per check per tool)
    .context/score-sandbox/tools.csv      per-tool aggregate scores (one row per tool)
    .context/score-sandbox/report.md      markdown report (eligibility, distribution, leaderboard)

Pure read-only against the host repo's tracked data. Does not touch the CLI or scorecards/.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import polars as pl

REPO = Path(__file__).resolve().parent.parent
SCORECARDS = REPO / "scorecards"
COVERAGE = REPO / "src/data/coverage-matrix.json"
OUT_DIR = REPO / ".context/score-sandbox"

VERSION_RE = re.compile(r"^(.+)-v([0-9].*)\.json$")


def parse_version(v: str) -> tuple[int, ...]:
    return tuple(int(x) if x.isdigit() else 0 for x in v.split("."))


def load_tier_lookup() -> dict[str, str]:
    matrix = json.loads(COVERAGE.read_text())
    lookup: dict[str, str] = {}
    for row in matrix["rows"]:
        for v in row.get("verifiers", []):
            lookup[v["check_id"]] = row["level"]  # must | should | may
    lookup.setdefault("p3-version", "must")
    return lookup


def load_latest_scorecards() -> list[dict]:
    """Pick the highest-versioned scorecard per slug."""
    seen: dict[str, dict] = {}
    for f in sorted(SCORECARDS.glob("*.json")):
        m = VERSION_RE.match(f.name)
        if not m:
            continue
        slug, version = m.group(1), m.group(2)
        prior = seen.get(slug)
        if prior is None or parse_version(version) > parse_version(prior["version"]):
            data = json.loads(f.read_text())
            seen[slug] = {"slug": slug, "version": version, "file": f.name, "data": data}
    return sorted(seen.values(), key=lambda x: x["slug"])


def build_long_frame(cards: list[dict], tiers: dict[str, str]) -> pl.DataFrame:
    """One row per check per tool: slug, version, check_id, status, layer, tier."""
    rows = []
    for card in cards:
        for r in card["data"]["results"]:
            rows.append(
                {
                    "slug": card["slug"],
                    "version": card["version"],
                    "check_id": r["id"],
                    "status": r["status"],
                    "layer": r.get("layer", ""),
                    "tier": tiers.get(r["id"], "must"),
                }
            )
    return pl.DataFrame(rows)


# ───── scoring expressions ─────────────────────────────────────────────────


def weighted_score(
    weights: dict[str, float],
    *,
    may_warn_as_skip: bool = False,
    skip_in_denom: bool = False,
    exec_pass: float = 1.0,
    exec_warn: float = 0.5,
    exec_fail: float = 0.0,
) -> pl.Expr:
    """Element-value: sum(base * exec) / sum(base over denom rows).

    `skip_in_denom=False` (default): denominator = base over pass/warn/fail only.
        Rewards tools whose evaluated set is mostly passes — "ratio under tier weights."
    `skip_in_denom=True`: denominator = base over pass/warn/fail/skip.
        True skating model: skip earns no points but its base still appears in the
        ceiling, so a tool that didn't attempt the check pays for that absence.
    `may_warn_as_skip`: reclassify MAY-tier `warn` to `skip` before applying the
        skip-handling rule. Lets "MAY non-adoption shouldn't count against you"
        compose with either denominator stance.
    """
    tier_w = (
        pl.when(pl.col("tier") == "must")
        .then(weights["must"])
        .when(pl.col("tier") == "should")
        .then(weights["should"])
        .when(pl.col("tier") == "may")
        .then(weights["may"])
        .otherwise(1.0)
    )
    eff_status = (
        pl.when((pl.col("tier") == "may") & (pl.col("status") == "warn") & may_warn_as_skip)
        .then(pl.lit("skip"))
        .otherwise(pl.col("status"))
    )
    exec_mult = (
        pl.when(eff_status == "pass")
        .then(exec_pass)
        .when(eff_status == "warn")
        .then(exec_warn)
        .when(eff_status == "fail")
        .then(exec_fail)
        .otherwise(0.0)  # skip → contributes 0 to numerator
    )
    if skip_in_denom:
        # Denom rows: every status except `error` (probe broke; anc-side bug).
        denom_valid = eff_status != "error"
    else:
        # Denom rows: only pass/warn/fail.
        denom_valid = eff_status.is_in(["pass", "warn", "fail"])
    num = (tier_w * exec_mult).filter(denom_valid).sum()
    denom = tier_w.filter(denom_valid).sum()
    return (
        pl.when(denom > 0)
        .then((num / denom * 100).round(0))
        .otherwise(0)
        .cast(pl.Int64)
    )


def current_score() -> pl.Expr:
    pass_n = (pl.col("status") == "pass").sum()
    warn_n = (pl.col("status") == "warn").sum()
    fail_n = (pl.col("status") == "fail").sum()
    denom = pass_n + warn_n + fail_n
    return (
        pl.when(denom > 0)
        .then((pass_n / denom * 100).round(0))
        .otherwise(0)
        .cast(pl.Int64)
    )


def compliance_score() -> pl.Expr:
    """MUST + SHOULD only. MAY excluded from headline."""
    mask = pl.col("tier").is_in(["must", "should"])
    pass_n = ((pl.col("status") == "pass") & mask).sum()
    eval_n = (pl.col("status").is_in(["pass", "warn", "fail"]) & mask).sum()
    return (
        pl.when(eval_n > 0)
        .then((pass_n / eval_n * 100).round(0))
        .otherwise(0)
        .cast(pl.Int64)
    )


def extras_score() -> pl.Expr:
    """MAY adoption rate: pass / (pass + warn + fail + skip) over MAY-tier checks.

    Skip counts in the denominator so the metric reflects what fraction of the
    spec's MAY menu the tool adopts — including 'tool didn't ship this thing.'
    """
    mask = pl.col("tier") == "may"
    pass_n = ((pl.col("status") == "pass") & mask).sum()
    total_n = mask.sum()
    return (
        pl.when(total_n > 0)
        .then((pass_n / total_n * 100).round(0))
        .otherwise(0)
        .cast(pl.Int64)
    )


def weighted_blend(comp_weight: float = 0.85) -> pl.Expr:
    return (
        (compliance_score() * comp_weight + extras_score() * (1 - comp_weight))
        .round(0)
        .cast(pl.Int64)
    )


# ───── aggregation per tool ───────────────────────────────────────────────


def compute_tool_scores(long: pl.DataFrame) -> pl.DataFrame:
    tier_mix = (
        long.group_by("slug")
        .agg(
            (pl.col("tier") == "must").sum().alias("n_must"),
            (pl.col("tier") == "should").sum().alias("n_should"),
            (pl.col("tier") == "may").sum().alias("n_may"),
            pl.col("version").first(),
        )
    )

    scored = long.group_by("slug").agg(
        current_score().alias("A_current"),
        weighted_score({"must": 1, "should": 2, "may": 3}).alias("B_skating_1_2_3"),
        weighted_score({"must": 1, "should": 2, "may": 4}).alias("C_skating_1_2_4"),
        compliance_score().alias("D_compliance"),
        extras_score().alias("D_extras"),
        weighted_score({"must": 1, "should": 2, "may": 3}, may_warn_as_skip=True).alias(
            "E_skating_may_skip"
        ),
        weighted_blend(0.85).alias("F_weighted_85_15"),
        weighted_score({"must": 1, "should": 2, "may": 3}, skip_in_denom=True).alias(
            "G_ceiling_1_2_3"
        ),
        weighted_score(
            {"must": 1, "should": 2, "may": 3},
            skip_in_denom=True,
            may_warn_as_skip=True,
        ).alias("H_ceiling_may_skip"),
    )

    return tier_mix.join(scored, on="slug").sort("B_skating_1_2_3", descending=True)


# ───── reporting ──────────────────────────────────────────────────────────


def threshold_eligibility(df: pl.DataFrame, threshold: int) -> dict[str, int]:
    cols = [
        "A_current", "B_skating_1_2_3", "C_skating_1_2_4", "D_compliance",
        "E_skating_may_skip", "F_weighted_85_15", "G_ceiling_1_2_3", "H_ceiling_may_skip",
    ]
    out = {c: int(df.filter(pl.col(c) >= threshold).height) for c in cols}
    out["D_both"] = int(
        df.filter((pl.col("D_compliance") >= threshold) & (pl.col("D_extras") >= 50)).height
    )
    return out


def bucket_distribution(df: pl.DataFrame, col: str) -> list[int]:
    buckets = [(90, 100), (80, 89), (70, 79), (60, 69), (50, 59), (0, 49)]
    return [
        int(df.filter((pl.col(col) >= lo) & (pl.col(col) <= hi)).height)
        for (lo, hi) in buckets
    ]


def add_ranks(df: pl.DataFrame) -> pl.DataFrame:
    return df.with_columns(
        pl.col("A_current").rank("min", descending=True).cast(pl.Int64).alias("A_rank"),
        pl.col("B_skating_1_2_3").rank("min", descending=True).cast(pl.Int64).alias("B_rank"),
        pl.col("F_weighted_85_15").rank("min", descending=True).cast(pl.Int64).alias("F_rank"),
    ).with_columns(
        (pl.col("A_rank") - pl.col("B_rank")).alias("rank_delta_A_to_B"),
    )


def render_markdown(df: pl.DataFrame) -> str:
    lines: list[str] = []
    push = lines.append
    push("# Scoring sandbox — v0.4.0 rescore data")
    push("")
    push(f"Tools analyzed: {df.height}. Generated by `scripts/score-sandbox.py`.")
    push("")
    push("## Configurations")
    push("")
    push("- **A current** — `pass / (pass + warn + fail)`, skip/error excluded. Today's algorithm.")
    push("- **B skating 1/2/3** — element-value, weights MUST=1, SHOULD=2, MAY=3; pass=1.0 warn=0.5 fail=0.0; skip/error excluded.")
    push("- **C skating 1/2/4** — element-value, weights MUST=1, SHOULD=2, MAY=4; same execution multiplier as B.")
    push("- **D compliance / extras** — two numbers per tool. Compliance = MUST + SHOULD ratio (skip/error excluded). Extras = MAY pass rate against the full MAY menu (skips in denominator).")
    push("- **E skating + MAY→skip** — same weights as B, but MAY-warn results are reclassified as skip (excluded from numerator AND denominator).")
    push("- **F weighted 85/15** — single-number blend of D: `compliance × 0.85 + extras × 0.15`.")
    push("- **G ceiling 1/2/3** — same weights as B but `skip` is counted in the denominator (spec ceiling). True skating model: a tool that didn't attempt a check pays for the absence.")
    push("- **H ceiling + MAY→skip** — G with MAY-warn reclassified as skip. Tests whether shifting MAY-warns to skips meaningfully changes outcomes when the denominator already counts skips.")
    push("")

    push("## Eligibility counts")
    push("")
    e75 = threshold_eligibility(df, 75)
    e80 = threshold_eligibility(df, 80)
    push("| Threshold | A | B | C | D both | D comp | E | F | G | H |")
    push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    push(f"| ≥ 75 | {e75['A_current']} | {e75['B_skating_1_2_3']} | {e75['C_skating_1_2_4']} | {e75['D_both']} | {e75['D_compliance']} | {e75['E_skating_may_skip']} | {e75['F_weighted_85_15']} | {e75['G_ceiling_1_2_3']} | {e75['H_ceiling_may_skip']} |")
    push(f"| ≥ 80 | {e80['A_current']} | {e80['B_skating_1_2_3']} | {e80['C_skating_1_2_4']} | {e80['D_both']} | {e80['D_compliance']} | {e80['E_skating_may_skip']} | {e80['F_weighted_85_15']} | {e80['G_ceiling_1_2_3']} | {e80['H_ceiling_may_skip']} |")
    push("")

    push("## Distribution by score bucket")
    push("")
    cols_for_dist = [
        ("A_current", "A"),
        ("B_skating_1_2_3", "B"),
        ("C_skating_1_2_4", "C"),
        ("D_compliance", "D-comp"),
        ("D_extras", "D-ext"),
        ("E_skating_may_skip", "E"),
        ("F_weighted_85_15", "F"),
        ("G_ceiling_1_2_3", "G"),
        ("H_ceiling_may_skip", "H"),
    ]
    header = "| Bucket | " + " | ".join(label for _, label in cols_for_dist) + " |"
    push(header)
    push("| --- | " + " | ".join("---:" for _ in cols_for_dist) + " |")
    bucket_labels = ["90–100", "80–89", "70–79", "60–69", "50–59", "0–49"]
    bucket_data = {col: bucket_distribution(df, col) for col, _ in cols_for_dist}
    for i, label in enumerate(bucket_labels):
        row = "| " + label + " | " + " | ".join(str(bucket_data[col][i]) for col, _ in cols_for_dist) + " |"
        push(row)
    push("")

    df_ranked = add_ranks(df)

    # Sort leaderboard by G (true skating ceiling model) rather than B.
    df_ranked = df_ranked.sort("G_ceiling_1_2_3", descending=True)

    push("## Per-tool leaderboard (sorted by config G — true skating ceiling)")
    push("")
    push("| # | Slug | Version | M/S/m | A | B | C | D comp/ext | E | F | G | H | Δ rank A→G |")
    push("| ---: | --- | --- | :---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: | :---: |")
    df_ranked = df_ranked.with_columns(
        pl.col("G_ceiling_1_2_3").rank("min", descending=True).cast(pl.Int64).alias("G_rank"),
    ).with_columns(
        (pl.col("A_rank") - pl.col("G_rank")).alias("rank_delta_A_to_G"),
    )
    for i, row in enumerate(df_ranked.iter_rows(named=True), start=1):
        delta = row["rank_delta_A_to_G"]
        arrow = f"▲{delta}" if delta > 0 else (f"▼{-delta}" if delta < 0 else "–")
        push(
            f"| {i} | {row['slug']} | v{row['version']} | "
            f"{row['n_must']}/{row['n_should']}/{row['n_may']} | "
            f"{row['A_current']} | {row['B_skating_1_2_3']} | {row['C_skating_1_2_4']} | "
            f"{row['D_compliance']} / {row['D_extras']} | "
            f"{row['E_skating_may_skip']} | {row['F_weighted_85_15']} | "
            f"{row['G_ceiling_1_2_3']} | {row['H_ceiling_may_skip']} | {arrow} |"
        )
    push("")

    push("## Biggest A→B rank movers")
    push("")
    movers = df_ranked.sort("rank_delta_A_to_B", descending=True)
    push("### Climbers (rank ↑ going from A to B)")
    push("")
    push("| Slug | A rank | B rank | A% | B% | Δ rank |")
    push("| --- | ---: | ---: | ---: | ---: | :---: |")
    for row in movers.head(15).iter_rows(named=True):
        if row["rank_delta_A_to_B"] <= 0:
            continue
        push(
            f"| {row['slug']} | {row['A_rank']} | {row['B_rank']} | "
            f"{row['A_current']} | {row['B_skating_1_2_3']} | ▲{row['rank_delta_A_to_B']} |"
        )
    push("")
    push("### Fallers (rank ↓ going from A to B)")
    push("")
    push("| Slug | A rank | B rank | A% | B% | Δ rank |")
    push("| --- | ---: | ---: | ---: | ---: | :---: |")
    for row in movers.tail(15).iter_rows(named=True):
        if row["rank_delta_A_to_B"] >= 0:
            continue
        push(
            f"| {row['slug']} | {row['A_rank']} | {row['B_rank']} | "
            f"{row['A_current']} | {row['B_skating_1_2_3']} | ▼{-row['rank_delta_A_to_B']} |"
        )
    push("")

    return "\n".join(lines)


def main() -> int:
    if not COVERAGE.exists():
        print(f"error: missing {COVERAGE}", file=sys.stderr)
        return 1
    tiers = load_tier_lookup()
    cards = load_latest_scorecards()
    if not cards:
        print("error: no scorecards found", file=sys.stderr)
        return 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    long_path = OUT_DIR / "long.parquet"
    tools_path = OUT_DIR / "tools.csv"
    report_path = OUT_DIR / "report.md"

    long = build_long_frame(cards, tiers)
    long.write_parquet(long_path)

    df = compute_tool_scores(long)
    df.write_csv(tools_path)

    md = render_markdown(df)
    report_path.write_text(md)

    # Echo the markdown report to stdout so a `bash` invocation captures it.
    print(md)
    print(
        f"\n---\nlong-form dataframe: {long_path.relative_to(REPO)}  ({long.height} rows)",
        file=sys.stderr,
    )
    print(
        f"per-tool table:      {tools_path.relative_to(REPO)}  ({df.height} rows)",
        file=sys.stderr,
    )
    print(
        f"markdown report:     {report_path.relative_to(REPO)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
