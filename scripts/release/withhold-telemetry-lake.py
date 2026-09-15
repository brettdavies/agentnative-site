#!/usr/bin/env python3
"""Remove the telemetry-lake feature from a release tree.

The lake is complete on `dev` and withheld from releases: it publishes a
privacy posture page describing telemetry, binds a permanent R2 lake, and
schedules a daily freshness check whose stall alert calls `notify()`, which
returns `unprovisioned` while no `EMAIL` binding exists. Shipping that puts a
page making a promise, and an alert that cannot keep it, in front of
production.

Run this against a `release/*` branch after the overlay and the guarded-path
strip, before the release commit. `dev` keeps every line, so the feature ships
whole once the alert path is provisioned and this script is deleted.

The structured-log emitter stays. It has no user-facing surface and every
Worker log site routes through it.

Usage:
    scripts/release/withhold-telemetry-lake.py [--check]

    --check   Report what would change and exit non-zero if anything would,
              without writing. Use it to tell an already-withheld tree from
              one that still carries the lake.

Exit codes: 0 applied (or already clean); 1 drift, see stderr; 2 --check found
pending changes.

Drift is a hard error, never a skip. A file that exists but no longer contains
the expected text means the feature changed shape on `dev`; silently skipping
it would ship the lake. The residue check at the end is the real guard: it
fails on any surviving reference regardless of which edit missed.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]

# Files the feature owns outright.
DELETE = (
    "content/privacy.md",
    "src/worker/telemetry/lake-freshness.ts",
    "tests/telemetry-lake-freshness.test.ts",
    "docs/runbooks/sitewide-analytics.md",
)

# (path, exact text, replacement). Exact-match so drift errors instead of
# guessing.
EDITS: tuple[tuple[str, str, str], ...] = (
    # Build: stop emitting and linking the privacy page.
    ("src/build/07-subpages.mjs", "  { name: 'privacy', breadcrumb: 'Privacy' },\n", ""),
    ("src/build/10-sitemap.mjs", "    '/privacy',\n", ""),
    ("src/build/shell.mjs", '          <a href="/privacy">Privacy</a>\n', ""),
    # Worker: drop the lake cron and its bindings.
    (
        "src/worker/index.ts",
        "import { LAKE_FRESHNESS_CRON, type LakeFreshnessEnv, runLakeFreshnessCheck } from './telemetry/lake-freshness';\n",
        "",
    ),
    (
        "src/worker/index.ts",
        """  // Telemetry-lake freshness bindings. TELEMETRY_LAKE is the lake bucket
  // the daily cron lists for stall detection; TELEMETRY_ENVIRONMENT names
  // the deploy environment so the stall alert emails only from production
  // (everything else is log-only). Optional so tests that don't exercise
  // the cron can stub a minimal env.
  TELEMETRY_LAKE?: R2Bucket;
  TELEMETRY_ENVIRONMENT?: string;
""",
        "",
    ),
    (
        "src/worker/index.ts",
        """      case LAKE_FRESHNESS_CRON:
        await runLakeFreshnessCheck(env as LakeFreshnessEnv);
        return;
