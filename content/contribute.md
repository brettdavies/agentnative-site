# Contribute

The agent-native CLI spec is `status: active` because the contracts are stable enough to cite, not because anything is
locked. The pressure-test mechanism is how the spec revises a position when a finding warrants it. This page is the
navigation across the four repos that make up the project, plus the honest expectations on response time.

## What kinds of contribution are welcome

Three tiers, all welcome, none required. The shape of the contribution determines the intake.

| Tier            | What                                                                                                                                                                                                         | Where                                                              | Time     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------- |
| **1. Signal**   | A finding against a principle's wording, a missing citation, a contradiction between two principles, a false positive in `anc`, a broken link on the site, a bundle content issue                            | A repo-specific issue template (see "Per-repo intake" below)       | ~5 min   |
| **2. Proposal** | A new principle the spec is missing, a MUST/SHOULD tier change with rationale, a counter-example that breaks an applicability clause, a new language checker design, a new host runtime for the skill bundle | An issue with the full case in the body, against the relevant repo | ~1-2 hrs |
| **3. Code**     | A new language checker for `anc`, a tool scoring submission for the leaderboard, a site or skill-bundle improvement, a governance or workflow PR                                                             | A pull request against the relevant repo's `dev` branch            | Variable |

## Per-repo intake

Each repo handles a different layer of the project. File against the one that matches the contribution's shape.

### Spec: [agentnative](https://github.com/brettdavies/agentnative)

The principle text, the requirement IDs, the versioning policy. Pressure-tests against the standard live here.

- [Pressure-test a principle](https://github.com/brettdavies/agentnative/issues/new?template=pressure-test.yml) (Tier 1
  or 2)
- [Ask a spec question](https://github.com/brettdavies/agentnative/issues/new?template=spec-question.yml) (Tier 1)
- [Submit a tool for grading](https://github.com/brettdavies/agentnative/issues/new?template=grade-a-cli.yml) (Tier 3,
  lightweight)
- [`CONTRIBUTING.md`](https://github.com/brettdavies/agentnative/blob/main/CONTRIBUTING.md) ·
  [`principles/AGENTS.md` § Pressure-test protocol](https://github.com/brettdavies/agentnative/blob/main/principles/AGENTS.md)

### Linter: [agentnative-cli](https://github.com/brettdavies/agentnative-cli)

`anc`, the Rust linter that scores any repo against the spec. The scoring engine, the registry, the language checkers.

- [Report a false positive](https://github.com/brettdavies/agentnative-cli/issues/new?template=false-positive.yml) (Tier
  1)
- [Request a feature](https://github.com/brettdavies/agentnative-cli/issues/new?template=feature-request.yml) (Tier 1 or
  2)
- [Report a scoring bug](https://github.com/brettdavies/agentnative-cli/issues/new?template=scoring-bug.yml) (Tier 1)
- [Source repo](https://github.com/brettdavies/agentnative-cli)

### Site: [agentnative-site](https://github.com/brettdavies/agentnative-site)

This site. The leaderboard renderer, the live-scoring loop, the per-tool scorecard pages, the Worker.

- [File a site bug](https://github.com/brettdavies/agentnative-site/issues/new?template=site-bug.yml) (Tier 1)
- [Source repo](https://github.com/brettdavies/agentnative-site)

### Skill bundle: [agentnative-skill](https://github.com/brettdavies/agentnative-skill)

The `agent-native-cli` bundle that agents discover via filesystem convention. The install paths, the host-runtime
detection, the SKILL.md prose.

- [Source repo + intake](https://github.com/brettdavies/agentnative-skill)

## Response expectations (the honest part)

This is a solo-maintainer project. The honest framing:

- **Tier 1 and 2** are welcome and get a substantive reply when time allows. A pressure-test that names a specific
  failure mode and an implementer's reasoning is the contribution shape that lands fastest.
- **Tier 3 PRs** are reviewed when scope and time permit. Real PRs land. No merge-window promise; the queue is what the
  maintainer can actually read.
- **Status flips** are how the spec records that a finding is being worked on. A principle moves to `status:
  under-review` when a substantive pressure-test is being processed, then back to `status: active` once the next MINOR
  release lands. Visible in the principle file's frontmatter.

The standard takes positions because positions are useful. Positions held without willingness to revise them are dogma.
Both halves of that are intentional.

## How the revision mechanism works

For a Tier 2 proposal that changes a MUST/SHOULD/MAY tier or adds a new principle:

1. The pressure-test issue lands with a specific finding: which requirement, which direction, what failure mode argues
   for the change.
2. If the finding is substantive, the relevant principle file's `status` flips from `active` to `under-review`.
3. The next MINOR spec release resolves the finding: the prose is revised, `last-revised` updates, status returns to
   `active`. Or the finding is closed with a documented `[wontfix]` rationale appended to the principle's pressure-test
   notes section.

The mechanism is described in full at
[`principles/AGENTS.md` § Pressure-test protocol](https://github.com/brettdavies/agentnative/blob/main/principles/AGENTS.md).

## Adjacent reading

- [Spec status lifecycle](https://github.com/brettdavies/agentnative/blob/main/principles/AGENTS.md) — the `draft →
  under-review → active → locked` flow
- [BRAND.md](https://github.com/brettdavies/agentnative/blob/main/BRAND.md): voice and identity
- [CHANGELOG.md](https://github.com/brettdavies/agentnative/blob/main/CHANGELOG.md): what landed when

The leaderboard at [`/scorecards`](/scorecards) is the running answer to "what does the spec catch in practice."
