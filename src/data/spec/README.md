# `src/data/spec/` — vendored agentnative-spec snapshot

What lives here:

- `VERSION` — single line, the spec version this **vendored snapshot** is at. Read at module load by
  `../../build/util.mjs` and exported as `SPEC_VERSION`. **NOT used for any user-visible surface** — kept as a reference
  / diff target. The site has TWO other version concepts; see the version-distinction box below.
- `CHANGELOG.md` — Keep-a-Changelog format. Currently only kept in-tree as a diff target / reference; not yet read by
  the site build. Future use: `/changelog` page could render this verbatim if the hand-written `content/changelog.md` is
  retired.
- `principles/p*-*.md` — the spec's structured principle files (frontmatter-heavy, machine-readable). **Currently a diff
  target only.** Nothing in the site build consumes these for rendering. Site rendering of `/p1`–`/p7` reads from
  `content/principles/`, which is human-written site copy that exists alongside (not derived from) the spec prose.

For the full spec landing page — leaderboard, badge convention, and acknowledgements — see [anc.dev](https://anc.dev) or
the upstream [`README`](https://github.com/brettdavies/agentnative#readme).

## Three distinct spec-version concepts on this site

The site shows version labels in three places. **Each pulls from a different source by design** — they can legitimately
diverge during the manual reconciliation window:

| Surface                                         | Constant / source                                                                                                           | What it means                                                                                                                                                                | Bumped by                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Site footer                                     | `SITE_SPEC_VERSION` (reads `../../../content/principles/VERSION`)                                                           | The spec version the site's **prose** has been reconciled to. Honest claim of currency.                                                                                      | Manually, by the contributor who reconciles `content/principles/p*-*.md` after a `sync-spec.sh` run. |
| Per-tool badge SVGs                             | Each scorecard's own `spec_version` field (passed to `renderBadgeSvg(score, scorecard.spec_version)`)                       | The spec version the `anc` binary was compiled against when it produced that scorecard. Each badge tracks the actual scoring context.                                        | Automatic — bumps whenever the scorecard is regenerated (which uses an `anc` build with newer spec). |
| OG social card                                  | `anc`'s self-scorecard's `spec_version` (read from `scorecards/anc-v*.json`'s highest version, by `scripts/og/generate.ts`) | The spec version `anc` claims to score against. Same source-shape as the per-tool badges (scorecard `spec_version` field), with `anc`'s own scorecard as the representative. | Automatic on `bun run og` after the `anc` scorecard is refreshed.                                    |
| Vendored `SPEC_VERSION` (THIS file's `VERSION`) | `SPEC_VERSION` (reads `./VERSION`)                                                                                          | The spec version we last **vendored a snapshot of**. NOT displayed anywhere on the site. Reference only.                                                                     | Automatic — `./scripts/sync-spec.sh` overwrites this file with the latest upstream tag.              |

Why three sources, not one:

- **`SPEC_VERSION` (vendored, this file)** moves the moment we run `sync-spec.sh`. That's a fetch, not a reconciliation.
- **`SITE_SPEC_VERSION`** (`content/principles/VERSION`) only moves when a contributor finishes reconciling the site
  prose to the new spec. The lag is honest — the footer correctly tells visitors that the prose hasn't caught up yet.
- **Per-scorecard `spec_version`** moves at the scoring-pipeline cadence, which is independent of both the vendoring
  cadence (here) and the site-prose reconciliation cadence (`content/principles/`). The `anc` binary that scored
  `bird-v0.1.3.json` last week may have been compiled against an older spec than the one we just vendored.

This separation prevents a single misleading scenario: vendoring a new spec snapshot and immediately bumping the footer
to claim the site is current to it, when the prose hasn't been touched. The footer's job is to tell the truth about
**site currency**, not **vendor currency**.

## Why both `content/principles/` AND `src/data/spec/principles/`?

They serve different audiences:

| Path                                 | Audience                                                                                                         | Shape                                                                                                       | Source                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `content/principles/p<n>-*.md`       | Humans reading anc.dev                                                                                           | Prose-first. "Why Agents Need It" framing. MUST/SHOULD/MAY blocks with code examples in multiple languages. | Hand-written by site contributors.              |
| `src/data/spec/principles/p<n>-*.md` | The CLI's `build.rs` (in agentnative-cli, which has its own copy) and any future automated consumer in this repo | Frontmatter-heavy. Structured `requirements:` array (id, level, applicability, summary). Machine-readable.  | Vendored from agentnative-spec at a pinned tag. |

They are not duplicates. Per `AGENTS.md` doctrine: *"site's principle copy in `content/principles/` is written manually
from these files — no build-time import, no live link... Do not edit the spec to match the site; propagate in the other
direction, deliberately."*

## Workflow when spec prose changes

1. agentnative-spec ships v0.X.Y with principle prose changes.
2. Site contributor runs `./scripts/sync-spec.sh` from the repo root. The script picks up the latest v* tag from the
   remote (or falls back to `$SPEC_ROOT`) and rewrites this directory. **Footer does NOT move yet** — `SPEC_VERSION`
   updates here, but `SITE_SPEC_VERSION` (`content/principles/VERSION`) is unchanged. The footer correctly shows the
   site is not yet reconciled.
3. Inspect: `git diff src/data/spec/principles/` shows exactly what the spec changed.
4. **Manual editorial decision**: contributor decides whether (and how) to update `content/principles/p<n>-*.md` to
   reflect the spec change. The two file shapes are intentionally different — there is no automated 1-to-1 converter.
   Site copy may incorporate the spec change verbatim, paraphrase it for prose flow, add a code example, or deliberately
   not change (e.g., when the spec edit is purely a frontmatter tier shift).
5. **Bump `content/principles/VERSION`** to the new spec version once the prose is reconciled. This is the gate that
   moves the footer. Do this LAST — bumping before reconciliation lies to visitors about site currency.
6. Open a PR with the vendored update (`src/data/spec/`) + any reconciled `content/principles/` edits + the
   `content/principles/VERSION` bump.

The vendored copy is a **diff target**, not a source the site renders from. Re-vendoring is a routine, low-stakes
operation; reconciling site prose is a deliberate editorial act; bumping `content/principles/VERSION` is the explicit "I
have caught up" signal.

## When to resync

After every new agentnative-spec release. The spec repo's `.github/workflows/publish.yml` fires
`repository_dispatch:spec-release` to this repo on tag publish — a consumer-side handler that auto-PRs the resync is
tracked as follow-up work in the sync-spec plan but not yet shipped.

For now: rerun `./scripts/sync-spec.sh` manually whenever `cat src/data/spec/VERSION` shows an older version than `gh
api repos/brettdavies/agentnative/releases/latest --jq .tag_name` (or just whenever you remember).

## What does NOT live here

- Site rendering source — that's `content/`.
- Generated HTML/CSS/JS — that's `dist/` (gitignored).
- Skill bundle metadata — that's `src/data/skill.json`, hand-edited (not vendored).
- Coverage matrix — that's `src/data/coverage-matrix.json`, vendored from agentnative-cli via
  `scripts/sync-coverage-matrix.sh`.

## Reference

- Vendoring script: `scripts/sync-spec.sh`
- Cross-repo sync map: `scripts/SYNCS.md`
- Plan that introduced this directory:
  [`docs/plans/2026-04-23-001-feat-sync-spec-plan.md`](../../../docs/plans/2026-04-23-001-feat-sync-spec-plan.md)
- Cross-repo version model:
  [`docs/solutions/best-practices/agentnative-version-model-2026-05-01.md`](../../../docs/solutions/best-practices/agentnative-version-model-2026-05-01.md)
- Upstream spec: <https://github.com/brettdavies/agentnative>
- AGENTS.md doctrine on manual reconciliation: see the `~/obsidian-vault/Projects/brettdavies-agentnative/principles/`
  paragraph in `AGENTS.md` (top-level of this repo).
