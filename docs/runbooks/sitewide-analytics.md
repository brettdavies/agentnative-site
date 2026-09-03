# Sitewide analytics runbook

Covers the sitewide telemetry lake (Workers Logpush → Pipelines → Apache Iceberg on R2), Web Analytics, and the zone
dashboards. The [live-scoring analytics runbook](./live-scoring-analytics.md) covers the Workers Analytics Engine score
datasets; the [web-audit operations runbook](./web-audit-operations.md) covers audit operations. This runbook owns what
`wrangler.jsonc` cannot express: the Logpush jobs (full options objects), pipeline/stream/sink/catalog names, every
credential minted for the pipeline, Web Analytics enablement and observed retention, the zone Custom Dashboard, Email
Sending onboarding state, and the canonical saved queries. Bindings, crons, and vars stay in `wrangler.jsonc` under the
existing test guards.

Two lake buckets, one per environment:

| Environment | Binding          | Bucket                       |
| ----------- | ---------------- | ---------------------------- |
| Production  | `TELEMETRY_LAKE` | `anc-telemetry-lake`         |
| Staging     | `TELEMETRY_LAKE` | `anc-telemetry-lake-staging` |

The binding pair is pinned by `tests/wrangler-config.test.ts`.

## Lake pipeline

Raw Worker events flow through managed export: Workers Logpush → Pipelines → Iceberg tables on R2, read via the R2 SQL
editor in the Cloudflare dashboard. Both lake buckets run with the R2 Data Catalog enabled, with compaction and snapshot
expiration. The setup commands live in
[`RELEASES.md` § R2 telemetry-lake catalog](../../RELEASES.md#r2-telemetry-lake-catalog).

Both buckets were created on 2026-09-02. Catalog, compaction, and snapshot expiration are not yet enabled: the `wrangler
r2 bucket catalog` commands require the R2 Data Catalog permission on the API token, which the current
`CLOUDFLARE_API_TOKEN` does not carry. Grant the permission in the dashboard token editor, then run the setup and verify
commands from `RELEASES.md`.

## Logpush job

One job per environment: dataset `workers_trace_events`, destination Pipelines with an Iceberg sink into the
environment's lake bucket, filtered to the environment's script name, no sampling.

- Production: script `agentnative-site` → `anc-telemetry-lake`.
- Staging: script `agentnative-site-staging` → `anc-telemetry-lake-staging`.

The job's output field list is an allowlist naming exactly `EventTimestampMs`, `EventType`, `Outcome`, `ScriptName`,
`ScriptVersion`, `Exceptions`, `Logs`. The `Event` envelope is excluded until the [export audit](#export-audit) clears
it. Logpush job updates replace the options object wholesale, so this section records each job's full options object
verbatim once created.

### Staging job

Not yet created; this subsection records the job's full options object verbatim once it exists.

### Production job

Not yet created; this subsection records the job's full options object verbatim once it exists.

## Field-selection audit

The allowlist-vs-dataset-schema audit that must complete before the first job is enabled. Audited 2026-09-02 against the
`workers_trace_events` dataset reference (Cloudflare docs, page dated 2026-07-08).

The dataset's complete field list: `CPUTimeMs` (int), `DispatchNamespace` (string), `Entrypoint` (string), `Event`
(object), `EventTimestampMs` (int), `EventType` (string), `Exceptions` (array[object]), `Logs` (array[object]),
`Outcome` (string), `ScriptName` (string), `ScriptTags` (array[string]), `ScriptVersion` (object), `WallTimeMs` (int).

Findings:

- The dataset defines no top-level client-IP field and no User-Agent field, so no allowlist choice can export either.
- All seven allowlist fields exist in the dataset with the expected shapes.
- `Event` is the only opaque object (source-event details, which for fetch events include request metadata). It stays
  off the allowlist until the [export audit](#export-audit) inspects a live staging delivery.
- `Logs[]` and `Exceptions[]` carry only what the Worker itself emits; keeping them inside the R5 posture is the
  emitting code's obligation, confirmed per delivery by the export audit.

## Export audit

Records the inspection of one delivered staging batch for identifying data and the resulting decision on whether `Event`
joins the allowlist. Not yet recorded.

## Sink layout

Records the object layout the Pipelines sink writes (prefix, file naming) and whether catalog compaction writes into the
same listed prefix — the lake-freshness check depends on this answer. Not yet recorded.

## Lake freshness check

`src/worker/telemetry/lake-freshness.ts`, dispatched from the Worker's `scheduled()` handler on the daily `0 6 * * *`
cron (both env blocks declare it beside the weekly rescore cron; `tests/wrangler-config.test.ts` pins the pair). The
check lists the lake bucket through the `TELEMETRY_LAKE` binding under `LAKE_INGEST_PREFIX` and compares the newest
object's upload age to a 24-hour threshold; an empty listing counts as stale (a sink that never delivered is a stall).
On breach it calls the KV-deduped email path with key `telemetry-lake-stale`, naming the environment in the subject and
the stale age in the text. `TELEMETRY_ENVIRONMENT` gates sending: only `production` emails; staging logs the breach and
stops, because its lake is legitimately quiet most days and routine staging alerts would train the operator to ignore
the production key. Every run emits one `telemetry.lake-freshness` status line.

`LAKE_INGEST_PREFIX` must scope to ingest-written objects: catalog compaction rewrites old data into new objects with
fresh timestamps, so a whole-bucket signal reads young during a real stall. The [Sink layout](#sink-layout) record
governs the constant's value; update it there first, then in the module. While the constant is empty (layout
unrecorded), the check fails closed: it emits `ingest_prefix_unrecorded` and renders no verdict — arming it is the
one-line prefix change after the layout is recorded. A listing failure in production alerts through the same email path
with key `telemetry-lake-check-failed`; off production it is log-only.

## Live-layer field index

The live layer indexes every key of an object the Worker logs. Every emit site goes through
`src/worker/telemetry/log.ts`, so each record's fields are queryable dimensions in Query Builder; the emitter also
absorbs the string-shaped lines Workers Logs auto-parsed before. The keys endpoint is the instrument for confirming
this, and it samples recent records: a window with no traffic from the service lists only the platform's `$metadata`
keys, so query a window that holds traffic (the request recipe is in the
[live-scoring monitoring runbook](./live-scoring-monitoring.md#querying-the-telemetry)).

Recorded against the staging Worker on 2026-09-03 over a fifteen-minute window holding page, MCP, score, and web-audit
traffic:

| Measure                                  | Before (production, 7-day window, pre-emitter) | After (staging, window with traffic) |
| ---------------------------------------- | ---------------------------------------------- | ------------------------------------ |
| Keys listed                              | 121                                            | 177                                  |
| Platform keys (`$metadata`, `$workers`)  | 119                                            | 114                                  |
| Keys from this Worker's records          | 2 (`level`, `message`)                         | 63                                   |

The 63 include `scope`, `event`, `tier`, `client_name`, and every `page.request` field (`path`, `format`, `status`,
`cache_status`, `cache_age_present`, `client_class`, `agent_name`, `browser_family`, `browser_version`, `engine`,
`engine_version`, `os_family`, `ms_bucket`), plus nested fields as dotted keys (`checks.pass`) and arrays as positional
keys (`evidence.0.status`). The `level` and `message` keys in the before column belong to the invocation records and to
plain-string console lines, not to the Worker's structured records.

Query Builder filters the console records by these keys directly; group `scope:"page.request"` by `client_class` for the
audience split and `scope:"score.tier"` by `tier` for the live-scoring tier mix.

### Platform keys that carry the client address

Two record types share the index. The Worker's console records (`$metadata.type: cf-worker`) carry only the fields the
emitter wrote: no request headers, no `cf` object. The platform's invocation records (`$metadata.type: cf-worker-event`,
one per request) carry the request envelope, and on both Workers the index lists
`$workers.event.request.headers.cf-connecting-ip`, `$workers.event.request.headers.x-real-ip`,
`$workers.event.request.headers.x-forwarded-for`, `$workers.event.request.headers.user-agent`, and (on production)
`$workers.event.request.headers.sec-ch-ua*`, together with `$workers.event.request.cf.latitude`, `.longitude`, `.city`,
and `.postalCode`, all populated. So the live layer holds the client IP and raw User-Agent for seven days on every
invocation record, outside anything this repo emits. The Logpush allowlist excludes the `Event` envelope that carries
them, which is what keeps them out of the lake; a session key derived from the address must not be joined to an
invocation record by request id, because that record already holds the address it was derived to avoid.

## Credentials

Records every credential minted for the pipeline: name, permission set, scope. All credentials are least-privilege,
scoped to the two lake buckets only, with no public read path. None minted yet.

## Canonical queries

Reserved for the saved R2 SQL queries: the headline agent-share query, the crawler series with ai/search and
named-crawler breakouts, and the unknown line. None saved yet.

## Web Analytics

Records the site entry, enablement date, and observed retention. Not yet enabled.

## Zone dashboard (90-day coarse view)

Records the Custom Dashboard over `httpRequests1dGroups`: its name and panels. Not yet created.

## Email Sending onboarding

Unprovisioned; the alert path returns `unprovisioned` until onboarding completes. Steps:
[`docs/runbooks/web-audit-operations.md` § Failure notifications](./web-audit-operations.md#failure-notifications).

## Verification discipline

Freshness checks and CSP/beacon verification read the Worker path and the served edge response. CLI object reads
(`wrangler r2 object get`) can serve stale copies, and built output is not evidence.
