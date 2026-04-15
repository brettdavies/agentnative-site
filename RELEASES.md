# Releasing agentnative-site

Every change reaches production via this pipeline. Direct commits to `dev` or `main` are not permitted — every change
has a PR number in its squash commit message, which keeps the history scannable and attributable.

```text
feature branch → PR to dev (squash merge)
              → cherry-pick to release/* branch
              → PR to main (squash merge)
              → deploy.yml publishes to staging automatically
```

## Branches

| Branch        | Role                              | Lifetime                       | Protection                                |
| ------------- | --------------------------------- | ------------------------------ | ----------------------------------------- |
| `main`        | Production. Only release commits. | Forever.                       | `.github/rulesets/protect-main.json`      |
| `dev`         | Integration. All feature PRs land here. | Forever. Never delete.   | `.github/rulesets/protect-dev.json`       |
| `feat/*`, `fix/*`, `chore/*` | Feature work.      | One PR's worth. Auto-deleted on merge. | None — squash into dev freely. |
| `release/*`   | The head of a dev → main PR.      | One release's worth. Auto-deleted on merge. | None.                     |

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

`.github/workflows/deploy.yml` runs on every push to `main`. It builds the static site and publishes the Worker to the
staging subdomain on `*.workers.dev`. Since PRs are the only way for commits to land on `main`, every deploy maps 1:1 to
a merged release PR.

Manual deploys (for retries after a secret fix, or to deploy a specific SHA without merging) use `workflow_dispatch`:

```bash
gh workflow run deploy.yml --ref main                 # redeploy main HEAD
gh workflow run deploy.yml --ref release/<slug>       # deploy an unmerged
                                                       # release branch for
                                                       # verification
gh workflow run deploy.yml -f ref=<sha>               # deploy a specific SHA
```

### Production domain attach

The production domain (`agentnative.dev` / `.io` / `.org`) is a purchase Brett hasn't made yet. Until it lands,
everything runs on `*.workers.dev`. The staging-host guard in `src/worker/headers.ts` adds `X-Robots-Tag: noindex` on
any response served from a `.workers.dev` host, so staging never ends up in search indexes.

See [AGENT.md § Domain ownership](./AGENT.md#domain-ownership) for the one-line `wrangler.jsonc` swap when the domain
arrives.

## Secrets

Stored as GitHub Actions secrets on `brettdavies/agentnative-site`. Accessible to workflows via `${{ secrets.<name> }}`.

| Secret          | Purpose                                                   | Rotation              |
| --------------- | --------------------------------------------------------- | --------------------- |
| `CF_API_TOKEN`  | Cloudflare API token with `Workers Scripts:Edit` + `Account:Read`. Used by `wrangler-action` to deploy. | Max 1 year; renew before expiry. |
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

Committing the JSON alongside the code means ruleset changes land via the same
review process as workflow changes — a `chore(ci): tighten protect-main` release goes through dev → release/* → main
like anything else.

## Related docs

- [`AGENT.md`](./AGENT.md) — onboarding, repo conventions, tool-site sequencing
- [`docs/DESIGN.md`](./docs/DESIGN.md) — design system and build contract
- [`docs/TODOS.md`](./docs/TODOS.md) — deferred work (not in v0 scope)
