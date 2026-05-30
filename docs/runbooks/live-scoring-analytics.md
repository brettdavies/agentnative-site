# Live-scoring analytics runbook

Queryable counterpart to the [live-scoring monitoring runbook](./live-scoring-monitoring.md). The monitoring runbook
covers manual playbooks, `wrangler tail`, kill-switch flips, and incident response. This runbook covers the Workers
Analytics Engine surface: canonical SQL for usage, performance, errors, and cost-efficiency aggregates.

Two datasets, one per environment:

| Environment | Binding           | Dataset                  |
| ----------- | ----------------- | ------------------------ |
| Production  | `SCORE_TELEMETRY` | `anc_live_score_prod`    |
| Staging     | `SCORE_TELEMETRY` | `anc_live_score_staging` |

Dataset names are configured in `wrangler.jsonc` at top-level (prod) and `env.staging`. The shape isolation is enforced
by `tests/wrangler-config.test.ts` so a future config refactor cannot accidentally merge the two datasets and pollute
prod aggregates with staging traffic.

Queries below are written against `anc_live_score_staging`. Swap the dataset name when querying production.

## Field schema

One `writeDataPoint` per `/api/score` request, emitted from `src/worker/score/handler.ts` in the same `try/finally`
block that emits the `score.tier` console log. The console log is the manual-recovery fallback when Analytics Engine is
down; this runbook covers the AE side.

| Slot      | Field         | Type                                                               | Notes                                                                                                |
| --------- | ------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `blob1`   | input kind    | `registry` \| `install-command` \| `github-url` \| `invalid`       | Mapped from `ValidatedInput.kind`; `registry` is the slug-matched case                               |
| `blob2`   | pm            | `npm` \| `cargo-binstall` \| `pip` \| `uv` \| `bun` \| `go` \| ... | Null when no `InstallSpec` was resolved (curated hit, cache hit, validation reject)                  |
| `blob3`   | error code    | `ScoreError.code` string                                           | Null on success                                                                                      |
| `blob4`   | freshness     | `live` \| `cache-hit` \| `registry-hit`                            | Null on error                                                                                        |
| `blob5`   | resolved step | `0.5-hints` \| `2-releases-asset` \| `3-crates` \| ...             | Set when discovery ran; `registry` for curated hits; null otherwise                                  |
| `double1` | total ms      | number                                                             | Worker handler wall clock                                                                            |
| `double2` | install ms    | number                                                             | Sandbox install exec duration; null on non-live paths                                                |
| `double3` | anc audit ms  | number                                                             | Sandbox anc-audit exec duration; null on non-live paths                                              |
| `double4` | status        | number                                                             | HTTP status code                                                                                     |
| `index1`  | tool          | string                                                             | Tool name or slug; cardinality target ≤10k. AE samples high-cardinality indexes automatically (1:N). |

The slot map is pinned by `tests/score-telemetry.test.ts`. Reordering blobs or doubles silently breaks every query
below; the regression test fires loudly if the order moves.

## Where to run

Cloudflare dashboard → Workers → Analytics Engine → SQL editor. Paste any query and run. Datasets appear on first write;
no `wrangler analytics-engine create` step.

