#!/usr/bin/env -S uv run python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0"]
# ///
"""U3 local rescore harness (analysis-only, uncommitted output).

Reads registry.yaml, finds which tool binaries are installed on PATH, and runs
a locally-built `anc` (schema 0.6) against each to emit 7-status scorecards into
a scratch dir. Pure analysis input for the U3 formula decision; NOT the official
U6 rescore (that runs the released CLI via the docker/score harness).
"""
from __future__ import annotations
import json, shutil, subprocess, sys, os
from pathlib import Path
import yaml

REPO = Path(__file__).resolve().parent.parent
REGISTRY = REPO / "registry.yaml"
ANC = os.environ.get("ANC", str(Path.home() / "dev/agentnative-cli/target/release/anc"))
OUT = REPO / ".context/u3-rescore/scratch"


def load_registry() -> list[dict]:
    data = yaml.safe_load(REGISTRY.read_text())
    if isinstance(data, dict):
        data = data.get("tools", next(iter(data.values())))
    return [t for t in data if isinstance(t, dict) and "name" in t]


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    tools = load_registry()
    available, missing = [], []
    for t in tools:
        binary = t.get("binary") or t["name"]
        if shutil.which(binary):
            available.append((t["name"], binary))
        else:
            missing.append(t["name"])

    print(f"registry tools: {len(tools)}")
    print(f"installed locally: {len(available)}")
    print(f"missing: {len(missing)}")
    print()

    ok, failed = [], []
    for name, binary in available:
        dest = OUT / f"{name}.json"
        try:
            proc = subprocess.run(
                [ANC, "audit", "--command", binary, "--output", "json"],
                capture_output=True, text=True, timeout=120,
            )
            # anc exits non-zero on warn/fail; the JSON is still valid on stdout.
            data = json.loads(proc.stdout)
            dest.write_text(proc.stdout)
            s = data["summary"]
            ok.append(name)
            print(f"  [ok]   {name:<16} pass={s['pass']} warn={s['warn']} "
                  f"fail={s['fail']} opt_out={s['opt_out']} n_a={s['n_a']} "
                  f"skip={s['skip']} err={s['error']}")
        except Exception as e:  # noqa: BLE001
            failed.append((name, str(e)[:80]))
            print(f"  [FAIL] {name:<16} {e}")

    print()
    print(f"scored ok: {len(ok)}  failed: {len(failed)}")
    print(f"scratch dir: {OUT.relative_to(REPO)}")
    if missing:
        print()
        print("missing (not on PATH): " + ", ".join(sorted(missing)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
