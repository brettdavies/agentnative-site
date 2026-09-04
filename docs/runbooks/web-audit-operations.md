# Web-audit operations runbook

How to run the website agent-readiness audit against a real target, in each environment, and how to operate the
web-board rescore (weekly cron, post-deploy hook, on-demand triggers). Pairs with the
[MCP operator runbook](./mcp-operator.md) (kill switches, `wrangler tail`) and the
[live-scoring monitoring runbook](./live-scoring-monitoring.md).

## Environments

| Branch | Deploys to                                        | Host                                               | Notes                                                                |
| ------ | ------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| `dev`  | `agentnative-site-staging` Worker (`env.staging`) | `agentnative-site-staging.<subdomain>.workers.dev` | `X-Robots-Tag: noindex` on every response; behind Cloudflare Access. |
| `main` | `agentnative-site` Worker (top-level, production) | `anc.dev` (custom domain)                          | Full indexing, public.                                               |

Source of truth: `.github/workflows/deploy.yml` and the `env.staging` / top-level blocks of `wrangler.jsonc`.

**A `dev` merge reaches staging only, never production.** Production `anc.dev` lags `dev` until a release lands on
`main` (see `RELEASES.md`). So immediately after a `dev` merge, `anc.dev` still serves the previous code and content.
This matters for any audit that reads the target's own content: an audit of `anc.dev` before the production release
scores the old content, and the deploy hook re-scores it once the release lands (see
[Operating the board rescore](#operating-the-board-rescore)).

## The audit endpoint

`POST /api/audit-web` with a JSON body `{ url, site_type?, public_listing?, turnstile_token }` streams NDJSON. The
terminal `{ "type": "complete", "cached", "scored_at", "refresh_after", "scorecard", "share_url" }` event carries the
full web scorecard (schema `0.4`). `site_type` is optional (`content` | `api`); omit it to let the audit auto-detect.

A cache hit answers with a single `application/json` body instead of a stream, carrying the same freshness fields and no
`type`. Content-type is the discriminator: `application/json` means served from cache, NDJSON means the engine ran. Both
shapes are documented at [/web-scorecard-schema](../../content/web-scorecard-schema.md); the operator-relevant part is
that `cached`, `scored_at`, and `refresh_after` sit outside the scorecard, so they never move the schema version.

Two gates sit in front of the audit and shape how you reach it per environment:

- **Turnstile.** Production verifies a real Turnstile token, which you cannot mint from a script. Staging uses the
  Cloudflare always-passes test secret, so any string works (`"turnstile_token": "x"`).
- **SSRF.** `src/worker/audit-web/ssrf.ts` blocks loopback, RFC1918, link-local, and `localhost`/`*.internal`. You
  **cannot** audit a local `bun run dev` server (`http://localhost:8787`) through `/api/audit-web`; the root fetch is
  rejected. The target must be a public host.

### Quick check: the working-tree engine (`scripts/web-audit/run.sh`)

`scripts/web-audit/run.sh` runs the current working tree's audit logic (`scripts/web-audit/audit.ts`, under Bun) against
real remote content and reports every check. It defaults to the staging host, resolves the Cloudflare Access service
token from 1Password, and rebuilds `dist/_internal/web-audit-registry.json` first.

```bash
scripts/web-audit/run.sh                              # full report + score for staging
scripts/web-audit/run.sh --check mcp-get-fast-fail    # one check; exit 0 = pass, 1 = failing, 3 = not evaluable
scripts/web-audit/run.sh --target https://anc.dev/    # a public target (e.g. production after a release)
scripts/web-audit/run.sh --json                       # the full scorecard as JSON
scripts/web-audit/run.sh --no-build                   # reuse the existing dist/ (skip the rebuild)
```

This runs the audit **logic** you are about to ship against **live** content, so a change to an antecedent or a check
assertion shows its effect immediately. A check whose pass depends on the target's own **content** (`noscript-fallback`,
`link-headers`, ...) reads whatever the target currently serves, so verify content-dependent checks against a host that
already serves the new content: staging after a `dev` merge, production after a release.

Under the hood the helper calls `runWebAudit` with a `fetchImpl` that injects the Access service token on the staging
host only. `guardedFetch` uses standard `fetch` plus hostname validation (no Workers-only APIs), so the engine runs
under Bun.

**Why not a deployed self-audit.** The staging Worker cannot audit itself. Cloudflare Access bounces unauthenticated
requests to its login wall, and the engine's internal `guardedFetch` calls do not carry the service token, so every
probe reads the Access page and every check lands `n_a` (score near 0). Running the engine locally and injecting the
token on the staging host sidesteps this; that is what `run.sh` does.

### Against production (`anc.dev`)

For a real user-facing audit, use the site's audit UI (`https://anc.dev/web-audit`) or the `audit_website` MCP tool. A
scripted `POST /api/audit-web` needs a real Turnstile token, which you cannot mint from a script. To preview the
working-tree engine against live production content, point the helper at it: `scripts/web-audit/run.sh --target
https://anc.dev/` (a public host, so no Access token is fetched).

## Operating the board rescore

The web leaderboard is curated, not crawled: `src/data/web-audit/seed.yaml` holds the domain list (projected at build
time to `dist/_internal/web-seed.json`), and every score lives in R2. The rescore Workflow audits each seeded domain
(one Workflow step per domain) and then rebuilds the two board aggregates (`leaderboard`, `leaderboard-frontpage`) in a
final step. All board surfaces (`/web`, the homepage web pane, `list_website_audits`) read the aggregate;
`/web/<domain>` and `get_website_audit` read per-domain R2. Nothing is committed.

Three triggers start a rescore, all coalescing through a single-flight helper (a start while a batch is in flight no-ops
onto the running instance):

- **Weekly cron.** `triggers.crons` in `wrangler.jsonc` (both envs) fires `scheduled()` every Monday 06:00 UTC.
- **Post-deploy hook.** `deploy.yml` POSTs `/api/web-rescore` after each `wrangler deploy`, so a deploy (or a
  `SPEC_VERSION` bump, which rotates every R2 key) repopulates R2 under the current version. The step fails loudly on
  any non-2xx.
- **Manual.** The same endpoint, authed by the `x-web-rescore-secret` header:

  ```bash
  curl -sSf -X POST -H "x-web-rescore-secret: $WEB_RESCORE_SECRET" https://anc.dev/api/web-rescore
  # staging additionally needs the CF Access service-token headers
  ```

  The 202 response carries `{ started, coalesced, instance_id }`. 401 means a wrong or missing header; 500 means the
  Worker-side secret is unset.

**Staleness batching and registry-change reflow.** Each rescore selects the seeded domains whose cached audit is older
than a 2-hour eligibility window (or never audited), oldest-first, in bounded batches, and cycles until none remain, so
one run drains the whole list regardless of size. Recently-audited domains are skipped, so a rescore right after a fresh
board is a cheap aggregate rebuild rather than a full re-audit. The exception is a **registry-shape change**: when the
normalized registry's fingerprint differs from the one recorded in KV (`web_rescore:registry_fp`), the next rescore
forces a full reflow (every domain re-audited regardless of freshness) so cached scorecards re-render under the new
checks and categories, then records the new fingerprint and returns to incremental batching. This covers a display-only
change (for example splitting a category) that does not rotate the `SPEC_VERSION` cache key, and it runs through the
Workflow's own audit path, so it is not subject to the on-demand endpoint's per-source rate limit. Adding or retiering
checks in `registry.yaml` is a registry-shape change; the post-deploy rescore after this kind of PR reflows every
curated seed. Stale `/web/<domain>` URLs keep serving the previous row set until that reflow: missing check ids are
omitted, not shown as ghost rows.

**Secrets.** `WEB_RESCORE_SECRET` is a `wrangler secret put` value on both Workers (`--env staging` and production) and
lives in the GitHub environment secret `ANC_WEB_RESCORE_SECRET` for the deploy hook. Rotate by setting a new value in
both places; there is no fallback window.

**On-demand freshness.** An on-demand audit (`audit_website` or `POST /api/audit-web`) of a seeded domain rebuilds the
aggregates immediately, so a board entry refreshes without waiting for the batch. A cached entry younger than 1 minute
serves as-is; older entries re-run on demand. Every per-target result surface reports that boundary as `refresh_after`,
the earliest instant a re-audit leaves the cache-reuse window; the kill switch, rate limits, and service failures can
still block a fresh audit after it passes. The window is `WEB_AUDIT_STALE_AFTER_MS` in `src/worker/audit-web/cache.ts`;
`refresh_after` is derived from the stored `scored_at` on every read rather than stored, so retuning that constant moves
every advertised boundary with it and no stored value goes stale.

**Verifying the freshness contract after a deploy.** A fresh run and the cache read that immediately follows it must
report the same `scored_at` and `refresh_after` and differ only on `cached`. Against staging (add the CF Access
service-token headers; staging binds the always-passes Turnstile secret, so any token string verifies):

```bash
HOST=https://agentnative-site-staging.<subdomain>.workers.dev
BODY='{"url":"<target>","turnstile_token":"x"}'
# 1. fresh run: streams NDJSON; the terminal line carries cached=false
curl -sSf -X POST "$HOST/api/audit-web" -H 'content-type: application/json' -d "$BODY" \
  | tail -1 | jq '{cached, scored_at, refresh_after}'
# 2. immediately re-read: a single JSON body, same instants, cached=true
curl -sSf -X POST "$HOST/api/audit-web" -H 'content-type: application/json' -d "$BODY" \
  | jq '{cached, scored_at, refresh_after}'
```

`GET /web/<domain>` and its `.md` twin state the same two instants in prose, and `get_website_audit` reports them as
response fields, so a disagreement between any two of those surfaces means storage and a response have drifted.

**Result-page tools are read-only.** `/web/<domain>` registers four WebMCP tools (`get_worksheet`, `get_fix_prompt`,
`get_fix_prompts`, `get_audit_summary`) that read the rendered DOM only. None of them fetches, submits, or navigates, so
no browser-agent path starts an audit or reaches the endpoint behind Turnstile. Fresh audits arrive only through `POST
/api/audit-web` (Turnstile-gated) and the `audit_website` MCP tool (IP-gated), which is where the kill switch and the
limiters sit.

**Cold start / empty board.** After a fresh deploy or a `SPEC_VERSION` bump, the board and homepage pane render a
"scoring in progress" empty state until the deploy hook's batch lands. If the empty state persists, check the Workflow:

```bash
wrangler workflows instances list web-rescore            # production (web-rescore-staging on staging)
wrangler workflows instances describe web-rescore <id>
```

A per-domain step failure is logged (`scope: web-rescore`) and skipped; that domain drops off the board until the next
successful rescore of it.

**Adding a board entry.** Add the row to `seed.yaml`, merge, and either wait for the deploy hook (fires on the same
merge's deploy) or trigger the endpoint manually.

## Logging

Every audit, on every surface (the streaming route, the `audit_website` MCP tool, the rescore Workflow), emits one
summary line to Workers Logs (`observability.enabled` with 100% head sampling in `wrangler.jsonc`):

- `scope: web-audit.run`: target, surface (`stream` | `mcp` | `rescore`), terminal state (`complete` | `incomplete` |
  `unreachable` | `none` when the engine threw), discovered MCP endpoint, elapsed ms, and a per-status check count.
- `scope: web-audit.error`: the engine or stream task threw; carries the target, surface, and message.

Query them in the dashboard under Workers & Pages -> agentnative-site -> Logs, filtering on the `scope` field.

### Debug logging

`WEB_AUDIT_DEBUG: "true"` adds one `web-audit.check` line per check result (id, status, evidence) and a
`web-audit.discovery` line carrying the full probe evidence. Staging binds it in `env.staging.vars`, so every staging
audit is verbose. Production stays at summary-only; for an incident, flip it transiently without a commit:

```bash
wrangler deploy --var WEB_AUDIT_DEBUG:true    # production is the top-level env: no --env flag
# ... reproduce, read logs ...
wrangler deploy                               # redeploy the committed config to turn it back off
```

### Diagnosing a blocked or unreachable target

A target behind a bot-blocking CDN produces one of two log signatures:

- `terminal: "complete"` with a check count dominated by `broken` and evidence full of one repeated status (401/403
  everywhere): the CDN answers, but refuses the auditor. The score is genuine (the site is agent-hostile), and the
  evidence names the status.
- `terminal: "unreachable"`: nothing (root fetch or discovery probe) returned an HTTP status. The engine ends the run
  without caching, the page and tool report the target as unreachable. Typically the CDN tarpits datacenter clients.

Probes identify themselves with the `anc-web-audit/1.0` User-Agent (`AUDIT_USER_AGENT` in
`src/worker/audit-web/ssrf.ts`), which several CDNs treat more leniently than UA-less requests. Do not change it to
impersonate a browser: the audit measures how a site treats agents, and evading the block would score a site the
auditor cannot honestly reach.

## Failure notifications

`src/worker/notify.ts` emails the operator when the audit engine throws (stream task or MCP tool), deduplicated to one
email per alert key per hour through `SCORE_KV`. It is a no-op until provisioned; the code and wiring ship dormant.

To provision (Cloudflare Email Service, Email Sending beta, Workers Paid):

1. Dashboard -> Compute -> Email Service -> Email Sending -> Onboard Domain -> pick the site zone. Cloudflare adds the
   bounce/SPF/DKIM/DMARC records on a `cf-bounce` subdomain.
2. Verify the destination address (Email Routing -> Destination addresses) if it is off-zone; sending to verified
   destination addresses is free on all plans.
3. Add the binding and addresses to `wrangler.jsonc` (staging first, then top-level at promotion):

   ```jsonc
   "send_email": [{ "name": "EMAIL" }],
   "vars": { "ALERT_EMAIL_FROM": "alerts@<zone>", "ALERT_EMAIL_TO": "<verified destination>" }
   ```

4. Deploy and confirm with a forced failure on staging; expect one email and a `deduped` outcome on an immediate
   second failure.

Until step 3 lands, `notifyFailure` returns `unprovisioned` and the only failure signal is `web-audit.error` in
Workers Logs.
