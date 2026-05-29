"""Score-algorithm sandbox (schema 0.6, binary-behavior scope).

Layout:
  config.py      tunable knobs (PROD weights, floors, data source) — edit to tune
  algorithms.py  the survey algorithms — add a registered function, touch nothing else
  scoring.py     scoring primitives the algorithms compose
  registry.py    the @algorithm registry the runner and report iterate
  frame.py       load 0.6 scorecards, build the long-form frame, emit parquet + CSV
  report.py      markdown report, generic over the registered algorithms
  run.py         orchestration

Run via `uv run scripts/score-sandbox.py`.
"""
