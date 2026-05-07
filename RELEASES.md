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

- **Commit style**: [Conventional Commits](https://www.conventionalcommits.org/).
- **PR body**: follow the repo's PR template. The `## Changelog` section is the source of truth for user-facing release
  notes.
- **PR body prose scrub**: `gh pr create` and `gh pr edit` send body text directly to GitHub; no local pre-push hook
  sees it. Save the body to `/tmp/`, run Vale + LanguageTool + unslop, fix findings, then submit via `--body-file`. See
  [§ Prose scrubbing](#prose-scrubbing).

## Releasing dev to main

Engineering docs (`docs/plans/`, `docs/solutions/`, `docs/brainstorms/`) live on `dev` only. `guard-main-docs.yml`
blocks them from reaching `main`, and the `guard-release-branch.yml` workflow rejects any PR to main whose head isn't
`release/*`. You MUST use the release-branch cherry-pick pattern:

**Branch naming** (CalVer, mandatory): `release/<YYYY-MM-DD>-<slug>` (e.g. `release/2026-05-01-content-neg-fix`). The
date prefix is the planned merge date, not the cut date — re-naming on slip is allowed but not required. Slug is
kebab-case, short, descriptive (3-6 words). Bare `release/<slug>` (no date prefix) is no longer permitted; the date
prefix is what makes release branches sortable and unambiguous when multiple cuts are in flight.

The `guard-release-branch.yml` workflow currently enforces the `release/` prefix only on PRs targeting `main`; the
CalVer date prefix is convention-enforced via review and this doc. Tightening the workflow regex to require
`^release/\d{4}-\d{2}-\d{2}-` is a tracked follow-up — until that lands, a PR with a date-less branch name will pass CI
but should be renamed before merge.

```bash
# 1. Branch from main, NOT dev. Branching from dev causes add/add conflicts
#    when dev and main have divergent histories (the post-squash-merge norm).
git fetch origin
git checkout -b release/<slug> origin/main

# 2. List the dev commits not yet on main:
git log --oneline dev --not origin/main

# 3. Cherry-pick the ones you want to ship. Docs commits stay on dev.
git cherry-pick <sha1> <sha2> ...

# 4. Triple-diff verification — belt-and-suspenders sweep that catches both
#    directions of drift before the release tag goes out:
#
#    A. main → release  (what users will see; the intended ship surface)
#    B. release → dev   (should be empty for non-doc paths until the
#                        bump/CHANGELOG commits land, and even then should
#                        only list those release-prep files — anything else
#                        is a missed cherry-pick)
#    C. dev → main      (sanity: phantom commits dev "appears ahead" on
#                        because cherry-pick rewrites SHAs post-squash)
git diff origin/main..HEAD --stat                                                # A
git diff HEAD..origin/dev --name-only | grep -v '^docs/' || echo "(none)"        # B
git diff origin/dev..origin/main --stat | tail -5                                # C
#
# Re-confirm no guarded paths leaked (this caught the original miss class):
git diff origin/main..HEAD --name-only \
  | grep -E '^(docs/plans|docs/brainstorms|docs/ideation|docs/reviews|docs/solutions|\.context)' \
  && echo "LEAKED — reset and redo" || echo "(clean — no guarded paths)"
#
# Patch-id cherry check — catches commits on dev that have NO patch-id
# equivalent on release. The file-level diff in B misses this class when
# the same content happens to land via a different commit.
#
# IMPORTANT: in a squash-merge workflow this output is noisy. Every '+'
# line needs human triage — it does NOT auto-block the release. Expected
# sources of '+' lines that are NOT real misses:
#
#   1. Historical commits squash-merged in prior releases. The squash
#      commit on main has a different patch-id than the dev commits it
#      consolidates, so old commits show as '+' forever. Anything older
#      than the previous release tag is almost always this.
#   2. Cherry-picks where conflict resolution stripped guarded paths
#      (docs/plans, docs/brainstorms, etc.) or otherwise altered the
#      tree. Same source-code intent, different patch-id.
#   3. Intentionally skipped commits — docs-only commits, release-prep
#      backports, revert-and-redo prep steps.
#
# A real miss looks like: a recent feat/fix/chore commit on dev whose
# *file content* is not yet on main. To triage a '+' line:
#
#   git show <sha> --stat                       # what did it touch?
#   git diff origin/main..HEAD -- <those-files> # already on release?
#
# If every touched file is guarded (docs/plans/, docs/brainstorms/, etc.)
# OR the content is already on main via a prior squash, it's a false
# positive — no action. Otherwise cherry-pick the commit and re-run the
# triple-diff.
git cherry HEAD origin/dev | grep '^+' || echo "(none — release is patch-equivalent through dev)"
#
# If B lists any non-docs path you didn't expect, fetch dev, identify the
# commit (`git log dev --not origin/main`), cherry-pick it, re-run the
# triple-diff. Missed cherry-picks have shipped to main on this and sibling
# repos before — this step is the cheap way to catch them.

# 5. Push and open the PR. The release-PR body is contributor-authored and goes
#    directly to GitHub (no pre-push reach), so scrub it through Vale +
#    LanguageTool + unslop before --body-file. See "Prose scrubbing" below.
git push -u origin release/<slug>
gh pr create --base main --head release/<slug> \
  --title "release: <summary>" --body-file /tmp/body.md
```

When the PR merges, `deploy.yml` picks up the push to `main` and publishes to staging (see "Deploy" below). Auto-delete
removes `release/<slug>` from the remote on merge. `dev` is untouched.

### Why branch from main, not dev

Branching from `dev` and then `git rm`-ing the guarded paths seems simpler but produces `add/add` merge conflicts
whenever `dev` and `main` have diverged (which they always do after the first squash merge). The file appears as "added"
on both sides with different content. Always branch from `origin/main` and cherry-pick onto it.

## Prose scrubbing

Three release-flow artifacts live outside any automated prose check and need a manual scrub before they ship:

- **PR bodies.** `gh pr create` and `gh pr edit` send body text directly to GitHub; nothing local intercepts it.
- **Release-PR bodies.** The `release/*` PR to `main` carries contributor-authored wrap-up text composed after the
  cherry-picks land, and the same out-of-repo gap applies.
- **Any future generated changelog.** This repo does not yet generate a `CHANGELOG.md`, but if one is added later it
  inherits whatever prose its upstream PR bodies carry — same scrub procedure applies.

The site repo does not yet vendor Vale or LanguageTool rule packs locally; the procedure below points Vale at the spec
repo's checkout (`~/dev/agentnative-spec/.vale.ini`) until U0-U4 of
[`docs/plans/2026-05-07-001-feat-prose-check-site-plan.md`](./docs/plans/2026-05-07-001-feat-prose-check-site-plan.md)
land local copies. The canonical description of the rule packs and the orchestrator's blocking-category whitelist lives
in the spec at
[`~/dev/agentnative-spec/docs/architecture/voice-enforcement.md`](https://github.com/brettdavies/agentnative/blob/dev/docs/architecture/voice-enforcement.md).

The scrub procedure:

```bash
# 1. Save the artifact to /tmp/. The auto-format hook skips /tmp paths, so the
#    body keeps its authored shape and no soft-wrapping is injected.
gh pr view <num> --json body --jq .body > /tmp/body.md         # for PR body edits
# cp CHANGELOG.md /tmp/body.md                                 # for changelog scrub (when one exists)

# 2. Vale (against the spec's rule packs — until vendored locally, point at the spec checkout).
vale --no-global --config ~/dev/agentnative-spec/.vale.ini --output=line --minAlertLevel=error /tmp/body.md

# 3. LanguageTool (blocking categories: TYPOS|GRAMMAR|CONFUSED_WORDS, mirrors the orchestrator's whitelist).
curl -sS -X POST "${LANGUAGETOOL_URL:-http://pool.tail42ba87.ts.net:8081}/v2/check" \
  --data-urlencode "language=en-US" --data-urlencode "text@/tmp/body.md" \
  | jaq '.matches[] | select(.rule.category.id | test("^(TYPOS|GRAMMAR|CONFUSED_WORDS)$"))'

# 4. unslop (em-dash density and AI-unique structural patterns Vale + LT do not catch).
~/.claude/skills/unslop/scripts/score.py /tmp/body.md

# 5. Apply fixes per finding. Re-run until 0 blocking and unslop score is 0.

# 6. Apply the cleaned version:
gh pr edit <num> --body-file /tmp/body.md     # for PR body edits
# (regenerate CHANGELOG.md per the repo's existing changelog flow, once one exists)
```

For a generated-changelog finding (future), fix the upstream PR body and regenerate. Hand-editing the generated artifact
directly produces drift the next regeneration overwrites.

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

### Status-check context pitfall

The `required_status_checks[].context` strings in `protect-main.json` must match exactly what GitHub publishes for each
check:

- **Inline job** (with `name:` field): published as just `<job-name>` (no workflow-name prefix).
- **Reusable-workflow caller** (`uses: .../foo.yml@ref`): published as `<caller-job-id> / <reusable-job-id-or-name>`.

Mixing these produces a stuck-but-green PR: all actual checks report green, but the ruleset waits forever on a context
that will never appear. Confirm the real contexts after a first CI run with:

```bash
gh api repos/brettdavies/agentnative-site/commits/<sha>/check-runs --jq '.check_runs[].name'
```

## Skill releases

`/skill.json` and `/skill` advertise the `agent-native-cli` skill, hosted at
[`brettdavies/agentnative-skill`](https://github.com/brettdavies/agentnative-skill). This site vendors the skill's
manifest (per-host install commands, version, surface metadata) in `src/data/skill.json`; the skill repo holds the
actual content. Surface contract in `docs/DESIGN.md` §3.9. Update detection at install sites is delegated to the skill
bundle's `bin/check-update`, which compares the local bundle's `VERSION` against `main` on GitHub.

The skill repo's branch model: `main` is the published-release pointer (default branch); `dev` is the integration
branch. The bare `git clone --depth 1` in each install command lands on `main` — so each release requires the skill
maintainer to fast-forward `main` to the new tag.

### Skill-release procedure

1. **Cut the skill release** (in `agentnative-skill`): edit, commit, tag `v0.x.y` (signed if a key is configured), then
   `git push origin dev --follow-tags`. Fast-forward `main` to the new tag and push: `git checkout main && git merge
   --ff-only v0.x.y && git push origin main`. The site's bare `git clone --depth 1` lands on `main`, so the fast-forward
   is what makes the new release reachable.
2. **Bump the manifest in this repo (only when user-facing fields changed)**: edit `src/data/skill.json` to bump
   `version` and update any per-host install commands, description, or other surface fields the release modified. If
   nothing user-facing changed, skip the manifest bump entirely — the skill bundle's `bin/check-update` is what tells
   installed users a new release exists.
3. **PR to `dev`**: CI runs the unit + worker tests on the bumped manifest. Squash-merge on green.
4. **Release `dev` → `main`** via the standard `release/*` flow above. Site deploys to `anc.dev`.
5. **Cache-purge** `/skill`, `/skill.json`, and `/skill.md` via the Cloudflare cache-purge API after a manifest bump, so
   users don't pick up the old shape from the 24h `s-maxage` window. Use the API token stored in 1Password
   (`secrets-dev` vault, `Cloudflare API Token - Wrangler (bigdaddy)`). First-deploy-after-rename note (cutover from
   `/install*` → `/skill*`): also purge `/install`, `/install.json`, and `/install.md` once to evict any cached skill
   content under the old paths. Skip this on subsequent deploys.
6. **Verify the deployed manifest**: `curl -s https://anc.dev/skill.json | jq -r .version` matches the new version. The
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
