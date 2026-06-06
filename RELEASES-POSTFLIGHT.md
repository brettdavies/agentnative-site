# Post-deploy verification: `agentnative-site`

Operational post-flight checklist. Runs **after a deploy lands**, against either the staging Worker or the production
custom domain. Two environments to verify per release cycle:

- **staging** (`agentnative-site-staging.brettdavies.workers.dev`). Deploys on every push to `dev` per
  `.github/workflows/deploy.yml`. Run `--env staging` once dev is at the soak state for the release.
- **prod** (`anc.dev`). Deploys on every `release/<YYYY-MM-DD>-<slug>` → `main` merge per
  [`RELEASES.md` § Releasing dev to main](./RELEASES.md#releasing-dev-to-main). Run `--env prod` after the merge fires
  `deploy.yml` at main.

Same gates run against both environments. Differences the script handles transparently:

- URL: staging Worker (workers.dev) vs `anc.dev` custom domain.
- Branch the deploy gate watches: `dev` (staging deploy) vs `main` (prod deploy).
- Container app name: `agentnative-site-staging-sandbox` vs `agentnative-site-sandbox`.
- Auth: staging is gated by CF Access (service token auto-staged from 1Password); prod is unauthenticated.
- Backport: the `main → dev` backport concept applies only to prod (the release branch can land edits on `main` that did
  not round-trip to `dev`); staging deploys from `dev` directly so the gate SKIPs there.

Companion to [`RELEASES-PREFLIGHT.md`](./RELEASES-PREFLIGHT.md), which gates the release-branch cut. Both docs follow
the same go/no-go shape: every box is explicit, an unchecked or red item motivates a hotfix.

## Quick start: run the automated gates

```bash
# After a dev push, verify staging
scripts/release/postflight.sh --env staging all

# After a release/* → main merge, verify prod
scripts/release/postflight.sh --env prod all
# (--env prod is the default; the flag is optional in this case)
```

The script (`scripts/release/postflight.sh`) covers the automatable post-deploy gates: `deploy.yml` conclusion,
container app readiness, front-page and leaderboard renders, the registry-fast-path `/api/score` smoke, the live MCP
suite via `scripts/release/mcp-smoke.sh`, the cache-purge confirmation for `/skill` artifacts, and the prod-only `main →
dev` backport signal.

The production live-DO smoke against a non-registry binary requires a browser. The real Turnstile site key + secret gate
the JSON path until the service-token bypass ships per the plan at
[`docs/plans/2026-06-01-003-feat-production-live-do-smoke-bypass-plan.md`](./docs/plans/2026-06-01-003-feat-production-live-do-smoke-bypass-plan.md).
The script reports that gate as a SKIP with the manual recipe; the gate body in this doc carries the steps.

Sub-commands let you re-run one verification in isolation. Each is parameterized on `--env`:

| Sub-command | What it checks                                                                                        | Source of truth                        |
| ----------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `deploy`    | `deploy.yml` on the env's branch (`dev` for staging, `main` for prod): conclusion=success             | `gh run view`                          |
| `container` | Env container app (`agentnative-site[-staging]-sandbox`) state is `ready`                             | `bunx wrangler containers list`        |
| `pages`     | `<env-url>/`, `/scorecards`, and `/api/score` registry-hit all return expected                        | `curl`                                 |
| `mcp`       | `<env-url>/mcp` initialize + `tools/list` + registry-tier symmetry + live audit against `$MCP_BINARY` | `scripts/release/mcp-smoke.sh`         |
| `purge`     | `<env-url>/skill.json` version matches `src/data/skill/skill.json`                                    | `curl`                                 |
| `backport`  | Merged PR to `dev` with the release slug in its title (prod only; SKIPs on staging)                   | `gh pr list --base dev --state merged` |
| `all`       | Every above (live-DO smoke is documented manually below)                                              |                                        |

Flags:

- `--env staging|prod` — target environment (default: `prod`)
- `--repo OWNER/REPO` — override the auto-detected nameWithOwner
- `--release-slug <slug>` — override backport-gate auto-detection (default: parse the most recent merged `release/*` PR
  title)
- `--mcp-binary <binary>` — override the live-audit binary (default: `${MCP_BINARY:-figlet}`)
- `--staging-url <url>` — override the staging Worker URL
- `--prod-url <url>` — override the prod URL

## Checklist

### Deploy

Driven by `scripts/release/postflight.sh --env <staging|prod> deploy` and `scripts/release/postflight.sh --env
<staging|prod> container`.

- [ ] **Env deploy green end-to-end.** The deploy gate watches `deploy.yml` on `dev` (staging) or `main` (prod). For the
  release flow, the `release/<slug> → main` PR merge triggers the prod run. Watch with `gh run watch <run-id>
  --exit-status`, then verify explicitly per `~/.claude/ci-watch-prompt.sh`:

  ```bash
  gh pr view <num> --json statusCheckRollup,mergeStateStatus \
    --jq '{merge: .mergeStateStatus, checks: [.statusCheckRollup[] | {name, conclusion}]}'
  ```

  Every conclusion must be `SUCCESS`. The watcher exit code alone is not authoritative (a completed watcher is not a
  green watcher).

- [ ] **Env container app reaches `ready`.** If the deploy advanced the env's container pin (`containers[0].image` for
  prod, `env.staging.containers[0].image` for staging), the container app rolls asynchronously after deploy. Wait for
  `ready` before smoking the live path:

  ```bash
  # staging
  bunx wrangler containers list | grep agentnative-site-staging-sandbox
  # prod
  bunx wrangler containers list | grep -E 'agentnative-site-sandbox(\s|$)' | grep -v staging
  # STATE must read `ready`, not `provisioning`
  ```

  Loop until `ready` or escalate after ~5 minutes. A smoke during `provisioning` lands on warm OLD-image instances.