""",
        "",
    ),
    ("src/worker/telemetry/log.ts", "  | 'telemetry.lake-freshness'\n", ""),
    # Generated binding types.
    (
        "src/worker-configuration.d.ts",
        "\tTELEMETRY_LAKE: R2Bucket;\n\tSCORE_TELEMETRY: AnalyticsEngineDataset;",
        "\tSCORE_TELEMETRY: AnalyticsEngineDataset;",
    ),
    (
        "src/worker-configuration.d.ts",
        "\t\tTELEMETRY_LAKE: R2Bucket;\n\t\tSCORE_TELEMETRY: AnalyticsEngineDataset;",
        "\t\tSCORE_TELEMETRY: AnalyticsEngineDataset;",
    ),
    ("src/worker-configuration.d.ts", '\tTELEMETRY_ENVIRONMENT: "staging" | "production";\n', ""),
    ("src/worker-configuration.d.ts", '\t\tTELEMETRY_ENVIRONMENT: "staging";\n', ""),
    ("src/worker-configuration.d.ts", ' | "TELEMETRY_ENVIRONMENT"', ""),
    # A runbook link into the deleted analytics doc.
    (
        "docs/runbooks/live-scoring-monitoring.md",
        "# analytics token is the one to use (name in docs/runbooks/sitewide-analytics.md).\n",
        "# analytics token is the one to use (name in 1Password).\n",
    ),
    # wrangler.jsonc: logpush, the lake buckets, the daily cron, the env var.
    (
        "wrangler.jsonc",
        """  // Script-level Logpush opt-in. Without it the workers-trace-events
  // dataset receives nothing from this script and the telemetry-lake
  // export chain (Logpush → Pipelines → Iceberg on R2) has no input, with
  // no error anywhere. Inheritable key — env.staging restates it
  // explicitly per this repo's convention (see RELEASES-RATIONALE.md §
  // Wrangler env inheritance traps).
  "logpush": true,
""",
        "",
    ),
    (
        "wrangler.jsonc",
        """    },
    // TELEMETRY_LAKE — permanent Iceberg telemetry lake (the Logpush →
    // Pipelines sink target). Dedicated bucket pair so the lake's
    // lifecycle and credentials stay isolated from anc-score-cache, whose
    // prefix-scoped expiry rules must never touch lake data. Catalog +
    // Logpush setup: RELEASES.md § R2 telemetry-lake catalog and
    // docs/runbooks/sitewide-analytics.md.
    {
      "binding": "TELEMETRY_LAKE",
      "bucket_name": "anc-telemetry-lake"
    }
  ],
""",
        """    }
  ],
""",
    ),
    (
        "wrangler.jsonc",
        """  // Two schedules, dispatched in scheduled() on the controller's cron
  // string. Weekly: the web-board rescore, started through a single-flight
  // helper so a tick that lands during an in-flight batch coalesces
  // instead of running a second one (freshness between ticks comes from
  // the post-deploy hook POST /api/web-rescore and on-demand audits).
  // Daily at 06:00 UTC: the telemetry-lake freshness check, which lists
  // the lake bucket and alerts through the KV-deduped email path when the
  // newest ingest-written object is older than a day.
  "triggers": { "crons": ["0 9 * * SUN", "0 6 * * *"] },
""",
        """  // Weekly web-board rescore. The scheduled() handler starts the
  // web-rescore Workflow through a single-flight helper, so a tick that
  // lands during an in-flight batch coalesces instead of running a second
  // one. Freshness between ticks comes from the post-deploy hook
  // (POST /api/web-rescore) and on-demand audits.
  "triggers": { "crons": ["0 9 * * SUN"] },
""",
    ),
    (
        "wrangler.jsonc",
        """    "MCP_LEGACY_ENABLED": "true",
    // TELEMETRY_ENVIRONMENT names the deploy environment for the daily
    // lake-freshness check: the stall alert emails the operator only when
    // it reads "production"; every other value is log-only. Plain var,
    // not a secret — the value is just the environment's name.
    "TELEMETRY_ENVIRONMENT": "production"
  },
""",
        """    "MCP_LEGACY_ENABLED": "true"
  },
""",
    ),
    (
        "wrangler.jsonc",
        """      // Explicit restatement: `logpush` is an inheritable key, and without
      // the opt-in the workers-trace-events dataset receives nothing from
      // the staging script — the lake export chain goes dark silently.
      "logpush": true,
""",
        "",
    ),
    (
        "wrangler.jsonc",
        """      // Explicit override: `triggers` is an inheritable key, so staging
      // states its crons deliberately rather than silently inheriting the
      // top-level ones. Staging runs the same weekly rescore so its board
      // exercises the exact production path during soak, and the same
      // daily lake-freshness check, which is log-only off production. See
      // RELEASES-RATIONALE.md § Wrangler env inheritance traps.
      "triggers": { "crons": ["0 9 * * SUN", "0 6 * * *"] },
