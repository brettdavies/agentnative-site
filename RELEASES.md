# Releasing agentnative-site

Every change reaches production via this pipeline. Direct commits to `dev` or `main` are not permitted — every change
has a PR number in its squash commit message, which keeps the history scannable and attributable.

```text
feature branch → PR to dev (squash merge)
              → deploy.yml publishes to staging (agentnative-site-staging.*.workers.dev)
              → cherry-pick to release/* branch
              → PR to main (squash merge)
              → deploy.yml publishes to production (anc.dev)
```

**Exception — `docs/plans/`.** Plan documents are author-driven thinking artifacts. They don't ship to production
(`guard-main-docs.yml` blocks `docs/plans/`, `docs/solutions/`, and `docs/brainstorms/` from reaching `main`) and they
don't need code review. Commit them directly to `dev` with a `docs(plans):` Conventional Commits message — skip the
feature branch entirely. The dev ruleset's admin bypass (`bypass_actor` for RepositoryRole 5) allows this without
needing the otherwise-required CI check. The same convention applies to ad-hoc edits of `docs/brainstorms/` and
`docs/solutions/` (the latter being a symlink to the shared `solutions-docs` repo, which has its own commit flow). Code,
content, scripts, registry, and everything else still go through the PR pipeline above.

## Branches

| Branch                       | Role                                    | Lifetime                                    | Protection                           |
| ---------------------------- | --------------------------------------- | ------------------------------------------- | ------------------------------------ |
| `main`                       | Production. Only release commits.       | Forever.                                    | `.github/rulesets/protect-main.json` |
| `dev`                        | Integration. All feature PRs land here. | Forever. Never delete.                      | `.github/rulesets/protect-dev.json`  |
| `feat/*`, `fix/*`, `chore/*` | Feature work.                           | One PR's worth. Auto-deleted on merge.      | None — squash into dev freely.       |
| `release/*`                  | The head of a dev → main PR.            | One release's worth. Auto-deleted on merge. | None.                                |

`dev` is a **forever branch**. Never delete it locally or remotely, even after a `release/* → main` merge. The next
release cycle reuses the same `dev`. The repo's `deleteBranchOnMerge: true` setting doesn't touch `dev` as long as `dev`
is never the head of a PR — using a short-lived `release/*` head is what keeps the setting compatible with a forever
integration branch.

## Daily development (feature → dev)

```bash
git checkout dev && git pull
git checkout -b feat/short-description
# ... work ...
git push -u origin feat/short-description
gh pr create --base dev --title "feat(scope): what changed"
# Wait for CI. Squash-merge (PR_BODY becomes the dev commit message).
```

