# Architecture decisions

Companion to [`RELEASES.md`](./RELEASES.md). RELEASES.md is the runbook (commands, paths, decision tables). This file
holds the WHY behind those rules: branching model, PR conventions, CI design, deploy filter logic, sandbox-image
lifecycle, status-check pitfalls.

Read this when:

- A rule in RELEASES.md doesn't make sense and you're tempted to change it.
- A new contributor asks "why do we do X this way".
- You're adding a new release-flow rule and need to know where it fits the existing model.

## Branching model

### Forever `dev`, ephemeral release branches

`dev` is never deleted, even after a release. The next release cycle reuses the same `dev`. The repo's
`deleteBranchOnMerge: true` setting doesn't touch `dev` as long as `dev` is never the head of a PR. Using a short-lived
`release/*` head is what keeps the setting compatible with a forever integration branch.

Engineering docs (`docs/plans/`, `docs/solutions/`, `docs/brainstorms/`) live on `dev` only. They never reach `main`.
`guard-main-docs.yml` blocks them from PRs targeting `main`, and `guard-release-branch.yml` rejects any PR to main whose
head isn't `release/*`.

### Why cherry-pick from `main`, not branch from `dev`

Branching from `dev` and then `git rm`-ing the guarded paths seems simpler but produces `add/add` merge conflicts
whenever `dev` and `main` have diverged (which they always do after the first squash merge). The file appears as "added"
on both sides with different content. Always branch from `origin/main` and cherry-pick the dev commits onto it.

### CalVer release branches

Branch naming `release/<YYYY-MM-DD>-<slug>` (mandatory) makes release branches sortable and unambiguous when multiple
cuts are in flight. The date prefix is the planned merge date, not the cut date; re-naming on slip is allowed but not
required. Slug is kebab-case, short, descriptive (3-6 words). Bare `release/<slug>` (no date prefix) is no longer
permitted.

The `guard-release-branch.yml` workflow currently enforces the `release/` prefix on PRs targeting `main`; the CalVer
date prefix is convention-enforced via review and the runbook. Tightening the workflow regex to require
`^release/\d{4}-\d{2}-\d{2}-` is a tracked follow-up.

## PR body conventions

### No explainer prose in the body

