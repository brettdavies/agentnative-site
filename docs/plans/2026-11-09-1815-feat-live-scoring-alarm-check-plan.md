---
artifact_contract: ce-unified-plan/v1
execution: code
product_contract_source: ce-plan-bootstrap
title: "Live-scoring alarm check - Plan"
type: feat
status: waiting-for-production-live-scoring-traffic
prs: []
date: 2026-11-09
topic: live-scoring-alerts
---

# Live-scoring alarm check - Plan

## Goal Capsule

- **Objective:** an alarm in `docs/runbooks/live-scoring-monitoring.md` reaches the operator without anyone running the runbook.
- **Means:** one script reads the production Worker's `score.tier` lines through the Workers Observability telemetry API, and one hourly workflow keeps one open `alert` issue per tripped alarm.
- **Status:** waiting. The site is pre-usage, so no code exists on any branch. This plan holds the design and the facts measured against the live API.
- **Authority:** the runbook's threshold table wins on numbers. This plan wins on mechanism.
- **Stop conditions:** a change to what the Worker logs, a new threshold, a notification channel other than an issue, or a watch-level alarm is outside this plan. Stop and report.
- **Who finishes:** an agentnative-site session builds it as one draft PR to `dev`, then reviews it with `ce-code-review`, `/devex-review` and `/cso`.

## Product Contract

- **R1.** For each alarm the logs can answer, the script reports tripped or clear for the window that alarm names.
- **R2.** Below about 50 requests, an alarm judges by absolute count and not by ratio.
- **R3.** Prose by default. `--json` prints one result object per line. Exit codes differ for alarm tripped, query failed and credential missing.
- **R4.** An hourly workflow, plus `workflow_dispatch`, opens one `alert` issue per tripped alarm and updates it while the alarm stays tripped. A missing credential fails the run.
- **R5.** Tests run on recorded API responses and never call the live API in CI.
- **R6.** The runbook states that alarms are checked hourly and where the issues appear.

**Not in scope:** changes to what the Worker logs, new thresholds, other notification channels, watch-level thresholds, closing an issue automatically, and staging coverage. Staging traffic is smoke tests behind Cloudflare Access, so its alarms would be noise.

### The eight alarms

Windows the runbook leaves unnamed use 1 h, the cadence of the check. `of` is the ratio's denominator. The count limit applies when that denominator is below 50.

| Alarm id                | Tiers counted                                                                     | Window | `of`                  | Ratio limit | Count limit | Real data today (see below)     |
| ----------------------- | --------------------------------------------------------------------------------- | ------ | --------------------- | ----------- | ----------- | ------------------------------- |
| `live-share`            | `live`                                                                            | 1 h    | all lines             | > 50%       | > 25        | Rows exist. Tripped needs edits |
| `turnstile-failed`      | `error_turnstile_failed`                                                          | 15 min | all lines             | > 20%       | > 10        | No rows                         |
| `rate-limited`          | `error_rate_limited`                                                              | 15 min | all lines             | > 10%       | > 5         | No rows                         |
| `service-misconfigured` | `error_service_misconfigured`                                                     | 1 h    | none                  | any         | any         | No rows                         |
| `incomplete-response`   | `error_incomplete_response_contract`                                              | 1 h    | none                  | any         | any         | No rows                         |
| `timeout`               | `error_timeout`                                                                   | 1 h    | `live` lines          | > 5%        | > 2.5       | No rows                         |
| `chain-resolved`        | `error_chain_resolved_install_failed`, `error_chain_resolved_no_binary_produced`  | 1 h    | `live` lines          | > 5%        | > 2.5       | No rows                         |
| `pre-hit-rate`          | attempted with no hit (`cache_pre_attempted` true, `cache_pre_hit` false)         | 1 h    | `cache_pre_attempted` | > 80% missed | > 40       | Rows exist. Misfires (below)    |

Measured over the 7-day log retention on 2026-11-09: production holds 40 lines, all `curated`, and staging holds 23 `curated` and 1 `live`. No `error_*` tier appears on either Worker.

Three runbook rows stay manual because a `score.tier` line cannot answer them: GitHub 403 rate (no line records it), sandbox p99 duration (the line carries no duration), and active sandbox instance count (Containers dashboard only).

## Planning Contract

### Verified API facts

Measured against production on 2026-11-09 by running the script end to end.