Programmatic access via the Cloudflare API is available for the same queries; details in
[Cloudflare's Analytics Engine SQL API docs](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).

For the agent-friendly counterpart, see the [monitoring runbook's Agent (MCP) subsections](./live-scoring-monitoring.md)
which document `mcp__plugin_cloudflare_cloudflare-observability__query_worker_observability` calls inline next to each
manual check.

## Canonical queries

Each query is named so it can be referred to from incident retrospectives. Time windows default to 24 h; widen or narrow
as needed.

### Daily request volume by pm

Counts requests grouped by package manager. `null` rows are the requests that never resolved to an `InstallSpec`
(curated hits, cache hits, validation rejects).

```sql
SELECT
  blob2 AS pm,
  COUNT() AS requests
FROM anc_live_score_staging
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY pm
ORDER BY requests DESC
FORMAT JSONCompact
```

### p50 and p99 install + anc audit latency by pm

Quantiles on the sandbox-side timings (live paths only — registry hits and cache hits have null timings). Surfaces the
"which PM is the long tail?" question without leaving the dashboard.

```sql
SELECT
  blob2 AS pm,
  quantileTDigest(0.5)(double2) AS install_p50_ms,
  quantileTDigest(0.99)(double2) AS install_p99_ms,
  quantileTDigest(0.5)(double3) AS anc_audit_p50_ms,
  quantileTDigest(0.99)(double3) AS anc_audit_p99_ms,
  COUNT() AS live_runs
FROM anc_live_score_staging
WHERE timestamp > NOW() - INTERVAL '24' HOUR
  AND blob4 = 'live'
GROUP BY pm
ORDER BY live_runs DESC
FORMAT JSONCompact
```

### Error code distribution

Counts each `ScoreError` variant. Replaces the manual log-query approach the U9 monitoring runbook documented for the
"Error rate by code" signal; cross-reference the manual path as a fallback for AE outages.

```sql
SELECT
  blob3 AS error_code,
  COUNT() AS hits,
  AVG(double4) AS avg_status
FROM anc_live_score_staging
WHERE timestamp > NOW() - INTERVAL '24' HOUR
  AND blob3 IS NOT NULL
GROUP BY error_code
ORDER BY hits DESC
FORMAT JSONCompact
```

Compare against the [monitoring runbook's threshold table](./live-scoring-monitoring.md#threshold-table) for which codes
are user-driven (expected) versus signal-bearing (investigate).

### Registry-hit-rate: the cost-efficiency signal

Higher is cheaper: registry hits are unmetered (no Turnstile, no rate-limit budget, no DO dispatch). Track this number
over time; a decline indicates the registry is missing tools the homepage form is being asked to score.

```sql
SELECT
  COUNTIf(blob4 = 'registry-hit') / COUNT() AS registry_hit_rate,
  COUNTIf(blob4 = 'cache-hit') / COUNT() AS cache_hit_rate,
  COUNTIf(blob4 = 'live') / COUNT() AS live_rate,
  COUNT() AS total
FROM anc_live_score_staging
WHERE timestamp > NOW() - INTERVAL '24' HOUR
  AND blob3 IS NULL
FORMAT JSONCompact
```

The denominator excludes error rows so the rate reflects served traffic, not bounced traffic. Tier mix expectations
(when healthy: registry-hit + cache-hit dominant; live is the long tail) match the
[monitoring runbook's tier-mix signal](./live-scoring-monitoring.md#tier-mix).

### Top tools by request count

Sample-corrected count via the `_sample_interval` AE virtual column. `index1` cardinality target is ≤10k; AE
auto-samples beyond that, and the multiplier corrects for it.

```sql
SELECT
  index1 AS tool,
  SUM(_sample_interval) AS requests
FROM anc_live_score_staging
WHERE timestamp > NOW() - INTERVAL '24' HOUR
  AND index1 IS NOT NULL
GROUP BY tool
ORDER BY requests DESC
LIMIT 25
FORMAT JSONCompact
```

### Discovery-step attribution

Which discovery tier resolves live traffic. Answers "should we invest in the README parser, or focus on releases-asset
hints?"

```sql
SELECT
  blob5 AS resolved_step,
  COUNT() AS resolutions
FROM anc_live_score_staging
WHERE timestamp > NOW() - INTERVAL '24' HOUR
  AND blob4 = 'live'
  AND blob5 IS NOT NULL
GROUP BY resolved_step
ORDER BY resolutions DESC
FORMAT JSONCompact
```

`registry` rows in this output are curated registry hits (live paths that fell through to a registered tool via
post-discovery cache — rare). Discovery-only resolutions land under `0.5-hints` (zero-cost), `2-releases-asset`, `3-brew
| 3-crates | 3-npm | 3-pypi | 3-go`, or `4-readme-parse`.

### Cache hit composition (cross-source query)

Analytics Engine captures freshness but not the `cache_pre_attempted` / `cache_pre_hit` / `cache_post_attempted` /
`cache_post_hit` pair from the `score.tier` console log. To break down cache-hit traffic by pre-discovery vs
post-discovery, join the Analytics Engine counts above against the score.tier log query in the
[monitoring runbook](./live-scoring-monitoring.md#cache-hit-rate-pre-discovery-vs-post-discovery). Cross-source
correlation is the explicit cost of keeping the schema slim; widening the Analytics Engine blobs to carry both
`cache_pre` and `cache_post` booleans is a U10.x consideration if the cross-source dance becomes load-bearing.

## Threshold inheritance

The watch and alarm thresholds from the
[monitoring runbook's threshold table](./live-scoring-monitoring.md#threshold-table) apply directly to AE aggregates.
Same numbers, easier to compute. Move thresholds in the monitoring runbook; this runbook inherits.

When a watch fires:

1. Cross-reference the
   [monitoring runbook's common-failures section](./live-scoring-monitoring.md#common-failures-and-operator-response)
   for diagnostic commands and resolution paths.
2. If the symptom doesn't match a documented failure mode, capture the AE query output as evidence and open a follow-up
   issue against the live-scoring plan.

## AE sampling

Workers Analytics Engine samples high-cardinality indexes automatically. `index1` (tool name or slug) has a target of
≤10k distinct values; beyond that, the dashboard rows carry a `_sample_interval` multiplier and queries should multiply
by `SUM(_sample_interval)` to reflect the corrected count (see the "Top tools" query above).

Blob columns are not sampled; they're aggregated faithfully regardless of cardinality. The schema kept low-cardinality
fields in blobs precisely so the most-queried aggregates (tier mix, error distribution, pm breakdown) stay exact.

If `index1` cardinality grows past 10k in real traffic and sampling becomes a problem (queries get noisier than is
useful), the cheap escape hatch is to truncate `index1` to a shorter prefix or fold it into a blob. Both are
config-level changes; deferred until traffic warrants.

## Cross-references

- Field-shape contract: `src/worker/score/telemetry.ts` (`ScoreEventFields`) and `tests/score-telemetry.test.ts` (slot
  regression).
- Manual log-query playbook: [`docs/runbooks/live-scoring-monitoring.md`](./live-scoring-monitoring.md).
- Cost guardrails (rate limits, kill switch, Budget Alerts, deferred auto-kill):
  [`RELEASES.md` § Cost guardrails](../../RELEASES.md#cost-guardrails).
- Wrangler binding declarations: `wrangler.jsonc` (top-level + `env.staging`).
- Gate-ordering rationale (why registry + cache hits are unmetered):
  [`docs/solutions/architecture-patterns/cf-worker-gate-ordering-before-cost-bearing-outbounds-2026-05-20.md`](../solutions/architecture-patterns/cf-worker-gate-ordering-before-cost-bearing-outbounds-2026-05-20.md).
- Plan unit: `docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md` (U10 deliverable 3).
