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

`POST /api/audit-web` with a JSON body `{ url, site_type?, turnstile_token }` streams NDJSON. The terminal `{ "type":
"complete", "scorecard", "share_url" }` event carries the full web scorecard (schema `0.2`). `site_type` is optional
(`content` | `api`); omit it to let the audit auto-detect.

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

  A 202 carries `{ started, coalesced, instance_id }`. 401 means a wrong/missing header; 500 means the Worker-side
  secret is unset.

**Secrets.** `WEB_RESCORE_SECRET` is a `wrangler secret put` value on both Workers (`--env staging` and production) and
lives in the GitHub environment secret `ANC_WEB_RESCORE_SECRET` for the deploy hook. Rotate by setting a new value in
both places; there is no fallback window.

**On-demand freshness.** An on-demand audit (`audit_website` or `POST /api/audit-web`) of a seeded domain rebuilds the
aggregates immediately, so a board entry refreshes without waiting for the batch. A cached entry younger than 5 minutes
serves as-is; older entries re-run on demand.

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