Commit-message style: [Conventional Commits](https://www.conventionalcommits.org/). PR body uses the repo's PR template
— the `## Changelog` section is the source of truth for user-facing release notes.

## Releasing dev to main

Engineering docs (`docs/plans/`, `docs/solutions/`, `docs/brainstorms/`) live on `dev` only. `guard-main-docs.yml`
blocks them from reaching `main`, and the `guard-release-branch.yml` workflow rejects any PR to main whose head isn't
`release/*`. You MUST use the release-branch cherry-pick pattern:

**Branch naming**: `release/<date>-<slug>` or `release/<slug>` (e.g. `release/2026-05-01-content-neg-fix`). Keep the
slug short and descriptive.

```bash
# 1. Branch from main, NOT dev. Branching from dev causes add/add conflicts
#    when dev and main have divergent histories (the post-squash-merge norm).
git fetch origin
git checkout -b release/<slug> origin/main

# 2. List the dev commits not yet on main:
git log --oneline dev --not origin/main

# 3. Cherry-pick the ones you want to ship. Docs commits stay on dev.
git cherry-pick <sha1> <sha2> ...

# 4. Verify no guarded paths leaked through:
git diff origin/main --stat
# If anything under docs/plans/, docs/solutions/, or docs/brainstorms/
# shows up, you cherry-picked a docs commit by mistake — reset and redo.

# 5. Push and open the PR:
git push -u origin release/<slug>
gh pr create --base main --head release/<slug> \
  --title "release: <summary>"
```

When the PR merges, `deploy.yml` picks up the push to `main` and publishes to staging (see "Deploy" below). Auto-delete
removes `release/<slug>` from the remote on merge. `dev` is untouched.

### Why branch from main, not dev

Branching from `dev` and then `git rm`-ing the guarded paths seems simpler but produces `add/add` merge conflicts
whenever `dev` and `main` have diverged (which they always do after the first squash merge). The file appears as "added"
on both sides with different content. Always branch from `origin/main` and cherry-pick onto it.

## Deploy

`.github/workflows/deploy.yml` runs on pushes to `dev` or `main`, targeting separate Workers via wrangler environments:

| Branch | Worker                     | Domain                                             | Wrangler command                |
| ------ | -------------------------- | -------------------------------------------------- | ------------------------------- |
| `dev`  | `agentnative-site-staging` | `agentnative-site-staging.<subdomain>.workers.dev` | `wrangler deploy --env staging` |
| `main` | `agentnative-site`         | `anc.dev` (custom domain, `workers_dev: false`)    | `wrangler deploy`               |

The staging-host guard in `src/worker/headers.ts` adds `X-Robots-Tag: noindex` on any response served from a
`.workers.dev` host. Production at `anc.dev` gets full indexing.

Manual deploys use `workflow_dispatch` with an explicit environment picker:

```bash
gh workflow run deploy.yml -f environment=staging              # redeploy staging
gh workflow run deploy.yml -f environment=production            # redeploy production
gh workflow run deploy.yml -f environment=staging -f ref=<sha>  # deploy a specific SHA to staging
```

### Docs-only commits skip deploy

A `paths-ignore` filter on the `push` trigger skips deploy when a commit only touches paths the build doesn't ingest:

- `docs/**` — all planning, design, and solution docs.
- Root-level `*.md` — `README.md`, `AGENTS.md`, `RELEASES.md`, `CHANGELOG.md` (the glob doesn't cross `/`, so
  `content/*.md` pages still deploy).

Everything else — `content/**`, `src/**`, `scripts/**`, workflows, `wrangler.jsonc`, `package.json`, etc. — still
triggers a deploy on push. `workflow_dispatch` is unaffected, so manual redeploys always work regardless of what
changed.

The filter is symmetric across `dev` and `main`. In practice the `main` side is mostly theoretical:
`guard-main-docs.yml` already blocks `docs/plans|solutions|brainstorms|reviews/**` from reaching `main` via PR, and the
remaining ignored paths (root `*.md`, `docs/DESIGN.md`, `docs/TODOS.md`) don't change build output — wrangler would
redeploy a bit-identical Worker. If a future case needs unconditional main-branch deploys, swap the workflow-level
filter for a job-level changed-files check.

## Secrets

Stored as GitHub Actions secrets on `brettdavies/agentnative-site`. Accessible to workflows via `${{ secrets.<name> }}`.

| Secret          | Purpose                                                                                                                                                                         | Rotation                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `CF_API_TOKEN`  | Cloudflare API token with `Workers Scripts:Edit` + `Account:Read`. Used by `wrangler-action` to deploy.                                                                         | Max 1 year; renew before expiry.                            |
| `CF_ACCOUNT_ID` | Cloudflare account ID. Not a formal secret, but kept out of the public repo; surfaces to wrangler via `CLOUDFLARE_ACCOUNT_ID` env (passed to `wrangler-action` as `accountId`). | Effectively never — changes only if the CF account changes. |

`GITHUB_TOKEN` is provided automatically by GitHub Actions; no setup needed.

Secrets are also mirrored in 1Password (`secrets-dev` vault) for disaster-recovery and cross-device use.

## Branch protection

Two rulesets are committed under `.github/rulesets/` and applied to the repo via the GitHub API:

- `protect-main.json` — required signatures, linear history, squash-only merges via PR, required status checks (`ci`,
  `guard-docs`, `guard-release-branch`), creation/deletion blocked, non-fast-forward blocked.
- `protect-dev.json` — required signatures, deletion blocked, non-fast-forward blocked. No PR-requirement at the ruleset
  level; the PR-only norm is enforced by convention + the `guard-release-branch` check on the main side.

### Applying changes

Edit the JSON locally, then sync to the remote:

```bash
# First apply (creating a ruleset):
gh api -X POST repos/brettdavies/agentnative-site/rulesets \
  --input .github/rulesets/protect-dev.json

# Subsequent updates (replace by ID — find via `gh api repos/.../rulesets`):
gh api -X PUT repos/brettdavies/agentnative-site/rulesets/<id> \
  --input .github/rulesets/protect-main.json
```

Committing the JSON alongside the code means ruleset changes land via the same review process as workflow changes — a
`chore(ci): tighten protect-main` release goes through dev → release/* → main like anything else.

## Related docs

- [`AGENT.md`](./AGENT.md) — onboarding, repo conventions, tool-site sequencing
- [`docs/DESIGN.md`](./docs/DESIGN.md) — design system and build contract
- [`docs/TODOS.md`](./docs/TODOS.md) — deferred work (not in v0 scope)
