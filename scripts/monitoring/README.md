# Live-scoring monitoring wrappers

JSON-emitting wrappers around the manual checks documented in
[`docs/runbooks/live-scoring-monitoring.md`](../../docs/runbooks/live-scoring-monitoring.md). Each script writes a
single JSON object to stdout in the shape:

```jsonc
{
  "check": "<name>",
  "env": "staging" | "production",
  "status": "ok" | "warn" | "alarm" | "error",
  "checked_at": "<RFC 3339 timestamp>",
  "evidence": { /* per-check fields */ }
}
```

Exit codes:

| Code | Meaning              |
| ---- | -------------------- |
| `0`  | `status: ok`         |
| `1`  | `status: warn`       |
| `2`  | `status: alarm`      |
| `3`  | prerequisite missing |
| `4`  | `status: error`      |

Status semantics follow
[`live-scoring-monitoring.md § Threshold table`](../../docs/runbooks/live-scoring-monitoring.md#threshold-table). The
`evidence` block carries the raw inputs the script consulted; consumers can recompute the verdict from it without
re-running the check.

The four wrappers cover the U10 agent-deterministic-check surface alongside the inline `Agent (MCP)` queries already
documented next to each manual check in the monitoring runbook. Either path produces the same answer; pick by audience
(JSON wrappers for shell-driven CI / cron / operator scripts; MCP for IDE agents and conversational tooling).

## Scripts

| Script                       | Purpose                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `check-kill-switch.sh`       | Read `SCORE_KV.scoring_disabled` via wrangler. Tier-mix lever state.                 |
| `check-r2-cache.sh`          | Bucket reachability + 7-day lifecycle rule presence for `anc-score-cache[-staging]`. |
| `check-recent-deploys.sh`    | Last 5 Worker deploys via `wrangler deployments list`.                               |
| `check-error-tier-sample.sh` | Last 1 h error-code distribution via the Analytics Engine SQL API.                   |

## Common invocation

All four scripts accept:

```bash
scripts/monitoring/<script>.sh [--env staging|production] [--help]
```

`--env staging` is the default. `production` flips the wrangler `--env` flag (absent for prod) and the AE dataset name
(`anc_live_score_staging` → `anc_live_score_prod`).

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
