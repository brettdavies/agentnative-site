# `src/data/spec/` — vendored agentnative-spec snapshot

What lives here:

- `VERSION` — single line, the spec version this checkout is pinned against. Read at module load by
  `../../build/util.mjs` and exported as `SPEC_VERSION` for the site footer, OG card, badge URLs, and the badge surface
  page.
- `CHANGELOG.md` — Keep-a-Changelog format. Currently only kept in-tree as a diff target / reference; not yet read by
  the site build. Future use: `/changelog` page could render this verbatim if the hand-written `content/changelog.md` is
  retired.
- `principles/p*-*.md` — the spec's structured principle files (frontmatter-heavy, machine-readable). **Currently a diff
  target only.** Nothing in the site build consumes these for rendering. Site rendering of `/p1`–`/p7` reads from
  `content/principles/`, which is human-written site copy that exists alongside (not derived from) the spec prose.

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
   remote (or falls back to `$SPEC_ROOT`) and rewrites this directory.
3. Inspect: `git diff src/data/spec/principles/` shows exactly what the spec changed.
4. **Manual editorial decision**: contributor decides whether (and how) to update `content/principles/p<n>-*.md` to
   reflect the spec change. The two file shapes are intentionally different — there is no automated 1-to-1 converter.
   Site copy may incorporate the spec change verbatim, paraphrase it for prose flow, add a code example, or deliberately
   not change (e.g., when the spec edit is purely a frontmatter tier shift).
5. Open a PR with the vendored update + any reconciled `content/principles/` edits.

The vendored copy is a **diff target**, not a source the site renders from. Re-vendoring is a routine, low-stakes
operation; reconciling site prose is a deliberate editorial act.

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