- `CF_ANALYTICS_READ_TOKEN` is set as a repo secret and `CF_ACCOUNT_ID` exists. A token with Workers Observability Read answers `telemetry/query` with HTTP 200. The public OpenAPI schema lists only Workers Observability Write for that endpoint, and Write is not needed.
- Boolean group values arrive as strings: `{"key":"cache_pre_attempted","value":"true"}`.
- A window with no matching lines answers `result.calculations[0].aggregates: []`, with `calculations` present.
- A 400 has no `errors` array: `{"success":false,"_e":null,"_i":<the request>,"_c":{"issues":[{"code","path","message"}],"name":"ZodError"}}`.
- A 403 is `{"success":false,"errors":[{"message":"Forbidden"}],"messages":[]}` and names no permission, so it cannot tell a missing permission from a wrong token scope.
- An aggregate row carries `groups`, `groupKey`, `value`, `count`, `interval` and `sampleInterval`. `sampleInterval` was 1 on 15-minute windows and 10 on a 7-day window. `value` and `count` were equal in every recording.
- `ignoreSeries: true` still returns `series`, as buckets with empty `data`.
- `dry: true` keeps a query from being saved. `result.run` carries account, user, workspace and environment identifiers, and a fixture must redact them.

The request, one per quarter-hour:

```json
{
  "queryId": "live-scoring-alarms",
  "timeframe": { "from": 0, "to": 0 },
  "view": "calculations",
  "dry": true,
  "ignoreSeries": true,
  "limit": 200,
  "parameters": {
    "datasets": ["cloudflare-workers"],
    "filterCombination": "and",
    "filters": [
      { "key": "$metadata.service", "operation": "eq", "type": "string", "value": "agentnative-site" },
      { "key": "scope", "operation": "eq", "type": "string", "value": "score.tier" }
    ],
    "calculations": [{ "operator": "count" }],
    "groupBys": [
      { "type": "string", "value": "tier" },
      { "type": "boolean", "value": "cache_pre_attempted" },
      { "type": "boolean", "value": "cache_pre_hit" }
    ]
  }
}
```

### Key Technical Decisions

- **KTD1. Bash and jq.** `scripts/monitoring/check-score-alarms.sh [--json] [--help]`, beside the other monitoring wrappers. The runner image already has curl, jq and gh, so the job installs nothing and no cache pays for itself. The script reads production only; a test pins its Worker name to `wrangler.jsonc`.
- **KTD2. The last complete clock hour, in four quarters.** Four contiguous 15-minute queries. The 1 h alarms sum them. The 15-minute alarms are judged on each quarter and report the worst, so a spike early in the hour still trips on an hourly schedule.
- **KTD3. The floor applies to each ratio's own denominator.** `tier` is single-valued, so an error line is never also a `live` line. Below 50 the limit is `ratio * 50`, the count each ratio gives at 50, so the verdict is continuous there and the runbook needs no second number.
- **KTD4. An unrecognised response stops the run.** A 200 must carry `success: true`, `result.run`, `result.statistics`, one `calculations` entry with an `aggregates` array, and a `tier` group on every row. Anything else is `query-failed` and never reads as clear.
- **KTD5. No partial verdicts.** One failed quarter fails the whole run, with one result and no alarm verdicts.
- **KTD6. The token never reaches the command line.** curl reads it from a header file in a private temp directory.

### Result contract

`--json` prints `{reason, exit_code, message, value, next_step: {action, command, docs}}`, one per line. The process exits with the highest code among its results.

| `reason`              | Exit | `next_step.action` | Meaning                                              |
| --------------------- | ---- | ------------------ | ---------------------------------------------------- |
| `alarm-clear`         | 0    | `none`             | One result per alarm.                                |
| `alarm-tripped`       | 2    | `investigate`      | One result per alarm.                                |
| `credential-missing`  | 3    | `set-secret`       | `value.missing` names the variable.                  |
| `query-failed`        | 4    | `retry`            | The API failed or answered in an unrecognised shape. |
| `credential-rejected` | 5    | `rotate-secret`    | Cloudflare answered 401 or 403.                      |
| `usage`               | 64   | `run`              | Unknown argument.                                    |

An alarm's `value` holds `alarm`, `window`, `window_start`, `window_end`, `basis` (`ratio`, `count` or `any`), `count`, `of`, `ratio` and `limit`. Its `next_step.command` is the read-only follow-up: `scripts/monitoring/check-r2-cache.sh --env production` for `live-share` and `pre-hit-rate`, `scripts/monitoring/check-error-tier-sample.sh --env production` for the rest. Its `docs` is the runbook section for that alarm.

### Workflow

`.github/workflows/live-scoring-alerts.yml`, cron `17 * * * *` plus `workflow_dispatch`, `contents: read` and `issues: write`, concurrency group `live-scoring-alerts` with no cancel, checkout pinned with `persist-credentials: false`. Scheduled runs execute `main`'s copy only.

