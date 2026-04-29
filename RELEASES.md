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

## CI

Two workflows gate pull requests:

| Workflow      | Fires on                                           | Purpose                                                                                                        |
| ------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ci.yml`      | PR with any change outside `docs/**` / root `*.md` | Heavy pipeline: `bun install → lint → build → test → wrangler --dry-run`. ~30s warm.                           |
| `ci-stub.yml` | PR that touches only `docs/**` or root `*.md`      | No-op stub. Emits the required check name to satisfy the ruleset gate without running the heavy pipeline. ~5s. |

Both jobs are named `lint · build · test · wrangler` — the same context the dev/main rulesets require. On a PR that
mixes docs and code, both workflows fire and both pass; the required-check gate is satisfied either way.

### Why the stub

Required status checks + `paths-ignore` is a known
[GitHub Actions sharp edge](https://docs.github.com/en/actions/using-jobs/using-conditions-to-control-job-execution): if
the workflow is filtered out for a given PR, the required check shows as "Expected" forever and the PR can't merge. The
stub workflow fires exactly when `ci.yml` is filtered, emits the same check context as a no-op success, and unblocks the
PR.

### The invariant

`ci.yml`'s `paths-ignore:` list and `ci-stub.yml`'s `paths:` list must stay identical. Drift creates gaps (no workflow
fires → required check never reports → PR stuck) or benign double-runs on mixed PRs. A comment in both files calls this
out explicitly; keep them in sync when editing either one.

### Visual-fidelity gates

Beyond the workflow checks above, two visual-regression rules apply to any change touching CSS, layout, or rendered
output: a "browser-verify before done" agent-side rule (working today) and a Playwright snapshot diff in CI (planned,
deferred until the design system stabilizes). Both live in [`AGENTS.md` § Visual fidelity](./AGENTS.md#visual-fidelity)
— that's the source of truth. A release that didn't satisfy those gates upstream isn't unblocked by this pipeline being
green.

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

## Skill releases

`/skill.json` and `/skill` advertise the `agent-native-cli` skill, hosted at
[`brettdavies/agentnative-skill`](https://github.com/brettdavies/agentnative-skill). This site vendors the skill's
upstream commit SHA in `src/data/skill.json`; the skill repo holds the actual content. Surface contract in
`docs/DESIGN.md` §3.9.

The skill repo's branch model: `main` is the published-release pointer (default branch); `dev` is the integration
branch. The bare `git clone --depth 1` in each install command lands on `main` — so each release REQUIRES the skill
maintainer to fast-forward `main` to the new tag before the site re-pins.

### Skill-release procedure

1. **Cut the skill release** (in `agentnative-skill`): edit, commit, tag `v0.x.y` (signed if a key is configured), then
   `git push origin dev --follow-tags`. Fast-forward `main` to the new tag and push: `git checkout main && git merge
   --ff-only v0.x.y && git push origin main`. The site's bare `git clone --depth 1` lands on `main`, so the fast-forward
   is what makes the new release reachable.
2. **Re-pin in this repo**: edit `src/data/skill.json` — bump `version`, `source.commit`, and `verify.expected`
   (`source.commit` and `verify.expected` are the same SHA until v2 schema decouples them). `loadSkillData()` will
   reject a non-hex / non-lowercase / non-40-char SHA at build time, so a typo fails fast.
3. **PR to `dev`**: CI runs the unit + worker tests on the bumped manifest. Squash-merge on green.
4. **Release `dev` → `main`** via the standard `release/*` flow above. Site deploys to `anc.dev`.
5. **Cache-purge** `/skill`, `/skill.json`, and `/skill.md` via the Cloudflare cache-purge API. Required for
   security-relevant pin updates so users don't pick up the old SHA from the 24h `s-maxage` window. Use the API token
   stored in 1Password (`secrets-dev` vault, `Cloudflare API Token - Wrangler (bigdaddy)`). First-deploy-after-rename
   note (cutover from `/install*` → `/skill*`): also purge `/install`, `/install.json`, and `/install.md` once to evict
   any cached skill content under the old paths. Skip this on subsequent deploys.
6. **Verify the deployed pin**: `curl -s https://anc.dev/skill.json | jq -r .source.commit` matches the new SHA. The
   Playwright `skill` project (`bun x playwright test --project=skill`) re-runs the live 4-host clone against the
   advertised hosts; run it locally before tagging if anything in the manifest's host commands changed.

### Skill-availability probe

`.github/workflows/skill-availability.yml` runs `git ls-remote --exit-code
https://github.com/brettdavies/agentnative-skill.git HEAD` daily at 13:00 UTC and on `workflow_dispatch`. It catches
visibility regressions between releases (repo deletion, accidental flip back to private, branch rename). The probe runs
over unauthenticated HTTPS; failures show up in the Actions tab and email the run owner. After the cutover that flips
the skill repo public, run `gh workflow run skill-availability.yml` once to seed a green run on the schedule.

## Related docs

- [`AGENT.md`](./AGENT.md) — onboarding, repo conventions, tool-site sequencing
- [`docs/DESIGN.md`](./docs/DESIGN.md) — design system and build contract
- [`docs/TODOS.md`](./docs/TODOS.md) — deferred work (not in v0 scope)
