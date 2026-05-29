"""Algorithm registry. An algorithm is a named function from a tool's rows to an
integer 0-100 score, plus a one-line doc for the report. Register with the
@algorithm decorator; the runner and report iterate ALGORITHMS in insertion
order, so adding one needs no change to any core file."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

Scorer = Callable[[list[dict]], int]


@dataclass(frozen=True)
class Algorithm:
    name: str
    fn: Scorer
    doc: str


ALGORITHMS: dict[str, Algorithm] = {}


def algorithm(name: str, doc: str = "") -> Callable[[Scorer], Scorer]:
    def register(fn: Scorer) -> Scorer:
        if name in ALGORITHMS:
            raise ValueError(f"duplicate algorithm name: {name}")
        ALGORITHMS[name] = Algorithm(name, fn, doc)
        return fn

    return register
