# Releasing agentnative-site

Operational runbook. Rationale lives in [`RELEASES-RATIONALE.md`](./RELEASES-RATIONALE.md).

```text
feature branch → PR to dev (squash merge)
              → deploy.yml publishes to staging (agentnative-site-staging.*.workers.dev)
              → cherry-pick to release/* branch
              → PR to main (squash merge)
              → deploy.yml publishes to production (anc.dev)
```

Direct commits to `dev` or `main` are not permitted: every change has a PR number in its squash commit message. The
[dev-direct exception](#dev-direct-exception) below names the path categories that may be committed directly to `dev`.

## Branches

| Branch                       | Role                                    | Lifetime                                    | Protection                           |
| ---------------------------- | --------------------------------------- | ------------------------------------------- | ------------------------------------ |
| `main`                       | Production. Only release commits.       | Forever.                                    | `.github/rulesets/protect-main.json` |
| `dev`                        | Integration. All feature PRs land here. | Forever. Never delete.                      | `.github/rulesets/protect-dev.json`  |
| `feat/*`, `fix/*`, `chore/*` | Feature work.                           | One PR's worth. Auto-deleted on merge.      | None. Squash into dev freely.        |
| `release/*`                  | The head of a dev → main PR.            | One release's worth. Auto-deleted on merge. | None.                                |

→ Rationale: [`RELEASES-RATIONALE.md` § Branching model](./RELEASES-RATIONALE.md#branching-model).

## Daily development (feature → dev)

```bash
git checkout dev && git pull
git checkout -b feat/short-description
# ... work ...
git push -u origin feat/short-description
gh pr create --base dev --title "feat(scope): what changed"
# Wait for CI. Squash-merge (PR_BODY becomes the dev commit message).
```

- **Commit style**: [Conventional Commits](https://www.conventionalcommits.org/).
- **PR body**: follow `.github/pull_request_template.md`. See [§ PR body](#pr-body).
- **PR body prose scrub**: see [§ Prose scrubbing](#prose-scrubbing).

### Dev-direct exception

Paths that live only on `dev` and never ship to `main` can be committed directly to `dev` without a feature branch or
PR. The `guard-main-docs` workflow blocks them from `main` PRs regardless. The exception applies to:

- Engineering docs: `docs/brainstorms/`, `docs/ideation/`, `docs/plans/`, `docs/research/`, `docs/reviews/`,
  `docs/solutions/`, and anything under `.context/`.
- Prose-check stack: `styles/`, `.vale.ini`, `scripts/prose-check.sh`.

The standard feature → PR → squash-merge flow remains required for everything else, including consumer-facing markdown
(README, AGENTS, CONTRIBUTING, the release runbook).

## PR body

Every PR uses `.github/pull_request_template.md` verbatim. Six sections, no inventions: `## Summary`, `## Changelog`,
`## Type of Change`, `## Related Issues/Stories`, `## Files Modified`, `## Testing`.

- **No explainer prose anywhere in the body.** User-facing substance only.
- **Summary describes the net diff only** — what merged `main` looks like vs the base branch. Not commit history,
  intermediate state, or cherry-pick mechanics.
- **Zero verification artifacts in the body.** No triple-diff stats, leak-check output ("`guard-main-docs` runs clean"),
  patch-id cherry-check counts, pre-push gate results, CI status, or prose-scrub findings. Anomalies get fixed before
  push, not audit-trailed.
- **Changelog** subsections (`### Added` / `### Changed` / `### Fixed` / `### Documentation`): 1-5 bullets each, delete
  empty subsections, each bullet starts with a verb.
- **Type of Change**: one checkbox. Prefer `feat`/`fix` over `chore` for any user-observable change.
- **Related Issues/Stories**: four labels (`Story:` / `Issue:` / `Architecture:` / `Related PRs:`). All four required
  even when empty (`- None.` / `n/a`).
- **Files Modified**: four sub-headers (`Modified` / `Created` / `Renamed` / `Deleted`). All four required even when
  empty.
- **No AI attribution** in commits or PR bodies.
- **No hard line wraps**: one logical line per paragraph or bullet.

→ Rationale: [`RELEASES-RATIONALE.md` § PR body conventions](./RELEASES-RATIONALE.md#pr-body-conventions).

## Releasing dev to main

```bash
# 1. Branch from main, NOT dev.
git fetch origin
git checkout -b release/<YYYY-MM-DD>-<slug> origin/main

# 2. List the dev commits not yet on main.
git log --oneline dev --not origin/main

# 3. Cherry-pick the ones to ship. Docs commits stay on dev.
git cherry-pick <sha1> <sha2> ...

# 4. Triple-diff verification.
git diff origin/main..HEAD --stat                                              # A: ship surface
git diff HEAD..origin/dev --name-only | grep -v '^docs/' || echo "(none)"      # B: no missed picks
git diff origin/dev..origin/main --stat | tail -5                              # C: phantom-commits sanity

# Re-confirm no guarded paths leaked.
git diff origin/main..HEAD --name-only \
  | grep -E '^(docs/plans|docs/brainstorms|docs/ideation|docs/reviews|docs/solutions|\.context)' \
  && echo "LEAKED — reset and redo" || echo "(clean)"

# Patch-id cherry check (noisy in squash-merge workflow; triage per-line).
git cherry HEAD origin/dev | grep '^+' || echo "(none)"

# 5. Push and open PR. Scrub body in /tmp/ first.
git push -u origin release/<YYYY-MM-DD>-<slug>
gh pr create --base main --head release/<YYYY-MM-DD>-<slug> \
  --title "release: <summary>" --body-file /tmp/body.md
```

**Branch naming** (mandatory): `release/<YYYY-MM-DD>-<slug>` (e.g. `release/2026-05-01-content-neg-fix`). Slug
kebab-case, 3-6 words.

When the PR merges, `deploy.yml` publishes to staging. Auto-delete removes `release/<slug>` from the remote on merge.
`dev` is untouched.

→ Rationale + triple-diff false-positive triage:
[`RELEASES-RATIONALE.md` § Triple-diff verification](./RELEASES-RATIONALE.md#triple-diff-verification).

## Prose scrubbing

Pre-push covers `*.md` files via Vale + LanguageTool. Three artifacts live outside that net and need a manual scrub:

- PR bodies (`gh pr create` / `gh pr edit` send body text directly to GitHub).
- Release-PR bodies (composed after cherry-picks land).
- Future generated changelog (if a `CHANGELOG.md` flow lands here).

```bash
# 1. Author or fetch in /tmp/.
$EDITOR /tmp/body.md                                           # author from scratch
gh pr view <num> --json body --jq .body > /tmp/body.md         # fetch existing

# 2. Vale (local rule packs at error tier).
vale --no-global --output=line --minAlertLevel=error /tmp/body.md

# 3. LanguageTool grammar check via lt_check (~/dotfiles/config/shell/languagetool.sh).
#    Skips cleanly if LT is unreachable. Inspect: `lt_rules`, `lt_info`. See
#    ~/dev/agentnative-spec/CONTRIBUTING.md § Voice enforcement for the
#    install-vs-required nuance.
lt_check /tmp/body.md

# 4. unslop (em-dash density + AI-unique structural patterns).
~/.claude/skills/unslop/scripts/score.py /tmp/body.md

# 5. Apply fixes in /tmp/. Re-run 2-4 until 0 blocking + unslop score 0.

# 6. Submit once.
gh pr create --base <base> --title "..." --body-file /tmp/body.md      # new PR
gh pr edit <num> --body-file /tmp/body.md                              # existing PR
```

→ Rationale + which artifacts need this:
[`RELEASES-RATIONALE.md` § Prose scrubbing scope](./RELEASES-RATIONALE.md#prose-scrubbing-scope).

## Deploy

`.github/workflows/deploy.yml` runs on pushes to `dev` or `main`:

| Branch | Worker                     | Domain                                             | Wrangler command                |
| ------ | -------------------------- | -------------------------------------------------- | ------------------------------- |
| `dev`  | `agentnative-site-staging` | `agentnative-site-staging.<subdomain>.workers.dev` | `wrangler deploy --env staging` |
| `main` | `agentnative-site`         | `anc.dev` (custom domain, `workers_dev: false`)    | `wrangler deploy`               |

The staging-host guard in `src/worker/headers.ts` adds `X-Robots-Tag: noindex` on `.workers.dev` hosts.

Manual deploys:

```bash
gh workflow run deploy.yml -f environment=staging              # redeploy staging
gh workflow run deploy.yml -f environment=production            # redeploy production
gh workflow run deploy.yml -f environment=staging -f ref=<sha>  # specific SHA to staging
```

### Docs-only commits skip deploy

A `paths-ignore` filter on the `push` trigger skips deploy when a commit only touches paths the build doesn't ingest:

- `docs/**`: all planning, design, and solution docs.
- Root-level `*.md`: `README.md`, `AGENTS.md`, `RELEASES.md`, `CHANGELOG.md`. The glob doesn't cross `/`, so
  `content/*.md` pages still deploy.

`workflow_dispatch` is unaffected by `paths-ignore`.

→ Rationale: [`RELEASES-RATIONALE.md` § Docs-only deploy filter](./RELEASES-RATIONALE.md#docs-only-deploy-filter).

### Sandbox image releases (live-scoring)

- **Base**: `python:3.12-slim-trixie` + Cloudflare Sandbox SDK + PMs (cargo-binstall, pip, uv, npm, bun, upstream Go).
- **Image**: `registry.cloudflare.com/<account-id>/anc-sandbox:<git-sha>`. Build decoupled from deploy.
- **Instance type**: staging `standard-2` (1 vCPU, 6 GiB RAM, 12 GB disk); prod `basic` (1/4 vCPU). Promotion: release
  PR + soak.
- **Rationale + version-pin matrix**:
  [`docs/solutions/tooling-decisions/cloudflare-sandbox-python-3.12-base-2026-05-19.md`](docs/solutions/tooling-decisions/cloudflare-sandbox-python-3.12-base-2026-05-19.md).

`wrangler.jsonc` holds TWO independent image pins:

- `containers[0].image` (top-level) = PRODUCTION pin. Advances only at release time.
- `env.staging.containers[0].image` = STAGING pin. Advances independently during development.

#### Image bump (feat PR to dev)

```bash
# from a clean working tree on dev
GIT_SHA=$(git rev-parse --short HEAD)
bun x wrangler containers build -p -t "anc-sandbox:$GIT_SHA" docker/sandbox/
```

Update **only `env.staging.containers[0].image`** in `wrangler.jsonc` with the new tag. Commit Dockerfile change +
staging-pin update together. PR to `dev`.

#### Promotion (release PR to main)

Cut a `release/*` branch from `main`, cherry-pick the dev commits, then add one promotion commit bumping the top-level
`containers[0].image` to match `env.staging.containers[0].image`. CI on a main-targeting PR enforces: both pins exist in
the CF managed registry AND both pins point at the same tag.

#### Lockstep-bump shortcut

For low-risk image changes (security patch, dependency-only update with no behavior delta), update BOTH pins in the same
feat PR.

→ Soak-then-promote rationale, retention discipline, DO migration walls, GHA fallback:
[`RELEASES-RATIONALE.md` § Sandbox image releases](./RELEASES-RATIONALE.md#sandbox-image-releases).

#### R2 score-cache lifecycle

Configure once per bucket (idempotent on the rule name):

```bash
bun x wrangler r2 bucket lifecycle add anc-score-cache scores-7day-ttl scores/ --expire-days 7 -y
bun x wrangler r2 bucket lifecycle add anc-score-cache-staging scores-7day-ttl scores/ --expire-days 7 -y
```

Verify:

```bash
bun x wrangler r2 bucket lifecycle list anc-score-cache
bun x wrangler r2 bucket lifecycle list anc-score-cache-staging
```

Both buckets were configured on 2026-05-19. The `tests/wrangler-config.test.ts` drift-guard pins the exact literal
command above.

## Live-scoring (v3) release procedure

The live-scoring stack adds a Worker route (`/api/score`), a `Sandbox` Durable Object, a Container image, two R2
buckets, a KV namespace (`SCORE_KV`), and two rate-limit bindings to the static-site release. Static-site mechanics are
unchanged.

→ Rationale and platform constraints:
[`RELEASES-RATIONALE.md` § Sandbox image releases](./RELEASES-RATIONALE.md#sandbox-image-releases) and
[§ DO migrations are one-way walls](./RELEASES-RATIONALE.md#do-migrations-are-one-way-walls).

### Image rebuild path

Image build and registry push happen inside the local `wrangler containers build -p` step (see § Sandbox image releases
above). `wrangler deploy` does NOT rebuild. Pin format: `registry.cloudflare.com/<account-id>/anc-sandbox:<git-sha>`.
Immutability is per-Worker-version via `wrangler rollback`, not via a `@sha256:` literal.

### Migration v1: the rollback recipe

`migrations[].new_sqlite_classes: ["Sandbox"]` (tag `v1`) is a one-way gate; rationale lives in
[`RELEASES-RATIONALE.md` § DO migrations are one-way walls](./RELEASES-RATIONALE.md#do-migrations-are-one-way-walls).
The only path past `v1` is a follow-up migration:

```jsonc
// wrangler.jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["Sandbox"] },
  { "tag": "v2-drop-sandbox", "deleted_classes": ["Sandbox"] }
]
```

Apply via a normal `wrangler deploy` against a Worker version that no longer references the `Sandbox` DO binding. The
`SCORE_CACHE` R2 bucket, `SCORE_KV`, and rate-limit counters are untouched by the migration.

### Cross-migration rollback rehearsal

Run on staging before opening the first `release/*` PR to main. The recipe assumes a one-time discovery: the **container
application binding to the deleted DO namespace is the gotcha**, and a `wrangler containers delete` step between v2 and
v3 is mandatory. Without it, v3-restore-sandbox uploads the Worker version cleanly but the container-app half of
`wrangler deploy` refuses with `There is already an application with the name <...> deployed that is associated with a
different durable object namespace`.

```bash
# 1. Confirm migration v1 is live on staging.
bun x wrangler deployments list --env staging | head -20

# 2. Verify /api/score works against a curated slug.
curl -fSsL -H "Content-Type: application/json" \
  -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
  -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
  -d '{"input":"ripgrep","turnstile_token":"x"}' \
  https://agentnative-site-staging.brettdavies.workers.dev/api/score \
  | jq '.scorecard.kind, .spec_version'

# 3. Apply the follow-up migration on a throwaway branch.
#    Edit wrangler.jsonc to add the v2-drop-sandbox migration AND
#    remove the Sandbox DO binding AND the containers[] block under env.staging
#    (containers reference Sandbox class_name and will fail validation if the
#    class no longer exists), then:
bun x wrangler deploy --env staging

# 4. Verify /api/score now bounces cleanly and non-sandbox routes still serve.
#    Inputs that match the registry-fast-path still return 200 (no DO call).
#    Inputs that force the DO-invocation path return CF error 1101 today (no
#    handler guard); the upcoming fix returns a clean 503 sandbox_unavailable.
curl -i https://agentnative-site-staging.brettdavies.workers.dev/api/score \
  -H "Content-Type: application/json" -d '{}' | head -20
curl -fSsL https://agentnative-site-staging.brettdavies.workers.dev/ | head -5
curl -fSsL https://agentnative-site-staging.brettdavies.workers.dev/scorecards | head -5

# 5a. MANDATORY before v3 — delete the staging container application. Its
#     internal binding to the old (now-deleted) DO namespace blocks the v3
#     deploy. List first to capture the ID, then delete.
bun x wrangler containers list
bun x wrangler containers delete <staging-container-app-id>

# 5b. Restore the Sandbox DO with a NEW migration tag (cannot reuse v1).
#     Edit wrangler.jsonc to add a v3-restore-sandbox migration with
#     new_sqlite_classes: ["Sandbox"] and re-add the binding + containers, then:
bun x wrangler deploy --env staging

# 6. Confirm /api/score works again (step 2 repeated). The DO-invocation path
#    (e.g., a real GitHub URL not in the registry) now reaches the sandbox and
#    returns a real scorecard or a clean handler error, not CF 1101.
```

After the rehearsal, dev's `env.staging.migrations` MUST include all three tags (`v1`, `v2-drop-sandbox`,
`v3-restore-sandbox`) because Cloudflare DO migrations are append-only — staging will reject future deploys whose
migration list is a subset of what's already applied. Top-level `migrations` (production) stays at `v1` until prod runs
its own rollback.

#### Rehearsal evidence

| Step | Date       | Staging deploy ID                      | Container app / DO namespace                                                                       | Notes                                                                                                                                                                  |
| ---- | ---------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 2026-05-24 | `c626ddad-6ac2-4f81-a9ec-4a7a6dd926ec` | container `a0309fd2-9622-4dd8-a6a8-faf95292f08e` / DO namespace `a4fb92ed020241cb802c1d5176a39608` | v1 baseline. `env.SCORE (Sandbox)` + all live-scoring bindings present.                                                                                                |
| 2    | 2026-05-24 | (no deploy)                            | n/a                                                                                                | `/api/score` ripgrep returned 200; triad complete (`spec_version: 0.4.0`, `site_spec_version: 0.4.0`, `anc_version: 0.3.0`, `auditor_url`).                            |
| 3    | 2026-05-24 | `25107ae7-6727-4ea9-90ff-75996cba8cdc` | container unchanged / DO namespace dropped                                                         | v2-drop-sandbox applied. Worker bindings list no longer shows `env.SCORE`.                                                                                             |
| 4    | 2026-05-24 | (no deploy)                            | n/a                                                                                                | `-d '{}'` → 400 clean (`unrecognized_input`). `/` + `/scorecards` → 200. DO-forcing input (`xplr`) → CF 1101 (handler guard gap captured).                             |
| 5a   | 2026-05-24 | (no deploy)                            | container `a0309fd2-...` deleted                                                                   | `wrangler containers delete` required — first v3 deploy attempt failed with the "different durable object namespace" error.                                            |
| 5b   | 2026-05-24 | `d88ef7f1-5cd0-4469-a0be-4d8c08d35800` | container `a03d7221-b4ed-4aad-b534-41d7c34461da` / DO namespace `50c9a04e3d4649268d8e8957572e0cd0` | v3-restore-sandbox applied. `env.SCORE (Sandbox)` back; container app recreated fresh at `instances: 0, max_instances: 10`.                                            |
| 6    | 2026-05-24 | (no deploy)                            | n/a                                                                                                | `/api/score` ripgrep → 200 with full triad. DO-forcing input (`xplr`) → 502 `chain_resolved_install_failed` (sandbox ran, real install bug — outside rehearsal scope). |

### Sandbox image promotion

Standard staging-leads-prod soak (see § Sandbox image releases above). Two pins in `wrangler.jsonc`:
`env.staging.containers[0].image` advances first; `containers[0].image` (top-level production pin) advances on the
release PR. Lockstep-bump shortcut for low-risk image changes only. CI on a main-targeting PR enforces both pins exist
in the CF managed registry AND both pins point at the same tag.

### Post-deploy smoke

`.github/workflows/deploy.yml` runs a smoke step against staging after every successful staging deploy. POSTs to
`/api/score` for the `ripgrep` slug with the CF Access service-token headers and a Turnstile test token; asserts the
response triad (`spec_version`, `site_spec_version`, `anc_version`, `auditor_url`) plus `scorecard.kind ===
"registry_hit"`. Fails the deploy on a missing field. No production smoke step runs until U10 promotes live scoring to
anc.dev.

→ Scope rationale (why the smoke covers only the registry-fast-path):
[`RELEASES-RATIONALE.md` § Post-deploy smoke scope](./RELEASES-RATIONALE.md#post-deploy-smoke-scope).

### Pre-release live-path smoke (manual)

The CI post-deploy smoke above exercises the registry-fast-path only. The live DO path (install + `anc audit` inside the
Sandbox container) is not exercised by automation. Before opening a `release/*` PR to main, run this smoke manually
against staging to catch coordination drift between the Worker's CLI invocation and the container's baked-in `anc`
binary.

Background: this gap was found on 2026-06-01 when a non-registry binary returned a 500 (`incomplete_response_contract:
anc_audit_failed`). Root cause was a coordination mismatch — PR #131 (2026-05-29) renamed the Worker invocation from
`anc check` to `anc audit`, but the staging container image was still pinned at the pre-rename `anc v0.4.0` binary,
which only understood `check`. The registry-fast-path smoke stayed green because it never invoked the container.
Reproduction recipe and remediation in
[`docs/solutions/integration-issues/sandbox-image-anc-cli-rename-coordination-2026-06-01.md`](./docs/solutions/integration-issues/sandbox-image-anc-cli-rename-coordination-2026-06-01.md).

Steps:

```bash
# 1. Pick a non-registry binary. `cowsay` (npm) is the fixture used historically — any
#    GitHub URL or install command that resolves to a binary NOT in registry.yaml works.
#    Verify the binary is not registry-curated first:
grep -E '^- name: cowsay$' registry.yaml || echo "ok, cowsay not in registry"

# 2. POST to staging /api/score with the live-path input. Staging Turnstile uses the
#    CF always-passes test secret, so turnstile_token:"x" is accepted.
curl -fSsL -H "Content-Type: application/json" \
  -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
  -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
  -d '{"input":"https://github.com/piuccio/cowsay","turnstile_token":"x"}' \
  https://agentnative-site-staging.brettdavies.workers.dev/api/score \
  | jq '{
      ok: (.scorecard != null and .scorecard.tool.binary != null),
      tier: (if .scorecard then "live-or-cache" else "error" end),
      error: .error.code,
      details: .error.details,
      spec_version, anc_version, auditor_url, share_url
    }'
```

Green outcome:

- `ok: true`
- `tier: "live-or-cache"`
- `error: null`
- Response triad (`spec_version`, `anc_version`, `auditor_url`) all present.
- `share_url` shaped as `/score/live/<binary>` (the share URL the cache wrote under).

Red outcome (block the release PR):

- HTTP 500 with `error.code: "incomplete_response_contract"`. Inspect `error.details` for the underlying DO error:
- `anc_audit_failed: error: ...` → CLI invocation incompatible with the container's `anc` binary (the 2026-06-01 case
    above). Fix: rebuild the container image with the correct `anc` release, bump the staging pin in `wrangler.jsonc`,
    redeploy. See § Sandbox image releases.
- `chain_resolved_install_failed: pm=<pm>` → install pipeline broke for that package manager inside the sandbox. Fix:
    investigate the install layer.
- `timeout` → DO budget exceeded. Fix: investigate install or audit duration in observability.
- HTTP 503 `sandbox_unavailable` → container app not bound. Fix: verify staging `containers[]` block in `wrangler.jsonc`
  and `wrangler containers list`.

The smoke is purposely manual rather than CI-automated: running a real install + sandbox spawn on every deploy would add
cost and flakiness for a check that only needs to run before a production promotion. CI-automating this requires a
separate kill-switch + cost ceiling (see [§ Cost guardrails](#cost-guardrails)).

### Cost-watch hand-off

Operator telemetry queries, error-tier breakdowns, cache hit-rate watchpoints, and the kill-switch flip procedure live
in the live-scoring monitoring runbook:

- [`docs/runbooks/live-scoring-monitoring.md`](docs/runbooks/live-scoring-monitoring.md).

The queryable counterpart with canonical Analytics Engine SQL lives in the analytics runbook:

- [`docs/runbooks/live-scoring-analytics.md`](docs/runbooks/live-scoring-analytics.md).

### Cost guardrails

Four-layer cost-cap stance, ordered by speed-to-act:

1. **Implicit per-request limits.** `SCORE_LIMITER` (10 req/min/session) and `SCORE_LIMITER_IP` (30 req/min/IP) are the
   per-user cost ceilings. Live since U5. Analytics Engine confirms whether they are effective on the registry-hit-rate
   query in the analytics runbook (high registry-hit-rate means most traffic is unmetered; low rate means the limiters
   are the load-bearing ceiling).
2. **Manual kill switch.** Flip via `wrangler kv key put`:

   ```bash
   # Staging
   wrangler kv key put --binding=SCORE_KV --env staging scoring_disabled true

   # Production
   wrangler kv key put --binding=SCORE_KV scoring_disabled true
   ```

   Recovery time is bounded by the in-isolate cache TTL (30 s) and the KV global propagation (≤60 s). Reset by deleting
   the key:

   ```bash
   wrangler kv key delete --binding=SCORE_KV --env staging scoring_disabled
   ```

   The operator-facing playbook lives in the monitoring runbook; this section names the procedure.
3. **Email-only Cloudflare Budget Alerts** at $5, $25, and $100 thresholds. Cloudflare has no native cost auto-cap; the
   billing dashboard is read-only at the API layer. Configure in the Cloudflare dashboard under Billing → Notifications.
   Add three separate Budget Alerts (one per threshold) with the operator email on the destination list; each alert
   fires once per billing cycle when the rolling charge crosses its threshold; setup is one-time per account and the
   alerts persist across deploys. Confirm the wiring with a test alert at a low threshold ($1) before relying on the
   production thresholds.
4. **Automated kill switch via cron.** DEFERRED to U10.1. Concept: a scheduled Worker queries the Analytics Engine
   dataset for rolling 24h request count and flips `scoring_disabled` past a threshold. Threshold tuning needs real
   traffic data; the pieces (dataset + kill switch + Workers cron primitive) all exist, but wiring them is its own
   discrete change. Do not speculate.

#### Analytics Engine datasets

Two distinct datasets keep staging traffic out of production aggregates:

| Environment | Binding           | Dataset                  |
| ----------- | ----------------- | ------------------------ |
| Production  | `SCORE_TELEMETRY` | `anc_live_score_prod`    |
| Staging     | `SCORE_TELEMETRY` | `anc_live_score_staging` |

Datasets are created on first write; no `wrangler analytics-engine create` step needed. Confirm in the Cloudflare
dashboard under Workers → Analytics Engine after the first post-deploy request.

Sample query (paste into the dashboard's AE SQL editor, replace dataset name per environment):

```sql
SELECT blob2 AS pm, COUNT() AS requests
FROM anc_live_score_staging
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY pm
ORDER BY requests DESC
FORMAT JSONCompact
```

The full canonical query playbook (daily volume, p50/p99 latency, error distribution, registry-hit-rate, top tools)
lives in [`docs/runbooks/live-scoring-analytics.md`](docs/runbooks/live-scoring-analytics.md).

## Staging access (Cloudflare Access)

Staging Worker gated by CF Access. Browser: SSO/email-OTP at `https://agentnative-site-staging.brettdavies.workers.dev`
(90-day session). CLI: `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers from 1Password (see
`scripts/staging-cache-smoke.sh` for the item lookup convention).

Bootstrap (idempotent):

```bash
CF_ACCOUNT_ID=<account-id> ./scripts/cf-access-bootstrap.sh
```

Inventory + rotation playbook + dashboard permission-group gotcha:
[`docs/solutions/tooling-decisions/cloudflare-access-staging-worker-2026-05-19.md`](docs/solutions/tooling-decisions/cloudflare-access-staging-worker-2026-05-19.md).

## CI

Two workflows gate pull requests:

| Workflow      | Fires on                                           | Purpose                                                                              |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ci.yml`      | PR with any change outside `docs/**` / root `*.md` | Heavy pipeline: `bun install → lint → build → test → wrangler --dry-run`. ~30s warm. |
| `ci-stub.yml` | PR that touches only `docs/**` or root `*.md`      | No-op stub. Emits the required check name without running the heavy pipeline. ~5s.   |

Both jobs are named `lint · build · test · wrangler`.

`ci.yml`'s `paths-ignore:` list and `ci-stub.yml`'s `paths:` list must stay identical.

→ Rationale + status-check context pitfall:
[`RELEASES-RATIONALE.md` § CI workflow split](./RELEASES-RATIONALE.md#ci-workflow-split).

## Secrets

GitHub Actions secrets on `brettdavies/agentnative-site`:

| Secret          | Purpose                                                                                                 | Rotation                                |
| --------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `CF_API_TOKEN`  | Cloudflare API token with `Workers Scripts:Edit` + `Account:Read`. Used by `wrangler-action` to deploy. | Max 1 year; renew before expiry.        |
| `CF_ACCOUNT_ID` | Cloudflare account ID. Surfaces to wrangler via `CLOUDFLARE_ACCOUNT_ID` env.                            | Changes only if the CF account changes. |

`GITHUB_TOKEN` is provided by GitHub Actions automatically.

Secrets are also mirrored in 1Password for disaster recovery and cross-device use.

## Branch protection

Rulesets committed under `.github/rulesets/`, applied to the repo via the GitHub API:

- `protect-main.json`: required signatures, linear history, squash-only merges via PR, required status checks (`ci`,
  `guard-docs`, `guard-release-branch`), creation/deletion blocked, non-fast-forward blocked.
- `protect-dev.json`: required signatures, deletion blocked, non-fast-forward blocked. PR-only norm is convention +
  `guard-release-branch` on the main side.

### Applying changes

```bash
# First apply (creating a ruleset):
gh api -X POST repos/brettdavies/agentnative-site/rulesets \
  --input .github/rulesets/protect-dev.json

# Subsequent updates (replace by ID — find via `gh api repos/.../rulesets`):
gh api -X PUT repos/brettdavies/agentnative-site/rulesets/<id> \
  --input .github/rulesets/protect-main.json
```

→ Status-check context strings (inline vs reusable):
[`RELEASES-RATIONALE.md` § Status-check context strings](./RELEASES-RATIONALE.md#status-check-context-strings).

## Skill releases

`/skill.json` and `/skill` advertise the `agent-native-cli` skill, hosted at
[`brettdavies/agentnative-skill`](https://github.com/brettdavies/agentnative-skill). Site vendors the manifest in
`src/data/skill/skill.json`; the skill repo holds the actual content.

### Release procedure

1. **Cut the skill release** (in `agentnative-skill`): edit, commit, tag `v0.x.y`, push `dev --follow-tags`.
   Fast-forward `main` to the new tag and push:

   ```bash
   git checkout main && git merge --ff-only v0.x.y && git push origin main
   ```

2. **Bump the manifest in this repo (only when user-facing fields changed)**: edit `src/data/skill/skill.json` to bump
   `version` and update any per-host install commands, description, or other surface fields.
3. **PR to `dev`**: CI runs unit + worker tests on the bumped manifest. Squash-merge on green.
4. **Release `dev` → `main`** via the standard `release/*` flow above. Site deploys to `anc.dev`.
5. **Cache-purge** `/skill`, `/skill.json`, `/skill.md` via the Cloudflare cache-purge API (token in 1Password).
   First-deploy-after-rename: also purge `/install`, `/install.json`, `/install.md` once.
6. **Verify**: `curl -s https://anc.dev/skill.json | jq -r .version` matches the new version. Run the Playwright `skill`
   project (`bun x playwright test --project=skill`) against the live host.

→ Rationale: [`RELEASES-RATIONALE.md` § Skill releases](./RELEASES-RATIONALE.md#skill-releases).

### Skill-availability probe

`.github/workflows/skill-availability.yml` runs `git ls-remote --exit-code
https://github.com/brettdavies/agentnative-skill.git HEAD` daily at 13:00 UTC and on `workflow_dispatch`. Catches
visibility regressions (repo deletion, accidental flip back to private, branch rename). After flipping the skill repo
public, run `gh workflow run skill-availability.yml` once to seed a green run on the schedule.

## Related docs

- [`RELEASES-RATIONALE.md`](./RELEASES-RATIONALE.md): release flow rationale, CI design, status-check pitfalls
- [`AGENT.md`](./AGENT.md): onboarding, repo conventions, tool-site sequencing
- [`DESIGN.md`](./DESIGN.md): design system and build contract
- [`docs/TODOS.md`](./docs/TODOS.md): deferred work (not in v0 scope)
