# Live-scoring monitoring runbook

Operator playbook for `/api/score`. Manual + log-query workflow against the Wrangler observability binding; the primary
telemetry surface is the `score.tier` log line that `src/worker/score/handler.ts` emits once per request, with a
queryable Workers Analytics Engine counterpart (`SCORE_TELEMETRY` binding → `anc_live_score_prod` /
`anc_live_score_staging`) introduced in U10. The analytics runbook covers the AE SQL playbook end-to-end; this runbook
covers manual incident response, kill-switch flips, and the operator-facing diagnostic recipes.

For canonical Analytics Engine SQL (daily volume, p50/p99 latency, error distribution, registry-hit-rate), see the
[live-scoring analytics runbook](./live-scoring-analytics.md). Threshold values in this runbook apply identically when
computed via AE SQL.

The runbook stays in staging-mode prose until live scoring promotes to anc.dev. Production-specific commands land here
when production promotion happens.

## Telemetry contract

`src/worker/score/handler.ts` calls `emitTelemetry()` in a `try/finally` so every code path produces one log line,
regardless of which tier served the response or which error short-circuited the pipeline. Schema:

```json
{
  "scope": "score.tier",
  "tier": "curated | cache_pre | cache_post | live | error_<code>",
  "cache_pre_attempted": true,
  "cache_pre_hit": false,
  "cache_post_attempted": true,
  "cache_post_hit": false,
  "binary": "ripgrep | null",
  "input_kind": "slug | install-command | github-url | null"
}
```

`tier` values:

- `curated` — registry-fast-path hit (in-memory hashmap, no I/O, unmetered).
- `cache_pre` — step-2 R2 cache hit; binary derivable from input.
- `cache_post` — step-6.5 R2 cache hit; binary discovered via fan-out, then re-checked against cache.
- `live` — Sandbox DO dispatched, container spawned, real `anc` check.
- `error_<code>` — terminal error. `<code>` is one of the 19 `ScoreError` variants from
  `src/worker/score/response-shape.ts`.

`cache_pre_*` and `cache_post_*` are independent: both can be `true` in a single request that missed pre-discovery
cache, fanned out, then hit the post-discovery cache. The pair tells you whether the cache shape (currently keyed on
`binary`) is doing its job before vs after discovery.

`binary` is `null` until the pipeline resolves an `InstallSpec`. `input_kind` records how the input parser classified
the request, useful when filtering by request shape.

## Querying the telemetry

Two complementary surfaces.

Live tail (debug a current incident):

```bash
bun x wrangler tail --env staging --format json --search 'score.tier'
```

Historical search (post-mortem, threshold checks): Cloudflare dashboard → Workers → `agentnative-site-staging` → Logs
(observability) → filter `scope:"score.tier"`. `head_sampling_rate` is `1.0`, so every request is captured.

The smoke script (`scripts/smoke-api-score.sh <base-url>`) exercises the registry-fast-path in CI and locally. Use it as
a one-shot reachability check before deeper investigation.

## What to watch

Five signals, ordered by how often a watch will look at them.

### Tier mix

Percentage of requests resolved by each tier over a rolling window (1 h for incident triage, 24 h for soak posture).
Healthy mix has `curated + cache_pre + cache_post` dominant; `live` is the long tail and `error_*` is bounded.

The R6 unmetered contract (curated + cache hits bypass kill-switch, Turnstile, and rate-limit) means `curated` and
`cache_pre` are the cheapest tiers per request and should carry most traffic. See
`docs/solutions/architecture-patterns/cf-worker-gate-ordering-before-cost-bearing-outbounds-2026-05-20.md` for the
rationale.

Watch: `live` climbing above ~30% sustained. Alarm: `live` above ~50% sustained over an hour. Either signals broken
cache writes, registry coverage gaps, or an abuse pattern fanning out to uncached binaries.

