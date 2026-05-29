---
title: "Spec governance model"
type: requirements
status: approved
date: 2026-04-20
---

# Spec governance model

## Problem

The agent-native CLI standard spans two public repos (spec site, auditor tool) with no formal governance model. Issues
about the spec have no clear home. Versioning tracks the overall spec but not individual principles or checks.
Contributors (human and agent) have no guidance on AI disclosure, search-before-create, or human signoff requirements.
The current issue templates are mechanical scaffolding without the policy layer.

## Decisions made

1. **Three-repo architecture.** Create new `agentnative` repo for the spec. Rename current tool repo from `agentnative`
   to `agentnative-cli` on GitHub only (crate name stays `agentnative`, binary stays `anc`). Only code change in tool
   repo: update `Cargo.toml` `repository` field. GitHub redirect handles existing links.

- `agentnative` — the standard (new repo: canonical principle text, governance, versioning, changelog)
- `agentnative-cli` — the auditor tool (GitHub rename only, crate name unchanged)
- `agentnative-site` — the website (unchanged, consumes spec repo as dependency)

1. **Coupled releases.** A principle revision is only complete when the corresponding auditor is also reviewed and
   re-dated. Spec version + principle dates + check dates ship together.
2. **Graduated AI gate.** Disclosure required on all contributions (one sentence at the end: what was AI-written, what
   was human-written). Human co-sign required for principle edits (pressure-tests) and PRs, not for bug reports or CLI
   grading submissions.
3. **Issues only.** No GitHub Discussions. All engagement flows through structured issue templates.
4. **Spec repo is the entry point for spec governance.** Site bugs go to the site repo. Tool bugs go to the tool repo.
   Principle edits, CLI grading, and spec questions go to the spec repo.

## Requirements

### R1: Spec repo (`agentnative`)

- R1.1: Holds canonical `principles/*.md` files (P1-P7).
- R1.2: Holds governance docs: CONTRIBUTING.md, versioning policy, changelog.
- R1.3: Issue templates for: pressure-test (principle edits), grade-a-cli, spec questions.
- R1.4: Repo description: "The agent-native CLI standard" (not "spec repo" or "governance").
- R1.5: CC BY 4.0 license for spec text (matches current /about).
- R1.6: README links to anc.dev for the rendered spec and to the tool repo for the auditor.

### R2: Site repo (`agentnative-site`) changes

- R2.1: Build pipeline consumes principle text from the spec repo (git submodule, subtree, or build-time fetch).
- R2.2: Issue templates scoped to site-specific concerns (build, design, performance, deployment).
- R2.3: /about contributing section updated to point at the spec repo for principle edits and CLI grading.
- R2.4: Remove principle-edit and grade-a-cli issue templates (moved to spec repo).
- R2.5: Keep false-positive template as a redirect link to the tool repo (already done).

### R3: Tool repo (`agentnative-cli`) changes

- R3.1: Issue templates scoped to auditor concerns: false positives/negatives, CLI feature requests, scoring bugs.
- R3.2: No spec governance issues accepted. Template config links to spec repo for principle questions.

### R4: Per-principle calver

- R4.1: Each principle carries a `last-revised: YYYY-MM-DD` date in frontmatter or metadata.
- R4.2: The date updates when any MUST/SHOULD/MAY in that principle changes tier, is added, or is removed.
- R4.3: Prose-only edits (clarity, examples, typos) do NOT update the revision date.
- R4.4: The rendered spec site displays each principle's revision date.
- R4.5: The changelog page groups entries by principle with the revision date.

### R5: Per-check calver

- R5.1: Each check in the tool carries a `last-revised: YYYY-MM-DD` field in its metadata or definition.
- R5.2: The date updates when the check's pass/fail logic changes.
- R5.3: `anc audit --output json` includes the check's revision date in the output.
- R5.4: Scorecard pages on the site display the check revision date alongside the check result.

### R6: Coupled release protocol

- R6.1: A principle revision PR in the spec repo MUST reference the corresponding check review PR in the tool repo (or
  confirm no check changes are needed).
- R6.2: A check logic change in the tool repo SHOULD reference the principle it implements and confirm the spec text
  still matches.
- R6.3: The spec version (v0.X.Y) bumps when any principle revision date changes. MINOR for new/changed MUSTs, PATCH for
  SHOULD/MAY changes.

### R7: AI-native contribution requirements

- R7.1: All issue templates include an "AI disclosure" field (required): one sentence stating what was AI-written and
  what was human-written.
- R7.2: All issue templates include agent-facing instructions in a collapsed details block: search for existing issues
  before creating, required disclosure format, link to CONTRIBUTING.md.
- R7.3: Pressure-test (principle edit) template requires a "Human reviewer" field: the GitHub handle of the human who
  reviewed and approved the submission.
- R7.4: PR template requires the same human reviewer field for AI-assisted PRs.
- R7.5: Follow-up comments on any issue or PR must carry the same one-sentence AI disclosure if AI-assisted.
- R7.6: CONTRIBUTING.md documents the graduated gate policy: disclosure always, human co-sign for spec changes and PRs.

### R8: Cross-repo routing

- R8.1: Each repo's issue template config (`config.yml`) includes contact links to the other two repos with clear
  routing guidance.
- R8.2: The spec repo's CONTRIBUTING.md is the canonical routing document. The site and tool repos link to it.
- R8.3: The /about page on anc.dev links to the spec repo for all spec-related contributions.

## Non-goals

- Community submission flow for adding tools to the registry (separate feature, not governance).
- Automated cross-repo issue linking or transfer (manual for now).
- Formal RFC process with stages (TC39-style). Single-author spec, single approval gate.
- GitHub Discussions on any repo.

## Open questions

- Q1: Git submodule vs subtree vs build-time fetch for the site consuming spec repo content? (Implementation decision,
  defer to /ce-plan.)
- Q2: Should the spec repo also hold the changelog, or does the changelog stay on the site? (Recommendation: spec repo
  holds the changelog since it tracks spec evolution, not site evolution.)
- ~~Q3: Resolved. `agentnative` (spec, new repo), `agentnative-cli` (tool, GitHub rename only, crate unchanged),
  `agentnative-site` (website, unchanged). Crate name is independent of repo name per crates.io policy.~~

## Success criteria

- A contributor can find the right repo for their issue within 30 seconds of reading /about or any repo's README.
- An agent filing an issue is guided to search first, disclose AI involvement, and route to the correct repo.
- A tool consumer can answer "which version of P3 was I scored against?" from the `anc audit` output alone.
- A principle revision PR cannot merge without a linked check review (or explicit "no check changes needed").
