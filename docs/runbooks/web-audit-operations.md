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

### Against production (`anc.dev`)

Use the site's own audit UI (`https://anc.dev/web-audit`) or the `audit_website` MCP tool. A scripted `POST` needs a
real Turnstile token, so it is not the convenient path.

### Against staging

Staging sits behind Cloudflare Access, so a plain request returns `302` to the Access login. Send the service-token
headers (item **"Cloudflare Access Service Token - agentnative-site-staging"** in the vault; fetch via the `/1password`
skill, never inline the values):

```bash
STAGING="https://agentnative-site-staging.<subdomain>.workers.dev"
curl -sS -X POST "$STAGING/api/audit-web" \
  -H 'content-type: application/json' \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -d "{\"url\":\"$STAGING/\",\"turnstile_token\":\"x\"}"
```

Auditing the staging URL itself is a faithful preview of what `main` will serve, because staging runs the `dev` code
against the `dev`-built content.

### With the local engine against a public URL (preview a fix)

The reliable way to run the **current working-tree** audit logic against **real remote content** without deploying: call
`runWebAudit` from a throwaway Bun script. `guardedFetch` uses standard `fetch` plus hostname validation (no
Workers-only APIs), so the engine runs under Bun. This is how you confirm a change to the antecedents or scoring before
it ships.

```bash
bun run build   # produces dist/_internal/web-audit-registry.json
```

```ts
// audit-once.ts — bun run audit-once.ts
import { readFileSync } from 'node:fs';
import { runWebAudit } from './src/worker/audit-web/engine';

const registry = JSON.parse(readFileSync('dist/_internal/web-audit-registry.json', 'utf8'));
const audit = runWebAudit({ url: 'https://anc.dev/', registry, specVersion: '0.5.0', fetchOptions: {} });

let scorecard: unknown = null;
let ev = await audit.next();
while (!ev.done) {
  if (ev.value.type === 'complete') scorecard = ev.value.scorecard;
  ev = await audit.next();
}
console.log(JSON.stringify(scorecard, null, 2));
```

The audit logic is the local code; the content is whatever the target serves live. So a fix to the audit **logic** (e.g.
an antecedent) shows its effect immediately, but a check whose pass depends on the target's **content** (e.g.
`noscript-fallback` needs the page to ship a `<noscript>`) still reads the target's currently-deployed content.

## Regenerating a web seed scorecard

The web leaderboard is curated, not crawled. Each board entry has a committed snapshot at `scorecards/web/<domain>.json`
(web scorecard schema `0.2`), listed in `src/data/web-audit/seed.yaml`. The build renders the static board pages from
these files; on-demand user audits live only in R2 and never appear here.

To regenerate an entry: run the audit against the live site and save the terminal `complete` event's `scorecard` as
`scorecards/web/<domain>.json`.

**Regenerate against live production, after the content is on `main`.** The seed represents `anc.dev` as the public sees
it, so it must be captured from production once the relevant code **and** content are live there. Capturing it earlier
bakes in a transient state:

- The local-engine recipe against `anc.dev` shows a **logic** fix (say an antecedent now resolving `n_a`) but reads the
  old production **content**, so content-dependent checks (`noscript-fallback`, `link-headers`, ...) read as `absent`
  until their PRs reach `main`.
- Staging is a faithful preview but its scorecard's `target_url` is the staging host, not `anc.dev`.

So the correct order is: land the code and content on `main`, let the production deploy finish, run the audit against
`https://anc.dev/`, then commit the resulting `scorecards/web/anc.dev.json`. Auditing before the production release
produces a scorecard that is wrong the moment the release lands.
