# Vendored agentnative-spec

This directory is a **vendored copy** of [`brettdavies/agentnative`](https://github.com/brettdavies/agentnative) — the
canonical specification of agent-native CLI principles. Files here are not edited by hand; they are mirrored from the
latest upstream `v*` tag and ship inside the skill bundle so consumers carry the canonical principle text alongside the
skill metadata. Each release of this bundle re-vendors against the latest spec tag. The currently vendored version is
recorded in [`VERSION`](./VERSION).

For the full spec landing page — leaderboard, badge convention, and acknowledgements — see [anc.dev](https://anc.dev) or
the upstream [`README`](https://github.com/brettdavies/agentnative#readme).

## Resync

Run from the repo root:

```bash
scripts/sync-spec.sh    # queries the remote for the latest v* tag; falls back to local on network failure
```

The script resolves the latest `v*` tag of `brettdavies/agentnative` through `gh api` and fetches each vendored file at
that tag from the GitHub contents API, with no clone. `--ref <branch|tag|sha>` (or `SPEC_REF`) vendors another ref. If
the API is unreachable, the script falls back to a local checkout (`$HOME/dev/agentnative-spec` by default; override
with `SPEC_ROOT`) and reads files with `git show`, so the checkout's working tree is untouched. Override
`SPEC_REMOTE_URL` to point at a different repository.

## Layout

| Path                      | Source in `agentnative-spec`     | Purpose                                                                                            |
| ------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `VERSION`                 | `VERSION`                        | Spec version string; the skill's vendored `SPEC_VERSION`                                           |
| `CHANGELOG.md`            | `CHANGELOG.md`                   | Spec change history; informational                                                                 |
| `principles/p*.md`        | `principles/p*.md`               | Frontmatter `requirements[]` is the machine-readable contract                                      |
| `principles/scoring.md`   | `principles/scoring.md`          | Leaderboard formula, badge eligibility floor, and color bands                                      |
| `reading-the-spec.md`     | `README.md` § "Reading the spec" | `requirements[]` fields and the flag-name reading rule; relative links point at the spec repo      |
| `.markdownlint-cli2.yaml` | none; this repo's own            | Turns MD013 off for the vendored files, which keep upstream's line shapes; other rules still apply |

Each principle file has a YAML frontmatter block with `id`, `title`, `last-revised`, `status`, and `requirements[]`.
Each `requirements[]` entry carries a stable `id` (e.g. `p1-must-no-interactive`), a `level` (`must`/`should`/`may`), an
`applicability` (`universal` or `{if: <reason>}`), and a one-sentence `summary`. The `anc` auditor
([brettdavies/agentnative-cli](https://github.com/brettdavies/agentnative-cli)) emits these IDs in its scorecard so
agents can navigate from a finding directly to the requirement.

## Licensing

Upstream content is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). This skill bundle is
dual-licensed under MIT or Apache-2.0; vendoring a CC BY 4.0 source requires attribution only, satisfied by this README
plus the upstream project link in each principle's frontmatter `id` field.
