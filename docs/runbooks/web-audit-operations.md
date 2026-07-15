# Web-audit operations runbook

How to run the website agent-readiness audit against a real target, in each environment, and how to regenerate a
committed web-leaderboard seed scorecard. Pairs with the [MCP operator runbook](./mcp-operator.md) (kill switches,
`wrangler tail`) and the [live-scoring monitoring runbook](./live-scoring-monitoring.md).

## Environments

| Branch | Deploys to                                        | Host                                               | Notes                                                                |
| ------ | ------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| `dev`  | `agentnative-site-staging` Worker (`env.staging`) | `agentnative-site-staging.<subdomain>.workers.dev` | `X-Robots-Tag: noindex` on every response; behind Cloudflare Access. |
| `main` | `agentnative-site` Worker (top-level, production) | `anc.dev` (custom domain)                          | Full indexing, public.                                               |

Source of truth: `.github/workflows/deploy.yml` and the `env.staging` / top-level blocks of `wrangler.jsonc`.

**A `dev` merge reaches staging only, never production.** Production `anc.dev` lags `dev` until a release lands on
`main` (see `RELEASES.md`). So immediately after a `dev` merge, `anc.dev` still serves the previous code and content.
This matters for any audit that reads the target's own content (see
[Seed regeneration](#regenerating-a-web-seed-scorecard)).

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

## Regenerating a web seed scorecard

The web leaderboard is curated, not crawled. Each board entry has a committed snapshot at `scorecards/web/<domain>.json`
(web scorecard schema `0.2`), listed in `src/data/web-audit/seed.yaml`. The build renders the static board pages from
these files; on-demand user audits live only in R2 and never appear here.

To regenerate an entry, run the helper against the live site and write its `--json` output:

```bash
scripts/web-audit/run.sh --target https://<domain>/ --json > scorecards/web/<domain>.json
```

**Regenerate against live production, after the content is on `main`.** The seed represents `anc.dev` as the public sees
it, so it must be captured from production once the relevant code **and** content are live there. Capturing it earlier
bakes in a transient state:

- The helper against `anc.dev` shows a **logic** fix (say an antecedent now resolving `n_a`) but reads the old
  production **content**, so content-dependent checks (`noscript-fallback`, `link-headers`, ...) read as `absent` until
  their PRs reach `main`.
- Staging is a faithful preview but its scorecard's `target_url` is the staging host, not `anc.dev`.

So the correct order is: land the code and content on `main`, let the production deploy finish, run the helper against
`https://anc.dev/`, then commit the resulting `scorecards/web/anc.dev.json`. Auditing before the production release
produces a scorecard that is wrong the moment the release lands.
