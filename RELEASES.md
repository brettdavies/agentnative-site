# Releasing agentnative-site

Operational runbook. Rationale lives in [`RELEASES-RATIONALE.md`](./RELEASES-RATIONALE.md).

```text
feature branch → PR to dev (squash merge)
              → deploy.yml publishes to staging (agentnative-site-staging.*.workers.dev)
              → cherry-pick to release/* branch
              → PR to main (squash merge)
              → deploy.yml publishes to production (anc.dev)
```

Direct commits to `dev` or `main` are not permitted: every change has a PR number in its squash commit message.

**Exception** for `docs/plans/`, `docs/brainstorms/`, `docs/solutions/`: commit directly to `dev` with `docs(plans):`
(or similar) message. No feature branch, no PR. These paths never reach `main` (`guard-main-docs.yml`).

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

## PR body

Every PR uses `.github/pull_request_template.md` verbatim. Six sections, no inventions: `## Summary`, `## Changelog`,
`## Type of Change`, `## Related Issues/Stories`, `## Files Modified`, `## Testing`.

- **No explainer prose anywhere in the body.** User-facing substance only.
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

# 3. LanguageTool (blocking categories: TYPOS|GRAMMAR|CONFUSED_WORDS).
curl -sS -X POST "${LANGUAGETOOL_URL:-http://languagetool:8081}/v2/check" \
  --data-urlencode "language=en-US" --data-urlencode "text@/tmp/body.md" \
  | jaq '.matches[] | select(.rule.category.id | test("^(TYPOS|GRAMMAR|CONFUSED_WORDS)$"))'

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

Run on staging before opening the first `release/*` PR to main. The no-prod-until-U10 rule keeps this from blocking
today's work; capture the deploy IDs in the evidence table below at the next staging soak window.

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
#    remove the Sandbox DO binding under env.staging, then:
bun x wrangler deploy --env staging

# 4. Verify /api/score now bounces cleanly and non-sandbox routes still serve.
curl -i https://agentnative-site-staging.brettdavies.workers.dev/api/score \
  -H "Content-Type: application/json" -d '{}' | head -20
curl -fSsL https://agentnative-site-staging.brettdavies.workers.dev/ | head -5
curl -fSsL https://agentnative-site-staging.brettdavies.workers.dev/scorecards | head -5

# 5. Restore the Sandbox DO with a NEW migration tag (cannot reuse v1).
#    Edit wrangler.jsonc to add a v3-restore-sandbox migration with
#    new_sqlite_classes: ["Sandbox"] and re-add the binding, then:
bun x wrangler deploy --env staging

# 6. Confirm /api/score works again (step 2 repeated).
```

Capture staging deploy IDs and DO instance counts at each step in the rehearsal-evidence block below.

#### Rehearsal evidence

| Step    | Date    | Staging deploy ID | DO instance count | Notes                                          |
| ------- | ------- | ----------------- | ----------------- | ---------------------------------------------- |
| pending | pending | pending           | pending           | Rehearsal scheduled before the first prod cut. |

### Sandbox image promotion

Standard staging-leads-prod soak (see § Sandbox image releases above). Two pins in `wrangler.jsonc`:
`env.staging.containers[0].image` advances first; `containers[0].image` (top-level production pin) advances on the
release PR. Lockstep-bump shortcut for low-risk image changes only. CI on a main-targeting PR enforces both pins exist
in the CF managed registry AND both pins point at the same tag.

### Post-deploy smoke

`.github/workflows/deploy.yml` runs a smoke step against staging after every successful staging deploy. POSTs to
`/api/score` for the `ripgrep` slug with the CF Access service-token headers and a Turnstile test token; asserts the
response triad (`spec_version`, `site_spec_version`, `anc_version`, `checker_url`) plus `scorecard.kind ===
"registry_hit"`. Fails the deploy on a missing field. No production smoke step runs until U10 promotes live scoring to
anc.dev.

→ Scope rationale (why the smoke covers only the registry-fast-path):
[`RELEASES-RATIONALE.md` § Post-deploy smoke scope](./RELEASES-RATIONALE.md#post-deploy-smoke-scope).

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
`src/data/skill.json`; the skill repo holds the actual content.

### Release procedure

1. **Cut the skill release** (in `agentnative-skill`): edit, commit, tag `v0.x.y`, push `dev --follow-tags`.
   Fast-forward `main` to the new tag and push:

   ```bash
   git checkout main && git merge --ff-only v0.x.y && git push origin main
   ```

2. **Bump the manifest in this repo (only when user-facing fields changed)**: edit `src/data/skill.json` to bump
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