""",
        """      // Explicit override: `triggers` is an inheritable key, so staging
      // states its cron deliberately rather than silently inheriting the
      // top-level one. Staging runs the same weekly rescore so its board
      // exercises the exact production path during soak. See
      // RELEASES-RATIONALE.md § Wrangler env inheritance traps.
      "triggers": { "crons": ["0 9 * * SUN"] },
""",
    ),
    (
        "wrangler.jsonc",
        """        {
          "binding": "SCORE_CACHE",
          "bucket_name": "anc-score-cache-staging"
        },
        {
          "binding": "TELEMETRY_LAKE",
          "bucket_name": "anc-telemetry-lake-staging"
        }
""",
        """        {
          "binding": "SCORE_CACHE",
          "bucket_name": "anc-score-cache-staging"
        }
""",
    ),
    (
        "wrangler.jsonc",
        """        "WEB_AUDIT_DEBUG": "true",
        // TELEMETRY_ENVIRONMENT: any value other than "production" makes
        // the daily lake-freshness check log-only — the staging lake is
        // legitimately quiet most days, and routine staging alerts would
        // train the operator to ignore the production key.
        "TELEMETRY_ENVIRONMENT": "staging"
""",
        """        "WEB_AUDIT_DEBUG": "true"
""",
    ),
    # The cron drift-guard now describes one schedule, not two.
    (
        "tests/wrangler-config.test.ts",
        """  test('env.staging.triggers.crons is an explicit override that matches the top-level schedules', () => {
    // `triggers` is inheritable, so staging must state its crons
    // deliberately. Both envs run the same weekly web-rescore + daily
    // lake-freshness schedules; a staging block that silently drops the
    // override would re-inherit whatever top level says, and a divergent
    // schedule would mean soak no longer exercises the production path.
    expect(staging.triggers).toBeDefined();
    const stagingCrons = (staging.triggers as Record<string, unknown>).crons;
    const topCrons = (config.triggers as Record<string, unknown>).crons;
    expect(Array.isArray(stagingCrons)).toBe(true);
    expect(stagingCrons).toEqual(['0 9 * * SUN', '0 6 * * *']);
    expect(topCrons).toEqual(['0 9 * * SUN', '0 6 * * *']);
  });
""",
        """  test('env.staging.triggers.crons is an explicit override that matches the top-level schedule', () => {
    // `triggers` is inheritable, so staging must state its cron
    // deliberately. Both envs run the same weekly web-rescore; a staging
    // block that silently drops the override would re-inherit whatever top
    // level says, and a divergent schedule would mean soak no longer
    // exercises the production path.
    expect(staging.triggers).toBeDefined();
    const stagingCrons = (staging.triggers as Record<string, unknown>).crons;
    const topCrons = (config.triggers as Record<string, unknown>).crons;
    expect(Array.isArray(stagingCrons)).toBe(true);
    expect(stagingCrons).toEqual(['0 9 * * SUN']);
    expect(topCrons).toEqual(['0 9 * * SUN']);
  });
""",
    ),
    # Comment blocks whose describes are removed below.
    (
        "tests/wrangler-config.test.ts",
        """// The TELEMETRY_LAKE binding is non-inheritable per env, so both top-level
// (prod) and env.staging must declare it. Each env points at a DISTINCT
// bucket so staging traffic never lands in the permanent production lake —
// and the dedicated bucket pair keeps the lake's lifecycle and credentials
// isolated from anc-score-cache's prefix-scoped expiry rules. This guard
// fires loudly if either pin moves.