### Distribution surface

Driven by `scripts/release/postflight.sh --env <staging|prod> pages` and `scripts/release/postflight.sh --env
<staging|prod> purge`. For staging, the orchestrator auto-stages CF Access service-token headers from 1Password so the
manual recipe below skips the headers; for prod the recipe runs unauthenticated.

- [ ] **Env front page + leaderboard + registry-hit `/api/score` render.** Smoke against the env URL. Substitute the
  staging Worker URL or the prod custom domain as appropriate:

  ```bash
  ENV_URL=https://anc.dev   # or https://agentnative-site-staging.brettdavies.workers.dev for staging
  # When staging, also: -H "CF-Access-Client-Id: $CFID" -H "CF-Access-Client-Secret: $CFSEC" (from 1Password)

  curl -fSsL "${ENV_URL}/" | grep -q '<title>' && echo "home: ok"
  curl -fSsL "${ENV_URL}/scorecards" | grep -q 'leaderboard-table' && echo "leaderboard: ok"
  curl -fSsL "${ENV_URL}/api/score" -X POST \
    -H 'Content-Type: application/json' \
    -d '{"input":"ripgrep","turnstile_token":"x"}' \
    | jq '.scorecard.kind, .anc_version, .spec_version'
  # expect: "registry_hit", <anc_version>, <spec_version>
  ```

  All three must succeed. The registry-hit `/api/score` POST confirms the read tier composes `lookupOnly`'s curated
  branch correctly through the env's bindings.

- [ ] **Cache-purge after deploys that change `/skill`, `/skill.json`, `/skill.md`.** Cloudflare's edge cache holds
  these for the configured TTL; manual purge brings the new version live immediately. Token in 1Password
  (`scripts/staging-cache-smoke.sh` references the item). After purge, confirm the served version matches the bumped
  source:

  ```bash
  curl -fsSL "${ENV_URL}/skill.json" | jq -r '.version'
  jq -r '.version' src/data/skill/skill.json
  # both must match
  ```

### Live HTTP `/api/score` path (prod only)

**Prod only.** Staging uses CF's always-pass test Turnstile pair, so the staging live-DO smoke is already covered by
`scripts/release/preflight.sh do-smoke` against the staging deploy. Prod binds the real Turnstile site key + secret, so
the scripted recipe cannot satisfy this gate; NOT driven by `scripts/release/postflight.sh all`, which reports it as a
SKIP with a pointer to the manual recipe below. See the deferred-bypass plan at
[`docs/plans/2026-06-01-003-feat-production-live-do-smoke-bypass-plan.md`](./docs/plans/2026-06-01-003-feat-production-live-do-smoke-bypass-plan.md).

