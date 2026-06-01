# Live-scoring monitoring wrappers

JSON-emitting wrappers around the manual checks documented in
[`docs/runbooks/live-scoring-monitoring.md`](../../docs/runbooks/live-scoring-monitoring.md). Each script writes a
single JSON object to stdout in the shape:

```jsonc
{
  "check": "<name>",
  "env": "staging" | "production",
  "status": "ok" | "warn" | "alarm" | "dry-run" | "error",
  "checked_at": "<RFC 3339 timestamp>",
  "evidence": { /* per-check fields */ }
}
```

Exit codes:

| Code | Meaning                           |
| ---- | --------------------------------- |
| `0`  | `status: ok` or `status: dry-run` |
| `1`  | `status: warn`                    |
| `2`  | `status: alarm`                   |
| `3`  | prerequisite missing              |
| `4`  | `status: error`                   |

Status semantics follow
[`live-scoring-monitoring.md § Threshold table`](../../docs/runbooks/live-scoring-monitoring.md#threshold-table). The
`evidence` block carries the raw inputs the script consulted; consumers can recompute the verdict from it without
re-running the check.

This directory holds read-only checks. The write counterpart lives at [`scripts/ops/`](../ops/) (see
[`scripts/ops/README.md`](../ops/README.md) for `flip-kill-switch.sh` and any future operator actions).

## Scripts

| Script                       | Purpose                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `check-kill-switch.sh`       | Read `SCORE_KV.scoring_disabled` via wrangler. Tier-mix lever state.                 |
| `check-r2-cache.sh`          | Bucket reachability + 7-day lifecycle rule presence for `anc-score-cache[-staging]`. |
| `check-recent-deploys.sh`    | Last 5 Worker deploys via `wrangler deployments list`.                               |
| `check-error-tier-sample.sh` | Last 1 h error-code distribution via the Analytics Engine SQL API.                   |

## Common invocation

All four checks accept:

```bash
scripts/monitoring/<script>.sh [--env staging|production] [--dry-run] [--help]
```

`--env staging` is the default. `production` flips the wrangler `--env` flag (absent for prod) and the AE dataset name
(`anc_live_score_staging` → `anc_live_score_prod`).

`--dry-run` emits the JSON envelope with `status: "dry-run"` and an `evidence.would_run` array listing the remote
commands the script would have fired. No wrangler / curl call is made. Exit code is `0`. Useful for previewing what a
check will do, or smoke-testing the wrapper without credentials (the AE SQL check skips its `CF_ACCOUNT_ID` /
`CF_API_TOKEN` pre-check under `--dry-run`).

## Dependencies

- `bun x wrangler` for KV / R2 / deployments reads.
- `jaq` (preferred) or `jq` for JSON shaping.
- `curl` for the AE SQL API.
- `CF_ACCOUNT_ID` + `CF_API_TOKEN` env vars for `check-error-tier-sample.sh` only. Other checks rely on wrangler's
  existing auth flow.

## Why both surfaces

Per
[`live-scoring-monitoring.md § Agent-deterministic checks`](../../docs/runbooks/live-scoring-monitoring.md#agent-deterministic-checks).
The MCP queries serve IDE agents that already hold a Cloudflare MCP token. The JSON wrappers serve operators, CI, and
agents reaching Bash but not MCP. The wrappers keep the per-check answer reproducible from a shell prompt without a
Cloudflare API token in three of four cases (only the AE SQL check needs one).

## See also

- [`scripts/ops/README.md`](../ops/README.md): write-action wrappers (currently `flip-kill-switch.sh`) that follow the
  same JSON envelope + `--dry-run` contract documented here.
- [`docs/runbooks/live-scoring-monitoring.md`](../../docs/runbooks/live-scoring-monitoring.md): the manual playbooks
  these wrappers automate.