**AE (primary):** Use the
[registry-hit-rate query in the analytics runbook](./live-scoring-analytics.md#registry-hit-rate--the-cost-efficiency-signal)
for sustained tier-mix monitoring; the same row also surfaces `cache_hit_rate` and `live_rate` for the same window.

**Manual log-query (fallback when AE is down):** filter the Workers Logs dashboard by `scope:"score.tier"` and bucket
`tier` values over the window of interest.

**Agent (MCP):** `mcp__plugin_cloudflare_cloudflare-observability__query_worker_observability` with filter
`scope:"score.tier"` and a `groupBy: ["tier"]` aggregation returns the same buckets without the dashboard round-trip.

### Error rate by code

Group `error_<code>` lines and break down by `code`. Some codes are user-driven and expected:

- `chain_no_resolve` — input didn't match registry, hints, or GitHub probe. User mis-typed, or the binary genuinely
  isn't in any registry.
- `invalid_url`, `non_https_url`, `non_github_host`, `invalid_url_path`, `unrecognized_input`,
  `unparseable_install_command` — input parser rejections. Bounded by what the form lets through.

The signal-bearing codes:

- `turnstile_failed` (HTTP 400) — siteverify rejected the token. A spike means either bot-defense degraded (Cloudflare
  siteverify outage) or the homepage form is dispatching tokens incorrectly.
- `rate_limited` (HTTP 429) — caller burned through 10 distinct-tool requests per session per minute (`SCORE_LIMITER`)
  or 30 requests per minute per IP (`SCORE_LIMITER_IP`). Spike is abuse or a hot user.
- `service_misconfigured` (HTTP 500) — a required secret (`TURNSTILE_SECRET`, `SESSION_HMAC_SECRET`) is missing. Always
  operator-actionable; investigate immediately.
- `incomplete_response_contract` (HTTP 500) — handler produced a payload missing the response triad. Drift-guard for a
  future regression; should be zero.
- `scoring_disabled` (HTTP 503) — kill-switch is on. Expected during incidents; unexpected otherwise.
- `timeout` (HTTP 504) — sandbox install or scoring exceeded the budget. Sandbox cold-start drag or a stuck container.
- `chain_resolved_install_failed`, `chain_resolved_no_binary_produced` (HTTP 502) — the install spec resolved but the
  sandbox couldn't produce a usable binary. Image regression or upstream package outage.
- `discovery_redirect_loop` (HTTP 502) — the discovery chain cycled. Worth investigating individually.

HTTP-status mapping is canonical in `src/worker/score/response-shape.ts:statusForError`.

**AE (primary):** Use the
[error-code-distribution query in the analytics runbook](./live-scoring-analytics.md#error-code-distribution); it groups
`blob3` (error code) and counts. The same query carries `avg_status` so a status drift (e.g., a code that should be 404
returning 500) surfaces inline.

**Manual log-query (fallback when AE is down):** filter Workers Logs by `scope:"score.tier"` and bucket on lines where
`tier` starts with `error_`. Slower than AE but covers the same fields.

**Agent (MCP):** `mcp__plugin_cloudflare_cloudflare-observability__query_worker_observability` with filter
`scope:"score.tier" AND tier:error_*` and a `groupBy: ["tier"]` aggregation returns the same per-code breakdown.

### Cache hit rate, pre-discovery vs post-discovery

From `cache_pre_attempted` / `cache_pre_hit` / `cache_post_attempted` / `cache_post_hit`. Compute:

- pre-hit rate = `count(cache_pre_hit=true) / count(cache_pre_attempted=true)`
- post-hit rate = `count(cache_post_hit=true) / count(cache_post_attempted=true)`

Pre-hit rate should be substantially higher than post-hit rate in a healthy state, because pre-discovery hits are the
cheapest path. If post-hit rate consistently dominates, the cache key shape (`scores/<binary>/<SPEC_VERSION>.json`,
keyed on the discovered binary) isn't catching round-1 traffic. The reshape (key on owner/repo) is a future planning
call; document the observation here and surface it in the next planning pass rather than acting on each spike.

**Cross-source dependency:** Analytics Engine carries only `freshness` (`live` / `cache-hit` / `registry-hit`) — it does
NOT carry the `cache_pre_*` / `cache_post_*` booleans, which stay in the `score.tier` console log. To break down
cache-hit traffic by pre-discovery vs post-discovery, run the manual log-query above and combine the result with the
Analytics Engine freshness aggregate. See the
[cache-hit composition cross-source note in the analytics runbook](./live-scoring-analytics.md#cache-hit-composition-cross-source-query).

### GitHub unauth quota proximity

No direct telemetry. Discovery hits `api.github.com` at 60 requests/hour per IP, but the IP is Cloudflare's shared
egress pool, so the quota is consumed across every Worker tenant. Detection is reactive: `chain_no_resolve` rates climb
for inputs that previously resolved, and `wrangler tail` shows 403s from `api.github.com` in the request trace.

Mitigation today is "wait for the hourly window to reset"; curated and cache tiers stay healthy throughout the outage
because of the R6 unmetered contract. Chronic exhaustion is a U10 trigger to add an authenticated GitHub PAT to
discovery.

### Sandbox cold-start and run latency

Not in `score.tier` directly. Pull from the observability `duration` field on requests where `tier === 'live'`.
Acceptable bounds while the staging soak continues:

- median sandbox-served request: 5 to 15 s
- p99: under 60 s (the install + score timeout budget)

Above p99 budget means timeouts will follow. Check Cloudflare Containers dashboard for instance count and recent image
churn before assuming the worst.

## Threshold table

Watch thresholds are informational (look closer). Alarm thresholds page the operator. Conservative on the alarm side;
easier to tighten later than to recover from a missed incident.

| Signal                              | Watch                              | Alarm                              | Where to look                                                  |
| ----------------------------------- | ---------------------------------- | ---------------------------------- | -------------------------------------------------------------- |
| `tier === 'live'` share             | > 30% over 1 h                     | > 50% over 1 h                     | Tier mix query                                                 |
| `error_turnstile_failed` rate       | > 5% of POSTs over 15 min          | > 20% of POSTs over 15 min         | Error breakdown                                                |
| `error_rate_limited` rate           | > 2% of POSTs over 15 min          | > 10% of POSTs over 15 min         | Error breakdown + per-IP attribution in dashboard              |
| `error_service_misconfigured` count | any                                | any                                | Error breakdown; always investigate                            |
| `error_incomplete_response`         | any                                | any                                | Treat as a regression; reproduce + open issue                  |
| `error_timeout` rate                | > 1% of `tier === 'live'`          | > 5% of `tier === 'live'`          | Sandbox + container dashboard                                  |
| `error_chain_resolved_*` rate       | > 1% of `tier === 'live'`          | > 5% of `tier === 'live'`          | Compare against recent image deploys                           |
| Pre-hit rate                        | < 40% with `cache_pre_attempted>0` | < 20% with `cache_pre_attempted>0` | Cache shape candidate (defer action to U10)                    |
| GitHub 403 rate on outbound         | any                                | sustained > 5 min                  | `wrangler tail`, `api.github.com` Status                       |
| Sandbox p99 duration                | > 45 s                             | > 60 s                             | Observability `duration` filtered to `tier === 'live'`         |
| Active sandbox instance count       | -                                  | At configured ceiling for > 5 min  | Containers dashboard (`max_instances: 3` per `wrangler.jsonc`) |

Rate-limit + Turnstile alarms presume traffic is non-trivial. Below ~50 requests in the window, treat ratios as noisy
and rely on absolute counts.

## Common failures and operator response

Six runbook entries. Each names a symptom, the diagnostic command, and the resolution. Stop at the first match; the list
is not a tree.

### Kill-switch flip (manual incident response)

Symptom: not a failure mode; the operator's tool for stopping all `live` traffic when something downstream is on fire.

```bash
# Flip ON. Subsequent /api/score live requests return 503 with Retry-After: 3600.
bun x wrangler kv key put --binding=SCORE_KV --env staging scoring_disabled true

# Flip OFF.
bun x wrangler kv key delete --binding=SCORE_KV --env staging scoring_disabled
```

The Worker caches the flag in-isolate for 30 s, and KV propagates globally within ~60 s, so allow up to a minute for the
flip to land everywhere. `curated` and cache tiers keep serving because they short-circuit ahead of the gate block (R6
unmetered contract).

The U10 auto-kill cron will flip the same flag based on Budget Alert state. Manual flip stays available as an override.

### Turnstile siteverify outage

Symptom: `error_turnstile_failed` rate spikes above the alarm threshold while site traffic looks otherwise normal.

Diagnostic:

```bash
# Confirm siteverify reachability from your laptop (does not consume metered budget).
curl -i https://challenges.cloudflare.com/turnstile/v0/siteverify -d 'secret=1x0000000000000000000000000000000AA&response=x'

# Check Cloudflare Status for ongoing incidents.
open https://www.cloudflarestatus.com/
```

Resolution: nothing operator-actionable. The Worker fail-closes on siteverify failures (intentional). Wait for
Cloudflare to restore. `curated` and cache tiers stay healthy throughout.

If siteverify is healthy but `turnstile_failed` persists, suspect the homepage form: check the dispatched token shape
against the staging form's network tab and confirm `TURNSTILE_SITEKEY` matches `TURNSTILE_SECRET` (staging uses the
always-passes test pair).

### GitHub API exhaustion (unauthenticated quota)

Symptom: `chain_no_resolve` rate climbs for inputs that previously resolved. `wrangler tail` shows 403s from
`api.github.com`.

Diagnostic:

```bash
# Live tail for outbound 403s.
bun x wrangler tail --env staging --search 'api.github.com'
```

Resolution: no operator action; wait for the hourly window to reset. Curated entries and cached binaries keep serving
because of the R6 unmetered contract.

If exhaustion is chronic (multiple windows in a row), escalate to U10 to add an authenticated GitHub PAT for discovery.

### Sandbox crash or cold-start timeout

Symptom: `error_timeout` or `error_chain_resolved_install_failed` rates spike for inputs that previously worked; sandbox
p99 duration crosses the alarm.

Diagnostic:

```bash
# Live deploy history.
bun x wrangler deployments list --env staging | head -20

# Container instance health (Cloudflare dashboard).
open https://dash.cloudflare.com/?to=/:account/workers/services/view/agentnative-site-staging/containers
```

Resolution:

1. If a recent Worker version coincides with the spike, roll it back: `bun x wrangler rollback <version-id> --env
   staging`. The DO migration `v1` stays; rollback only reverts code + bindings.
2. If the image was bumped recently, inspect the image build for missing dependencies (matches the U6
   `python:3.12-slim-trixie` sdist allowlist pattern); deploy a corrected image via the standard `wrangler containers
   build -p` → `wrangler deploy` flow documented in
   [`RELEASES.md` § Sandbox image releases](../../RELEASES.md#sandbox-image-releases).
3. If neither, raise the kill-switch (see above) and investigate offline.

### R2 cache failure

Symptom: `cache_pre_attempted=true` with `cache_pre_hit=false` for inputs that should be cached (e.g., a slug scored
within the last 7 days). Pre-hit rate craters across all inputs.

Diagnostic:

```bash
# Confirm R2 is reachable from your laptop and the bucket has objects.
bun x wrangler r2 object list anc-score-cache-staging --prefix=scores/ | head -20

# Confirm the lifecycle rule is intact.
bun x wrangler r2 bucket lifecycle list anc-score-cache-staging
```

Resolution: cache reads and writes are best-effort in `src/worker/score/cache.ts`; a missing cache makes `live` runs
more frequent (more expensive) but doesn't break the route. If the R2 binding is genuinely broken, the lifecycle rule
disappeared, or the bucket is gone, restore via the recipes in
[`RELEASES.md` § R2 score-cache lifecycle](../../RELEASES.md#r2-score-cache-lifecycle).

### Service misconfigured

Symptom: `error_service_misconfigured` appears at all.

Diagnostic + resolution:

```bash
# List wrangler secrets to confirm what's bound.
bun x wrangler secret list --env staging

# Re-set whichever is missing. The handler fail-closes when either is absent.
bun x wrangler secret put TURNSTILE_SECRET --env staging
bun x wrangler secret put SESSION_HMAC_SECRET --env staging
```

Both secrets are required for `/api/score` to mint sessions and verify tokens. Treat any occurrence of this error as an
immediate page; the route serves only `curated` + cache tiers (the unmetered ones) while it persists.

## Cost-watch checklist

Quick hand-check before each staging deploy, and any time a tier mix or error alarm fires. The numbers below are
reference points, not contracts; tune as soak data arrives.

- Wrangler dashboard request count for the last 24 h. Baseline expected: low (this is staging, gated by CF Access). A
  jump means traffic shape changed or a test harness ran loose.
- Active sandbox container instance count. Ceiling is `max_instances: 3` per `wrangler.jsonc`. Sustained at-ceiling
  means traffic is exceeding the container budget; the kill-switch flip is the safety valve.
- R2 storage size for `anc-score-cache-staging` `scores/` prefix. Should plateau because of the 7-day lifecycle. Steady
  growth means lifecycle is broken; see the R2 cache failure entry above.
- Outbound GitHub request rate. Proxy: count `tier === 'live'` lines and multiply by ~5 (each live run touches GitHub
  Releases, the repo metadata endpoint, and a few README/asset fetches).
- Turnstile siteverify rate. One per session mint; should track `tier === 'live'` plus `tier === 'cache_post'` roughly.

Production cost watch is documented in [`RELEASES.md` § Cost guardrails](../../RELEASES.md#cost-guardrails). Budget
Alerts at $5 / $25 / $100 live in the Cloudflare dashboard and trigger ahead of the kill-switch, so the manual checklist
is a backstop, not the primary signal.

## Cross-references

- Telemetry emitter: `src/worker/score/handler.ts` (the `Telemetry` type + `emitTelemetry()`).
- Error union + HTTP status mapping: `src/worker/score/response-shape.ts` (`statusForError`).
- Kill switch: `src/worker/score/kill-switch.ts` + the `SCORE_KV` binding in `wrangler.jsonc`.
- Cache shape: `src/worker/score/cache.ts` (key `scores/<binary>/<SPEC_VERSION>.json`).
- Gate-ordering rationale (why R6 unmetered tier is safe under abuse):
  `docs/solutions/architecture-patterns/cf-worker-gate-ordering-before-cost-bearing-outbounds-2026-05-20.md`.
- Release procedure:
  [`RELEASES.md` § Live-scoring (v3) release procedure](../../RELEASES.md#live-scoring-v3-release-procedure).
- Post-deploy smoke: [`RELEASES.md` § Post-deploy smoke](../../RELEASES.md#post-deploy-smoke) and
  `scripts/smoke-api-score.sh`.
- Sandbox image lifecycle and DO migrations:
  [`ARCHITECTURE.md` § Sandbox image releases](../../ARCHITECTURE.md#sandbox-image-releases) and
  [§ DO migrations are one-way walls](../../ARCHITECTURE.md#do-migrations-are-one-way-walls).
- Plan unit: `docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md` (U9 deliverable 5).

## Still deferred

Out of scope for U10, named here so the operator knows where the next gap is:

- **Auto-kill cron** (U10.1). Reads an Analytics Engine aggregate for rolling 24h request count and flips
  `scoring_disabled` automatically when the budget breaches the configured ceiling. Threshold needs real traffic data to
  set; deferred until staging soak produces enough signal.
- **Production-side procedure block** in this runbook (commands, thresholds, escalation paths against anc.dev rather
  than the staging Worker). Lands when live scoring promotes to anc.dev.
- **Authenticated GitHub PAT for discovery**, if chronic unauth-quota exhaustion has materialised by then.

### Agent-deterministic checks

**Decision (U10):** Path B (MCP queries) shipped. Each manual check above carries an inline **Agent (MCP)** subsection
naming the `mcp__plugin_cloudflare_cloudflare-observability__query_worker_observability` (or related cloudflare-bindings
MCP) call. No `scripts/monitoring/` wrapper scripts were added; the existing wrangler CLI + dashboard surface stays the
operator path, and agents reach the same data through native MCP tools.

Rationale: agents already have Cloudflare MCP tools; documenting which call to make for which check costs zero new code
surface and zero ongoing maintenance. The alternative (shell scripts in `scripts/monitoring/`) was deferred — its unique
value is GitHub Actions cron reach, which U10's acceptance bar doesn't require. If automated CI monitoring becomes a
need later, scripts can land as a separate change without unwinding the MCP docs.

Until U10 lands, the runbook above is the operator's only playbook.