- [ ] **Production live-DO smoke against a non-registry binary.** Production binds the real Turnstile site key + secret
  (staging uses Cloudflare's always-pass test pair), so the staging-style curl recipe with `turnstile_token:"x"` returns
  `turnstile_failed` against `anc.dev`. Pick one of two paths:

- **Manual (operator-only path).** Open `https://anc.dev/` in a browser, paste the same fresh non-registry binary picked
  for staging into the form (e.g., `npm install -g cowsay`), submit, watch the live run complete, then visit the
  resulting share URL (`/score/live/<binary>`) and confirm the four scorecard classes render (`scorecard-summary`,
  `scorecard-audits`, `scorecard-meta`, `scorecard-embed`).
- **Service-token (CI / scripted path).** Once the service-token bypass lands per the plan at
  [`docs/plans/2026-06-01-003-feat-production-live-do-smoke-bypass-plan.md`](./docs/plans/2026-06-01-003-feat-production-live-do-smoke-bypass-plan.md),
  re-use the staging smoke recipe with an added `X-Anc-Smoke-Token: ${SMOKE_SERVICE_TOKEN}` header. The bypass skips
  Turnstile only; rate-limit + kill-switch stay enforced; bypassed runs emit a distinct telemetry tag (`freshness:
  "live-smoke"`) so they stay separable from user traffic in Analytics Engine.

  Either path satisfies the box. Until the bypass ships, the manual browser path is the only option;
  `scripts/release/postflight.sh all` reports this gate as a SKIP with the manual recipe.

### Live MCP surface (mandatory)

The deployed counterpart to PREFLIGHT's
[Live MCP surface against `wrangler dev --local`](./RELEASES-PREFLIGHT.md#live-mcp-surface-mandatory). What this section
catches and the preflight could not: deploy-side rate-limiter bindings (`MCP_LIMITER` 60/60s, `MCP_AUDIT_LIMITER` 5/60s
burst + 5/60min per-IP KV ceiling), binding drift between `wrangler.jsonc` and the live Worker, and any kill-switch
(`MCP_ENABLED`, `MCP_LIVE_SCORING_ENABLED`) flipped at the env's wrangler block.

Runs against both envs:

- Staging (`https://agentnative-site-staging.brettdavies.workers.dev/mcp`) — gated by CF Access. The orchestrator
  auto-stages the service-token headers from 1Password; `scripts/release/mcp-smoke.sh` reads `CF_ACCESS_CLIENT_ID` /
  `CF_ACCESS_CLIENT_SECRET` from the env when present and attaches them to every curl invocation.
- Prod (`https://anc.dev/mcp`) — unauthenticated (no CF Access on the custom domain).

Driven by `scripts/release/postflight.sh --env <staging|prod> mcp`, which delegates to `scripts/release/mcp-smoke.sh
<env-url>`. The same script is invoked from preflight against `http://localhost:8787`. The only difference between the
three callers is the base URL (plus the env-driven auth headers when `--env staging`).

- [ ] **Production `/mcp` transport answers `initialize` and reports the 9-tool surface.** Confirms `MCP_ENABLED=true`
  at the top-level wrangler env, content negotiation, and that no tool was dropped between releases:

  ```bash
  curl -fsSL -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"postflight","version":"1"}}}' \
    https://anc.dev/mcp \
    | jq '{server: .result.serverInfo.name, protocol: .result.protocolVersion}'
  # expect: server: "anc", protocol: "2025-06-18"

  curl -fsSL -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
    https://anc.dev/mcp \
    | jq '.result.tools | length'
  # expect: 9
  ```

  A 503 / kill-switch envelope means `MCP_ENABLED` is wrong at the top level (production). A non-9 tool count is a
  tool-wiring regression that escaped preflight — block and roll back if it cannot be hotfixed quickly.

- [ ] **Symmetry contract: registry tier returns matching envelopes from both scorecard tools.** Same shape as
  preflight, against prod. Confirms the orchestrator's curated-registry branch composes through the prod bindings
  (preflight validated the code path; this validates the live binding):

  ```bash
  curl -fsSL -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_scorecard","arguments":{"slug":"ripgrep"}}}' \
    https://anc.dev/mcp \
    | jq -r '.result.content[0].text' | jq '{source, scorecard_url}'
  # expect: source: "registry", scorecard_url: "https://anc.dev/score/ripgrep"

  curl -fsSL -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"score_cli","arguments":{"slug":"ripgrep"}}}' \
    https://anc.dev/mcp \
    | jq -r '.result.content[0].text' | jq '{audited, source, next_tool}'
  # expect: audited: false, source: "registry", next_tool: "get_scorecard"
  ```

  Drift between the envelopes means the shared registry-hit branch regressed under prod bindings (e.g., `SCORE_CACHE` R2
  binding misconfigured at top-level wrangler env) — block and investigate.

- [ ] **Live MCP audit via `score_cli` against a fresh non-registry binary.** Exercises the full DO path through the
  prod-side MCP surface AND the `MCP_AUDIT_LIMITER` binding. Consumes one unit of the 5/hour audit budget for the
  caller's IP. Re-use `MCP_BINARY` from preflight (e.g., `figlet`):

  ```bash
  MCP_BINARY=figlet
  grep -E "^- name: ${MCP_BINARY}$" registry.yaml && echo "FAIL: already in registry, pick another" || echo "ok"

  curl -fsSL -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"score_cli\",\"arguments\":{\"install\":\"npm install -g ${MCP_BINARY}\"}}}" \
    https://anc.dev/mcp \
    | jq -r '.result.content[0].text' | jq '{audited, source, has_scorecard: (.scorecard != null), anc_version, error}'
  ```

  Green outcome:

- `audited: true`, `has_scorecard: true`, `source: "live"`
- `anc_version` populated
- no `error` field

  Red outcomes (motivate hotfix or rollback):

- `error.code: "incomplete_response_contract"` with `details: anc_audit_failed` / `chain_resolved_install_failed` /
  `timeout` / `sandbox_unavailable` — investigate per the live-scoring runbook
  ([`docs/runbooks/live-scoring-monitoring.md`](./docs/runbooks/live-scoring-monitoring.md)).
- JSON-RPC envelope at HTTP 200 with `error.code: -32099` (rate-limit breach) — `MCP_AUDIT_LIMITER` is misconfigured at
  the top-level wrangler env (binding should grant 5 / 60s) OR the per-IP KV-backed hourly ceiling regressed. Inspect
  `wrangler.jsonc` `ratelimits[]` and the KV `mcp_audit_hourly:*` keys.

Run `scripts/release/postflight.sh mcp` to run all three MCP gates in sequence.

### Backport (prod only)

Driven by `scripts/release/postflight.sh --env prod backport`. The gate SKIPs on `--env staging` because staging deploys
directly from `dev` — there is no `main → dev` flow to verify.

- [ ] **Backport `main` → `dev`** via a **merged PR to `dev` with the release slug in its title.** The release-branch
  flow can produce edits on `main` that didn't round-trip to `dev` (release-only CHANGELOG.md sections, RELEASES.md
  meta-edits, generator config edits). Cherry-pick those across so the next release's preflight diff-establishment step
  is quiet — a real missed cherry-pick stands out instead of hiding in expected divergence noise.

  The gate (`scripts/release/postflight.sh backport`) is signal-agnostic about which files moved — it looks for the
  merged PR alone, since "which files" varies release-to-release. Branch-name convention is flexible
  (`sync/main-to-dev-<slug>`, `backport/<slug>`, head=`main`, etc.); the only requirement is the release slug in the PR
  title.

  ```bash
  git switch -c backport/<slug> origin/main      # or whatever naming convention you prefer
  # ...any other release-only edits you want to backport...
  gh pr create --base dev --title "backport <slug> release-only files from main"
  ```

## Related docs

- [`RELEASES-PREFLIGHT.md`](./RELEASES-PREFLIGHT.md): pre-cut go/no-go checklist (runs BEFORE this one).
- [`RELEASES.md`](./RELEASES.md): operational runbook for the full release lifecycle. The "Releasing dev to main"
  section references back here as the post-merge verification step.
- [`RELEASES-RATIONALE.md`](./RELEASES-RATIONALE.md): release-flow rationale (branching model, soak-then-promote, CI
  smoke scope).
-

[`docs/solutions/integration-issues/sandbox-image-anc-cli-rename-coordination-2026-06-01.md`](./docs/solutions/integration-issues/sandbox-image-anc-cli-rename-coordination-2026-06-01.md):
the coordination trap the live-DO smoke exists to prevent. -
[`docs/solutions/workflow-issues/cloudflare-container-rollout-readiness-before-smoke.md`](./docs/solutions/workflow-issues/cloudflare-container-rollout-readiness-before-smoke.md):
the rollout-readiness discipline that gates the live-DO smoke.

- [`docs/runbooks/live-scoring-monitoring.md`](./docs/runbooks/live-scoring-monitoring.md): operator telemetry,
  error-tier breakdown, kill-switch flip.