// Script-level Logpush opt-in: without `logpush: true` the
// workers-trace-events dataset receives nothing from the script, and the
// whole lake export chain (Logpush → Pipelines → Iceberg) goes dark with
// no error anywhere. `logpush` is an inheritable key; this repo states
// inheritable keys explicitly under env.staging, so both blocks are pinned.

""",
        "",
    ),
)

# Top-level `describe(...)`/`test(...)` blocks to remove wholesale, as
# (path, opening text).
BLOCKS = (
    ("tests/wrangler-config.test.ts", "describe('wrangler.jsonc — TELEMETRY_LAKE R2 bindings (telemetry plan U1)'"),
    ("tests/wrangler-config.test.ts", "describe('wrangler.jsonc — script-level logpush opt-in (telemetry plan U1)'"),
    ("tests/wrangler-config.test.ts", "describe('wrangler.jsonc — TELEMETRY_ENVIRONMENT var (telemetry plan U3)'"),
    (
        "tests/wrangler-config.test.ts",
        "describe('RELEASES.md — R2 telemetry-lake catalog setup commands (telemetry plan U1)'",
    ),
    ("tests/e2e/flows.e2e.ts", "test.describe('privacy posture page'"),
)

# Banner-delimited sections to remove whole, as (path, title substring). The
# suite separates sections with a rule comment; a section is removed from its
# rule through to the next one, so its prose goes with its tests.
BANNER_SECTIONS = (
    ("tests/wrangler-config.test.ts", "Telemetry-lake R2 bindings + Logpush opt-in"),
    ("tests/wrangler-config.test.ts", "TELEMETRY_ENVIRONMENT var"),
)

# Regex-delimited regions, as (path, pattern, replacement).
REGIONS = (
    (
        "tests/build.test.ts",
        r"\n  test\('privacy twin opens with frontmatter derived from its source; HTML stays clean'.*?\n  \}\);\n",
        "\n",
    ),
    (
        "tests/wrangler-config.test.ts",
        r"// The daily lake-freshness check names its environment from this var and\n(?:// .*\n)+\n",
        "",
    ),
    (
        "tests/wrangler-config.test.ts",
        r"// R2 Data Catalog enablement on the lake buckets lives in the Cloudflare\n(?:// .*\n)+\n",
        "",
    ),
    (
        "RELEASES.md",
        r"\n#### R2 telemetry-lake catalog\n.*?\n(?=## Live-scoring \(v3\) release procedure\n)",
        "\n",
    ),
)

# Nothing in a withheld tree may mention these.
RESIDUE = (
    "anc-telemetry-lake",
    "TELEMETRY_LAKE",
    "TELEMETRY_ENVIRONMENT",
    "lake-freshness",
    "sitewide-analytics",
    "logpush",
    "/privacy",
)


def _drop_block(text: str, opening: str) -> str | None:
    """Removes a brace-balanced block starting at `opening`, plus trailing blanks."""
    start = text.find(opening)
    if start == -1:
        return None
    i = text.index("{", start)
    depth = 0
    for j in range(i, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                end = text.find("\n", j)
                while end + 1 < len(text) and text[end + 1] == "\n":
                    end += 1
                return text[:start] + text[end + 1:]
    return None


RULE = "// " + "-" * 75 + "\n"


def _drop_banner_section(text: str, title: str) -> str | None:
    """Removes a rule-delimited section, from its rule through to the next one."""
    i = text.find(title)
    if i == -1:
        return None
    start = text.rfind(RULE, 0, i)
    if start == -1:
        return None
    # Two rules bracket the title; the section body follows the second.
    after_title = text.find(RULE, i)
    if after_title == -1:
        return None
    nxt = text.find(RULE, after_title + len(RULE))
    end = nxt if nxt != -1 else len(text)
    return text[:start] + text[end:]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="report without writing")
    args = ap.parse_args()

    changed: list[str] = []
    errors: list[str] = []

    for rel in DELETE:
        p = REPO / rel
        if not p.exists():
            continue
        changed.append(f"delete {rel}")
        if not args.check:
            subprocess.run(["trash", str(p)], check=True)

    for rel, old, new in EDITS:
        p = REPO / rel
        if not p.exists():
            continue
        s = p.read_text()
        n = s.count(old)
        if n == 0:
            continue  # already applied
        if n > 1:
            errors.append(f"{rel}: {n} matches for an edit expecting one; the feature changed shape")
            continue
        changed.append(f"edit   {rel}")
        if not args.check:
            p.write_text(s.replace(old, new))

    for rel, opening in BLOCKS:
        p = REPO / rel
        if not p.exists():
            continue
        s = p.read_text()
        if opening not in s:
            continue
        out = _drop_block(s, opening)
        if out is None:
            errors.append(f"{rel}: unbalanced braces after {opening[:60]}")
            continue
        changed.append(f"block  {rel}: {opening[:50]}")
        if not args.check:
            p.write_text(out)

    for rel, title in BANNER_SECTIONS:
        p = REPO / rel
        if not p.exists():
            continue
        t = p.read_text()
        if title not in t:
            continue
        out = _drop_banner_section(t, title)
        if out is None:
            errors.append(f"{rel}: could not bracket the section titled {title!r}")
            continue
        changed.append(f"section {rel}: {title}")
        if not args.check:
            p.write_text(out)

    for rel, pattern, repl in REGIONS:
        p = REPO / rel
        if not p.exists():
            continue
        s = p.read_text()
        if not re.search(pattern, s, re.DOTALL):
            continue
        changed.append(f"region {rel}")
        if not args.check:
            p.write_text(re.sub(pattern, repl, s, count=1, flags=re.DOTALL))

    if errors:
        for e in errors:
            print(f"DRIFT: {e}", file=sys.stderr)
        print("\nThe lake changed shape on dev. Update this script to match before cutting.", file=sys.stderr)
        return 1

    if args.check:
        if changed:
            print(f"would withhold the telemetry lake ({len(changed)} change(s)):")
            for c in changed:
                print(f"  {c}")
            return 2
        print("telemetry lake already withheld from this tree")
        return 0

    # Removing a block leaves the blank lines that surrounded it, which the
    # repo's formatter counts as an error. Format what was touched rather than
    # hand-patching each seam; `format` only reflows, so it cannot change
    # behaviour the way `check --write`'s lint fixes could.
    touched = sorted(
        {c.split(None, 1)[1].split(":", 1)[0].strip() for c in changed if not c.startswith("delete")}
    )
    formattable = [t for t in touched if t.endswith((".ts", ".mjs", ".js", ".json", ".jsonc"))]
    if formattable:
        subprocess.run(
            ["bun", "x", "biome", "format", "--write", *formattable],
            cwd=REPO,
            capture_output=True,
            check=False,
        )

    # The real guard: whichever edit missed, a surviving reference fails here.
    found = subprocess.run(
        ["rg", "-l", "--glob", "!bun.lock", "--glob", "!node_modules", "--glob", "!dist", "-e", "|".join(RESIDUE)],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=False,  # no matches exits 1, which is the good case
    )
    guarded = subprocess.run(
        [str(REPO / "scripts/release/guarded-paths.sh")],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    guarded_re = re.compile(guarded) if guarded else None
    self_rel = "scripts/release/withhold-telemetry-lake.py"
    residue = [
        ln
        for ln in found.stdout.splitlines()
        if ln.strip() and ln != self_rel and not (guarded_re and guarded_re.search(ln))
    ]
    if residue:
        print("DRIFT: telemetry-lake references survive in:", file=sys.stderr)
        for r in residue:
            print(f"  {r}", file=sys.stderr)
        return 1

    if not changed:
        print("telemetry lake already withheld from this tree")
        return 0
    print(f"withheld the telemetry lake ({len(changed)} change(s)); no references survive")
    return 0


if __name__ == "__main__":
    sys.exit(main())
