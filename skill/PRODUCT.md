# PRODUCT.md: skill bundle channel design context

Channel-specific design context for the **skill bundle channel** of agentnative. Inherits the shared identity, voice
anchor, audiences, and universal anti-patterns from [`BRAND.md`](BRAND.md), vendored from
[`agentnative-spec`](https://github.com/brettdavies/agentnative) via a dev-only vendoring script (kept off `main` by the
workflow guard). Read `BRAND.md` first.

## Inheritance

The skill bundle channel sits in a three-tier waterfall. Each tier owns a different concern; nothing duplicates.

1. **Universal layer: [`BRAND.md`](BRAND.md).** Shared identity, voice anchor, audiences, universal anti-patterns.
   Vendored from `agentnative-spec` by a dev-only sync script (kept off `main` by the workflow guard; parallel to
   [`scripts/sync-spec.sh`](scripts/sync-spec.sh), which vendors `spec/principles/` and does ship to `main`). Read
   `BRAND.md` first.
2. **Channel delta: this file (`PRODUCT.md`).** Instructional voice, second-person imperative allowed (the bundle
   teaches agents how to invoke `anc`), terse and agent-loadable. The narrative companion to the shipped bundle content
   at the repo root.
3. **Bundle layer: repo root.** The shipped skill: [`SKILL.md`](SKILL.md), [`getting-started.md`](getting-started.md),
   [`references/`](references/), [`templates/`](templates/), [`bin/`](bin/), and the vendored [`spec/`](spec/). What an
   agent loads into runtime via `~/.claude/skills/agent-native-cli/`, `~/.cursor/skills/agent-native-cli/`, and
   equivalent paths under Codex / OpenCode / Factory / Kiro. Built from the same commit as `PRODUCT.md`.

## Channel: skill bundle

The skill bundle teaches agents how to use `anc` and the spec. The spec describes the contract; the linter verifies it;
the skill bundle teaches the workflow that connects the two.

## Audience (narrowed)

- **AI agents** loading the skill via Claude Code's skill discovery (frontmatter triggers), Cursor's skill registry,
  Codex's `~/.codex/skills/`, OpenCode's `.opencode/skills/`, and equivalent runtimes. The agent reads `SKILL.md` first,
  drills into [`getting-started.md`](./getting-started.md) for one of three loops (existing CLI / new Rust CLI / other
  language), and consults `references/` only when remediating a specific `anc` finding.
- **Humans** running `anc skill install <host>` for the first time, or maintaining the bundle. They expect commands to
  be runnable as written, paths to resolve, and the bundle to track what `anc` produces.

## Register

- **Instructional voice.** Second-person imperative is the default. "Run `anc audit . --output json` to score the repo."
  Not "the skill recommends running `anc audit`."
- **Every action is a runnable command.** Code blocks contain commands the reader can paste. Pseudo-commands and
  prose-only "how to think about it" are out.
- **Reference-shaped tables.** Where the artifact is a list of options, files, or trade-offs, render it as a table with
  stable column headers. The three-artifact table at the top of `SKILL.md` and the useful-flags paragraph in
  `getting-started.md` are the patterns.
- **Triggers and keywords are first-class.** The skill's `description` frontmatter determines which agents discover the
  skill. Keep it dense in the canonical vocabulary (`agentic CLI`, `agent-native`, `anc audit`, `audit-profile`, …). The
  opposite of marketing prose; closer to a search-index line.
- **Cross-link to the spec, the linter, and the templates.** A skill that paraphrases what the spec says drifts. Link
  instead, and quote the requirement ID, not the prose.

## Skill-specific anti-patterns

These extend the universal bans in `BRAND.md`:

- **No "in this guide we will…" preamble.** The agent skips it. Open with the action.
- **No narrative scaffolding.** "First, we'll cover X. Then, Y. Finally, Z." Out. The TOC and section headings carry the
  structure; prose that recapitulates them is noise.
- **No "consider doing X" hedges.** State the action. "Run `anc audit`." Not "you might want to consider running `anc
  check`."
- **No paraphrased spec content.** When the contract matters, link to `spec/principles/p<N>-*.md` and quote the
  requirement ID (`p1-must-no-interactive`), not the prose. Spec drift is silent and expensive when paraphrased.
- **No screenshots, no images.** The skill is consumed by agents; images are tokens-for-no-signal.
- **No version numbers in prose.** "Currently `v0.3.0`" goes stale. Reference [`VERSION`](./VERSION) and
  [`spec/VERSION`](./spec/VERSION) directly, or link to the canonical source. Frontmatter aside.

## Voice anchor application

The pattern in `BRAND.md`, specialized for the skill channel:

- **`SKILL.md`** opens with the three-artifact table (spec / linter / skill), the first action (update check), then the
  launch link to `getting-started.md`. No preamble.
- **`getting-started.md`** opens with the three loops, each as a runnable command sequence with inline annotation.
- **`references/*.md`** are exhaustive references for one technical area each (Rust/clap patterns, framework idioms,
  project structure, update check). Each section stands alone; readers arrive via deep links from `anc` findings.
- **`templates/*`** are the smallest functional starting points, not "examples." A copied template runs.

## Status

This file is the skill-channel `PRODUCT.md`. The spec channel's equivalent lives at
[`agentnative-spec/PRODUCT.md`](https://github.com/brettdavies/agentnative/blob/main/PRODUCT.md); the site channel's at
`agentnative-site/PRODUCT.md`. Cross-channel content is in `BRAND.md`, synced from the spec repo.
