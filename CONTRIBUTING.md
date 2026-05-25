# Contributing to `agentnative-site`

This is the source for [anc.dev](https://anc.dev): the rendered spec, the live leaderboard, the live-scoring loop, the
per-tool scorecard pages, the badge surface, and the skill-distribution endpoint. Principle-level discussion belongs in
the [spec repo](https://github.com/brettdavies/agentnative); scoring-engine work belongs in the
[CLI repo](https://github.com/brettdavies/agentnative-cli). For visitor-facing cross-repo navigation, see
[`anc.dev/contribute`](https://anc.dev/contribute).

## Contribution tiers

The site accepts three shapes of contribution. All three are welcome; none required. Site work skews toward Tier 3
because the site is the public surface. Most improvements are concrete code or copy changes.

| Tier            | Shape                                                                                                                                             | Intake                                                                                         | Effort   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------- |
| **1. Signal**   | Site bug, rendering issue, broken link, copy critique, mobile-layout regression, performance regression                                           | [`site-bug`](https://github.com/brettdavies/agentnative-site/issues/new?template=site-bug.yml) | ~5 min   |
| **2. Proposal** | A new page or section, a scorecard renderer rework, a Worker route addition, a build-pipeline change, a live-scoring surface change               | Issue with the design before opening a PR                                                      | ~1-2 hrs |
| **3. Code**     | Site copy or design polish, scorecard renderer improvements, Worker route or header work, build-pipeline work, accessibility fixes, OG image work | PR against `dev`; `release/<YYYY-MM-DD>-<slug>` cut from `main` for deploys                    | Variable |

**Scorecard submissions** (adding a tool to the leaderboard at [`/scorecards`](https://anc.dev/scorecards)) go through
the cli repo's
[`add-tool-to-registry`](https://github.com/brettdavies/agentnative-cli/issues/new?template=add-tool-to-registry.yml)
template, not a PR here. The site renders what the registry contains; the registry lives in the cli repo. The spec
repo's `grading-finding` template is a separate path for spec-feedback derived from scoring, not for registry
submissions.

**Response expectations:** Tier 1 and Tier 2 are welcome and get a substantive reply when time allows. Tier 3 PRs are
reviewed when scope and time permit. A solo maintainer cannot promise merge windows; real PRs land.

## Branch model

```text
feat/* → PR to dev (squash merge)
       → cherry-pick to release/<YYYY-MM-DD>-<slug>
       → PR release/* to main (squash merge)
       → deploy.yml fires on push-to-main → Cloudflare Workers production
```

`dev` is the integration branch. `main` is what `anc.dev` serves. There are no tags or semver versions; the site deploys
continuously via Cloudflare's `deploy.yml` on push-to-main. Engineering docs (`docs/plans/`, `docs/solutions/`,
`docs/brainstorms/`, `docs/reviews/`) live on `dev` only and are blocked from `main` by `guard-main-docs.yml`.

## Dev setup

```bash
git clone https://github.com/brettdavies/agentnative-site && cd agentnative-site
bun install
bun run build              # produces dist/
bun run dev                # local dev server with hot reload
bun x playwright test      # end-to-end suite
```

Worker dev against the staging bindings:

```bash
wrangler dev --env staging
```

The site uses Cloudflare Workers, Durable Objects (Sandbox for live scoring), R2 (score cache), and KV (kill switch +
rate limits). The full binding inventory is in [`wrangler.jsonc`](./wrangler.jsonc).

## Pre-push hook

The repo ships a pre-push hook that mirrors CI plus the prose-check stages CI doesn't run. Activate once after clone:

```bash
git config core.hooksPath scripts/hooks
```

Seven stages:

1. **lint** (`biome check` + `markdownlint-cli2`)
2. **build** (`bun src/build/build.mjs`)
3. **tests** (`bun test`, unit + regression)
4. **wrangler dry-run** (`wrangler deploy --dry-run`, config + bundle validation)
5. **pack-README drift** (`bun scripts/generate-pack-readme.mjs site --check`)
6. **banned-fonts** (`bash scripts/check-banned-fonts.sh`, deployment-layer scan against `styles/site/BannedFonts.yml`)
7. **prose-check** (`bash scripts/prose-check.sh`, Vale plus LanguageTool when reachable; skips cleanly otherwise)

PRs that pass the hook locally also pass CI for stages 1-4; stages 5-7 are pre-push-only. Fix locally before pushing.

## Pull requests

- **Title format:** [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): description`). The PR
  title becomes the squash-merge commit subject.
- **Body:** follow [`.github/pull_request_template.md`](.github/pull_request_template.md). The `## Changelog` section
  captures user-visible changes for the eventual release-PR `CHANGELOG.md` entry.
- **Tests:** new pages ship a regression test that asserts the rendered HTML contains expected anchors and the markdown
  twin renders. Worker routes ship unit tests under `tests/`; e2e tests live under `tests/e2e/`.
- **Voice:** site copy passes the prose-check stack: Vale custom rule packs (brand + spec channel) plus the `/unslop`
  floor. Run `scripts/prose-check.sh --changed-only` during authoring.

## Releases

Cuts are CalVer date-prefixed, slugged per change: `release/2026-05-21-show-hn-cut`, `release/2026-04-30-routing-fix`,
etc. Cherry-pick from `dev` to the release branch, open the PR against `main`, merge via squash. `deploy.yml` fires on
push-to-main and reaches `anc.dev` within ~2 minutes. The full procedure lives in [`RELEASES.md`](./RELEASES.md).

## AI disclosure

Inherits from the spec's AI disclosure policy. See
[agentnative/CONTRIBUTING.md § AI disclosure policy](https://github.com/brettdavies/agentnative/blob/main/CONTRIBUTING.md#ai-disclosure-policy).

## Security

Do not file security issues in the public tracker. Use the
[GitHub private security advisories channel](https://github.com/brettdavies/agentnative-site/security/advisories/new).
The Sandbox container, the Worker, and the R2 cache are the primary surfaces of concern.

## License

See [`LICENSE`](./LICENSE).

## Cross-repo navigation

The full visitor-facing menu lives at [`anc.dev/contribute`](https://anc.dev/contribute). Per-repo intakes:

- [Spec](https://github.com/brettdavies/agentnative): principle text, pressure-tests, versioning policy
- [Linter](https://github.com/brettdavies/agentnative-cli): `anc`, the scoring engine, the registry
- This repo: the site, the leaderboard renderer, the live-scoring loop
- [Skill bundle](https://github.com/brettdavies/agentnative-skill): agent-facing bundle, install paths