Every section of a PR body is user-facing substance only: what is changing for the consumer that was not already there —
the **net diff**, not the commit history or intermediate state that produced it. Workflow mechanics (cherry-pick,
regenerate, pre-push gate, CI behavior) is documented in RELEASES.md and `.github/`, NOT in the PR body. Triple-diff
output ("A: 12 files, B: none, C: clean"), leak-check narration ("`guard-main-docs` runs clean", "no guarded paths
leaked"), patch-id cherry-check counts, pre-push gate results, CI check status, exclusion rationale, and other
verification artifacts stay local; anomalies get fixed before push, not audit-trailed in the body.

The PR body is read by humans reviewing what shipped. Workflow mechanics and tool-fix provenance are noise from that
perspective; they belong in this file, the script outputs, and the commit history respectively.

### Why `feat`/`fix` are preferred over `chore`

`cliff.toml` skips `^chore` (and `^style` / `^test` / `^ci` / `^build`) regardless of body content. Mistyping a
user-facing change as `chore` silently strips it from release notes. Prefer `feat` / `fix` when the change has any
user-observable effect (config defaults, env vars, default behaviors).

### Why required-when-empty sub-headers

`Related Issues/Stories` has four labels (`Story:` / `Issue:` / `Architecture:` / `Related PRs:`). `Files Modified` has
four sub-headers (`Modified` / `Created` / `Renamed` / `Deleted`). All four must appear in every PR, even when empty;
write `- None.` or `n/a` rather than deleting the label. Reason: scanners and humans both rely on a known section shape.
Conditionally-absent sections force every reader to mentally check "did the author skip this or does it not apply?"

### Why no AI attribution

`Co-Authored-By: Claude …`, `🤖 Generated with [Claude Code]`, or any similar AI-attribution trailer is banned from
commit messages and PR bodies. Commits and PRs stand on their own technical content. Attribution trailers are noise and
they age poorly as tools shift.

### Why no hard line wraps

Author each paragraph and each bullet as one logical line, however long. GitHub soft-wraps for display. Hard wraps
within prose produce visible mid-sentence breaks in some renderers and interfere with the prose-check pipeline: Vale's
line-anchored output reports findings against split lines, LanguageTool's input handling can choke on certain
control-char interactions. The auto-format hook skips `/tmp/` paths so the body keeps its authored shape; don't undo
that with manual wrapping during composition. Same rule applies to commit messages composed via heredoc.

### Why release-PR bodies repeat changelog entries from upstream PRs

The release PR carries the same `### Added` / `### Changed` / `### Fixed` bullets as the feature PRs it cherry-picks.
The repetition is intentional and harmless: `cliff.toml`'s `^release` skip prevents the release-PR squash commit from
being double-counted in any future regeneration.

### Why internal-tooling commits don't appear in `## Changelog`

`chore(cliff): ...`, `chore(prose-check): ...`, and similar internal tooling commits don't appear in the PR body's `##
Changelog`. They are not user-facing. They belong in commit history and in the Files Modified / Key Details sections of
the PR body, not in the source-of-truth release notes.

## Triple-diff verification

The release-PR procedure runs three diffs (A: main→release, B: release→dev for non-doc paths, C: dev→main) plus a
patch-id cherry check. This is belt-and-suspenders because missed cherry-picks have shipped to `main` on this and
sibling repos before, and the file-level diff in B alone doesn't catch the patch-id false-negative class.

### Why patch-id cherry-check output is noisy

In a squash-merge workflow, `git cherry HEAD origin/dev` produces many `+` lines that need human triage. They do NOT
auto-block the release. Expected sources of false positives:

1. **Historical commits squash-merged in prior releases.** The squash commit on main has a different patch-id than the
   dev commits it consolidates, so old commits show as `+` forever. Anything older than the previous release tag is
   almost always this.
2. **Cherry-picks where conflict resolution stripped guarded paths** (`docs/plans/`, `docs/brainstorms/`, etc.) or
   otherwise altered the tree. Same source-code intent, different patch-id.
3. **Intentionally skipped commits**: docs-only commits, release-prep backports, revert-and-redo prep steps.

A real miss looks like: a recent feat/fix/chore commit on dev whose *file content* is not yet on main. To triage a `+`
line:

```bash
git show <sha> --stat                       # what did it touch?
git diff origin/main..HEAD -- <those-files> # already on release?
```

If every touched file is guarded (`docs/plans/`, `docs/brainstorms/`, etc.) OR the content is already on main via a
prior squash, it's a false positive: no action. Otherwise cherry-pick the commit and re-run the triple-diff.

## Prose scrubbing scope

Pre-push covers `*.md` files in the repo via Vale + LanguageTool. Three release-flow artifacts live outside that net and
need a manual scrub before they ship:

- **PR bodies**: `gh pr create` and `gh pr edit` send body text directly to GitHub; pre-push has no reach there.
- **Release-PR bodies**: the `release/*` PR to `main` carries contributor-authored wrap-up text composed after the
  cherry-picks land, and the same out-of-repo gap applies.
- **Any future generated changelog**: if a `CHANGELOG.md` flow lands here, it inherits whatever prose its upstream PR
  bodies carry.

Scrub-before-submit (author in `/tmp/`, scrub there, submit via `--body-file`) avoids the round-trip of "submit, scrub,
edit, scrub again". Every fix lands locally and the public PR sees only clean text. The auto-format hook skips `/tmp/`
paths so the body keeps its authored shape and no soft-wrapping is injected.

For a future generated-changelog finding, fix the upstream PR body (which the regeneration script re-fetches every run)
and regenerate. Hand-editing the generated artifact directly produces drift the next regeneration overwrites.

## Docs-only deploy filter

The `paths-ignore` filter on the `push` trigger skips deploy when a commit only touches paths the build doesn't ingest.
The filter is symmetric across `dev` and `main`. In practice the `main` side is mostly theoretical:
`guard-main-docs.yml` already blocks `docs/plans|solutions|brainstorms|reviews/**` from reaching `main` via PR, and the
remaining ignored paths (root `*.md`, `DESIGN.md`, `docs/TODOS.md`) don't change build output; wrangler would redeploy a
bit-identical Worker.

If a future case needs unconditional main-branch deploys, swap the workflow-level filter for a job-level changed-files
check. The `workflow_dispatch` trigger is unaffected by `paths-ignore`, so manual redeploys always work regardless of
what changed.

## Sandbox image releases

### Soak-then-promote default

Most image changes go through a staging-soak cycle before reaching production. This protects prod from any sandbox
regression that only surfaces under real install traffic. The two `wrangler.jsonc` image pins (top-level prod,
`env.staging.containers[0].image`) are independent CF resources with separate version histories; they may legitimately
differ during a soak.

After merge to dev, CI deploys `agentnative-site-staging` to the new image. Soak: observability, integration tests, real
traffic on the staging.workers.dev URL. When the image is ready to ship, a release PR adds one promotion commit that
bumps the top-level pin to match staging.

### Lockstep-bump shortcut (low-risk only)

For image changes that don't need a soak (base-image security patch, dependency-only update with no behavior delta),
update BOTH pins in the same feat PR. The dev-targeting PR has equal pins from the start; the eventual release PR
carries equal pins; staging and prod deploy the new image in lockstep. The CI guard accepts this because both pins exist
in the registry on every PR.

Use the soak-then-promote default for any change that touches sandbox behavior: package manager additions, runtime
version bumps, `anc` upgrades, `cargo-binstall` upgrades, anything in `docker/sandbox/Dockerfile` past the base-image
FROM line.

### Deploy never rebuilds

`wrangler deploy --env staging` (and `wrangler deploy` on main) against the fully-qualified registry URI does NOT
trigger a rebuild. The image was already published during the local `wrangler containers build -p` step. Build is
decoupled from deploy: a Worker code-only deploy never rebuilds the image, and an image-only release never reships
Worker code unintentionally.

### Image-retention discipline

NEVER delete a tag from the CF managed registry that backed a shipped Worker version. Deletion silently breaks `wrangler
rollback` for any version that referenced the image (per
[Containers Limits](https://developers.cloudflare.com/containers/platform-details/limits/)). The 50 GB account-wide cap
is a quarterly prune review, not a routine cleanup. When a release tag ships, record the pair `<git-tag> <-> <registry
URI>` in the release commit body so the inventory survives.

Retention is what makes soak-then-promote safe: while a new image is soaking on staging, the prod pin still references
the previous release's tag, and that tag must remain in the registry for prod to keep serving.

### DO migrations are one-way walls

The first Worker version that applied `migrations[].new_sqlite_classes: ["Sandbox"]` (`v1`) cannot be rolled back across
that boundary via `wrangler rollback` (per
[Versions and deployments / Rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)).
Treat DO-migration commits as milestone releases that get an explicit reviewer note.

The only path past the wall is a follow-up migration with `deleted_classes: ["Sandbox"]` on a Worker version that no
longer references the DO binding. The Cloudflare platform destroys the durable storage attached to the deleted class as
part of applying the migration; this is a platform behaviour, not a project choice. The R2 score cache survives because
it lives on a separate binding (`SCORE_CACHE`). The kill-switch flag (`SCORE_KV.scoring_disabled`) and rate-limit
counters live on KV / rate-limit bindings and are also untouched. The only data loss is whatever the `Sandbox` DO's
SQLite storage held at the moment the `deleted_classes` migration applies.

Cross-migration recovery is therefore non-trivial: applying the rollback once destroys data, and re-introducing the
`Sandbox` class later requires a fresh migration tag (`v3-restore-sandbox` or similar; `v1` cannot be reused). The
rehearsal exists to prove the sequence works on staging before any prod cut depends on it, and to make the data-loss
cost concrete (the evidence table in `RELEASES.md` records DO instance counts at each step). Skipping the rehearsal is
what makes the first prod incident unrecoverable in practice.

### GHA fallback

If a local build is impossible, set `image:` to a Dockerfile path (`./docker/sandbox/Dockerfile`) and let
`cloudflare/wrangler-action` build inline on `ubuntu-latest` (~60-130s cold per deploy; no GHA-side layer cache; push is
auto-skipped when the existing tag still matches). This is a fallback, not the primary path; the local-build-once flow
is what the deploy workflow assumes.

### R2 score-cache lifecycle

Plan U7 caches successful live scorecards under `scores/{binary}/{anc-version}.json` in the `SCORE_CACHE` R2 bucket. A
7-day lifecycle rule reaps stale entries at the bucket level rather than per-write, keeping `Cache-Control: public,
max-age=300` on every object so CDN edges don't over-cache while the R2 origin holds the long TTL.

The rule name (`scores-7day-ttl`) identifies the rule for future updates or removal. The prefix (`scores/`) scopes the
TTL so future writes under a different prefix in the same bucket are NOT affected. If a future change adds a new prefix
(e.g., `audit-logs/`), set up a matching lifecycle rule for it deliberately rather than broadening this one.

The `tests/wrangler-config.test.ts` drift-guard scans the RELEASES.md section for the exact literal command so a future
regression on the syntax surfaces in CI.

### Post-deploy smoke scope

The CI smoke step after staging deploys (`/api/score` with the `ripgrep` slug, asserting the response triad and
`registry_hit`) deliberately covers the registry-fast-path only. The motivation is two-sided.

First, the registry-fast-path is the surface every other branch of the pipeline depends on: if the curated
`/api/score?input=ripgrep` doesn't return `{ scorecard, spec_version, site_spec_version, anc_version, checker_url }`, no
downstream tier works either. Failing the deploy on this surface catches the broadest class of regressions in the
shortest run time.

Second, the alternative branches each carry a cost the smoke step shouldn't pay on every deploy. Live-sandbox dispatch
spins a Container instance and pulls from package registries; doing it on every staging deploy multiplies billable
egress and surfaces ecosystem-dependency flakes as red builds. Gate behaviour (Turnstile bouncing, rate-limit
exhaustion) is a contract assertion that lives in unit tests, where it can be exercised deterministically without
external infrastructure. The opt-in `homepage-score-live` e2e suite covers the live round-trip on a manual / nightly
cadence where the cost and the latency are acceptable.

The smoke is therefore a high-leverage tripwire, not a full pipeline test. When it fails, the deploy is wrong; when it
passes, the deploy is at least serving the response triad to a curated input, not a proof that the live path works.

## Wrangler env inheritance traps

Wrangler's per-env config inherits some keys from the top-level and not others. Mismatched expectations on either side
produced a real production incident on this repo (the 2026-04-30 routing-drift bug: every `wrangler deploy --env
staging` was silently re-attaching `anc.dev` to the staging Worker because `env.staging` inherited the top-level
`routes` array). The current `env.staging` block carries explicit overrides for every inheritable key so the inheritance
behavior is deliberate and visible, not silent.

### Inheritable keys: explicit override required

These keys inherit from top-level when absent under `env.staging`. The current block overrides each one.

- **`routes`** (load-bearing): empty `[]` array breaks the inheritance. Without the override, `env.staging` inherits the
  top-level `[{pattern: "anc.dev", custom_domain: true}]` and every `wrangler deploy --env staging` re-attaches anc.dev
  to the staging Worker. This is the 2026-04-30 routing-drift incident; the explicit `routes: []` under env.staging is
  the fix.
- **`triggers`** (prophylactic): empty `{crons: []}` override. There are no production cron schedules today, but
  `triggers.crons` inherits the same way `routes` does. The empty array forces a deliberate decision when a top-level
  schedule is added.
- **`vars`** (REPLACE semantics): when `env.staging.vars` exists, it fully replaces the top-level `vars`, not
  deep-merged. Staging carries the always-pass Turnstile test `sitekey` (`1x...AA`), which correctly isolates staging
  from the real production `sitekey`. Any future top-level `vars` addition must be mirrored under `env.staging.vars` or
  staging won't see it.

### Non-inheritable keys: mirror under env.staging

These keys do NOT inherit; `wrangler` warns when they're absent under an env. The staging block mirrors each one with
staging-specific values:

- `durable_objects`, `containers`, `migrations`, `ratelimits`, `r2_buckets`, `kv_namespaces`,
  `analytics_engine_datasets`.
- Staging-side values diverge from prod on resource identifiers (R2 bucket suffix `-staging`, distinct rate-limit
  namespace IDs `1002`/`1004`, distinct Analytics Engine dataset `anc_live_score_staging`) so prod and staging traffic
  stay isolated.

### Container app naming

The container app name doesn't follow wrangler's automatic `<worker>-<env>` env-suffix convention; the staging block
needs an explicit `name: "agentnative-site-staging"` so the container app derives as `agentnative-site-staging-sandbox`
and is distinct from prod's `agentnative-site-sandbox`. Without the explicit name, the derivation collides and a
`wrangler deploy --env staging` would target the production container app.

## CI workflow split

### Why the stub workflow exists

Required status checks + `paths-ignore` is a known
[GitHub Actions sharp edge](https://docs.github.com/en/actions/using-jobs/using-conditions-to-control-job-execution): if
the workflow is filtered out for a given PR, the required check shows as "Expected" forever and the PR can't merge. The
stub workflow (`ci-stub.yml`) fires exactly when `ci.yml` is filtered, emits the same check context as a no-op success,
and unblocks the PR.

### The paths-ignore invariant

`ci.yml`'s `paths-ignore:` list and `ci-stub.yml`'s `paths:` list must stay identical. Drift creates gaps (no workflow
fires → required check never reports → PR stuck) or benign double-runs on mixed PRs. A comment in both files calls this
out explicitly.

### Status-check context strings

The `required_status_checks[].context` strings in `protect-main.json` must match exactly what GitHub publishes for each
check:

- **Inline job** (with `name:` field): published as just `<job-name>` (no workflow-name prefix).
- **Reusable-workflow caller** (`uses: .../foo.yml@ref`): published as `<caller-job-id> / <reusable-job-id-or-name>`.

Mixing these produces a stuck-but-green PR: all actual checks report green, but the ruleset waits forever on a context
that will never appear. Confirm the real contexts after a first CI run with:

```bash
gh api repos/brettdavies/agentnative-site/commits/<sha>/check-runs --jq '.check_runs[].name'
```

## Visual-fidelity gates

Two visual-regression rules apply to any change touching CSS, layout, or rendered output: a "browser-verify before done"
agent-side rule (working today) and a Playwright snapshot diff in CI (planned, deferred until the design system
stabilizes). Both live in [`AGENTS.md` § Visual fidelity](./AGENTS.md#visual-fidelity), the source of truth. A release
that didn't satisfy those gates upstream isn't unblocked by the CI pipeline being green.

## Skill releases

`/skill.json` and `/skill` advertise the `agent-native-cli` skill, hosted at
[`brettdavies/agentnative-skill`](https://github.com/brettdavies/agentnative-skill). This site vendors the skill's
manifest (per-host install commands, version, surface metadata) in `src/data/skill.json`; the skill repo holds the
actual content. Surface contract in `DESIGN.md` §3.9.

Update detection at install sites is delegated to the skill bundle's `bin/check-update`, which compares the local
bundle's `VERSION` against `main` on GitHub.

The skill repo's branch model: `main` is the published-release pointer (default branch); `dev` is the integration
branch. The bare `git clone --depth 1` in each install command lands on `main`, so each release requires the skill
maintainer to fast-forward `main` to the new tag.

The cache-purge step after a manifest bump exists because users see the manifest via `/skill.json` (24 h `s-maxage`);
without a purge they'd pick up the old shape for a day. The first-deploy-after-rename note (cutover from `/install*` →
`/skill*`) is a one-time eviction so legacy cached paths don't serve stale content.

## Related docs

- [`RELEASES.md`](./RELEASES.md): operational runbook (commands, paths, decision tables)
- [`AGENT.md`](./AGENT.md): onboarding, repo conventions, tool-site sequencing
- [`DESIGN.md`](./DESIGN.md): design system and build contract
- [`docs/TODOS.md`](./docs/TODOS.md): deferred work (not in v0 scope)
