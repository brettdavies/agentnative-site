---
title: "Session brief for handoff 2: v0.1.1 agentnative-site"
type: session-handoff
phase: v0.1.1
written_by: session that landed handoff 1 (PR #21)
written_at: 2026-04-20 (late afternoon CDT)
supersedes: nothing; supplements docs/plans/2026-04-20-v011-handoff-2-site-spec-coverage.md
---

# Session brief: picking up handoff 2

You are the session that implements handoff 2. Your job is defined in
`docs/plans/2026-04-20-v011-handoff-2-site-spec-coverage.md` — **read that first**, this brief only adds what changed
during handoff 1 that the plan couldn't know yet.

## Sibling handoffs

| # | Phase  | Repo               | Doc                                                                              |
|---|--------|--------------------|----------------------------------------------------------------------------------|
| 1 | v0.1.1 | `agentnative`      | `docs/plans/2026-04-20-v011-handoff-1-agentnative-impl.md`                       |
| 2 | v0.1.1 | `agentnative-site` | `docs/plans/2026-04-20-v011-handoff-2-site-spec-coverage.md`                     |
|   |        |                    | `docs/plans/2026-04-20-v011-handoff-2-session-brief.md` *(this doc)*             |
| 3 | v0.1.1 | `agentnative-site` | `docs/plans/2026-04-20-v011-handoff-3-scorecard-regen.md`                        |
| 4 | v0.1.2 | `agentnative`      | `docs/plans/2026-04-20-v012-handoff-4-behavioral-checks.md`                      |
| 5 | v0.1.3 | `agentnative-site` | `docs/plans/2026-04-20-v013-handoff-5-audience-leaderboard.md`                   |

## What landed in handoff 1 (PR #21)

Branch `feat/v011-principle-registry-and-coverage` in `brettdavies/agentnative`, open against `dev`. CI is green (fmt,
clippy -Dwarnings, test, security audits, Windows compat, package check). Do **not** push more commits there unless
handoff 1 needs correction — that branch is the Rust-side PR.

Three commits:

1. `docs(plans)` — the five v0.1.1–v0.1.3 handoff plans (including the one that tells you what to do).
2. `feat(principles)` — new `src/principles/` module, `Check::covers()`, `anc generate coverage-matrix` subcommand.
3. `feat(v0.1.1)` — check renames, P1 gate fix, scorecard v1.1, committed `docs/coverage-matrix.md` +
   `coverage/matrix.json`.

## Artifact schemas (now fixed; you can wire against these)

Handoff 2's plan says "start with a placeholder, swap in the real artifact
once handoff 1's format is stable." The format is stable now. Use these.

### `coverage/matrix.json` (source of truth for `/coverage` page)

Lives in the `agentnative` repo at `coverage/matrix.json`. Shape:

```json
{
  "schema_version": "1.0",
  "generated_by": "anc generate coverage-matrix",
  "rows": [
    {
      "id": "p1-must-no-interactive",
      "principle": 1,
      "level": "must",                            // "must" | "should" | "may"
      "summary": "...",
      "applicability": { "kind": "universal" },   // or
      "applicability": { "kind": "conditional", "condition": "CLI authenticates..." },
      "verifiers": [
        { "check_id": "p1-non-interactive",        "layer": "behavioral" },
        { "check_id": "p1-non-interactive-source", "layer": "project" }
      ]
    }
    // ... 46 rows total, grouped by principle + level
  ],
  "summary": {
    "total": 46, "covered": 19, "uncovered": 27,
    "must":   { "total": 23, "covered": 17 },
    "should": { "total": 16, "covered": 2 },
    "may":    { "total": 7,  "covered": 0 }
  }
}
```

Key: `verifiers` is empty (`[]`) when a requirement is uncovered. Render that as "UNCOVERED" per the plan.

### Scorecard JSON v1.1 (for `/score/<tool>` page)

Lives in the site repo at `scorecards/*.json`. New top-level fields:

```json
{
  "schema_version": "1.1",
  "results": [ /* per-check entries, unchanged from v1.0 */ ],
  "summary":    { /* pass/warn/fail/skip/error, unchanged */ },
  "coverage_summary": {
    "must":   { "total": 23, "verified": 17 },
    "should": { "total": 16, "verified": 2 },
    "may":    { "total": 7,  "verified": 0 }
  },
  "audience":       null,    // stub until v0.1.3; render banner only when non-null
  "audit_profile":  null     // stub until v0.1.3; render exception pill only when non-null
}
```

**Naming difference to watch for:** the matrix uses `covered` (requirement has any verifier); the scorecard uses
`verified` (verifier ran in this scorecard run). Same idea, different noun — keep them distinct in UI copy so readers
can tell "does `anc` verify this at all" from "did `anc` verify it for *this tool*."

**Back-compat:** the 10 committed v1.0 scorecards under `scorecards/*.json` **do not** have `coverage_summary`,
`audience`, or `audit_profile` yet. Your renderer must tolerate missing keys (feature- detect, don't assume). Handoff 3
regenerates those files; don't regenerate them in this PR.

## Check rename map (for handoff 3, but you will see the old IDs)

The 10 committed scorecards under `scorecards/*.json` still carry the old IDs. Handoff 3 regenerates them; until then,
your renderer sees both:

| Old ID              | New ID                    |
|---------------------|---------------------------|
| `p6-tty-detection`  | `p1-tty-detection-source` |
| `p6-env-flags`      | `p1-env-flags-source`     |

If you build a lookup by check ID, accept both keys. Once handoff 3 merges, you can drop the compatibility shim.

## Repo + branch state (as of this brief)

`/home/brett/dev/agentnative-site`:

- Currently on branch `feat/registry-schema-and-expansion`, **not** `dev`.
- Working tree has unstaged changes to `public/fonts/*.woff2` + `scripts/fonts/hashes.txt` and untracked
  `public/fonts/full/` + `scripts/fonts/subset.sh`. **Those are someone else's in-progress font work** — do not commit,
  revert, or stash them into your branch. Leave them alone.
- Create your branch from `origin/dev`, not from the current HEAD: `git fetch origin && git checkout -b
  feat/v011-spec-doctrine-and-coverage-page origin/dev`.
- PR target: `dev` in `brettdavies/agentnative-site`.

## How to pull the matrix artifact into the site repo

The `/coverage` page needs to consume `coverage/matrix.json` from the
`agentnative` repo. Cross-repo artifact sync is a decision the handoff plan defers to you. Recommended approach:

- **Copy the committed JSON** into the site repo at a stable path (suggested: `src/data/coverage-matrix.json`) and have
  `build.mjs` read it at build time. Add a comment at the top of the file pointing to
  `brettdavies/agentnative:coverage/matrix.json` as the source of truth, and a short `scripts/sync-coverage-matrix.sh`
  one-liner the dev can run when the Rust side bumps. Drift risk is real but small — `anc generate coverage-matrix
  --check` fails CI on the Rust side if the registry changes without the artifact being regenerated, so the artifact is
  never *silently* stale.

Do **not** fetch at build time from a raw GitHub URL — the site build
should be network-free and reproducible. Do **not** try to symlink across repos.

## What to verify before opening the PR

- [x] `/coverage` page renders all 46 requirements, marks uncovered ones clearly, and links each row to its principle
  page anchor.
- [x] `/score/<tool>` page renders `coverage_summary` counts and handles the absence of `audience` / `audit_profile`
  fields (v1.0 scorecards) gracefully — no broken renders.
- [x] Old v1.0 scorecards and (hypothetically) new v1.1 scorecards both render without error. Simulate v1.1 by
  hand-editing one JSON locally to add the new fields; do not commit the edit.
- [x] Principle docs P1 / P5 / P6 / P7 pass the site's markdown lint + link check. The P1 MUST rewording must match the
  "Doctrine Decision" section of the CEO plan verbatim.
- [x] `bun run build` succeeds; any playwright / vitest suites pass.

**All verified and merged:** 2026-04-21 via PR #24.

## What **not** to do

- Do not edit anything in `brettdavies/agentnative` — that's handoff 1, which has already shipped. Your branch is in the
  site repo only.
- Do not regenerate scorecards — that's handoff 3 and it waits on you.
- Do not fill in `audience` / `audit_profile` values speculatively. They stay `null` until v0.1.3.
- Do not touch `registry.yaml` except possibly setting `audit_profile` on a tool that actually needs a categorical
  exception (none currently do).
- Do not revert or stage the in-progress font-hash changes on the site's current branch. Branch cleanly from
  `origin/dev`.

## When you finish

Open the site PR against `agentnative-site:dev`, title
`feat(v0.1.1): P1 doctrine rewording, applicability gates, /coverage page`. Link to agentnative PR #21 in the body.

After both PRs merge, handoff 3 (scorecard regeneration) unblocks. v0.1.1 tag waits on handoff 3.
