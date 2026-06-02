# Live-scoring ops wrappers

JSON-emitting wrappers around the operator write actions documented in
[`docs/runbooks/live-scoring-monitoring.md`](../../docs/runbooks/live-scoring-monitoring.md). Each script writes a
single JSON object to stdout in the shape:

```jsonc
{
  "check": "<name>",
  "env": "staging" | "production",
  "status": "ok" | "dry-run" | "error",
  "checked_at": "<RFC 3339 timestamp>",
  "evidence": { /* per-action fields */ }
}
```

Exit codes:

| Code | Meaning                           |
| ---- | --------------------------------- |
| `0`  | `status: ok` or `status: dry-run` |
| `3`  | prerequisite missing              |
| `4`  | `status: error`                   |

Write actions don't carry threshold semantics, so there's no `warn` / `alarm` status here. The `evidence` block records
the would-run command, the wrangler exit code, and stdout / stderr so a consumer can attach the receipt to an incident
log or retro doc.

This directory holds write actions. The read counterpart lives at [`scripts/monitoring/`](../monitoring/) (see
[`scripts/monitoring/README.md`](../monitoring/README.md) for the four `check-*.sh` wrappers + JSON envelope + exit-code
contract that this README mirrors).

## Scripts

| Script                | Purpose                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| `flip-kill-switch.sh` | Set or clear `SCORE_KV.scoring_disabled`. `--on` puts `true`, `--off` deletes. |

## Common invocation

```bash
scripts/ops/flip-kill-switch.sh --on|--off [--env staging|production] [--dry-run] [--yes] [--help]
```

`--on` or `--off` is required. `--env staging` is the default. `production` drops the wrangler `--env` flag (the
top-level wrangler config targets prod).

`--dry-run` emits the JSON envelope with `status: "dry-run"` and an `evidence.would_run` array listing the remote
command the script would have fired. No wrangler call is made. Exit code is `0`. Useful for previewing the wrangler
command before flipping, or smoke-testing the wrapper without write authority.

## Production safety

Production flips (either direction) require `--yes`. Staging flips are free. Rationale:

- `--on` against production turns `/api/score` live requests into 503 `Retry-After: 3600`. A typo here is an outage.
- `--off` against production restores live traffic. A flip-off issued too early (before the underlying incident is
  resolved) re-exposes the cost ceiling that the operator just paid an alert to defend.

Recovery time is bounded by the in-isolate cache TTL (30 s) and KV global propagation (≤60 s); allow up to a minute for
the flip to land everywhere.

## Dependencies

- `bun x wrangler` for the KV write.
- `jaq` (preferred) or `jq` for JSON shaping.

The wrangler call uses the operator's existing wrangler auth flow; no separate Cloudflare API token is needed.

## See also

- [`scripts/monitoring/README.md`](../monitoring/README.md): the four read-only `check-*.sh` wrappers and the shared
  JSON envelope contract.
- [Kill-switch flip playbook](../../docs/runbooks/live-scoring-monitoring.md#kill-switch-flip-manual-incident-response):
  when to flip and the raw wrangler equivalent the wrapper calls under the hood.
- [Agent-deterministic checks](../../docs/runbooks/live-scoring-monitoring.md#agent-deterministic-checks): why these
  wrappers exist alongside the inline MCP queries documented next to each manual check.