- **Check step.** Holds the two Cloudflare secrets and no GitHub token. Exit 0 or 2 continues. Any other code prints `::error::` and fails the run, because no verdict was reached.
- **Issue step.** Holds `GH_TOKEN` and no Cloudflare secret. It exits early when nothing tripped, and creates the `alert` label only when it is missing.
- **De-duplication.** Open issues come from the REST list, `gh api --paginate "repos/$GH_REPO/issues?labels=alert&state=open&per_page=100"`, filtered to drop pull requests. `gh issue list --label` goes through the search API, whose index lags, so a fresh issue could be missed and duplicated. An issue belongs to an alarm by its first line, `<!-- live-scoring-alarm:<id> -->`, which survives a title edit. A match gets `gh issue edit --body-file`, which rewrites the reading without a notification per hour. No match gets `gh issue create --title "Live-scoring alarm: <id>" --label alert --body-file`.

### Fixtures

`tests/fixtures/score-alarms/` holds recordings with account and user identifiers redacted. The tests stub `curl` and `gh` on PATH and run the workflow's real `run:` blocks.

- **Unedited recordings:** an empty quarter, a quarter with two `curated` lines, a real 400 (inverted timeframe), and a real 403.
- **Count-edited recordings (approved):** a real `curated` and `live` response with only its numbers changed, named `*.count-edited.json`. Used for tripped, ratio-basis clear, at-the-limit, and both low-traffic paths.
- **Tier-edited recordings (undecided):** numbers alone cannot produce an `error_*` row, because none exists in retention. Without tier-edited fixtures or real incidents, the 15-minute quarter logic and six of the eight alarms have no test.
- **Shape rejection:** tests corrupt a recording at run time, because a response the API never sends cannot be recorded.

## Prerequisites before resuming

1. **The pre-hit alarm misfires.** `src/worker/audit/api.ts` (around line 602) sets `cache_pre_attempted` before the registry lookup, so every `curated` request logs an attempt with no hit. Under the runbook's formula a curated-only hour reads 0% and trips above 40 attempts with nothing wrong. Decide: exclude `curated` rows in the script (recommended, one runbook line), keep the formula, or drop this alarm from the check.
2. **The Turnstile alarm counts tokenless requests.** `src/worker/audit/api.ts` logs a POST with no token as `error_turnstile_failed`, so a run of tokenless agent POSTs trips the alarm while siteverify is healthy. Decide whether the runbook's reading of this signal stands.
3. **Decide on tier-edited fixtures** (see Fixtures).
4. **Correct two runbook pointers.** The keys-endpoint recipe says the token's name is in `docs/runbooks/sitewide-analytics.md`, which does not name it. The telemetry contract cites `src/worker/score/handler.ts`, and the emitter is `src/worker/score/telemetry.ts`.

## When to resume

Resume when production carries real live-scoring traffic: `score.tier` lines with tiers beyond `curated`, at a volume where an hour can reach the 50-request floor. The request above, widened to 7 days, measures both. Real traffic also supplies recordings the current retention cannot.

## Implementation Units

- **U1. Script and tests.** `scripts/monitoring/check-score-alarms.sh`, a section in `scripts/monitoring/README.md`, `tests/score-alarms-script.test.ts`, and fresh fixtures.
- **U2. Workflow and tests.** `.github/workflows/live-scoring-alerts.yml`, with tests that run its `run:` blocks against the stubs.
- **U3. Runbook.** A `### Hourly alarm check` section under the threshold table, naming the workflow, the `alert` label, the eight alarms, the three manual rows, and the two judging rules.

## Verification Contract

- Record fixtures from the live API with the read-only token. Never commit an unredacted response.
- Watch each test fail against broken code before trusting it passing: an alarm that never trips, a count basis that always trips, the floor ignored, a failed query read as quiet, the credential check removed, string booleans not understood, the workflow opening a new issue every run, and the workflow not failing on a missing credential.
- Run the script against production before opening the PR.
- After the workflow reaches `main`, run it once with `gh workflow run live-scoring-alerts.yml` and read the result.

## Definition of Done

- One draft PR to `dev` with all three reviews complete and each verdict in a PR comment.
- Every alarm above has a test on a recorded response, or is named as untested in the PR body.
- The first production run on `main` is green.

## Review log

No plan review has run. It needs `/plan-eng-review`, `/plan-devex-review` and `/compound-engineering:ce-doc-review` when work resumes.
